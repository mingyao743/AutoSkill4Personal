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
  const raw: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      raw.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      continue; // 损坏行静默跳过
    }
  }

  // dsh 的 tool/result 事件本身不带工具名，要从同 callId 的 tool/call 取
  const toolNames = new Map<string, string>();
  for (const e of raw) {
    if (e.type !== "tool/call") continue;
    const d = e.data as Record<string, unknown> | undefined;
    const id = d?.callId ?? (d?.message as Record<string, unknown> | undefined)?.toolCallId;
    if (typeof id === "string" && typeof d?.name === "string") toolNames.set(id, d.name);
  }

  const out: MessageEntry[] = [];
  const seenIds = new Set<string>();
  for (const e of raw) {
    const se = e as unknown as SessionEntry;
    let entry: MessageEntry | null = null;
    if (se.type === "message" && se.id && se.message) entry = se as MessageEntry;
    // dsh v4 会话形状归一（user/message + assistant/message + tool/result → 统一 MessageEntry）
    else entry = normalizeDshEntry(e, toolNames);
    // id 必须唯一：覆盖水位、批次索引、msg_range 全靠它查表，撞了会静默串账
    if (entry && !seenIds.has(entry.id)) {
      seenIds.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** dsh 宿主会话事件 → pi MessageEntry 归一（user/message + assistant/message + tool/result 三事件形状）。
 *  dsh v4 会话实测形状：{type, seq, time, data:{role, content:[{type,text}], id}}；
 *  user/message 的 data 直接含 content；assistant/message 与 tool/result 的 data.message 含 content。
 *
 *  tool/result 必须收：它是命令行执行结果与报错原文的唯一来源（P1 卡片逐字接地全靠它）。
 *  漏收的后果实测过：288 条 entries 只序列化出 118 行、命令行与报错各 0 条，
 *  sop / postmortem 类型整场没机会出现（见 design/REVIEW_ONE_STAGE_2026-11-12.md 顶部警告）。 */
function normalizeDshEntry(e: Record<string, unknown>, toolNames: Map<string, string>): MessageEntry | null {
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const isUser = e.type === "user/message";
  const isAssistant = e.type === "assistant/message";
  const isToolResult = e.type === "tool/result";
  if (!isUser && !isAssistant && !isToolResult) return null;
  const msg = (isUser ? data : data.message) as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return null;
  const time = typeof e.time === "number" ? new Date(e.time).toISOString() : void 0;

  if (isToolResult) {
    // dsh 原始 role 是 "tool"，统一成 pi 的 "toolResult"（下游序列化两种都认，但管线过滤只认后者）
    const callId = String(msg?.toolCallId ?? data.callId ?? "");
    return {
      type: "message",
      id: callId || `dsh-${e.seq}`,
      parentId: null,
      timestamp: time ?? new Date().toISOString(),
      message: {
        role: "toolResult", content, toolCallId: callId,
        toolName: toolNames.get(callId) ?? "", timestamp: e.time,
      } as MessageEntry["message"],
    };
  }

  const role = msg?.role;
  if (role !== "user" && role !== "assistant") return null;
  return {
    type: "message",
    id: (msg.id as string) ?? `dsh-${e.seq}`,
    parentId: null,
    timestamp: time ?? new Date().toISOString(),
    message: { role, content, timestamp: e.time } as MessageEntry["message"],
  };
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
  // 短 session id：8 位十六进制。必须剥掉 dsh 的 "session-" 前缀，
  // 否则 "session-<uuid>" 去连字符后前 8 位恒为 "session9" → 所有会话窗口 id 撞车。
  const shortId = sessionId
    .replace(/^session-/, "")
    .replace(/-/g, "")
    .slice(0, 8)
    .toLowerCase();

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
    else if (b.type === "toolCall" || b.type === "tool-call" || b.type === "tool_call") {
      // dsh 的 arguments 是 JSON 字符串、pi 是对象；两种都按序列化后长度估
      const a = (b as ToolCallBlock2).arguments;
      n += (typeof a === "string" ? a.length : JSON.stringify(a ?? {}).length) + 128;
    }
    // thinking 块不计入（序列化时丢弃）
  }
  return n;
}

type TextBlock2 = { type: "text"; text: string };
type ToolCallBlock2 = { type: string; arguments: Record<string, unknown> | string };

/** 工具结果截断长度，serialize.ts 与此处共用 */
export const TOOL_RESULT_TRUNC = 1500;
