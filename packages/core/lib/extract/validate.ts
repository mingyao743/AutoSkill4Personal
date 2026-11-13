/**
 * 知识卡片校验：schema 约束子集 + 类型化准入（doc_type）+ SLICE_CATALOG 枚举（仅旧知识卡片）。
 *
 * 两条路径：
 *  新知识卡片（带 doc_type）：分类由类型查表推出、必填字段按类型给、强制 why；
 *                        atom_type 降级为自由细标签，不再对齐 44 切片（实测该枚举已失效）
 *  旧知识卡片（无 doc_type）：沿用原逻辑（category+atom_type 必须命中 catalog）
 */
import type { CatalogCategory } from "./prompt.ts";
import type { KnowledgeAtom } from "../base/atom-store.ts";
import {
  DOC_TYPE_SPEC,
  isDocType,
  isKeepAs,
  keepAsForType,
  requiresExpiry,
  checkSensitive,
} from "../base/admission.ts";

const ATOM_ID_RE = /^atom_[a-f0-9]{12}$/;
/** 抽取窗口 win_*，或 agent 声明来源 decl_*（两者不互相污染） */
const WINDOW_ID_RE = /^(win_[a-f0-9]+_\d+|decl_[a-z0-9]+_\d+|sig_[a-z0-9]+_\d+)$/;
const CATEGORIES = ["01", "02", "03", "04", "05"];
const STATUSES = ["draft", "reviewed", "published", "deprecated"];
const EXTRACTED_BY = [
  "llm-haiku", "llm-flash", "llm-gemini-flash",
  "agent-tool", "agent-tool-dsh", "offline-pipeline", "compaction-rescue", "signal-distill",
];

/** 旧知识卡片（无 doc_type）按 category 分支的 required 特化字段 */
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

export interface ValidateOptions {
  /**
   * 是否强制类型特化字段（`DOC_TYPE_SPEC[doc_type].required`）。默认 **true**。
   *
   * **抽取路径传 false**（2026-11-12 决议）：查了下游，除 `assemble.ts` 读 `skeleton`
   * （且带真值判断）外**没有任何代码消费这些字段**——强制一个没人消费的契约，代价是
   * 实测一轮拒掉 6 张真实卡片、另一轮 26% 的卡片走降级。prompt 里继续要求（软约束），
   * 缺了由 `fillMissingSpecialized()` 记进 `pending_fields` 供事后观测/回填。
   * 回填、人工录入等其他入口一律不传，保持严格。
   */
  requireSpecialized?: boolean;
}

export function validateAtom(
  atom: KnowledgeAtom,
  catalog: CatalogCategory[],
  validMsgIds?: Set<string>,
  opts: ValidateOptions = {}
): ValidationResult {
  const errors: string[] = [];
  const e = (m: string) => errors.push(m);
  const hasType = isDocType(atom.doc_type);

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

  // ---- 类型化准入（新知识卡片） ----
  if (atom.doc_type != null) {
    if (!hasType) {
      e(`doc_type 非法: ${atom.doc_type}（只允许 8 类型）`);
    } else {
      if (atom.category !== DOC_TYPE_SPEC[atom.doc_type].category)
        e(`category 与 doc_type 不匹配: ${atom.doc_type} 应为 ${DOC_TYPE_SPEC[atom.doc_type].category}`);
      if (opts.requireSpecialized !== false) {
        for (const f of DOC_TYPE_SPEC[atom.doc_type].required) {
          const v = (atom as Record<string, unknown>)[f];
          if (v == null || (typeof v === "string" && v.trim() === "")) e(`特化字段缺失: ${f}`);
        }
      }
      // 价值理由：准入规则之外的兜底（防止绕过准入规则直接写库）
      if (typeof atom.why !== "string" || atom.why.trim().length < 8)
        e("缺价值理由 why（≥8 字，写明不存会损失什么）");
      // 易腐型必须写失效条件
      if (requiresExpiry(atom.doc_type) && !String(atom.expires_when ?? "").trim())
        e(`doc_type=${atom.doc_type} 必须写 expires_when（失效条件）`);
    }
  } else {
    // ---- 旧知识卡片：catalog 枚举（含 category↔切片匹配）----
    const cat = catalog.find((c) => c.category === atom.category);
    if (cat) {
      if (!cat.slices.some((s) => s.atom_type === atom.atom_type)) {
        e(`atom_type "${atom.atom_type}" 不在 ${atom.category} 类切片清单（幻觉切片或跨类错配）`);
      }
    } else {
      e(`category 无对应 catalog: ${atom.category}`);
    }
  }

  // ---- 去向字段 ----
  if (atom.keep_as != null) {
    if (!isKeepAs(atom.keep_as)) e(`keep_as 非法: ${atom.keep_as}`);
    else if (hasType && atom.keep_as !== keepAsForType(atom.doc_type)) {
      // 唯一允许的例外：case 可以在 reference / data 之间选（工件 vs 参考）
      const allowed = atom.doc_type === "case" && (atom.keep_as === "data" || atom.keep_as === "reference");
      if (!allowed)
        e(`keep_as 与 doc_type 不符: ${atom.doc_type} 默认 ${keepAsForType(atom.doc_type)}，实为 ${atom.keep_as}`);
    }
  }

  // ---- 旧逻辑保留：旧知识卡片仍校验 category 分支 required ----
  if (!hasType) {
    for (const f of BRANCH_REQUIRED[atom.category] ?? []) {
      const v = (atom as Record<string, unknown>)[f];
      if (v == null || (typeof v === "string" && v.trim() === "")) e(`特化字段缺失: ${f}`);
    }
  }

  // ---- grounding 分级（可选但取值受枚举约束） ----
  const g = (atom as Record<string, unknown>).grounding;
  if (g != null && !GROUNDING_LEVELS.includes(String(g)))
    e(`grounding 非法: ${g}（只允许 G1/G2/G3/G4）`);

  // ---- 敏感信息 ----
  for (const r of checkSensitive(atom.content ?? "", { pii: atom.keep_as === "data" || atom.doc_type === "case" })) e(r);

  return { ok: errors.length === 0, errors };
}
