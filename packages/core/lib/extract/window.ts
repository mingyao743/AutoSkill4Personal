/**
 * 会话解析：从 session.jsonl 原始行流解析出 MessageEntry[]。
 *
 * 在线(extension)与离线(CLI/capture)共用——dsh 的 v4 事件形状在此归一成 pi 的 MessageEntry。
 * 旧的 50 条消息窗切分（buildWindows）随 atoms 抽取管线一起删除了。
 */
import type { MessageEntry, SessionEntry } from "../base/types.ts";

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
