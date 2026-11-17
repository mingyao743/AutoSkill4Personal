/**
 * 窗口切分：把「N 个已完成轮次」切成一份可交给编译器的 window.json。
 *
 * `extract/window.ts` 的 `parseSession` 负责会话行流 → MessageEntry[] 归一，
 * 这个是**按轮次**切（30 轮），且带哈希与来源信息，落盘给编译器。
 *
 * 预算规则（方案 §4）：
 *  - 工具结果截断 2k 字符（命令行输出原文常常几万行，不截会撑爆预算）
 *  - assistant 只留文本块（丢 thinking）
 *  - 总长上限 120k 字符；超出时按「用户消息 + 结论段」抽
 */
import { createHash } from "node:crypto";
import type { MessageEntry } from "../base/types.ts";
import type { Turn } from "./turns.ts";

export const MAX_WINDOW_CHARS = 120_000;
export const TOOL_RESULT_MAX_CHARS = 2_000;

/** 落盘的窗口（编译器的唯一输入） */
export interface WindowPayload {
  schema: 1;
  agent: "dsh" | "pi";
  session_id: string;
  cwd: string;
  from_seq: number;
  to_seq: number;
  from_turn: number;
  to_turn: number;
  turns: number;
  started_at?: string;
  ended_at?: string;
  hash: string;
  messages: WindowMessage[];
}

export interface WindowMessage {
  seq: number;
  role: "user" | "assistant" | "tool";
  name?: string;
  text: string;
  /** 被截断时记原长度，供报告与调试 */
  truncated?: number;
}

export interface BuildWindowOptions {
  agent: "dsh" | "pi";
  sessionId: string;
  cwd: string;
  /** 整段会话的消息（已归一成 MessageEntry，带 seq） */
  entries: Array<MessageEntry & { seq: number }>;
  /** 本窗的轮次切片 */
  turns: Turn[];
  maxChars?: number;
}

/**
 * 切窗口。
 *
 * 只收 `from_seq..to_seq` 范围内的消息；超出字符预算时按优先级抽：
 * 先保全部用户消息，再保每轮的最后一个 assistant 文本（结论段），最后才保工具结果。
 */
export function buildWindowPayload(opts: BuildWindowOptions): WindowPayload {
  const { agent, sessionId, cwd, entries, turns } = opts;
  const maxChars = opts.maxChars ?? MAX_WINDOW_CHARS;
  if (turns.length === 0) throw new Error("buildWindowPayload: 轮次切片为空");

  const fromSeq = turns[0].fromSeq;
  const toSeq = turns[turns.length - 1].toSeq;
  const inRange = entries.filter((e) => e.seq >= fromSeq && e.seq <= toSeq);

  const all = inRange.map(toWindowMessage).filter((m): m is WindowMessage => m !== null);
  // 先按优先级选材，再把选中的内容压进硬预算。
  // 旧实现只做第一步：用户消息全保，实测 30 轮窗口能到 245k 字符（上限 120k）。
  const trimmed = fitBudget(applyBudget(all, maxChars), maxChars);

  const payload: WindowPayload = {
    schema: 1,
    agent,
    session_id: sessionId,
    cwd,
    from_seq: fromSeq,
    to_seq: toSeq,
    from_turn: turns[0].index,
    to_turn: turns[turns.length - 1].index,
    turns: turns.length,
    started_at: turns[0].endedAt,
    ended_at: turns[turns.length - 1].endedAt,
    hash: "",
    messages: trimmed,
  };
  payload.hash = hashWindow(payload);
  return payload;
}

/** MessageEntry → WindowMessage（工具结果截断；assistant 只留 text 块） */
function toWindowMessage(e: MessageEntry & { seq: number }): WindowMessage | null {
  const role = e.message?.role;
  const content = e.message?.content;
  const text = blocksToText(content);
  if (!text.trim()) return null;

  if (role === "user") return { seq: e.seq, role: "user", text };
  if (role === "assistant") return { seq: e.seq, role: "assistant", text };
  if (role === "toolResult" || role === "tool") {
    const name = (e.message?.toolName as string | undefined) ?? undefined;
    if (text.length > TOOL_RESULT_MAX_CHARS) {
      return {
        seq: e.seq,
        role: "tool",
        name,
        text: text.slice(0, TOOL_RESULT_MAX_CHARS),
        truncated: text.length,
      };
    }
    return { seq: e.seq, role: "tool", name, text };
  }
  return null;
}

/** 内容块 → 纯文本（thinking 类块直接丢） */
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    // thinking / reasoning / toolCall 块一律不收（toolCall 的参数在 toolResult 里有对应）
  }
  return parts.join("\n");
}

/**
 * 预算裁剪：先保用户消息，再保每轮末尾的 assistant（结论），最后按原序补工具结果。
 * 返回仍按 seq 升序，保证编译器读到的顺序与真实对话一致。
 */
function applyBudget(msgs: WindowMessage[], maxChars: number): WindowMessage[] {
  const total = msgs.reduce((n, m) => n + m.text.length, 0);
  if (total <= maxChars) return msgs;

  const keep = new Set<number>(); // seq
  let used = 0;

  // 1. 用户消息全保
  for (const m of msgs) {
    if (m.role !== "user") continue;
    keep.add(m.seq);
    used += m.text.length;
  }

  // 2. 每轮的最后一个 assistant 文本（结论段）
  let lastAssistantSeq: number | null = null;
  for (const m of msgs) {
    if (m.role === "assistant") lastAssistantSeq = m.seq;
    else if (m.role === "user" && lastAssistantSeq != null) {
      const hit = msgs.find((x) => x.seq === lastAssistantSeq);
      if (hit && !keep.has(hit.seq)) {
        keep.add(hit.seq);
        used += hit.text.length;
      }
      lastAssistantSeq = null;
    }
  }
  if (lastAssistantSeq != null) {
    const hit = msgs.find((x) => x.seq === lastAssistantSeq);
    if (hit && !keep.has(hit.seq)) {
      keep.add(hit.seq);
      used += hit.text.length;
    }
  }

  // 3. 剩余预算按原序补工具结果与中间 assistant
  for (const m of msgs) {
    if (keep.has(m.seq)) continue;
    if (used + m.text.length > maxChars) continue;
    keep.add(m.seq);
    used += m.text.length;
  }

  return msgs.filter((m) => keep.has(m.seq));
}

/** 每条消息至少保留这么多字符，避免比例裁剪把短结论削没 */
const MIN_KEEP_CHARS = 300;

/**
 * 硬预算：保证所有消息文本总长 ≤ maxChars。
 *
 * 为什么不能只靠 applyBudget：它优先保用户消息，用户消息本身就可能超过上限。
 * 这里对每条消息做**比例裁剪**（至少留 MIN_KEEP_CHARS），并记录原长度。
 * 消息太多、连最小保留都放不下时，退化为平均分配。
 */
export function fitBudget(msgs: WindowMessage[], maxChars: number): WindowMessage[] {
  const total = msgs.reduce((n, m) => n + m.text.length, 0);
  if (total <= maxChars) return msgs;

  const fixed = MIN_KEEP_CHARS * msgs.length;
  if (fixed >= maxChars) {
    const per = Math.max(50, Math.floor(maxChars / Math.max(1, msgs.length)) - 1);
    return msgs.map((m) => m.text.length <= per ? m : {
      ...m, text: m.text.slice(0, per), truncated: m.text.length,
    });
  }

  const extraBudget = maxChars - fixed;
  const extraTotal = total - fixed;
  const ratio = extraTotal <= 0 ? 0 : extraBudget / extraTotal;
  let used = 0;
  return msgs.map((m, i) => {
    const keep = Math.max(
      MIN_KEEP_CHARS,
      MIN_KEEP_CHARS + Math.floor((m.text.length - MIN_KEEP_CHARS) * ratio),
    );
    // 最后一条把剩余预算兜住，避免 floor 误差累计超限
    const room = maxChars - used;
    const limit = i === msgs.length - 1 ? Math.max(0, room) : Math.min(keep, Math.max(0, room));
    used += Math.min(m.text.length, Math.max(0, limit));
    if (m.text.length <= limit) return m;
    return { ...m, text: m.text.slice(0, Math.max(0, limit)), truncated: m.text.length };
  });
}

/** 稳定哈希：只取影响编译结果的字段（时间戳不进哈希，否则同一窗口两次哈希不同） */
export function hashWindow(w: WindowPayload): string {
  const canon = JSON.stringify({
    agent: w.agent,
    session_id: w.session_id,
    cwd: w.cwd,
    from_seq: w.from_seq,
    to_seq: w.to_seq,
    from_turn: w.from_turn,
    to_turn: w.to_turn,
    messages: w.messages.map((m) => [m.seq, m.role, m.name ?? "", m.text]),
  });
  return `sha256:${createHash("sha256").update(canon).digest("hex")}`;
}

/** 窗口 → 给 LLM 的纯文本（编译器 prompt 用） */
export function renderWindowText(w: WindowPayload): string {
  const lines: string[] = [];
  for (const m of w.messages) {
    const who = m.role === "tool" ? `tool:${m.name ?? "?"}` : m.role;
    lines.push(`### [${m.seq}] ${who}`);
    lines.push(m.text);
    if (m.truncated) lines.push(`（原文 ${m.truncated} 字符，已截断）`);
    lines.push("");
  }
  return lines.join("\n");
}
