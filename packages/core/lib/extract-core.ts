/**
 * 抽取辅助：旧规范化 helper（normalizeAtom）+ 机械 G4 判定（isMechanicalG4）。
 *
 * 历史曾是"抽取引擎核心"（含 extractWindow 整窗引擎），旧引擎去掉后只剩这两个
 * 被复用的纯函数：normalizeAtom 供 smoke-extract-principles 测类型推导；
 * isMechanicalG4 被 one-stage 主线（pipeline.ts 准入闸）+ smoke 复用。
 */
import { atomId, type AtomSource, type KnowledgeAtom } from "./atom-store.ts";
import { categoryForType, defaultAtomType, isDocType, isKeepAs, keepAsForType } from "./admission.ts";
import type { MessageEntry, Window } from "./types.ts";

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

/** 原始 LLM 输出 → 规范化知识卡片（补默认值、校 msg_range、算 atom_id） */
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
  // 类型化准入：doc_type 合法 → 分类/去向查表推导，模型不参与
  const rawDocType = raw.doc_type != null ? String(raw.doc_type) : undefined;
  const docType = isDocType(rawDocType) ? rawDocType : undefined;
  const atom: KnowledgeAtom = {
    atom_id: atomId(content, sources),
    category: docType ? categoryForType(docType) : rawCategory,
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
  // 分诊字段最后写，避免被 PASS_FIELDS 透传的原始值覆盖（category 也在 PASS_FIELDS 里）
  if (rawDocType != null) atom.doc_type = rawDocType;
  if (docType) {
    atom.category = categoryForType(docType);
    // case 是唯一允许在 reference / data 之间选的类型（工件 vs 参考）
    atom.keep_as = docType === "case" && raw.keep_as === "data" ? "data" : keepAsForType(docType);
    if (!atom.atom_type) atom.atom_type = defaultAtomType(docType);
  } else if (isKeepAs(raw.keep_as)) {
    atom.keep_as = raw.keep_as;
  }
  const why = typeof raw.why === "string" ? raw.why.trim() : "";
  if (why) atom.why = why;
  atom.expires_when = typeof raw.expires_when === "string" && raw.expires_when.trim() ? raw.expires_when.trim() : null;
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
