/**
 * 窗口切分：user msg 对齐，窗口间不重叠。
 * 默认 50 条/窗：当前抽取主要由 compaction 抢救触发（待压缩区一次性进来，全靠默认值），
 * 小窗让单次 LLM 调用的知识密度可控、失败重试成本低；条数与字符预算减半对齐。
 * 纯函数、纯内存——在线(extension)与离线(CLI)共用同一份逻辑。
 */
import type { MessageEntry, SessionEntry, Window } from "./types.ts";

export interface WindowOptions {
  maxEntries?: number; // 每窗最大消息条数（默认 50）
  maxChars?: number;   // 每窗序列化后字符预算（默认 40000，与条数上限对齐）
}

const isUserMsg = (e: SessionEntry): e is MessageEntry =>
  e.type === "message" && e.message?.role === "user";

/** 从 session.jsonl 原始行流解析出消息 entries */
export function parseSession(lines: string[]): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: SessionEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // 损坏行静默跳过
    }
    if (e.type === "message" && e.id && e.message) out.push(e as MessageEntry);
  }
  return out;
}

/**
 * user msg 对齐切窗：
 * 1. 从第一个 user msg 开始；
 * 2. 累积至 maxEntries 或序列化字符预算超限；
 * 3. 关窗时边界落到下一个 user msg（保证事件完整，下一个窗口以 user 开头）。
 */
export function buildWindows(
  entries: MessageEntry[],
  sessionId: string,
  opts: WindowOptions = {}
): Window[] {
  const maxEntries = opts.maxEntries ?? 50;
  const maxChars = opts.maxChars ?? 40_000;

  // 跳过首个 user msg 之前的内容
  let start = entries.findIndex(isUserMsg);
  if (start < 0) return [];

  const windows: Window[] = [];
  const shortId = sessionId.replace(/-/g, "").slice(0, 8);

  let i = start;
  let seq = 1;
  while (i < entries.length) {
    const windowStart = i;
    let count = 0;
    let chars = 0;
    while (i < entries.length && count < maxEntries && chars < maxChars) {
      chars += estimateChars(entries[i]);
      count++;
      i++;
    }
    // 关窗边界落在下一个 user msg：把后续非 user 消息并入本窗（补完当前事件）
    while (i < entries.length && !isUserMsg(entries[i])) {
      i++;
    }
    const windowEntries = entries.slice(windowStart, i);
    if (windowEntries.length === 0) break;
    windows.push({
      window_id: `win_${shortId}_${String(seq).padStart(3, "0")}`,
      session_id: sessionId,
      msg_range: [windowEntries[0].id, windowEntries[windowEntries.length - 1].id],
      entry_count: windowEntries.length,
      entries: windowEntries,
    });
    seq++;
  }
  return windows;
}

/** 序列化字符量的粗估（与 serialize.ts 的截断规则一致） */
function estimateChars(e: MessageEntry): number {
  const msg = e.message;
  if (msg.role === "toolResult") return TOOL_RESULT_TRUNC + 64;
  if (typeof msg.content === "string") return msg.content.length + 64;
  let n = 64;
  for (const b of msg.content ?? []) {
    if (b.type === "text") n += (b as TextBlock2).text.length;
    else if (b.type === "toolCall") n += JSON.stringify((b as ToolCallBlock2).arguments).length + 128;
    // thinking 块不计入（序列化时丢弃）
  }
  return n;
}

type TextBlock2 = { type: "text"; text: string };
type ToolCallBlock2 = { type: "toolCall"; arguments: Record<string, unknown> };

/** 工具结果截断长度，serialize.ts 与此处共用 */
export const TOOL_RESULT_TRUNC = 1500;
