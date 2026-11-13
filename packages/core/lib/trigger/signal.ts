/**
 * 留存信号门：判断一个窗口值不值得烧 token 编译。
 *
 * 目的不是判断「有没有知识」，而是**剔掉明显不值得的窗口**——纯问答、纯检索、
 * 纯闲聊，编译出来也是噪声页。真正的价值判断留给编译器。
 *
 * 规则（方案 §5.4 第 4 条）：≥1 条用户诉求 + ≥1 个工具/决策动作。
 */
import type { WindowPayload } from "./window.ts";

export interface SignalResult {
  keep: boolean;
  /** 判定原因，进 metrics.jsonl 供调参 */
  reason: string;
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    /** 用户消息的总字符数（太短说明只是「继续」「好」这类应答） */
    userChars: number;
  };
}

/** 用户消息短于这个长度且无工具动作 → 视为闲聊应答 */
const MIN_USER_CHARS = 20;

/** 决策/改动类动词：出现在工具名或文本里算「有动作」 */
const ACTION_HINTS = [
  "bash", "edit", "write", "apply", "patch", "create", "delete", "move",
  "git", "npm", "pnpm", "node", "python", "curl", "test", "build", "install",
];

export function evaluateSignal(w: WindowPayload): SignalResult {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let userChars = 0;

  for (const m of w.messages) {
    if (m.role === "user") {
      userMessages += 1;
      userChars += m.text.length;
    } else if (m.role === "assistant") {
      assistantMessages += 1;
    } else if (m.role === "tool") {
      toolCalls += 1;
    }
  }

  const stats = { userMessages, assistantMessages, toolCalls, userChars };

  if (userMessages === 0) {
    return { keep: false, reason: "no-user-message", stats };
  }
  if (assistantMessages === 0) {
    return { keep: false, reason: "no-assistant-output", stats };
  }
  // 有工具动作就算有信号（哪怕用户只说了「跑一下测试」）
  if (toolCalls > 0) {
    return { keep: true, reason: "has-tool-actions", stats };
  }
  // 没有工具动作：要求用户消息有实质内容
  if (userChars < MIN_USER_CHARS) {
    return { keep: false, reason: "short-chatter", stats };
  }
  // 再确认不是纯检索式提问（这类问题答案在文档里，不必沉淀）
  if (looksLikePureLookup(w)) {
    return { keep: false, reason: "pure-lookup", stats };
  }
  return { keep: true, reason: "substantive-discussion", stats };
}

/**
 * 纯检索判定：整窗没有一个动作词，且用户消息里出现「查一下/列一下/是什么」这类。
 * 保守实现——只在**明确**是检索时才判 false，避免误杀。
 */
function looksLikePureLookup(w: WindowPayload): boolean {
  const haystack = w.messages
    .map((m) => (m.role === "tool" ? (m.name ?? "") : m.text))
    .join("\n")
    .toLowerCase();
  if (ACTION_HINTS.some((h) => haystack.includes(h))) return false;
  return /查一下|查查|列一下|有哪些|是什么|怎么用|在哪里|搜一下/.test(haystack);
}
