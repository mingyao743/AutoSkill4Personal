/**
 * 知识抽取：把触发扫描的候选写成知识卡片。
 *
 * 与"整窗抽取"的区别：
 *  - 整窗抽取 = 整窗 → 知识卡片（不知道哪里重要）
 *  - 知识抽取 = 候选锚点 → 知识卡片（触发扫描已经指出哪里重要，这里只负责写准）
 *
 * 三条硬规则（来自 93 条候选的实测）：
 *  1. doc_type 重新判，不沿用触发扫描的 kind（实测 kind 互串严重）
 *  2. 凭据/一次性进度/寒暄 → 丢弃或合并，不独立成知识卡片
 *  3. **区间扩展**：以候选锚点为终点，向前找同轮最近的 user 消息或工具结果作为证据起点。
 *     否则 70% 锚在 assistant 消息上的候选会被机械 G4 判定全部拒掉。
 */
import { chatComplete, extractJsonFromText } from "./llm.ts";
import {
  admissionGate, categoryForType, defaultAtomType, isDocType, keepAsForType,
} from "./admission.ts";
import { validateAtom } from "./validate.ts";
import { atomId, type AtomSource, type KnowledgeAtom } from "./atom-store.ts";
import { isMechanicalG4 } from "./extract-core.ts";
import { serializeEntries } from "./serialize.ts";
import type { MessageEntry } from "./types.ts";
import type { ScanCandidate } from "./trigger-scan.ts";

export interface CardExtractOptions {
  sessionId: string;
  /** 完整会话 entries（用于区间扩展与机械 G4 判定） */
  entries: MessageEntry[];
  candidates: ScanCandidate[];
  /** 主题提示；模型也可自拟 */
  domainHint?: string;
  /** 已有主题清单：给了就必须从里面选，防止主题被拆碎 */
  domainOptions?: string[];
  model?: string;
  /** 每次调用处理多少候选（默认 12） */
  batchSize?: number;
  /** 每条候选的上下文上限（默认 1200 字符） */
  maxContextChars?: number;
  /** 已有 atom_id，用于幂等过滤 */
  knownAtomIds?: Set<string>;
  signal?: AbortSignal;
  onBatch?: (info: { index: number; total: number; atoms: number; dropped: number; tokensIn: number; tokensOut: number; ms: number }) => void;
}

export interface CardExtractDrop {
  anchor: string;
  reason: string;
}

export interface CardExtractResult {
  atoms: KnowledgeAtom[];
  dropped: CardExtractDrop[];
  rejected: { content: string; reason: string }[];
  batches: number;
  tokensIn: number;
  tokensOut: number;
  stopped?: string;
}

/**
 * 区间扩展：以锚点为终点，向前找最近的 user / toolResult 作为证据起点。
 * 找不到就退回 [anchor, anchor]——机械 G4 会拒掉它，这是正确行为。
 */
export function expandRange(
  entries: MessageEntry[],
  anchorId: string,
  lookback = 6,
): [string, string] | null {
  const idx = entries.findIndex((e) => e.id === anchorId);
  if (idx < 0) return null;
  if (entries[idx].message?.role === "user") return [anchorId, anchorId];
  const floor = Math.max(0, idx - lookback);
  for (let i = idx - 1; i >= floor; i--) {
    const role = entries[i].message?.role;
    if (role === "user" || role === "toolResult") return [entries[i].id, anchorId];
  }
  return [anchorId, anchorId];
}

/** 候选上下文：证据起点 → 锚点，截断到预算 */
export function buildCandidateContext(
  entries: MessageEntry[],
  range: [string, string],
  maxChars: number,
): string {
  const i0 = entries.findIndex((e) => e.id === range[0]);
  const i1 = entries.findIndex((e) => e.id === range[1]);
  if (i0 < 0 || i1 < 0) return "";
  const text = serializeEntries(entries.slice(i0, i1 + 1));
  return text.length <= maxChars ? text : text.slice(0, maxChars) + `\n…(截断，原文 ${text.length} 字符)`;
}

export function extractSystemPrompt(domainHint?: string, domainOptions?: string[]): string {
  return `你是知识抽取器（知识抽取的第二段：把片段写成知识卡片）。输入是触发扫描从一条 coding agent 会话里挑出的候选：每条带锚点消息、扫描提示类型、扫描理由，以及"证据 → 锚点"的上下文。
把这些候选写成可复用的知识卡片；**同一主题的多条候选合并成一张卡片**。

## 类型（doc_type 唯一合法枚举）
- sop：操作流程（按顺序的动作，含前置/失败分支）。必填 step
- spec：口径/契约/规则/术语。必填 concept_name、definition，且必须写出排除了哪种理解
- template：可填空的模板/骨架。必填 template_name、skeleton
- case：完整成品、真实数据、客户资料（脱敏）。必填 case_name、solution
- postmortem：现象→根因→处置。必填 problem、root_cause
- convention：环境约定（路径/版本/命名/雷区）。必填 concept_name、definition、**expires_when**
- index：东西在哪（文件位置/入口/ID 映射）。必填 concept_name、definition、**expires_when**
- rubric：判据/评分标准。必填 concept_name、definition

## 硬规则
1. **不要沿用扫描阶段的 kind**，自己重新判 doc_type。
2. why 必填（≥8 字）：写"不存会损失什么"的具体后果，禁止"有价值/重要"。
3. **丢弃**：API key/密码/手机号/邮箱/证件号；一次性的进度状态（"已完成""配置好了"）；寒暄与确认；纯日志流水。
4. **合并**：同一主题的多条候选（例如一条可用性矩阵 + 两条补测结果）合并成一张卡片，content 写成结论。
5. content 去语境化，脱离本对话也能看懂；保留关键命令、路径、版本号。
   若上下文含「…(截断)」，**不要照抄省略号、不要臆造缺失内容**，用"其余待复核"收尾。
6. 有时效的结论必须写 expires_when（如"模型可用性随后端变化"）。
7. grounding：G1 执行验证 / G2 工具观测 / G3 文档依据 / G4 纯生成。**G4 不要输出**（会被拒）。
8. domain：${domainOptions?.length
    ? `**必须从下列已有主题中选一个，不要自拟**：${domainOptions.join(" / ")}`
    : `kebab-case 英文；不确定就用 ${domainHint ?? "general"}`}。
9. 只输出 JSON：{"atoms":[{"anchor":"候选锚点id","doc_type":"...","content":"...","why":"...","domain":"...","confidence":0.8,"grounding":"G2","expires_when":null,"step":"..."}],"dropped":[{"anchor":"...","reason":"..."}]}
   结构化字段按 doc_type 填。**被合并或丢弃的候选只放 dropped，不要输出 content 为空的知识卡片。**
   没有可写的就输出 {"atoms":[],"dropped":[...]}。不要 markdown、不要解释。`;
}

export function buildExtractUserPrompt(blocks: string): string {
  return `${blocks}\n\n请写成知识卡片，只输出 JSON。`;
}

interface RawAtom {
  anchor?: unknown;
  doc_type?: unknown;
  content?: unknown;
  why?: unknown;
  domain?: unknown;
  confidence?: unknown;
  grounding?: unknown;
  expires_when?: unknown;
  [k: string]: unknown;
}

export function parseExtractOutput(
  text: string,
  validAnchors: Set<string>,
): { atoms: RawAtom[]; dropped: CardExtractDrop[] } {
  const json = extractJsonFromText(text);
  if (!json) return { atoms: [], dropped: [] };
  let parsed: { atoms?: unknown; dropped?: unknown };
  try {
    parsed = JSON.parse(json) as { atoms?: unknown; dropped?: unknown };
  } catch {
    return { atoms: [], dropped: [] };
  }
  // 模型有时用"空 content 知识卡片"标记"这条已合并"——不要当成知识卡片，转成丢弃记录
  const rawAtoms = Array.isArray(parsed.atoms) ? parsed.atoms : [];
  const atoms: RawAtom[] = [];
  const emptyDropped: CardExtractDrop[] = [];
  for (const a of rawAtoms) {
    if (!a || typeof a !== "object") continue;
    const anchor = String((a as RawAtom).anchor ?? "");
    if (!validAnchors.has(anchor)) continue;
    if (String((a as RawAtom).content ?? "").trim().length < 8) {
      emptyDropped.push({ anchor, reason: "空内容（模型标记的合并/丢弃项）" });
      continue;
    }
    atoms.push(a as RawAtom);
  }
  const dropped = (Array.isArray(parsed.dropped) ? parsed.dropped : [])
    .filter((d): d is { anchor: string; reason: string } => !!d && typeof d === "object" && typeof (d as { anchor?: unknown }).anchor === "string")
    .map((d) => ({ anchor: d.anchor, reason: String(d.reason ?? "").slice(0, 120) }));
  return { atoms, dropped: [...dropped, ...emptyDropped] };
}

/** 候选 → 知识卡片（含准入规则、校验、幂等） */
export function toAtom(
  raw: RawAtom,
  range: [string, string],
  sessionId: string,
  seq: number,
  domainHint?: string,
): KnowledgeAtom | { error: string } {
  const docType = String(raw.doc_type ?? "");
  if (!isDocType(docType)) return { error: `doc_type 非法: ${docType}` };
  const content = String(raw.content ?? "").trim();
  const source: AtomSource = {
    session_id: sessionId,
    window_id: `sig_${sessionId.replace(/^session-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}_${String(seq).padStart(3, "0")}`,
    msg_range: range,
  };
  const atom: KnowledgeAtom = {
    atom_id: atomId(content, [source]),
    category: categoryForType(docType),
    atom_type: String(raw.atom_type ?? "") || defaultAtomType(docType),
    content,
    domain: String(raw.domain ?? "").trim() || domainHint || "general",
    sources: [source],
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.75,
    version: 1,
    superseded_by: null,
    refs: [],
    status: "draft",
    extracted_at: new Date().toISOString(),
    extracted_by: "signal-distill",
    doc_type: docType,
    keep_as: keepAsForType(docType),
    why: String(raw.why ?? "").trim(),
    expires_when: typeof raw.expires_when === "string" && raw.expires_when.trim() ? raw.expires_when.trim() : null,
    origin: "signal",
  };
  // 结构化字段透传（只接受字符串/数字/数组/布尔，防止模型塞嵌套垃圾）
  for (const [k, v] of Object.entries(raw)) {
    if (["anchor", "doc_type", "content", "why", "domain", "confidence", "grounding", "expires_when", "atom_type"].includes(k)) continue;
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") atom[k] = v;
    else if (Array.isArray(v)) atom[k] = v.filter((x) => typeof x === "string" || typeof x === "number");
  }
  if (["G1", "G2", "G3", "G4"].includes(String(raw.grounding))) atom.grounding = String(raw.grounding);
  return atom;
}

export async function extractCandidates(opts: CardExtractOptions): Promise<CardExtractResult> {
  const batchSize = opts.batchSize ?? 12;
  const maxContextChars = opts.maxContextChars ?? 1200;
  const known = opts.knownAtomIds ?? new Set<string>();
  const atoms: KnowledgeAtom[] = [];
  const dropped: CardExtractDrop[] = [];
  const rejected: { content: string; reason: string }[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let stopped: string | undefined;
  let seq = 0;

  // 先做区间扩展；锚点定位不到的候选直接记为丢弃
  const prepared = opts.candidates.map((c) => {
    const range = expandRange(opts.entries, c.msg_id);
    return { candidate: c, range };
  }).filter((p) => {
    if (!p.range) { dropped.push({ anchor: p.candidate.msg_id, reason: "锚点不在会话里" }); return false; }
    return true;
  });

  const batches = Math.ceil(prepared.length / batchSize);
  for (let i = 0; i < prepared.length; i += batchSize) {
    if (opts.signal?.aborted) { stopped = "aborted"; break; }
    const chunk = prepared.slice(i, i + batchSize);
    const validAnchors = new Set(chunk.map((p) => p.candidate.msg_id));
    const blocks = chunk.map((p, j) => {
      const ctx = buildCandidateContext(opts.entries, p.range!, maxContextChars);
      return `### 候选 ${j + 1}\n锚点: ${p.candidate.msg_id}\n扫描提示: ${p.candidate.kind}｜${p.candidate.reason}\n上下文:\n${ctx}`;
    }).join("\n\n");

    const t0 = Date.now();
    try {
      const res = await chatComplete({
        system: extractSystemPrompt(opts.domainHint, opts.domainOptions),
        user: buildExtractUserPrompt(blocks),
        model: opts.model,
        signal: opts.signal,
      });
      const parsed = parseExtractOutput(res.text, validAnchors);
      tokensIn += res.usage?.promptTokens ?? 0;
      tokensOut += res.usage?.completionTokens ?? 0;

      for (const raw of parsed.atoms) {
        const anchor = String(raw.anchor);
        const range = chunk.find((p) => p.candidate.msg_id === anchor)?.range;
        if (!range) continue;
        const built = toAtom(raw, range, opts.sessionId, seq + 1, opts.domainHint);
        if ("error" in built) { rejected.push({ content: String(raw.content ?? "").slice(0, 80), reason: built.error }); continue; }
        if (known.has(built.atom_id)) continue; // 幂等
        const gate = admissionGate(built, {
          requireWhy: true,
          hasGrounding: !isMechanicalG4(built, opts.entries),
        });
        if (!gate.ok) { rejected.push({ content: built.content.slice(0, 80), reason: gate.reasons.join(";") }); continue; }
        const v = validateAtom(built, []);
        if (!v.ok) { rejected.push({ content: built.content.slice(0, 80), reason: v.errors.join(";") }); continue; }
        seq++;
        known.add(built.atom_id);
        atoms.push(built);
      }
      dropped.push(...parsed.dropped);

      opts.onBatch?.({
        index: Math.floor(i / batchSize) + 1,
        total: batches,
        atoms: parsed.atoms.length,
        dropped: parsed.dropped.length,
        tokensIn: res.usage?.promptTokens ?? 0,
        tokensOut: res.usage?.completionTokens ?? 0,
        ms: Date.now() - t0,
      });
    } catch (e) {
      stopped = `batch ${Math.floor(i / batchSize) + 1} failed: ${String(e).slice(0, 120)}`;
      break;
    }
  }

  return { atoms, dropped, rejected, batches, tokensIn, tokensOut, stopped };
}
