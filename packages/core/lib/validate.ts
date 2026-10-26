/**
 * 原子校验（三道关）：镜像 design/atom.schema.json 的约束子集 + SLICE_CATALOG 枚举。
 * 手写实现而非 ajv：免依赖，覆盖 schema 实际用到的全部校验点。
 */
import type { CatalogCategory } from "./prompt.ts";
import type { KnowledgeAtom } from "./atom-store.ts";

const ATOM_ID_RE = /^atom_[a-f0-9]{12}$/;
const WINDOW_ID_RE = /^win_[a-f0-9]+_\d+$/;
const CATEGORIES = ["01", "02", "03", "04", "05"];
const STATUSES = ["draft", "reviewed", "published", "deprecated"];
const EXTRACTED_BY = [
  "llm-haiku", "llm-flash", "llm-gemini-flash",
  "agent-tool", "offline-pipeline", "compaction-rescue",
];

/** 各 category 分支的 required 特化字段（schema allOf/then） */
const BRANCH_REQUIRED: Record<string, string[]> = {
  "01": ["concept_name", "definition"],
  "02": ["step"],
  "03": ["template_name", "skeleton"],
  "04": ["case_name", "solution", "result"],
  "05": ["problem", "root_cause"],
};

const GROUNDING_LEVELS = ["G1", "G2", "G3", "G4"];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateAtom(
  atom: KnowledgeAtom,
  catalog: CatalogCategory[],
  validMsgIds?: Set<string>
): ValidationResult {
  const errors: string[] = [];
  const e = (m: string) => errors.push(m);

  // ---- 基础字段 ----
  if (!ATOM_ID_RE.test(atom.atom_id ?? "")) e("atom_id 格式非法");
  if (!CATEGORIES.includes(atom.category)) e(`category 非法: ${atom.category}`);
  if (typeof atom.atom_type !== "string" || atom.atom_type.length < 2) e("atom_type 过短");
  if (typeof atom.content !== "string" || atom.content.length < 1) e("content 为空");
  if (typeof atom.domain !== "string" || atom.domain.length < 2) e("domain 过短");
  if (typeof atom.confidence !== "number" || atom.confidence < 0 || atom.confidence > 1)
    e(`confidence 非法: ${atom.confidence}`);
  if (typeof atom.version !== "number" || atom.version < 1) e("version 非法");
  if (!STATUSES.includes(atom.status)) e(`status 非法: ${atom.status}`);
  if (!EXTRACTED_BY.includes(atom.extracted_by)) e(`extracted_by 非法: ${atom.extracted_by}`);
  if (typeof atom.extracted_at !== "string" || Number.isNaN(Date.parse(atom.extracted_at)))
    e("extracted_at 非法");

  // ---- sources 必填 + 结构 ----
  if (!Array.isArray(atom.sources) || atom.sources.length < 1) {
    e("sources 为空（无 source 拒绝入库）");
  } else {
    for (const s of atom.sources) {
      if (!s.session_id || !WINDOW_ID_RE.test(s.window_id ?? ""))
        e(`window_id 格式非法: ${s.window_id}`);
      if (!Array.isArray(s.msg_range) || s.msg_range.length !== 2)
        e("msg_range 必须是 [startId, endId]");
      if (validMsgIds) {
        for (const id of s.msg_range ?? []) {
          if (!validMsgIds.has(id)) e(`msg_range 含窗口外消息 id: ${id}`);
        }
      }
    }
  }

  // ---- catalog 枚举（含 category↔切片匹配）----
  const cat = catalog.find((c) => c.category === atom.category);
  if (cat) {
    if (!cat.slices.some((s) => s.atom_type === atom.atom_type)) {
      e(`atom_type "${atom.atom_type}" 不在 ${atom.category} 类切片清单（幻觉切片或跨类错配）`);
    }
  } else {
    e(`category 无对应 catalog: ${atom.category}`);
  }

  // ---- category 分支 required 特化字段 ----
  for (const f of BRANCH_REQUIRED[atom.category] ?? []) {
    const v = (atom as Record<string, unknown>)[f];
    if (v == null || (typeof v === "string" && v.trim() === "")) e(`特化字段缺失: ${f}`);
  }

  // ---- grounding 分级（EXTRACTION_PRINCIPLES §五，可选但取值受枚举约束） ----
  const g = (atom as Record<string, unknown>).grounding;
  if (g != null && !GROUNDING_LEVELS.includes(String(g)))
    e(`grounding 非法: ${g}（只允许 G1/G2/G3/G4）`);

  // ---- 敏感信息粗筛 ----
  if (typeof atom.content === "string" && /sk-[A-Za-z0-9]{20,}/.test(atom.content))
    e("content 疑似含 API key");

  return { ok: errors.length === 0, errors };
}
