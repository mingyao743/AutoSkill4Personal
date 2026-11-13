/**
 * 手动触发：解析 `小q` / `qdoc` 唤醒词与意图。
 *
 * 规则（方案 §6.2）——**判定从严，拿不准就不触发**：
 *  1. 唤醒词必须在句首，或独立成词（前后是空白/标点）
 *  2. 唤醒词后面必须跟动词，或什么都不跟（`小q` 单独一句 = 播报状态）
 *  3. 后面跟名词 → **不是命令**（`小q 这个功能怎么做` 是普通提问）
 *
 * 为什么这么严：误触发会白烧 token 或改坏文件；漏触发只是用户再打一次。
 * 这个不对称决定了必须从严。
 */
export type Intent =
  | "status"     // 小q            → 播报状态
  | "capture"    // 小q 沉淀       → 立刻编译当前会话
  | "publish"    // 小q 发布       → 把待发布页推到平台
  | "query"      // 小q 查 xxx     → 在线检索
  | "review"     // 小q 确认       → 处理待确认队列
  | "sync"       // 小q 同步       → 技能双向同步
  | "maintain"   // 小q 整理       → 重建索引/hot
  | "unknown";   // 唤醒了但没听懂

export interface ParseResult {
  /** 是否是命令（false = 普通对话，适配器应完全忽略） */
  isCommand: boolean;
  intent: Intent;
  /** 意图后面的参数（如查询词） */
  args: string;
  /** 命中的唤醒词原文 */
  wake?: string;
  /** 判定原因，进日志便于调参 */
  reason: string;
}

const WAKE_WORDS = ["小q", "小Q", "qdoc", "QDoc", "QDOC"];

/** 动词 → 意图。顺序有意义：长词优先（「发布技能」要在「发布」之前） */
const VERB_MAP: Array<{ verbs: string[]; intent: Intent }> = [
  { verbs: ["沉淀", "记一下", "记录", "编译"], intent: "capture" },
  { verbs: ["发布", "推送", "上传"], intent: "publish" },
  { verbs: ["查询", "查", "搜", "找", "检索"], intent: "query" },
  { verbs: ["确认", "审阅", "review", "待办"], intent: "review" },
  { verbs: ["同步", "更新技能", "拉技能"], intent: "sync" },
  { verbs: ["整理", "重建", "维护"], intent: "maintain" },
  { verbs: ["状态", "情况", "怎么样"], intent: "status" },
];

/** 句首位置：字符串开头，或前面是标点/空白/引号 */
const SENTENCE_START = /(?:^|[。！？；\n\r]|\s)\s*$/;

/**
 * 解析一条用户消息。
 *
 * @param text 用户输入原文
 */
export function parseWakeWord(text: string): ParseResult {
  const raw = text ?? "";
  if (!raw.trim()) return { isCommand: false, intent: "unknown", args: "", reason: "empty" };

  for (const wake of WAKE_WORDS) {
    const idx = raw.indexOf(wake);
    if (idx < 0) continue;

    // 规则 1：必须句首
    const before = raw.slice(0, idx);
    if (!SENTENCE_START.test(before)) continue;

    // 唤醒词后面紧跟字母/数字/汉字 → 是词的一部分（如 `qdocx`），不是唤醒
    const after = raw.slice(idx + wake.length);
    if (/^[A-Za-z0-9_]/.test(after)) continue;

    const trimmed = after.replace(/^[\s，,：:。.!！?？]+/, "");

    // 规则 2：后面什么都没跟 → 播报状态
    if (!trimmed) {
      return { isCommand: true, intent: "status", args: "", wake, reason: "bare-wake" };
    }

    // 规则 3：后面必须跟动词
    for (const { verbs, intent } of VERB_MAP) {
      for (const verb of verbs) {
        if (!trimmed.startsWith(verb)) continue;
        // 动词后面紧跟汉字 → 可能是更长词的一部分（「查询」vs「查一下」都行，
        // 但「查找」是「查」+「找」，仍算 query，所以不额外拦）
        const rest = trimmed.slice(verb.length).replace(/^[\s，,：:]+/, "");
        return { isCommand: true, intent, args: rest, wake, reason: `verb:${verb}` };
      }
    }

    // 唤醒了但没跟动词：看是不是名词短语 → 不是命令
    // 例：`小q 这个功能怎么做` / `qdoc 是什么`
    return {
      isCommand: false,
      intent: "unknown",
      args: trimmed,
      wake,
      reason: "wake-followed-by-noun",
    };
  }

  return { isCommand: false, intent: "unknown", args: "", reason: "no-wake" };
}

/** 意图 → 一句话说明（播报与帮助用） */
export const INTENT_HELP: Record<Intent, string> = {
  status: "小q —— 播报知识库状态",
  capture: "小q 沉淀 —— 立刻编译当前会话",
  publish: "小q 发布 —— 把待发布页推到 qdoc.chat",
  query: "小q 查 <关键词> —— 在线检索已发布文档",
  review: "小q 确认 —— 处理待确认队列",
  sync: "小q 同步 —— 技能双向同步",
  maintain: "小q 整理 —— 重建索引与热缓存",
  unknown: "（未识别）",
};

/** 帮助文本（用户问「小q 能干什么」时播报） */
export function helpText(): string {
  return [
    "可用命令（唤醒词 `小q` 或 `qdoc`，必须在句首）：",
    ...Object.values(INTENT_HELP).filter((s) => !s.startsWith("（")),
    "",
    "唤醒词后面跟名词不算命令（如「小q 这个功能怎么做」是普通提问）。",
  ].join("\n");
}
