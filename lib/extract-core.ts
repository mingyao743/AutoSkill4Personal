/**
 * 抽取引擎核心：LLM 输出 → 解析 → 规范化 → 校验。
 * 离线 CLI 与在线 extension 共用；传输层（fetch 流式）在 lib/llm.ts。
 */
import { buildUserPrompt, type CatalogCategory } from "./prompt.ts";
import { serializeEntries } from "./serialize.ts";
import { chatComplete, extractJsonFromText } from "./llm.ts";
import { validateAtom } from "./validate.ts";
import { atomId, type AtomSource, type KnowledgeAtom } from "./atom-store.ts";
import type { MessageEntry, Window } from "./types.ts";

export interface ExtractOptions {
  systemPrompt: string; // buildSystemPrompt(loadCatalog()) 的产物
  model?: string; // 覆盖默认主模型
  extractedBy: string; // offline-pipeline / compaction-rescue / ...
  status?: string; // 入库状态，默认 draft；compaction 抢救直入 published
  confidenceFloor?: number; // 抢救场景下限 0.7
}

/** LLM 输出 → 原子数组（null = 解析失败） */
export function parseAtoms(text: string): Record<string, unknown>[] | null {
  const jsonStr = extractJsonFromText(text);
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr) as { atoms?: unknown };
    if (!Array.isArray(obj.atoms)) return null;
    return obj.atoms.filter((a) => typeof a === "object" && a !== null) as Record<string, unknown>[];
  } catch {
    return null;
  }
}

// 各 category 特化字段白名单（schema 全字段保留，只透传清单内的）
const PASS_FIELDS = new Set([
  "category", "atom_type", "content", "domain", "confidence", "grounding", "msg_range", "refs", "tags",
  // 01 业务认知
  "concept_name", "definition", "boundary", "rules",
  // 02 操作SOP
  "step", "step_order", "prerequisites", "inputs", "outputs", "checkpoints", "exceptions", "command",
  // 03 模板与骨架
  "template_name", "purpose", "skeleton", "fields",
  // 04 案例与样例
  "case_name", "background", "solution", "process", "result", "highlights", "limitations", "applicable_conditions",
  // 05 问题与复盘
  "problem", "scenario", "impact", "root_cause", "temp_fix", "permanent_fix", "improvements",
]);

/** 原始 LLM 输出 → 规范化原子（补默认值、校 msg_range、算 atom_id） */
export function normalizeAtom(
  raw: Record<string, unknown>,
  w: Pick<Window, "window_id" | "session_id" | "msg_range">,
  validIds: Set<string>,
  extractedBy: string,
): KnowledgeAtom {
  const rawRange = Array.isArray(raw.msg_range) ? (raw.msg_range as string[]) : [];
  const msgRange: [string, string] =
    rawRange.length === 2 && validIds.has(rawRange[0]) && validIds.has(rawRange[1])
      ? [rawRange[0], rawRange[1]]
      : w.msg_range; // LLM 给的 id 不在窗口内 → 回退整个窗口范围
  const sources: AtomSource[] = [{ session_id: w.session_id, window_id: w.window_id, msg_range: msgRange }];
  const content = String(raw.content ?? "").trim();
  const rawCategory = String(raw.category ?? "").match(/\d{2}/)?.[0] ?? ""; // 防御：剥掉模型可能附加的类名文字
  const atom: KnowledgeAtom = {
    atom_id: atomId(content, sources),
    category: rawCategory,
    atom_type: String(raw.atom_type ?? ""),
    content,
    domain: String(raw.domain ?? "").trim(),
    sources,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.6,
    version: 1,
    superseded_by: null,
    refs: [],
    status: "draft",
    extracted_at: new Date().toISOString(),
    extracted_by: extractedBy,
  };
  for (const [k, v] of Object.entries(raw)) {
    if (PASS_FIELDS.has(k) && v != null) atom[k] = v;
  }
  if (Array.isArray(raw.refs)) atom.refs = raw.refs as string[];
  // grounding 收敛到枚举：非法取值丢弃（校验器只约束存在的取值）
  if (!["G1", "G2", "G3", "G4"].includes(String(atom.grounding))) delete atom.grounding;
  return atom;
}

/**
 * 机械 G4 判定（EXTRACTION_PRINCIPLES §五）：msg_range 区间内既无 toolResult 又无 user 消息
 * → 纯生成型，无接地。多源时任一源有接地即非 G4；全部区间无法定位时不拒（保守放行交人工）。
 */
export function isMechanicalG4(atom: KnowledgeAtom, entries: MessageEntry[]): boolean {
  const idx = new Map(entries.map((e, i) => [e.id, i]));
  let determinable = false;
  for (const s of atom.sources ?? []) {
    const i0 = idx.get(s.msg_range[0]);
    const i1 = idx.get(s.msg_range[1]);
    if (i0 == null || i1 == null) continue; // 区间无法定位 → 本源不可判定
    determinable = true;
    const [lo, hi] = i0 <= i1 ? [i0, i1] : [i1, i0];
    for (let i = lo; i <= hi; i++) {
      const role = entries[i]?.message?.role;
      if (role === "toolResult" || role === "user") return false; // 有接地
    }
  }
  return determinable; // 至少一个可判定区间且全部无接地 → G4
}

export interface WindowExtractResult {
  window_id: string;
  ok: boolean;
  atoms: KnowledgeAtom[]; // 校验通过（未做幂等过滤）
  rejected: { atom: KnowledgeAtom; reason: string }[]; // 校验被拒
  error?: string; // 失败原因（LLM 失败 / JSON 解析失败）
  rawPreview?: string; // 失败时的原始返回（供 errors.log）
}

/** 单窗完整抽取：序列化 → LLM → 解析 → 规范化 → 校验。不写库、不去重（调用方决定） */
export async function extractWindow(
  w: Window,
  catalog: CatalogCategory[],
  opts: ExtractOptions,
): Promise<WindowExtractResult> {
  const windowText = serializeEntries(w.entries);
  const validIds = new Set(w.entries.map((e) => e.id));

  let text: string;
  try {
    const res = await chatComplete({
      system: opts.systemPrompt,
      user: buildUserPrompt(windowText),
      model: opts.model,
    });
    text = res.text;
  } catch (err) {
    return { window_id: w.window_id, ok: false, atoms: [], error: `LLM失败: ${String(err).slice(0, 300)}` };
  }

  const raws = parseAtoms(text);
  if (!raws) {
    return { window_id: w.window_id, ok: false, atoms: [], error: "JSON解析失败", rawPreview: text.slice(0, 500) };
  }

  const status = opts.status ?? "draft";
  const floor = opts.confidenceFloor ?? 0;
  const atoms: KnowledgeAtom[] = [];
  const rejected: { atom: KnowledgeAtom; reason: string }[] = [];
  for (const raw of raws) {
    const atom = normalizeAtom(raw, w, validIds, opts.extractedBy);
    if (floor > 0 && atom.confidence < floor) atom.confidence = floor;
    atom.status = status;
    // G4 双重拒：机械判定（区间无 toolResult 且无 user）或 LLM 自报 G4（EXTRACTION_PRINCIPLES §五）
    if (isMechanicalG4(atom, w.entries) || atom.grounding === "G4") {
      rejected.push({ atom, reason: "G4 纯生成默认不抽（EXTRACTION_PRINCIPLES §五：无接地拒入池）" });
      continue;
    }
    const v = validateAtom(atom, catalog);
    if (v.ok) atoms.push(atom);
    else rejected.push({ atom, reason: v.errors.join(";") });
  }
  return { window_id: w.window_id, ok: true, atoms, rejected };
}

/** 过滤掉已存在原子（幂等）；被拒原子已在 result.rejected 里 */
export function acceptedOnly(
  result: WindowExtractResult,
  knownAtomIds: Set<string>,
): KnowledgeAtom[] {
  const accepted: KnowledgeAtom[] = [];
  for (const a of result.atoms) {
    if (knownAtomIds.has(a.atom_id)) continue; // 幂等跳过（不算拒）
    accepted.push(a);
    knownAtomIds.add(a.atom_id);
  }
  return accepted;
}
