/**
 * `ow capture`：手动编译一个会话文件。
 *
 * **为什么 CLI 版受限**：编译要在进程内用宿主自己的模型凭据。CLI 是独立进程，
 * dsh 的凭据是平台 refresh token（`~/.dsh/.credentials.yaml`），不是 OpenAI 兼容
 * key，CLI 用不了；pi 的 `auth.json` 同理只在 pi 进程内可见。
 *
 * 所以分两条路（方案 §6.4）：
 *  1. **有独立凭据**（`OPENAI_API_KEY` / `AUTOSKILL_PROVIDER` + models.json）→ 真编译
 *  2. **没有** → 只做「切窗 + 信号门 + 落 staging」，产出待编译队列，
 *     下次宿主会话里由 `ow` 前门技能或定时器接手
 *
 * 这样至少能回答「这个会话值不值得编译」，不会白等。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStandaloneConfig, activeConfigDescription } from "../base/llm.ts";
import { hostContext, setHostContext } from "../base/context.ts";
import { isPiSessionFile, readPiSession } from "./pi-session.ts";
import { indexTurns, remainingTurns, takeWindow, windowEndTurn, windowEndSeq } from "./turns.ts";
import { buildWindowPayload, type WindowPayload } from "./window.ts";
import { evaluateSignal, type SignalResult } from "./signal.ts";
import { getSessionState, sessionKey, advanceState } from "./state.ts";
import { readSessionEvents, readSessionHeader, isSubagentSession, sessionIdFromPath } from "./session-file.ts";
import { buildCompilePrompt } from "../compiler/prompt.ts";
import { runCompile } from "../compiler/run.ts";
import { writeCompileResult, type CompileReport } from "../compiler/report.ts";
import { rebuildHot, rebuildIndex, appendLog } from "../vault/index.ts";
import { parseSession } from "../extract/window.ts";
import { readSessionLines } from "./session-file.ts";
import type { MessageEntry } from "../base/types.ts";

export interface CaptureOptions {
  sessionFile: string;
  vaultDir: string;
  skillDir: string;
  /** 一次最多编译多少轮（默认全部剩余，上限由 maxWindows 控制） */
  turns?: number;
  maxWindows?: number;
  /** 只切窗不编译 */
  planOnly?: boolean;
  /**
   * 手动触发（用户说「小q 沉淀」）。
   *
   * 手动窗口**跳过信号门**（方案 §6.5）：用户明确叫了就是要记，此时
   * 「纯检索」「短闲聊」这些降噪规则不适用——它们的目的是省 token，
   * 而手动触发已经花了用户一次表达成本，再拒绝就是违背直觉。
   */
  manual?: boolean;
  /** 宿主；不传时按文件路径自动识别（pi 会话 vs dsh 会话）。
   *  opencode 会话不走本模块（live 会话由 adapter-opencode 直接喂 maybeCompile），
   *  联合类型保持同宽只为下游 cycle/window 类型对齐。 */
  agent?: "dsh" | "pi" | "opencode";
}

export type CaptureOutcome =
  | { status: "subagent" }
  | { status: "empty" }
  | { status: "nothing-pending"; pending: number }
  | { status: "planned"; windows: PlannedWindow[]; queued: string[] }
  | { status: "compiled"; reports: CompileReport[]; model: string }
  | { status: "no-llm"; reason: string; queued: string[] }
  | { status: "error"; error: string };

export interface PlannedWindow {
  from_turn: number;
  to_turn: number;
  turns: number;
  hash: string;
  signal: SignalResult;
  /**
   * 手动触发时强制编译（方案 §6.5）。
   *
   * 手动窗口**跳过信号门**：用户明确叫了就是要记，「纯检索」「短闲聊」这些
   * 降噪规则此时不适用——它们的目的是省 token，而手动触发已经花了用户一次
   * 表达成本，再拒绝就违背直觉。
   *
   * 但 `signal` 仍保留**真实判定**，这样 `ow capture --plan` 还能看到
   * 「这段本来会被信号门拦下，因为你是手动触发才编的」。
   */
  forced?: boolean;
  chars: number;
}

export const DEFAULT_MAX_WINDOWS = 8;

/** 把会话归一成带 seq 的 MessageEntry（与 adapter-dsh 的 attachSeqs 同逻辑） */
function entriesWithSeq(lines: string[], events: Array<Record<string, unknown>>): Array<MessageEntry & { seq: number }> {
  const entries = parseSession(lines);
  const byId = new Map<string, number>();
  const seqs: number[] = [];
  const msgTypes = new Set(["message", "user/message", "assistant/message", "tool/result"]);
  for (const e of events) {
    const seq = typeof e.seq === "number" ? e.seq : undefined;
    if (seq === undefined || !msgTypes.has(String(e.type))) continue;
    seqs.push(seq);
    const id = messageIdOf(e);
    if (id) byId.set(id, seq);
  }
  let cursor = 0;
  return entries.map((entry) => {
    const hit = byId.get(entry.id);
    if (hit !== undefined) return { ...entry, seq: hit };
    const seq = seqs[cursor] ?? seqs[seqs.length - 1] ?? 0;
    cursor += 1;
    return { ...entry, seq };
  });
}

function messageIdOf(e: Record<string, unknown>): string | undefined {
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (typeof data.id === "string") return data.id;
  const msg = data.message as Record<string, unknown> | undefined;
  if (typeof msg?.id === "string") return msg.id;
  const callId = data.callId ?? msg?.toolCallId;
  if (typeof callId === "string") return callId;
  return undefined;
}

interface LoadedSession {
  agent: "dsh" | "pi" | "opencode";
  sessionId: string;
  cwd: string;
  events: Array<Record<string, unknown>>;
  entries: Array<MessageEntry & { seq: number }>;
  subagent: boolean;
}

/** 按路径/显式 agent 选择 dsh 或 pi 的读取器 */
function loadSession(opts: CaptureOptions): LoadedSession {
  const agent = opts.agent ?? (isPiSessionFile(opts.sessionFile) ? "pi" : "dsh");
  if (agent === "pi") {
    const s = readPiSession(opts.sessionFile);
    return {
      agent: "pi",
      sessionId: s.header.id,
      cwd: s.header.cwd ?? process.cwd(),
      events: s.events,
      entries: s.entries,
      subagent: false,
    };
  }
  const lines = readSessionLines(opts.sessionFile);
  const events = readSessionEvents(opts.sessionFile);
  const header = readSessionHeader(opts.sessionFile);
  return {
    agent: "dsh",
    sessionId: header?.id ?? sessionIdFromPath(opts.sessionFile),
    cwd: header?.cwd ?? process.cwd(),
    events,
    entries: entriesWithSeq(lines, events),
    subagent: isSubagentSession(opts.sessionFile),
  };
}

/** pi 的 CLI 手动入口需要 models.json；未注入时补一次宿主上下文 */
export function ensurePiHostContext(): void {
  if (hostContext()?.homeDir) return;
  if (hostContext()) return; // 已注入 cli 等其他形态，不覆盖
  const agentDir = join(homedir(), ".pi", "agent");
  try {
    setHostContext({
      host: "pi",
      dataDir: join(agentDir, "data", "autoskill", "knowledge"),
      homeDir: agentDir,
      modelsPath: join(agentDir, "models.json"),
      settingsPath: join(agentDir, "settings.json"),
    });
  } catch {
    /* 冲突注入不阻塞 */
  }
}

/** 切出待编译窗口（不烧 token） */
export function planWindows(opts: CaptureOptions): PlannedWindow[] {
  const loaded = loadSession(opts);
  if (loaded.subagent) return [];
  const { agent, sessionId, cwd, events, entries } = loaded;
  const index = indexTurns(events, sessionId, agent);
  const state = getSessionState(opts.vaultDir, sessionKey(agent, sessionId));
  const turnsPer = opts.turns ?? 30;
  const maxWindows = opts.maxWindows ?? DEFAULT_MAX_WINDOWS;

  const out: PlannedWindow[] = [];
  let from = state.compiled_to_turn;
  for (let i = 0; i < maxWindows; i++) {
    const win = takeWindow(index, from, turnsPer);
    if (win.length === 0) break;
    const payload = buildWindowPayload({
      agent,
      sessionId,
      cwd,
      entries,
      turns: win,
    });
    out.push({
      from_turn: payload.from_turn,
      to_turn: payload.to_turn,
      turns: payload.turns,
      hash: payload.hash,
      signal: evaluateSignal(payload),
      forced: opts.manual === true ? true : undefined,
      chars: payload.messages.reduce((n, m) => n + m.text.length, 0),
    });
    from = windowEndTurn(win);
  }
  return out;
}

/** 主流程 */
export async function runCapture(opts: CaptureOptions): Promise<CaptureOutcome> {
  if (!existsSync(opts.sessionFile)) {
    return { status: "error", error: `会话文件不存在：${opts.sessionFile}` };
  }
  const loaded = loadSession(opts);
  if (loaded.subagent) return { status: "subagent" };
  const { agent, sessionId, cwd, events, entries } = loaded;
  if (events.length === 0) return { status: "empty" };

  const key = sessionKey(agent, sessionId);
  const index = indexTurns(events, sessionId, agent);
  const state = getSessionState(opts.vaultDir, key);
  const pending = remainingTurns(index, state.compiled_to_turn);
  if (pending === 0) return { status: "nothing-pending", pending: 0 };

  const planned = planWindows(opts);
  // 手动触发跳过信号门（§6.5）：forced 的窗口一律编译
  const keep = planned.filter((p) => p.signal.keep || p.forced);

  if (opts.planOnly) {
    return { status: "planned", windows: planned, queued: keep.map((p) => `${p.from_turn}-${p.to_turn}`) };
  }
  if (keep.length === 0) {
    return {
      status: "planned",
      windows: planned,
      queued: [],
    };
  }

  // 能不能真编译：CLI 独立进程需要 standalone 凭据
  if (agent === "pi") ensurePiHostContext();
  const { config, reason } = resolveStandaloneConfig();
  if (!config) {
    // pi 侧没有消费 queue 的 drain（自动走 extension），排队只会永远躺着；
    // 明确告诉用户回 pi 会话里手动/自动沉淀。
    if (agent === "pi") return { status: "no-llm", reason: reason ?? "pi CLI 无独立凭据", queued: [] };
    const queued = queueForHost(opts.vaultDir, {
      sessionFile: opts.sessionFile,
      sessionId,
      cwd,
      windows: keep,
      reason: reason ?? "无独立凭据",
    });
    return { status: "no-llm", reason: reason ?? "无独立凭据", queued };
  }

  // 有凭据：真编译
  const reports: CompileReport[] = [];
  let model = "";
  let compiledTo = state.compiled_to_turn;

  try {
    for (const plan of keep) {
      const win = index.turns.filter((t) => t.index > compiledTo && t.index <= plan.to_turn);
      if (win.length === 0) break;
      const payload = buildWindowPayload({ agent, sessionId, cwd, entries, turns: win });
      const prompt = buildCompilePrompt({ vaultDir: opts.vaultDir, window: payload, skillDir: opts.skillDir });
      const result = await runCompile({ prompt });
      model = result.model;
      const report = writeCompileResult({
        vaultDir: opts.vaultDir,
        window: payload,
        result,
        trigger: opts.manual ? "manual" : "auto",
      });
      reports.push(report);
      compiledTo = windowEndTurn(win);
      advanceState(opts.vaultDir, key, {
        compiled_to_turn: compiledTo,
        compiled_to_seq: windowEndSeq(win),
        pages: report.pages_created + report.pages_updated,
      });
    }
    rebuildIndex(opts.vaultDir);
    rebuildHot(opts.vaultDir);
    appendLog(opts.vaultDir, `手动编译 ${agent}/${sessionId}：${reports.length} 个窗口，模型 ${model}`);
    return { status: "compiled", reports, model };
  } catch (e) {
    return { status: "error", error: String(e) };
  }
}

/**
 * 无凭据时落队列：`.ow/pending/capture.json`。
 *
 * 为什么落文件而不是丢弃：宿主下次启动时读它补跑，用户不必重新说一遍。
 */
export function queueForHost(
  vaultDir: string,
  item: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
    windows: PlannedWindow[];
    reason: string;
  },
): string[] {
  const dir = join(vaultDir, ".ow", "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "capture.json");
  const entry = {
    session_file: item.sessionFile,
    session_id: item.sessionId,
    cwd: item.cwd,
    windows: item.windows.map((w) => ({ from_turn: w.from_turn, to_turn: w.to_turn })),
    reason: item.reason,
    queued_at: new Date().toISOString(),
  };

  let cur: { schema: number; items: unknown[] } = { schema: 1, items: [] };
  try {
    const parsed = JSON.parse(readFileIfExists(path) ?? "") as { items?: unknown[] };
    cur = { schema: 1, items: parsed.items ?? [] };
  } catch {
    /* 没有就新建 */
  }
  // 同会话只留最新一条（重跑覆盖，不累积）
  cur.items = cur.items.filter((i) => (i as { session_id?: string }).session_id !== item.sessionId);
  cur.items.push(entry);
  writeFileSync(path, JSON.stringify(cur, null, 2), "utf8");

  return item.windows.map((w) => `第 ${w.from_turn}–${w.to_turn} 轮`);
}

function readFileIfExists(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** 诊断：当前 CLI 能用哪种凭据 */
export function describeCredentialSituation(): string {
  const { config, reason } = resolveStandaloneConfig();
  return config
    ? `可编译：${activeConfigDescription()}，模型 ${config.model}`
    : `不可编译（CLI 独立进程）：${reason}`;
}

// ---------------- 死信队列补跑 ----------------

/** capture.json 里一条待补跑项（queueForHost 写入的形状） */
export interface PendingCaptureItem {
  session_file: string;
  session_id: string;
  cwd: string;
  windows: Array<{ from_turn: number; to_turn: number }>;
  reason: string;
  queued_at: string;
}

export interface DrainResult {
  /** 编完删掉的 item 数 */
  drained: number;
  /** 保留待下次重试的 item 数（error / 锁忙 / 预算用尽 / 无信号） */
  kept: number;
  /** 本次实际编译成功的窗口数 */
  windowsCompiled: number;
  /** 诊断信息（丢弃的坏项、单条异常等） */
  notes: string[];
}

/**
 * 排空「待补跑」队列（`.ow/pending/capture.json`）。
 *
 * 为什么需要它：`queueForHost` 在 CLI 无凭据时把编译任务落进队列，注释承诺
 * 「宿主下次启动时读它补跑」——但之前没有任何代码读它，写进去就石沉大海
 * （2026-11-17 实测：session-a3cea5a8 的 60 轮因此全晾着）。
 *
 * 宿主侧（adapter-dsh 定时器，in-process ChatCompleter 已注入）调本函数：对每条
 * item 反复跑 `runOne(sessionFile)`，每跑成一次（返回 "compiled"）就推进水位，
 * 直到没有整窗可编（"not-enough-turns" 等终态）才放下。`runOne` 注入是为了不让
 * core 反向依赖 adapter-dsh 的 runCycle，也方便测试用 mock 替身。
 *
 * 删除策略：
 *  - 编到「无整窗可编 / 会话空 / 自触发」→ 删（要么编完了，要么确实没东西可编）；
 *  - 会话文件已消失 → 删（留着只会永远失败）；
 *  - error / 锁忙 / 预算用尽 / 无信号 → **保留**，等下次 tick 续（水位已推进，
 *    续编剩余窗口；无信号时水位不推进，下次再判，signal 不会因静态历史翻转，
 *    但保留比静默丢弃数据安全）。
 */
export async function drainPendingCapture(
  vaultDir: string,
  runOne: (sessionFile: string) => Promise<string>,
): Promise<DrainResult> {
  const path = join(vaultDir, ".ow", "pending", "capture.json");
  let parsed: { schema: number; items: PendingCaptureItem[] };
  try {
    parsed = JSON.parse(readFileIfExists(path) ?? "") as { schema: number; items: PendingCaptureItem[] };
    if (!parsed.items?.length) {
      return { drained: 0, kept: 0, windowsCompiled: 0, notes: [] };
    }
  } catch {
    // 损坏或不存在：没东西可排
    return { drained: 0, kept: 0, windowsCompiled: 0, notes: [] };
  }

  const notes: string[] = [];
  let windowsCompiled = 0;
  const survivors: PendingCaptureItem[] = [];

  for (const item of parsed.items) {
    // 会话文件已不在（会话被清理）：留着只会永远失败，直接丢
    if (!item.session_file || !existsSync(item.session_file)) {
      notes.push(`丢弃 ${item.session_id ?? "?"}：会话文件不存在 ${item.session_file ?? "(空)"}`);
      continue;
    }

    let compiledAny = false;
    let last = "";
    try {
      // 反复编译直到不再返回 "compiled"（每跑成一次推进一次水位）
      for (;;) {
        last = await runOne(item.session_file);
        if (last !== "compiled") break;
        compiledAny = true;
        windowsCompiled++;
      }
    } catch (e) {
      // 单条异常不拖垮其它 item：保留这条，下次 tick 再试
      notes.push(`保留 ${item.session_id}: ${String(e).slice(0, 200)}`);
      survivors.push(item);
      continue;
    }

    // 终态判定：到「无整窗可编 / 会话空 / 自触发 / 子代理跳过」才删；
    // 可重试终态保留待下次。注意 compiledAny 时 last 必非 "compiled"，
    // 若是 not-enough-turns 则全编完→删；若是 error 则部分编完→保留续编。
    const terminal =
      last === "not-enough-turns" ||
      last === "skip" ||
      last === "none" ||
      last === "self-trigger" ||
      last === "subagent-skip" ||
      last === "already-compiled";
    if (!terminal) {
      survivors.push(item);
    }
  }

  if (survivors.length === 0) {
    // 全清：删文件，不留空壳（否则 status 会一直挂着一个 0 项队列文件）
    try {
      rmSync(path, { force: true });
    } catch {
      /* 忽略 */
    }
  } else {
    writeFileSync(path, JSON.stringify({ schema: 1, items: survivors }, null, 2), "utf8");
  }

  return {
    drained: parsed.items.length - survivors.length,
    kept: survivors.length,
    windowsCompiled,
    notes,
  };
}
