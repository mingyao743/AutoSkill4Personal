/**
 * 编译器执行：**进程内**调 `chatComplete`，不起子进程。
 *
 * 这是「复用各 agent 自己的模型」的落点（方案 §3.1）：
 *  - dsh：适配层注入 `ctx.llm` 桥 → `chatComplete` 走宿主凭据，凭据不离开宿主
 *  - pi ：`setModelRegistry` 注入 → 走 `models.json` 的当前路由
 *
 * **绝不能 spawn `dsh headless`**：新进程读不到会话的 `request/header`（那是每次会话的
 * 选择），也拿不到进程内的 `ctx.llm`。实测 `errors.log` 里「未找到可用 LLM 配置」
 * 全是这条路走出来的。
 */
import { writeFileSync } from "node:fs";
import { chatComplete } from "../base/llm.ts";
import { extractJsonFromText } from "../base/llm.ts";
import type { CompilePrompt } from "./prompt.ts";

export interface CompileRunOptions {
  prompt: CompilePrompt;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 覆盖模型（默认跟随注入的 registry / completer 的路由） */
  model?: string;
}

export interface RawPage {
  path: string;
  title: string;
  summary?: string;
  tags?: string[];
  body: string;
  publish_as?: string;
  base_confidence?: number;
  lifecycle?: string;
  sources?: string[];
}

export interface RawSkip {
  reason: string;
  detail?: string;
}

export interface CompileRunResult {
  pages: RawPage[];
  skipped: RawSkip[];
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  elapsedMs: number;
}

export const DEFAULT_MAX_TOKENS = 8_192;
export const DEFAULT_TIMEOUT_MS = 300_000;

/** 跑一次编译（唯一烧 token 的地方） */
export async function runCompile(opts: CompileRunOptions): Promise<CompileRunResult> {
  const t0 = Date.now();
  const res = await chatComplete({
    system: opts.prompt.system,
    user: opts.prompt.user,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    model: opts.model,
  });

  // 调试：把模型原始输出落盘（排查解析失败用，默认关闭）
  if (process.env.OW_DUMP_RAW) {
    try {
      writeFileSync(process.env.OW_DUMP_RAW, res.text, "utf8");
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }
  const parsed = parseCompileOutput(res.text);
  return {
    ...parsed,
    model: res.model,
    usage: res.usage,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 解析模型输出。三种容错：
 *  1. 纯 JSON
 *  2. ```json 围栏
 *  3. 前后有解释文字（取首个 { 到末个 }）
 */
export function parseCompileOutput(text: string): { pages: RawPage[]; skipped: RawSkip[] } {
  const json = extractJsonFromText(text) ?? text.trim();
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    // 一次修复尝试：模型把 markdown 正文塞进 JSON 字符串时，最常见的两种破坏是
    //   ① 正文里的 `"` 没转义 → 字符串提前结束
    //   ② 正文里的真实换行没写成 \n → JSON 不允许裸换行
    // 实测这两类占绝大多数（一次真实编译就撞上了①）。修不好才报错。
    const repaired = repairJson(json);
    if (repaired !== null) {
      obj = repaired;
    } else {
      throw new Error(
        `编译器输出不是合法 JSON：${String(e)}\n` +
          `原文长度 ${text.length} 字。JSON 非法位置附近：\n` +
          excerptAround(json, jsonErrorPosition(String(e))),
      );
    }
  }
  const o = obj as { pages?: unknown; skipped?: unknown };
  const pages = Array.isArray(o.pages) ? o.pages.map(normalizePage).filter((p): p is RawPage => p !== null) : [];
  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({ reason: String(s.reason ?? "unknown"), detail: s.detail ? String(s.detail) : undefined }))
    : [];
  return { pages, skipped };
}

const ALLOWED_PREFIX = ["concepts/", "entities/", "skills/", "references/", "synthesis/", "journal/"];

function normalizePage(raw: unknown): RawPage | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const path = typeof p.path === "string" ? p.path.trim().replace(/^\/+/, "") : "";
  const body = typeof p.body === "string" ? p.body : "";
  if (!path || !body.trim()) return null;
  // 路径必须落在允许的目录里，防止模型写出 `../` 或写到 vault 根
  if (!ALLOWED_PREFIX.some((pre) => path.startsWith(pre))) return null;
  if (path.includes("..")) return null;
  if (!path.endsWith(".md")) return null;

  const title = typeof p.title === "string" && p.title.trim()
    ? p.title.trim()
    : path.replace(/\.md$/, "").split("/").pop() ?? path;

  return {
    path,
    title,
    summary: typeof p.summary === "string" ? p.summary : "",
    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
    body,
    publish_as: typeof p.publish_as === "string" ? p.publish_as : "document",
    base_confidence: typeof p.base_confidence === "number" ? p.base_confidence : undefined,
    lifecycle: typeof p.lifecycle === "string" ? p.lifecycle : undefined,
    sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
  };
}

/** 从 JSON.parse 的错误消息里取位置（V8：`at position 2120`） */
function jsonErrorPosition(msg: string): number {
  const m = msg.match(/at position (\d+)/);
  return m ? Number(m[1]) : -1;
}

/** 取错误位置前后一段，便于人眼看模型到底写坏了什么 */
function excerptAround(text: string, pos: number, radius = 160): string {
  if (pos < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, pos - radius);
  const to = Math.min(text.length, pos + radius);
  const line = text.slice(0, pos).split("\n").length;
  return `…（第 ${line} 行附近）\n${text.slice(from, to)}\n${" ".repeat(Math.min(radius, pos - from))}^`;
}

/**
 * 尽力修复模型写坏的 JSON。
 *
 * 只做两件确定性的事，不猜语义：
 *  1. 字符串内部未转义的裸换行 → `\\n`
 *  2. 字符串内部未转义的双引号 → `\\"`
 *
 * 判定「字符串内部」用状态机扫一遍：跟踪是否在字符串里、上一个字符是否转义。
 * 第 2 条有歧义（分不清是结束引号还是正文里的引号），所以只在
 * 「引号后面既不是 `:`/`,`/`}`/`]`/空白，也不是行尾」时当作正文引号转义。
 */
export function repairJson(text: string): unknown | null {
  let out = "";
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }

    // 在字符串内部
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // 裸换行：JSON 字符串里非法
      out += ch === "\n" ? "\\n" : "\\r";
      continue;
    }
    if (ch === '"') {
      // 判断这是结束引号还是正文里的引号
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      const next = text[j];
      const endsHere = next === undefined || next === ":" || next === "," || next === "}" || next === "]" || next === "\n" || next === "\r";
      if (endsHere) {
        out += ch;
        inStr = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
