/**
 * 技能编译的确定性部分（就绪门 + 选材器 + 短效判定 + 编译简报）。
 *
 * 依据 design/SKILL_COMPILER.md §三 新流水线：① 就绪门、② 选材、③ 编译（外包给
 * create-skill，需要 LLM）、④ 规则校验（skill-contract.ts）、⑤ 路由自测（需要 LLM）。
 * 本模块只做 ①② 与 ③ 的输入构造；④ 由 skill-contract 校验产物，⑤ 不假装做过。
 *
 * 核心判断：技能不被加载等于白做，而“会不会被加载”由 description 和选材决定。
 * 所以选材/就绪门/契约必须自研，不能外包；本模块就是那部分。
 */
import { createHash } from "node:crypto";
import { isInstructionAtom, type KnowledgeAtom } from "../base/atom-store.ts";
import { isDocType } from "../base/admission.ts";
import { shortSessionId } from "../extract/coverage.ts";
import {
  BODY_BUDGET, DEFAULT_BODY_BUDGET, bodyBudgetFor, requiredSectionsFor,
} from "./skill-contract.ts";

/** 就绪门阈值（§三 ①） */
export const MIN_ATOMS = 5;
export const MIN_SESSIONS = 2;

/**
 * 短效知识判定命中的条数阈值。
 *
 * §七 原文写“三个机械判据任一命中即视为短效知识候选”，但判据 2（程序性 <20%）对
 * spec / rubric 这类本来就非流程性的主题天然成立，单独命中就把主题判死会误杀。
 * 这里要求 ≥2 条互相印证才算 short-lived；单条只记 warning。阈值集中在这里，可调。
 */
export const TRANSIENT_BLOCK_HITS = 2;

/** 旧知识卡片没有 doc_type：按 5 类目录反推一个最接近的类型 */
const CATEGORY_DOC_TYPE: Record<string, string> = {
  "01": "spec",
  "02": "sop",
  "03": "template",
  "04": "case",
  "05": "postmortem",
};

export function effectiveDocType(a: KnowledgeAtom): string {
  if (isDocType(a.doc_type)) return a.doc_type;
  return CATEGORY_DOC_TYPE[String(a.category ?? "")] ?? "spec";
}

/** 主题名 sanitize：skill name 必须 kebab-case（pi 目录名 / dsh candidate 校验同一条） */
export function sanitizeDomainName(domain: string): string {
  const out = String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return out || "general";
}

export function instructionAtomsOf(domain: string, atoms: readonly KnowledgeAtom[]): KnowledgeAtom[] {
  return atoms.filter((a) => {
    if (!isInstructionAtom(a)) return false;
    return String(a.domain ?? "general").trim() === domain;
  });
}

/** 跨会话数：同一 session 的 8 位短 id 只算一个（兼容 pi 短 id 与 dsh uuid） */
export function sessionCount(atoms: readonly KnowledgeAtom[]): number {
  const set = new Set<string>();
  for (const a of atoms) {
    for (const s of a.sources ?? []) {
      const id = shortSessionId(String(s.session_id ?? ""));
      if (id) set.add(id);
    }
  }
  return set.size;
}

/** 内容指纹：domain + atom_ids 集合 + 契约版本；用于“内容有变化才重编” */
export function inputHash(domain: string, atoms: readonly KnowledgeAtom[]): string {
  const ids = atoms.map((a) => a.atom_id).sort();
  return createHash("sha1").update(`${domain}\n${ids.join(",")}\ncompile-v1`).digest("hex").slice(0, 16);
}

// ---------------- 短效知识判定（§七） ----------------

const PROCEDURAL_RE = /\b(?:pnpm|npm|node|git|curl|docker|kubectl|bash|python3?)\b|^\s*\d+[.)、]\s+|```|步骤|命令|脚本/;
const STALE_EXPRESSION_RE = /已实现|实施完成|本次|今天|这轮|上次运行|当前状态|\bM[0-3]\b/;

export interface TransientReport {
  hits: string[];
  count: number;
  stale: boolean;
  rescueRatio: number;
  proceduralRatio: number;
  staleRatio: number;
  reasons: string[];
}

export function transientReport(atoms: readonly KnowledgeAtom[]): TransientReport {
  const n = atoms.length;
  if (n === 0) {
    return { hits: [], count: 0, stale: false, rescueRatio: 0, proceduralRatio: 0, staleRatio: 0, reasons: [] };
  }
  const rescue = atoms.filter((a) => a.extracted_by === "compaction-rescue").length;
  const procedural = atoms.filter((a) => {
    const t = effectiveDocType(a);
    if (t === "sop" || t === "template" || t === "rubric") return true;
    return PROCEDURAL_RE.test(String(a.content ?? ""));
  }).length;
  const staleAtoms = atoms.filter((a) => STALE_EXPRESSION_RE.test(String(a.content ?? ""))).length;
  const rescueRatio = rescue / n;
  const proceduralRatio = procedural / n;
  const staleRatio = staleAtoms / n;

  const hits: string[] = [];
  const reasons: string[] = [];
  if (rescueRatio >= 0.8) {
    hits.push("rescue");
    reasons.push(`来源集中在 compaction 抢救（${Math.round(rescueRatio * 100)}% ≥ 80%）——它天然只抓“刚才在干嘛”`);
  }
  if (proceduralRatio < 0.2) {
    hits.push("low-procedural");
    reasons.push(`程序性标记只占 ${Math.round(proceduralRatio * 100)}%（<20%）——不像“以后照着做”的知识`);
  }
  if (staleRatio >= 0.6) {
    hits.push("stale-wording");
    reasons.push(`${Math.round(staleRatio * 100)}% 的卡片含短效表述（≥60%）——描述的是某一刻的状态`);
  }
  return {
    hits,
    count: hits.length,
    stale: hits.length >= TRANSIENT_BLOCK_HITS,
    rescueRatio,
    proceduralRatio,
    staleRatio,
    reasons,
  };
}

// ---------------- 就绪门（§三 ①） ----------------

export interface ReadinessReport {
  domain: string;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  atomCount: number;
  sessionCount: number;
  inputHash: string;
  changed: boolean;
  transient: TransientReport;
  docTypes: string[];
  primaryDocType?: string;
}

export interface ReadinessOptions {
  /** 跳过“内容有变化”和短效知识判定（不跳过卡片数/会话数门槛） */
  force?: boolean;
  /** 上次编译的 inputHash；相同则 unchanged */
  lastHash?: string;
}

/** 主类型：数量最多的类型；平票按“可执行性”优先级（sop > template > rubric > postmortem > spec > convention > index） */
const PRIMARY_PRIORITY = ["sop", "template", "rubric", "postmortem", "spec", "convention", "index", "case"];

export function primaryDocType(atoms: readonly KnowledgeAtom[]): string | undefined {
  const count = new Map<string, number>();
  for (const a of atoms) {
    const t = effectiveDocType(a);
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const t of PRIMARY_PRIORITY) {
    const c = count.get(t) ?? 0;
    if (c > bestCount && c > 0) {
      best = t;
      bestCount = c;
    }
  }
  return best;
}

export function checkReadiness(domain: string, atoms: readonly KnowledgeAtom[], opts: ReadinessOptions = {}): ReadinessReport {
  const pool = instructionAtomsOf(domain, atoms);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const hash = inputHash(domain, pool);
  const changed = opts.lastHash !== undefined && opts.lastHash === hash ? false : true;
  const transient = transientReport(pool);
  const docTypes = [...new Set(pool.map(effectiveDocType))];
  const primary = primaryDocType(pool);

  const atomCount = pool.length;
  const sessions = sessionCount(pool);
  if (atomCount === 0) blockers.push("该主题没有 instruction 知识卡片");
  else if (atomCount < MIN_ATOMS) blockers.push(`知识卡片 ${atomCount} 张，未达就绪门 ${MIN_ATOMS} 张`);
  if (atomCount > 0 && sessions < MIN_SESSIONS) blockers.push(`只来自 ${sessions} 个会话，未达就绪门 ${MIN_SESSIONS} 个（单会话可能是噪音）`);
  if (transient.stale && !opts.force) {
    blockers.push(`判为短效知识（${transient.reasons.join("；")}）→ 转历史记录文档，不编译；--force 可强制`);
  } else if (transient.count === 1) {
    warnings.push(`短效信号 1 条（未达 ${TRANSIENT_BLOCK_HITS} 条阻断线）：${transient.reasons[0]}`);
  }
  if (!changed && !opts.force) blockers.push("内容与上次编译一致（用 --force 重编）");
  if (pool.length > 0 && pool.every((a) => !isDocType(a.doc_type))) {
    warnings.push("全部是旧知识卡片（无 doc_type），类型按 5 类目录推断");
  }
  if (sanitizeDomainName(domain) !== domain) {
    warnings.push(`域名 "${domain}" 不是 kebab-case，技能名将用 "${sanitizeDomainName(domain)}"`);
  }

  return {
    domain,
    ready: blockers.length === 0,
    blockers,
    warnings,
    atomCount,
    sessionCount: sessions,
    inputHash: hash,
    changed,
    transient,
    docTypes,
    primaryDocType: primary,
  };
}

// ---------------- 宿主提示：哪些主题该编了 ----------------

export interface CompileDueItem {
  domain: string;
  skillName: string;
  atoms: number;
  sessions: number;
  primaryDocType?: string;
  inputHash: string;
}

/**
 * 已过就绪门、内容又有变化的主题（不调 LLM、不写文件）。
 * 宿主在空闲提示里展示它，否则编译器只是仓库里一个没人跑的 CLI。
 */
export function compileDue(
  atoms: readonly KnowledgeAtom[],
  lastHashes: Record<string, string> = {},
  opts: { limit?: number } = {},
): CompileDueItem[] {
  const groups = new Map<string, KnowledgeAtom[]>();
  for (const a of atoms) {
    if (!isInstructionAtom(a)) continue;
    const domain = String(a.domain ?? "general").trim() || "general";
    const arr = groups.get(domain);
    if (arr) arr.push(a);
    else groups.set(domain, [a]);
  }
  const out: CompileDueItem[] = [];
  for (const domain of groups.keys()) {
    const r = checkReadiness(domain, atoms, { lastHash: lastHashes[sanitizeDomainName(domain)] });
    if (!r.ready) continue;
    out.push({
      domain,
      skillName: sanitizeDomainName(domain),
      atoms: r.atomCount,
      sessions: r.sessionCount,
      primaryDocType: r.primaryDocType,
      inputHash: r.inputHash,
    });
  }
  out.sort((a, b) => b.atoms - a.atoms || a.domain.localeCompare(b.domain));
  return out.slice(0, opts.limit ?? 10);
}

// ---------------- 选材器（§三 ② / §六） ----------------

export interface ScoreParts {
  procedural: number;
  multiSession: number;
  freshness: number;
  confidence: number;
  stalePenalty: number;
}

export interface ScoredAtom {
  atom: KnowledgeAtom;
  docType: string;
  score: number;
  parts: ScoreParts;
  reasons: string[];
}

const DAY = 24 * 60 * 60 * 1000;

export function scoreAtom(a: KnowledgeAtom, now = Date.now()): ScoredAtom {
  const docType = effectiveDocType(a);
  const procedural = docType === "sop" || docType === "template" || docType === "rubric" || PROCEDURAL_RE.test(String(a.content ?? "")) ? 3 : 0;
  const multiSession = new Set((a.sources ?? []).map((s) => shortSessionId(String(s.session_id ?? ""))).filter(Boolean)).size >= 2 ? 2 : 0;
  const ts = Date.parse(String(a.extracted_at ?? ""));
  const age = Number.isNaN(ts) ? Infinity : now - ts;
  const freshness = age <= 30 * DAY ? 2 : age <= 90 * DAY ? 1 : 0;
  const confidence = typeof a.confidence === "number" ? a.confidence : 0;
  const stalePenalty = STALE_EXPRESSION_RE.test(String(a.content ?? "")) ? 2 : 0;
  const score = procedural + multiSession + freshness + confidence - stalePenalty;
  const reasons: string[] = [];
  if (procedural > 0) reasons.push("程序性 +3");
  if (multiSession > 0) reasons.push("跨会话复现 +2");
  if (freshness > 0) reasons.push(`新鲜度 +${freshness}`);
  reasons.push(`置信度 ${confidence}`);
  if (stalePenalty > 0) reasons.push("短效表述 -2");
  return { atom: a, docType, score, parts: { procedural, multiSession, freshness, confidence, stalePenalty }, reasons };
}

export interface SelectionOptions {
  /** 正文预算（字）；默认按选中类型的最大档 */
  budgetChars?: number;
  now?: number;
}

export interface Selection {
  picked: ScoredAtom[];
  /** 预算外 / case：进 references，保留溯源 */
  overflow: ScoredAtom[];
  usedChars: number;
  budgetChars: number;
  docTypes: string[];
  primaryDocType?: string;
  /** 同类多卡聚合提示：docType → atom_ids（交给生成器合成对比矩阵/排障清单） */
  groups: Array<{ docType: string; atomIds: string[] }>;
}

export function selectMaterials(atoms: readonly KnowledgeAtom[], opts: SelectionOptions = {}): Selection {
  const now = opts.now ?? Date.now();
  const ranked = atoms.map((a) => scoreAtom(a, now)).sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (y.parts.confidence !== x.parts.confidence) return y.parts.confidence - x.parts.confidence;
    const tx = Date.parse(String(x.atom.extracted_at ?? "")) || 0;
    const ty = Date.parse(String(y.atom.extracted_at ?? "")) || 0;
    if (ty !== tx) return ty - tx;
    return x.atom.atom_id.localeCompare(y.atom.atom_id);
  });

  const docTypes = [...new Set(ranked.map((r) => r.docType))];
  // 预算按**主类型**分档（§十三 决议 1），不按“出现过的类型取最大”——
  // 否则一个 spec 主题里混进一张 postmortem 卡，预算就会被抬到 5000。
  const primaryForBudget = primaryDocType(atoms);
  const budget = opts.budgetChars
    ?? (primaryForBudget ? bodyBudgetFor([primaryForBudget]) : bodyBudgetFor(docTypes));

  const picked: ScoredAtom[] = [];
  const overflow: ScoredAtom[] = [];
  let used = 0;
  for (const r of ranked) {
    // case 永不进正文（design §四 / §五：case → reference）
    if (r.docType === "case") { overflow.push(r); continue; }
    const len = String(r.atom.content ?? "").trim().length;
    if (used + len <= budget) { picked.push(r); used += len; }
    else overflow.push(r);
  }

  const groups = [...new Set([...picked, ...overflow].map((r) => r.docType))]
    .sort()
    .map((docType) => ({
      docType,
      atomIds: [...picked, ...overflow].filter((r) => r.docType === docType).map((r) => r.atom.atom_id),
    }));

  return {
    picked,
    overflow,
    usedChars: used,
    budgetChars: budget,
    docTypes: [...new Set(picked.map((r) => r.docType))],
    primaryDocType: primaryDocType(picked.map((r) => r.atom)),
    groups,
  };
}

// ---------------- 编译简报（③ 的输入） ----------------

export interface CompileBrief {
  domain: string;
  skillName: string;
  generatedAt: string;
  readiness: ReadinessReport;
  selection: Selection;
  bodyBudget: number;
  contract: {
    requiredSections: string[];
    banned: string[];
    description: string;
    bodyBudget: number;
    referencesBudget: string;
  };
}

export interface BriefOutput {
  json: CompileBrief;
  markdown: string;
}

export function buildCompileBrief(domain: string, readiness: ReadinessReport, selection: Selection): BriefOutput {
  const skillName = sanitizeDomainName(domain);
  const requiredSections = requiredSectionsFor(selection.primaryDocType ?? readiness.primaryDocType);
  const bodyBudget = selection.budgetChars || DEFAULT_BODY_BUDGET;
  const json: CompileBrief = {
    domain,
    skillName,
    generatedAt: new Date().toISOString(),
    readiness,
    selection: {
      ...selection,
      // 简报里不带 content（可能很长），只留 id / 分数；正文由生成器从 atoms.jsonl 读
      picked: selection.picked.map((r) => ({ ...r, atom: { ...r.atom, content: String(r.atom.content ?? "").slice(0, 400) } })),
      overflow: selection.overflow.map((r) => ({ ...r, atom: { ...r.atom, content: String(r.atom.content ?? "").slice(0, 400) } })),
    },
    bodyBudget,
    contract: {
      requiredSections,
      banned: ["atom_ / 置信度 / status / 来源 等元数据", "短效表述 ≥2 次", "领域知识库 / 由 AutoSkill / 涉及…时加载", "分诊表行只有文件名没有条件"],
      description: "60–300 字，含 ≥3 个触发短语，写清“是什么 + 何时用”",
      bodyBudget,
      referencesBudget: "无上限；预算装不下的进 references/ 并保留溯源",
    },
  };
  return { json, markdown: renderBriefMarkdown(json) };
}

function renderBriefMarkdown(b: CompileBrief): string {
  const r = b.readiness;
  const lines: string[] = [];
  lines.push(`# 编译简报：${b.domain}`, "");
  lines.push("> 由 `compile-skills.ts` 生成（确定性，不调 LLM）。把本简报 + create-skill 一起交给生成器；");
  lines.push("> 产出 SKILL.md 后先 `--validate`，通过再 `--apply`。", "");
  lines.push("## 一、就绪门");
  lines.push(`- 知识卡片 ${r.atomCount} 张 / 来源会话 ${r.sessionCount} 个 / 主类型 ${r.primaryDocType ?? "未知"}`);
  lines.push(`- 内容指纹 \`${r.inputHash}\`（变化才会重编）`);
  lines.push(`- 正文预算 ${b.bodyBudget} 字（按 ${r.primaryDocType ?? "默认"} 档）`);
  for (const w of r.warnings) lines.push(`- ⚠ ${w}`);
  for (const x of r.blockers) lines.push(`- ⛔ ${x}`);
  lines.push("");

  lines.push(`## 二、选材（按分数排序，进正文 ${b.selection.picked.length} 张）`);
  lines.push("| atom_id | 类型 | 分 | 置信度 | 字数 | 会话数 | 内容首行 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r2 of b.selection.picked) {
    const a = r2.atom;
    const first = String(a.content ?? "").split("\n")[0]?.slice(0, 60) ?? "";
    const sessions = new Set((a.sources ?? []).map((s) => s.session_id)).size;
    lines.push(`| ${a.atom_id} | ${r2.docType} | ${r2.score.toFixed(2)} | ${a.confidence} | ${String(a.content ?? "").length} | ${sessions} | ${first.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  if (b.selection.overflow.length > 0) {
    lines.push(`## 三、进 references（预算外 / case，共 ${b.selection.overflow.length} 张）`);
    for (const r2 of b.selection.overflow) {
      lines.push(`- ${r2.atom.atom_id} [${r2.docType}] ${String(r2.atom.content ?? "").split("\n")[0]?.slice(0, 80)}`);
    }
    lines.push("");
  }

  if (b.selection.groups.some((g) => g.atomIds.length >= 2)) {
    lines.push("## 四、同类多卡聚合提示（§六）");
    for (const g of b.selection.groups.filter((x) => x.atomIds.length >= 2)) {
      const how = g.docType === "postmortem" ? "合成排障清单（现象 → 根因 → 处置）"
        : g.docType === "spec" ? "合成对比矩阵 / 口径表（含排除了哪种理解）"
        : "合并同节，保留每条的适用条件";
      lines.push(`- ${g.docType} ×${g.atomIds.length} → ${how}`);
    }
    lines.push("");
  }

  lines.push("## 五、生成契约（硬约束，校验器会逐条查）");
  lines.push(`- frontmatter：\`name: ${b.skillName}\`；description ${b.contract.description}`);
  lines.push(`- 必含章节：${b.contract.requiredSections.length > 0 ? b.contract.requiredSections.map((s) => `## ${s}`).join(" / ") : "（无类型信息，按契约模板）"}`);
  lines.push(`- 正文 ≤ ${b.bodyBudget} 字；历史必须写成历史（“当时定的是…”），禁祈使句`);
  lines.push("- 禁止：" + b.contract.banned.join("；"));
  lines.push("- 分诊表每一行都要有“你现在的处境 → 读这个”，不能只写文件名");
  lines.push("");
  lines.push("## 六、不能进正文");
  lines.push("- `case`（reference 层）、`index`/`data`（资料层）：只进 references 或知识库，不进正文");
  lines.push("");
  lines.push("## 七、下一步");
  lines.push(`1. 按契约生成 \`SKILL.md\`（可把本简报 + 选中卡片交给 create-skill）`);
  lines.push(`2. \`node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain ${b.domain} --validate <path>\``);
  lines.push(`3. 通过后 \`--apply <path> --skills-dir <宿主 skills 目录>\` 写 intake 提案，再跑 apply-patches`);
  return lines.join("\n") + "\n";
}

/** 正文预算表重导出，CLI 展示用 */
export { BODY_BUDGET };
