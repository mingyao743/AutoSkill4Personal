/**
 * 消息映射：OpenCode `ctx.session.context()` → core 归一事件流（设计文档 §3.3）。
 *
 * 目标形状与 adapter-pi 的 withSeq 完全一致（indexTurns 按 pi 语义数轮次）：
 *   events  = [{ type: "message", seq, time?, message: { role } }]
 *   entries = [{ type: "message", id, parentId: null, timestamp, message: { role, content }, seq }]
 *
 * 归一规则（设计文档 §3.3）：
 *  - user 消息 → 开一轮（沿用 pi 的 user 消息语义，indexTurns 自动路由）
 *  - assistant 消息保留文本 + 工具调用摘要（[工具: name] 行）
 *  - system / 其他 role 不产事件也不产 entry
 *  - seq = 消息在 transcript 里的序号（单调即可，窗口与水位只要求单调）
 *
 * 兼容两种消息形态：扁平 {role, parts} 与 V1 包装 {info, parts}。
 * 本模块纯计算：不 import OpenCode 类型运行时、不碰 fs、不碰 core 有副作用的部分。
 */
import type { MessageEntry } from "../../packages/core/lib/base/types.ts";
import type { OcMessage } from "./types.ts";

export interface MappedSession {
  events: Array<{ type: string; seq: number; time?: number; message: { role: string }; id?: string }>;
  entries: Array<MessageEntry & { seq: number }>;
}

/** role 兼容读取：扁平或 info 包装 */
function roleOf(m: OcMessage): string | undefined {
  return (typeof m.role === "string" && m.role) || (typeof m.info?.role === "string" && m.info.role) || undefined;
}

function idOf(m: OcMessage, fallback: string): string {
  if (typeof m.id === "string" && m.id) return m.id;
  if (typeof m.info?.id === "string" && m.info.id) return m.info.id;
  return fallback;
}

/** 时间戳：兼容秒/毫秒 epoch 与缺失（缺失回退当前时间，仅影响空闲判定精度） */
function timestampOf(m: OcMessage): { iso: string; ms?: number } {
  const raw = typeof m.time === "number"
    ? m.time
    : typeof m.time === "object" && m.time
    ? m.time.created
    : typeof m.info?.time === "object" && m.info.time
    ? m.info.time.created
    : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { iso: new Date().toISOString() };
  }
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return { iso: new Date(ms).toISOString(), ms };
}

/** 文本：parts 里的 text 块拼接；assistant 的 tool part 折叠成 [工具: name] 摘要 */
function textOf(m: OcMessage, role: string): string {
  const chunks: string[] = [];
  const tools: string[] = [];
  for (const p of m.parts ?? []) {
    const type = typeof p?.type === "string" ? p.type : "";
    if (type === "text" && typeof p.text === "string" && p.text.trim()) {
      chunks.push(p.text);
      continue;
    }
    if (role === "assistant" && (type === "tool" || type === "tool-call" || type === "tool_use")) {
      const name = p.name ?? p.tool ?? p.toolName ?? p.state?.tool ?? p.state?.name;
      if (typeof name === "string" && name) tools.push(name);
    }
  }
  if (chunks.length === 0 && typeof m.text === "string" && m.text.trim()) chunks.push(m.text);
  const text = chunks.join("\n").trim();
  if (tools.length > 0) {
    // 工具摘要独立成行，去重后截断（窗口里只用作信号与上下文，不参与编译产物）
    const uniq = [...new Set(tools)].slice(0, 8);
    const line = `[工具: ${uniq.join("、")}]`;
    return text ? `${text}\n${line}` : line;
  }
  return text;
}

/**
 * OpenCode transcript → 归一事件流。
 *
 * @param messages `ctx.session.context({ sessionID })` 的返回（只读）
 */
export function mapSessionMessages(messages: readonly OcMessage[] | undefined | null): MappedSession {
  const events: MappedSession["events"] = [];
  const entries: MappedSession["entries"] = [];
  if (!Array.isArray(messages)) return { events, entries };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const role = roleOf(m);
    if (role !== "user" && role !== "assistant") continue; // system/其他不进流水线

    const { iso, ms } = timestampOf(m);
    const text = textOf(m, role);
    const entry: MessageEntry & { seq: number } = {
      type: "message",
      id: idOf(m, `oc-${i}`),
      parentId: null,
      timestamp: iso,
      seq: i,
      message: { role, content: text },
    };
    entries.push(entry);
    events.push({ type: "message", seq: i, ...(ms != null ? { time: ms } : {}), message: { role }, id: entry.id });
  }
  return { events, entries };
}
