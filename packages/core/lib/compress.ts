/**
 * 一段式抽取的输入构造：分级压缩 + fail-safe 断言 + 轮次对齐分批。
 *
 * 设计依据 design/ONE_STAGE_EXTRACT.md §二（批次怎么切）、§三（分级压缩）。
 * 相对旧 serializeForScan（lib/trigger-scan.ts）的修订（2026-11-11）：
 *  - 工具参数：完整命令行 / 代码块 ≤600 字（旧：一律前 80 字）
 *  - 工具结果：stderr 与报错行全文 ≤800 字（旧：只留首行）
 *  - stdout / 重复 JSON 参数继续压（体积大头、价值低）
 *  - fail-safe 断言：报错行没能逐字保留 → 该条原样透传、不压
 *    （借鉴 billion-context log-select："每条 ERROR/FAIL 行必须逐字存活，否则整体拒绝、原文透传"）
 *  - 压掉的大块留"取回凭证"（msg_id + 类型 + 原始体积 + 命令），供模型按需声明 need_context
 *  - 分批按轮次对齐：一轮对话（一个 user 消息到下一个 user 消息之前）绝不切开
 */
import type { MessageEntry } from "./types.ts";

export interface ExtractLine {
  id: string;
  role: "user" | "assistant" | "toolResult";
  /** 轮次序号，从 0 开始；分批时不可切开同一轮 */
  turn: number;
  /** 压缩后喂给模型的文本 */
  text: string;
  /** 原文字符数 */
  rawChars: number;
  /** fail-safe 断言未通过 → 原样透传 */
  fallback?: boolean;
  /** 压完不比原文小 → 干脆不压（净收益检查） */
  noGain?: boolean;
  /** 被压掉的字符数（>0 时 text 里带取回凭证） */
  droppedChars?: number;
  toolName?: string;
}

export interface CompressOptions {
  /** 用户消息上限（默认 4000；实测用户消息只占全文 0.4%，基本不截断） */
  userChars?: number;
  /** 助手中间消息首尾各多少字（默认 500） */
  assistantChars?: number;
  /** 命令行 / 代码块上限（默认 600） */
  /** 命令行上限：截断会触发 fail-safe 整条透传，所以给足（实测 P90=2477，600 会截掉一半命令） */
  commandChars?: number;
  /** 写文件的正文上限：截断只损失篇幅、不影响可复现性，不触发透传 */
  contentChars?: number;
  /** stderr / 报错行合计上限（默认 800） */
  stderrChars?: number;
  /** 成功输出保留的首行上限（默认 200） */
  toolChars?: number;
  /** 结构化大参数：键名 + 前 N 字（默认 80） */
  argsChars?: number;
  /** fail-safe 透传时的硬上限（默认 4000） */
  hardCap?: number;
}

/** 报错行识别（含中文）；宁可多留不可漏留 */
const ERROR_LINE =
  /(\bERROR\b|\bERR!\b|\bFAIL(?:ED|URE|S)?\b|error:|Error:|\bException\b|Traceback \(most recent call last\)|fatal:|panic:|\bSEGFAULT\b|Command not found|No such file|Permission denied|ECONNREFUSED|ENOENT|exit code: [1-9]|错误[:：]|失败[:：]|异常[:：]|报错[:：])/;

/** 明显不是报错的行（防误判导致整条透传） */
const ERROR_FALSE_POSITIVE =
  /(\b0 errors?\b|\bno errors?\b|0 failed|without error|error-free|错误数[:：]?\s*0|--?fix\b.*error)/i;

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));
const headTail = (s: string, n: number): string =>
  s.length <= n * 2 ? s : s.slice(0, n) + "\n…(中略)…\n" + s.slice(-n);

/** 原文里的报错行（去空、去明显误判） */
export function errorLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && ERROR_LINE.test(l) && !ERROR_FALSE_POSITIVE.test(l));
}

/**
 * fail-safe 断言：原文里每条报错行都必须在压缩结果里逐字存在。
 * 不过 → 调用方必须原样透传该条，而不是接受残缺的压缩结果。
 */
export function assertErrorLinesKept(raw: string, compressed: string): boolean {
  for (const line of errorLines(raw)) {
    const t = line.trim();
    if (!t) continue;
    // 只比对前 200 字：报错行本身可能被 hardCap 截断，但头部必须逐字在
    if (!compressed.includes(clip(t, 200))) return false;
  }
  return true;
}

/** 取回凭证：让模型知道"这里被压掉了什么、要多大、怎么要回来" */
export function placeholder(id: string, kind: string, rawChars: number, cmd: string, kept: string): string {
  const c = cmd.trim();
  return `📦 [压掉 #${id} · ${kind} · 原 ${rawChars.toLocaleString("en-US")} 字 · ${kept}]${c ? ` \`${clip(c, 120)}\`` : ""}\n   → 需要原文时在 need_context 里报 ${id}`;
}

const CODE_ARG_KEYS = [
  "command", "cmd", "script", "code", "content", "file_text", "patch",
  "new_string", "old_string", "text", "query", "pattern", "sql",
];
const SHELL_TOOL = /^(bash|sh|shell|zsh|fish|terminal|run_command|exec|command|node|python3?|pnpm|npm|git)$/i;

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) ?? String(v ?? "");
  } catch {
    return String(v ?? "");
  }
}

/**
 * 工具参数：命令行 / 代码块完整保留（≤commandChars），结构化大参数只留键名 + 前 argsChars 字。
 * 返回 truncated=true 时调用方应触发 fail-safe 透传（命令被截断就不可复现）。
 */
/**
 * harness 注入的运行时元数据（时间戳/时区/上下文快照），不是人说的话。
 *
 * 实测一条会话里 64 条 user 消息有 **22 条（34%）是纯元数据**。契约要求每条 user 消息
 * 都要交代（进卡或进 drop），于是每批都白花输出 token 给噪声记账，drop 账里也混进一堆
 * "纯流水账"，掩盖真正的漏检。
 *
 * 判定保守：必须命中时间戳块开头，且剥掉已知元数据行后**一个字都不剩**才算噪声。
 * 宁可漏过噪声也绝不误杀真话——"好""对""就这样"这类一两个字的确认恰恰是 P0 决策信号，
 * 阈值取 5 或 20 都会把它们连同元数据一起丢掉（实测踩过）。未枚举到的元数据变体只会
 * 让消息被保留（漏过噪声），方向是安全的。
 */
const HARNESS_TIME_BLOCK = /^Time sampled while preparing turn \d+, step \d+:.*$/m;
const HARNESS_META_LINES = [
  /^Browser time zone for this request:.*$/m,
  /^Interpret otherwise-unqualified dates and times in this zone\..*$/m,
  /^Elapsed since the preceding (model-visible message|step context):.*$/m,
  /^Current runtime context(\. This snapshot supersedes earlier runtime-context snapshots)?\.?$/m,
];

export function isHarnessNoise(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return true;
  if (!HARNESS_TIME_BLOCK.test(t)) return false;
  let rest = t.replace(HARNESS_TIME_BLOCK, "");
  for (const re of HARNESS_META_LINES) rest = rest.replace(re, "");
  return rest.trim().length === 0;
}

/** 会话里有多少条 user 消息是纯 harness 元数据（报表用） */
export function harnessNoiseCount(entries: MessageEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.message?.role !== "user") continue;
    const c = e.message?.content;
    const txt = typeof c === "string"
      ? c
      : ((c ?? []) as Array<Record<string, unknown>>).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
    if (isHarnessNoise(txt)) n++;
  }
  return n;
}

/** dsh 的 tool-call arguments 是 JSON 字符串，pi 是对象；统一成对象好走后续按 key 取命令 */
export function parseArgs(a: unknown): unknown {
  if (typeof a !== "string") return a;
  const t = a.trim();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    return t; // 不是合法 JSON 就当纯文本命令，compressArgs 会按命令行处理
  }
}

/**
 * 命令行 key：截断就不可复现，必须触发 fail-safe 整条透传。
 * 其余 CODE_ARG_KEYS（content / file_text / new_string / patch …）是**写进文件的正文**，
 * 截断只损失篇幅、不影响可复现性，不触发透传——否则一次 write 长文件就把整条助手消息按 4000 字全文透传，
 * 实测 98/522 条命中（19%），远超验收 #8 的 5% 阈值，而且透传的全是文件正文不是命令。
 */
const COMMAND_ARG_KEYS = ["command", "cmd", "script", "sql"];

export interface ArgLimits {
  commandChars?: number;
  contentChars?: number;
  argsChars?: number;
}

export function compressArgs(
  toolName: string,
  args: unknown,
  limits: ArgLimits = {},
): { text: string; truncated: boolean; kind: "command" | "content" | "args" } {
  const commandChars = limits.commandChars ?? 2000;
  const contentChars = limits.contentChars ?? 600;
  const argsChars = limits.argsChars ?? 80;
  const shell = SHELL_TOOL.test(toolName);
  const rec = (args && typeof args === "object" ? args : null) as Record<string, unknown> | null;

  if (!rec) {
    // 纯字符串参数（含 JSON 解析失败的）：shell 工具当命令，其余当正文
    const v = safeStringify(args);
    const kind = shell ? "command" : "content";
    const cap = kind === "command" ? commandChars : contentChars;
    if (v.length <= cap) return { text: v, truncated: false, kind };
    return {
      text: clip(v, cap) + `\n…(${kind === "command" ? "命令" : "内容"}截断，原 ${v.length} 字)`,
      truncated: kind === "command",
      kind,
    };
  }

  const cmdKey = COMMAND_ARG_KEYS.find((k) => typeof rec[k] === "string" && String(rec[k]).trim().length > 0);
  const codeKey = CODE_ARG_KEYS.find((k) => typeof rec[k] === "string" && String(rec[k]).trim().length > 0);
  const isCommand = shell || !!cmdKey;
  const key = cmdKey ?? codeKey;

  if (key || shell) {
    const v = key ? String(rec[key]) : safeStringify(rec);
    const kind = isCommand ? "command" : "content";
    const cap = kind === "command" ? commandChars : contentChars;
    if (v.length <= cap) return { text: v, truncated: false, kind };
    return {
      text: clip(v, cap) + `\n…(${kind === "command" ? "命令" : "内容"}截断，原 ${v.length} 字)`,
      truncated: kind === "command",
      kind,
    };
  }
  const json = safeStringify(rec);
  return { text: `${Object.keys(rec).join(",")} = ${clip(json, argsChars)}`, truncated: false, kind: "args" };
}

/** 消息内容 → 文本片段（text 块 + 工具调用；thinking / image 一律跳过） */
function blocksOf(e: MessageEntry): { texts: string[]; calls: { name: string; args: unknown }[] } {
  const content = e.message?.content;
  const texts: string[] = [];
  const calls: { name: string; args: unknown }[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else {
    for (const b of (content ?? []) as Array<Record<string, unknown>>) {
      // 只收 text：reasoning（thinking）块按设计不进抽取（P3 级、未验证、会自我推翻、体量巨大）
      if (b.type === "text") texts.push(String(b.text ?? ""));
      // pi 形状是 toolCall + 对象 arguments；dsh 形状是 tool-call + JSON 字符串 arguments
      else if (b.type === "toolCall" || b.type === "tool-call" || b.type === "tool_call") {
        calls.push({ name: String(b.name ?? ""), args: parseArgs(b.arguments) });
      }
    }
  }
  return { texts, calls };
}

/** 轮次划分：每个 user 消息开启新的一轮 */
export function assignTurns(entries: MessageEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  let turn = 0;
  let seenUser = false;
  for (const e of entries) {
    if (e.message?.role === "user") {
      if (seenUser) turn++;
      seenUser = true;
    }
    map.set(e.id, turn);
  }
  return map;
}

/**
 * 净收益检查：压完不比原文小就干脆不压（借鉴 billion-context 的 net-benefit gate
 * "摘要不比原文小就拒绝"）。小消息 + 占位符/前缀的元数据开销可能反超原文。
 */
function finalize(
  id: string,
  role: ExtractLine["role"],
  turn: number,
  label: string,
  raw: string,
  body: string,
  opts: { fallback?: boolean; droppedChars?: number; toolName?: string; hardCap: number },
): ExtractLine {
  const base = { id, role, turn, rawChars: raw.length, toolName: opts.toolName };
  if (opts.fallback) {
    return { ...base, fallback: true, droppedChars: 0, text: `${label}\n${clip(raw, opts.hardCap)}` };
  }
  if (body.length >= raw.length) {
    const kept = raw.length <= opts.hardCap ? raw : clip(raw, opts.hardCap) + `\n…(截断，原 ${raw.length} 字)`;
    return { ...base, noGain: true, droppedChars: 0, text: `${label}\n${kept}` };
  }
  return { ...base, droppedChars: opts.droppedChars ?? Math.max(0, raw.length - body.length), text: `${label}\n${body}` };
}

/** 逐条压缩序列化：每条消息一行（带真实 id 与轮次号） */
export function serializeForExtract(entries: MessageEntry[], opts: CompressOptions = {}): ExtractLine[] {
  const userChars = opts.userChars ?? 4000;
  const assistantChars = opts.assistantChars ?? 500;
  const commandChars = opts.commandChars ?? 2000;
  const contentChars = opts.contentChars ?? 600;
  const stderrChars = opts.stderrChars ?? 800;
  const toolChars = opts.toolChars ?? 200;
  const argsChars = opts.argsChars ?? 80;
  const hardCap = opts.hardCap ?? 4000;

  const turns = assignTurns(entries);
  const lines: ExtractLine[] = [];

  for (const e of entries) {
    const role = e.message?.role ?? "";
    const turn = turns.get(e.id) ?? 0;
    const { texts, calls } = blocksOf(e);
    const toolName = String(e.message?.toolName ?? "");

    if (role === "user") {
      const raw = texts.join("\n").trim();
      if (!raw) continue;
      // harness 元数据不是人说的话，不进批次（否则每批都要为它记账）
      if (isHarnessNoise(raw)) continue;
      lines.push(finalize(e.id, "user", turn, `[User ${e.id}]`, raw, clip(raw, userChars), { hardCap }));
      continue;
    }

    if (role === "assistant") {
      const parts: string[] = [];
      let truncated = false;
      for (const t of texts) if (t.trim()) parts.push(t.trim());
      for (const c of calls) {
        const a = compressArgs(c.name, c.args, { commandChars, contentChars, argsChars });
        // 只有"命令行被截断"才触发 fail-safe：命令不完整就不可复现，而 sop 卡的核心正是"到底跑了什么"。
        // 写文件的正文被截断不算（可复现性不受影响，且这类透传实测占 19%）。
        if (a.truncated && a.kind === "command") truncated = true;
        parts.push(`[tool ${c.name}] ${a.text}`);
      }
      const raw = parts.join("\n");
      if (!raw.trim()) continue;
      // 命令被截断 → fail-safe 透传（命令不完整就不可复现，而 sop 卡的核心正是"到底跑了什么"）
      lines.push(finalize(e.id, "assistant", turn, `[Assistant ${e.id}]`, raw, headTail(raw, assistantChars), {
        fallback: truncated,
        hardCap,
      }));
      continue;
    }

    if (role === "toolResult" || role === "tool") {
      const raw = texts.join("\n");
      if (!raw.trim()) continue;
      const errs = errorLines(raw);
      const first = raw.split("\n")[0] ?? "";
      const label = `[Tool ${e.id}] ${toolName}`;

      if (errs.length > 0) {
        const kept = errs.join("\n");
        // 报错行被截断 → 违反 fail-safe，整条透传（宁可这一条不省钱）
        if (kept.length > stderrChars) {
          lines.push(finalize(e.id, "toolResult", turn, label, raw, "", { fallback: true, toolName, hardCap }));
          continue;
        }
        const dropped = Math.max(0, raw.length - kept.length - first.length);
        const ph = dropped > 0
          ? "\n" + placeholder(e.id, `${toolName || "tool"} 输出`, raw.length, first, `已保留报错 ${errs.length} 行`)
          : "";
        const body = `❌\n首行: ${clip(first, toolChars)}\n报错原文:\n${kept}${ph}`;
        // 断言复核（kept 取自 raw，理论必过；留作回归防线）
        if (!assertErrorLinesKept(raw, body)) {
          lines.push(finalize(e.id, "toolResult", turn, label, raw, "", { fallback: true, toolName, hardCap }));
          continue;
        }
        lines.push(finalize(e.id, "toolResult", turn, label, raw, body, { toolName, droppedChars: dropped, hardCap }));
        continue;
      }

      // 成功输出：首行 + 长度 + 凭证（stdout 是体积大头、价值低）
      const dropped = Math.max(0, raw.length - first.length);
      const ph = dropped > 200
        ? "\n" + placeholder(e.id, `${toolName || "tool"} 输出`, raw.length, first, "成功，仅留首行")
        : "";
      lines.push(finalize(e.id, "toolResult", turn, label, raw, `✅ ${raw.length} 字\n首行: ${clip(first, toolChars)}${ph}`, {
        toolName,
        droppedChars: dropped,
        hardCap,
      }));
    }
  }
  return lines;
}

/**
 * 轮次对齐分批：绝不切开一轮；单轮超限就自成一批。
 * maxChars 是"压缩后字符数"上限（默认 12k，对应 §二 成批阈值之一）。
 */
export function batchByTurn(lines: ExtractLine[], maxChars = 12_000): ExtractLine[][] {
  const byTurn = new Map<number, ExtractLine[]>();
  for (const l of lines) {
    const arr = byTurn.get(l.turn);
    if (arr) arr.push(l);
    else byTurn.set(l.turn, [l]);
  }
  const turnsAsc = [...byTurn.keys()].sort((a, b) => a - b);

  const out: ExtractLine[][] = [];
  let cur: ExtractLine[] = [];
  let chars = 0;
  for (const t of turnsAsc) {
    const group = byTurn.get(t) ?? [];
    const gChars = group.reduce((n, l) => n + l.text.length, 0);
    if (cur.length > 0 && chars + gChars > maxChars) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(...group);
    chars += gChars;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 上一批的最后一轮（只读上下文，防止跨批的"方案 → 纠正"被切散） */
export function overlapTurn(prevBatch: ExtractLine[] | undefined): ExtractLine[] {
  if (!prevBatch || prevBatch.length === 0) return [];
  const last = prevBatch[prevBatch.length - 1].turn;
  return prevBatch.filter((l) => l.turn === last);
}

/** 压缩统计（进运行账本，用于验收 §七#8 的 compress_fallback 比例） */
export function compressStats(lines: ExtractLine[]): {
  lines: number;
  rawChars: number;
  keptChars: number;
  fallback: number;
  noGain: number;
  ratio: number;
} {
  const rawChars = lines.reduce((n, l) => n + l.rawChars, 0);
  const keptChars = lines.reduce((n, l) => n + l.text.length, 0);
  return {
    lines: lines.length,
    rawChars,
    keptChars,
    fallback: lines.filter((l) => l.fallback).length,
    noGain: lines.filter((l) => l.noGain).length,
    ratio: rawChars > 0 ? Math.round((keptChars / rawChars) * 1000) / 1000 : 0,
  };
}
