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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStandaloneConfig, activeConfigDescription } from "../base/llm.ts";
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

/** 切出待编译窗口（不烧 token） */
export function planWindows(opts: CaptureOptions): PlannedWindow[] {
  const lines = readSessionLines(opts.sessionFile);
  const events = readSessionEvents(opts.sessionFile);
  const sessionId = readSessionHeader(opts.sessionFile)?.id ?? sessionIdFromPath(opts.sessionFile);
  const index = indexTurns(events, sessionId, "dsh");
  const state = getSessionState(opts.vaultDir, sessionKey("dsh", sessionId));
  const entries = entriesWithSeq(lines, events);
  const turnsPer = opts.turns ?? 30;
  const maxWindows = opts.maxWindows ?? DEFAULT_MAX_WINDOWS;

  const out: PlannedWindow[] = [];
  let from = state.compiled_to_turn;
  for (let i = 0; i < maxWindows; i++) {
    const win = takeWindow(index, from, turnsPer);
    if (win.length === 0) break;
    const payload = buildWindowPayload({
      agent: "dsh",
      sessionId,
      cwd: readSessionHeader(opts.sessionFile)?.cwd ?? process.cwd(),
      entries,
      turns: win,
    });
    out.push({
      from_turn: payload.from_turn,
      to_turn: payload.to_turn,
      turns: payload.turns,
      hash: payload.hash,
      signal: evaluateSignal(payload),
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
  if (isSubagentSession(opts.sessionFile)) return { status: "subagent" };

  const lines = readSessionLines(opts.sessionFile);
  const events = readSessionEvents(opts.sessionFile);
  if (events.length === 0) return { status: "empty" };

  const header = readSessionHeader(opts.sessionFile);
  const sessionId = header?.id ?? sessionIdFromPath(opts.sessionFile);
  const cwd = header?.cwd ?? process.cwd();
  const key = sessionKey("dsh", sessionId);
  const index = indexTurns(events, sessionId, "dsh");
  const state = getSessionState(opts.vaultDir, key);
  const pending = remainingTurns(index, state.compiled_to_turn);
  if (pending === 0) return { status: "nothing-pending", pending: 0 };

  const planned = planWindows(opts);
  const keep = planned.filter((p) => p.signal.keep);

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
  const { config, reason } = resolveStandaloneConfig();
  if (!config) {
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
  const entries = entriesWithSeq(lines, events);
  const reports: CompileReport[] = [];
  let model = "";
  let compiledTo = state.compiled_to_turn;

  try {
    for (const plan of keep) {
      const win = index.turns.filter((t) => t.index > compiledTo && t.index <= plan.to_turn);
      if (win.length === 0) break;
      const payload = buildWindowPayload({ agent: "dsh", sessionId, cwd, entries, turns: win });
      const prompt = buildCompilePrompt({ vaultDir: opts.vaultDir, window: payload, skillDir: opts.skillDir });
      const result = await runCompile({ prompt });
      model = result.model;
      const report = writeCompileResult({ vaultDir: opts.vaultDir, window: payload, result });
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
    appendLog(opts.vaultDir, `手动编译 ${sessionId}：${reports.length} 个窗口，模型 ${model}`);
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
