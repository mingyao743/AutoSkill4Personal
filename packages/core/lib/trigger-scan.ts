/**
 * 抽取触发机制：把"未覆盖"的消息压缩序列化后交给 LLM 过目，产出候选（不产卡片）。
 *
 * 设计要点（见 design/TRIGGER_PLAN.md）：
 *  - 正则不参与"是否送审"——压缩而不是筛选，每条消息都有代表
 *  - 助手消息首尾各 500 字；工具结果只留首行；工具参数只留前 80 字
 *  - 按字符分批（默认 12k），不按条数
 *  - 输出只含 msg_id + kind + reason，按 msg_id 去重
 *  - 预算超限就停，调用方把剩余消息留到下次（不停在半截还标已覆盖）
 */
import { chatComplete, extractJsonFromText, type ChatUsage } from "./llm.ts";
import type { MessageEntry } from "./types.ts";

export const SCAN_KINDS = ["correction", "decision", "verified", "artifact", "domain", "other"] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

const KIND_PRIORITY: Record<ScanKind, number> = {
  correction: 6,
  decision: 5,
  artifact: 4,
  domain: 3,
  verified: 2,
  other: 1,
};

export interface ScanLine {
  id: string;
  role: string;
  text: string;
}

export interface ScanCandidate {
  msg_id: string;
  kind: ScanKind;
  reason: string;
}

export interface ScanOptions {
  model?: string;
  /** 每批字符上限（默认 12000） */
  batchChars?: number;
  /** 总 token 预算；超了停止并返回 stopped="budget" */
  budgetTokens?: number;
  /** 最多跑几批（校准/试跑用） */
  maxBatches?: number;
  signal?: AbortSignal;
  onBatch?: (info: {
    index: number;
    total: number;
    chars: number;
    candidates: number;
    usage?: ChatUsage;
    ms: number;
  }) => void;
}

export interface ScanReport {
  candidates: ScanCandidate[];
  batches: number;
  reviewedMessages: number;
  serializedChars: number;
  tokensIn: number;
  tokensOut: number;
  stopped?: string;
}

export interface ScanSerializeOptions {
  /** 助手消息首尾各多少字（默认 500） */
  assistantChars?: number;
  /** 用户消息上限（默认 2000，实测用户只占全文 0.4%，基本不截断） */
  userChars?: number;
  /** 工具结果首行上限（默认 200） */
  toolChars?: number;
  /** 工具调用参数上限（默认 80） */
  argsChars?: number;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));
const headTail = (s: string, n: number): string =>
  s.length <= n * 2 ? s : s.slice(0, n) + "\n…(中略)…\n" + s.slice(-n);

/** 消息内容 → 文本（text 块 + 工具调用的极简摘要，thinking 不参与） */
function blocksToText(content: MessageEntry["message"]["content"], argsChars: number): string {
  if (typeof content === "string") return content;
  const out: string[] = [];
  for (const b of (content ?? []) as Array<Record<string, unknown>>) {
    if (b.type === "text") out.push(String(b.text ?? ""));
    // pi 形状 toolCall + 对象 arguments；dsh 形状 tool-call + JSON 字符串 arguments（漏认会整条丢命令）
    else if (b.type === "toolCall" || b.type === "tool-call" || b.type === "tool_call") {
      const a = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {});
      out.push(`[tool ${String(b.name ?? "")}] ${clip(a, argsChars)}`);
    }
    // thinking / image 等一律跳过
  }
  return out.join("\n");
}

/** 逐条序列化：每条消息一行（带真实 id），供分批 */
export function serializeForScan(entries: MessageEntry[], opts: ScanSerializeOptions = {}): ScanLine[] {
  const assistantChars = opts.assistantChars ?? 500;
  const userChars = opts.userChars ?? 2000;
  const toolChars = opts.toolChars ?? 200;
  const argsChars = opts.argsChars ?? 80;

  const lines: ScanLine[] = [];
  for (const e of entries) {
    const role = e.message?.role ?? "";
    const raw = blocksToText(e.message?.content, argsChars);
    if (!raw.trim()) continue;
    if (role === "user") {
      lines.push({ id: e.id, role, text: `[User ${e.id}]\n${clip(raw, userChars)}` });
    } else if (role === "assistant") {
      lines.push({ id: e.id, role, text: `[Assistant ${e.id}]\n${headTail(raw, assistantChars)}` });
    } else if (role === "toolResult" || role === "tool") {
      const first = raw.split("\n")[0] ?? "";
      const name = String((e.message as { toolName?: string }).toolName ?? "");
      lines.push({ id: e.id, role: "toolResult", text: `[Tool ${e.id}] ${name}\n${clip(first, toolChars)}` });
    }
  }
  return lines;
}

/** 按字符分批（单行不会超过上限：各类消息都已截断） */
export function batchLines(lines: ScanLine[], maxChars = 12_000): ScanLine[][] {
  const out: ScanLine[][] = [];
  let cur: ScanLine[] = [];
  let chars = 0;
  for (const l of lines) {
    if (cur.length > 0 && chars + l.text.length > maxChars) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(l);
    chars += l.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function scanSystemPrompt(): string {
  return `你是触发扫描器（知识抽取的第一段：只负责发现候选，不负责写成知识卡片）。输入是一段 coding agent 会话（已压缩：用户消息全文、助手消息首尾各 500 字、工具结果首行、工具参数前 80 字；每条消息带真实 msg id）。

任务：找出所有**值得长期留存**的知识信号，供后续知识抽取成卡片。
宁可多标，但每条必须给出具体理由；纯寒暄、纯确认、纯环境检查不标。

kind 只能取这六个：
- correction：人纠正/推翻模型或方案
- decision：做了取舍（含被否路径）
- verified：被工具结果/复测验证的事实
- artifact：人给的模板、资料、需求、文件
- domain：人的领域知识、口径、术语定义
- other：以上之外但值得留存

规则：
1. msg_id 必须是输入里真实出现的 id，不得编造。
2. 一条消息可标多个 kind 时，选最主要的那个。
3. reason ≤30 字，写"为什么值得留"，不要复述内容。
4. 只输出 JSON：{"candidates":[{"msg_id":"...","kind":"...","reason":"..."}]}；没有信号输出 {"candidates":[]}。不要 markdown、不要解释。`;
}

export function buildScanUserPrompt(batchText: string): string {
  return `${batchText}\n\n请标出信号，只输出 JSON。`;
}

/** 解析单批输出；只保留本批真实存在的 msg_id（防幻觉 id） */
export function parseScanOutput(text: string, validIds: Set<string>): ScanCandidate[] {
  const json = extractJsonFromText(text);
  if (!json) return [];
  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(json) as { candidates?: unknown };
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const out: ScanCandidate[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { msg_id?: unknown; kind?: unknown; reason?: unknown };
    const id = typeof c.msg_id === "string" ? c.msg_id : "";
    if (!validIds.has(id)) continue;
    const kind = (SCAN_KINDS as readonly string[]).includes(String(c.kind))
      ? (c.kind as ScanKind)
      : "other";
    out.push({ msg_id: id, kind, reason: clip(String(c.reason ?? ""), 80) });
  }
  return out;
}

/** 同一 msg_id 多条时按 kind 优先级合并；理由合并但限长 */
export function mergeCandidates(list: ScanCandidate[]): ScanCandidate[] {
  const map = new Map<string, ScanCandidate>();
  for (const c of list) {
    const prev = map.get(c.msg_id);
    if (!prev) {
      map.set(c.msg_id, { ...c });
      continue;
    }
    if (KIND_PRIORITY[c.kind] > KIND_PRIORITY[prev.kind]) {
      map.set(c.msg_id, { ...c, reason: c.reason || prev.reason });
    } else if (c.reason && !prev.reason.includes(c.reason)) {
      prev.reason = clip(`${prev.reason}；${c.reason}`, 120);
    }
  }
  return [...map.values()];
}

/** 单批发现：输入一批已序列化的消息，输出候选（供管线按批推进） */
export async function scanBatch(
  lines: ScanLine[],
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ candidates: ScanCandidate[]; usage?: ChatUsage; ms: number }> {
  const text = lines.map((l) => l.text).join("\n\n");
  const ids = new Set(lines.map((l) => l.id));
  const t0 = Date.now();
  const res = await chatComplete({
    system: scanSystemPrompt(),
    user: buildScanUserPrompt(text),
    model: opts.model,
    signal: opts.signal,
  });
  return { candidates: parseScanOutput(res.text, ids), usage: res.usage, ms: Date.now() - t0 };
}

export async function runScan(entries: MessageEntry[], opts: ScanOptions = {}): Promise<ScanReport> {
  const batchChars = opts.batchChars ?? 12_000;
  const lines = serializeForScan(entries);
  const allBatches = batchLines(lines, batchChars);
  const batches = opts.maxBatches ? allBatches.slice(0, opts.maxBatches) : allBatches;
  const raw: ScanCandidate[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let stopped: string | undefined;

  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) {
      stopped = "aborted";
      break;
    }
    if (opts.budgetTokens && tokensIn + tokensOut >= opts.budgetTokens) {
      stopped = "budget";
      break;
    }
    const batch = batches[i];
    const batchText = batch.map((l) => l.text).join("\n\n");
    try {
      const got = await scanBatch(batch, { model: opts.model, signal: opts.signal });
      raw.push(...got.candidates);
      tokensIn += got.usage?.promptTokens ?? 0;
      tokensOut += got.usage?.completionTokens ?? 0;
      opts.onBatch?.({
        index: i + 1,
        total: batches.length,
        chars: batchText.length,
        candidates: got.candidates.length,
        usage: got.usage,
        ms: got.ms,
      });
    } catch (e) {
      stopped = `batch ${i + 1} failed: ${String(e).slice(0, 120)}`;
      break;
    }
  }

  return {
    candidates: mergeCandidates(raw),
    batches: batches.length,
    reviewedMessages: lines.length,
    serializedChars: lines.reduce((n, l) => n + l.text.length, 0),
    tokensIn,
    tokensOut,
    stopped,
  };
}
