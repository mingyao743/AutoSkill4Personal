/**
 * 消息序列化：AgentMessage 流 → LLM 可读文本。
 * 与 pi 的 serializeConversation 同风格：[User 6598d960]: ... / [Tool result]: ...
 * - 每条消息带真实 id（LLM 用它在 msg_range 里溯源）
 * - thinking 块丢弃（会话噪音）
 * - 工具结果截断 1500 字符（控成本）
 */
import type { MessageEntry } from "./types.ts";
import { TOOL_RESULT_TRUNC } from "./window.ts";

export function serializeEntries(entries: MessageEntry[]): string {
  return entries.map(serializeEntry).join("\n\n");
}

function serializeEntry(e: MessageEntry): string {
  const msg = e.message;
  const id = e.id;
  if (msg.role === "toolResult") {
    const text = joinText(msg.content);
    return `[Tool result ${id}] (${msg.toolName ?? "tool"}):\n${truncate(text, TOOL_RESULT_TRUNC)}`;
  }
  if (msg.role === "assistant") {
    const parts: string[] = [];
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else {
      for (const b of content ?? []) {
        if (b.type === "text") parts.push((b as { text: string }).text);
        else if (b.type === "toolCall") {
          const tc = b as { name: string; arguments: unknown };
          parts.push(`[Tool call] ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
        // thinking 丢弃
      }
    }
    return `[Assistant ${id}]:\n${parts.join("\n")}`;
  }
  // user / 其他
  const text = joinText(msg.content);
  return `[${cap(msg.role)} ${id}]:\n${truncate(text, 4000)}`;
}

function joinText(content: string | unknown[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n) + `\n…(截断，原文 ${s.length} 字符)`;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
