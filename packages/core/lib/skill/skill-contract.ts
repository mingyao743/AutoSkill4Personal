/**
 * SKILL.md 契约校验（M1–M6，纯函数、零 token）。
 *
 * 依据 design/SKILL_COMPILER.md：
 *  - §四 SKILL.md 契约（章节 / 描述 / 机械禁止项）
 *  - §八 质量关卡（M1 结构 / M2 可执行 / M4 去噪 / M5 预算 / M6 引用闭合）
 *  - §十三 决议 1：正文预算按 doc_type 分档
 *
 * M3（路由自测：正 ≥4/5、负 ≤2/3）需要 LLM 或人工探针，本模块只标记 needsRoutingTest，
 * 不假装做过——这是“不依赖 LLM 的那部分”的边界。
 */

/** 正文预算按 doc_type 分档（SKILL_COMPILER §十三 决议 1）；case 不进正文 */
export const BODY_BUDGET: Record<string, number> = {
  sop: 8_000,
  spec: 4_000,
  template: 6_000,
  postmortem: 5_000,
  convention: 2_500,
  index: 2_000,
  rubric: 4_000,
  case: 0,
};

/** 没有类型信息时的总预算（SKILL_COMPILER §六） */
export const DEFAULT_BODY_BUDGET = 6_000;

/** 取呈现类型里最大的预算；空列表走默认值 */
export function bodyBudgetFor(docTypes: readonly string[]): number {
  const budgets = docTypes.map((t) => BODY_BUDGET[t]).filter((n): n is number => typeof n === "number" && n > 0);
  return budgets.length > 0 ? Math.max(...budgets) : DEFAULT_BODY_BUDGET;
}

/** 各类型的最小节子集（§四）；index 用分诊表代替“判断” */
const REQUIRED_SECTIONS: Record<string, string[]> = {
  sop: ["步骤", "失败与回退"],
  spec: ["判断", "边界"],
  template: ["步骤"],
  postmortem: ["失败与回退", "验证"],
  convention: ["边界"],
  rubric: ["判断"],
  index: ["判断"],
};

export function requiredSectionsFor(docType: string | undefined): string[] {
  return docType ? REQUIRED_SECTIONS[docType] ?? [] : [];
}

/** 机械禁止项（§四）：元数据 / 模板句式 / 短效表述 */
const METADATA_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\batom_[0-9a-f]{6,}\b/i, label: "atom_ 元数据" },
  { re: /置信度\s*[:：]?\s*0?\.\d+/, label: "置信度元数据" },
  { re: /\bstatus\s*[:：]\s*(draft|published|reviewed|deprecated)\b/i, label: "status 元数据" },
  { re: /来源\s*[:：]\s*\S+:\S+/, label: "来源元数据" },
];
const TEMPLATE_PHRASES: Array<{ re: RegExp; label: string }> = [
  { re: /领域知识库/, label: "“领域知识库”模板句" },
  { re: /由\s*AutoSkill\s*(知识管道)?/, label: "“由 AutoSkill 生成”模板句" },
  { re: /涉及.{0,10}时加载/, label: "“涉及…时加载”模板句" },
];
const TRANSIENT_RE = /已实现|实施完成|本次|今天|这轮|上次运行|当前状态|\bM[0-3]\b/g;

/**
 * references 路径（允许中文文件名，如 references/02-操作SOP.md）。
 * 排除空白与 markdown 结构字符，避免把表格分隔符/句号吃进路径。
 */
const REF_PATH_RE = /references\/[^\s`'")\]|<>]+\.md/g;
const REF_ONLY_RE = /^`?references\/[^\s`'")\]|<>]+\.md`?$/;

/** 正文里引用到的 references 文件（去重，保持出现顺序；允许中文文件名） */
export function referencePaths(text: string): string[] {
  return [...new Set(String(text ?? "").match(REF_PATH_RE) ?? [])];
}

/** 短效表述出现次数（“已实现/本次/今天/M0–M3…”——三个月后就是过期指令） */
export function countTransientWording(text: string): number {
  return (String(text ?? "").match(TRANSIENT_RE) ?? []).length;
}

/** 触发短语的粗判：按分隔符切段，取像短语的段（2–20 字） */
function triggerPhraseCount(description: string): number {
  return description
    .split(/[、，,；;。！!？?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 20 && !/^(适用于|涵盖|用于)$/.test(s)).length;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  raw: Record<string, string>;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  /** 二级标题 → 内容（不含标题行） */
  sections: Record<string, string>;
}

export type ParseResult = ParsedSkill | { error: string };

export function parseSkillMd(md: string): ParseResult {
  const text = String(md ?? "").replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return { error: "缺 frontmatter（文件必须以 --- 开头，并用 --- 收尾）" };
  const raw: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    raw[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!raw.name) return { error: "frontmatter 缺 name" };
  const body = text.slice(fm[0].length);
  const sections: Record<string, string> = {};
  const lines = body.split("\n");
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) sections[cur] = buf.join("\n").trim();
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h && !line.startsWith("###")) {
      flush();
      cur = h[1].trim();
      buf = [];
      continue;
    }
    if (cur !== null) buf.push(line);
  }
  flush();
  return {
    frontmatter: { name: raw.name, description: raw.description ?? "", raw },
    body,
    sections,
  };
}

/** 按名字取节：全等优先，其次前缀匹配（允许“步骤（执行顺序）”这类标题） */
export function findSection(sections: Record<string, string>, name: string): string | undefined {
  if (sections[name] != null) return sections[name];
  const hit = Object.keys(sections).find((k) => k.startsWith(name));
  return hit === undefined ? undefined : sections[hit];
}

function countNumberedItems(s: string): number {
  return (s.match(/^\s{0,3}\d+[.)、]\s+\S/gm) ?? []).length;
}

function countBullets(s: string): number {
  return (s.match(/^\s{0,3}[-*]\s+\S/gm) ?? []).length;
}

/** markdown 表的数据行数（排除表头与分隔行） */
function tableRows(s: string): string[][] {
  const rows: string[][] = [];
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue; // 分隔行
    rows.push(cells);
  }
  return rows;
}

function countJudgments(s: string): number {
  const rows = tableRows(s);
  if (rows.length > 0) return Math.max(0, rows.length - 1); // 首行是表头
  return countBullets(s);
}

export type CheckId = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";

export interface SkillCheck {
  id: CheckId;
  name: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface SkillValidationReport {
  ok: boolean;
  checks: SkillCheck[];
  errors: string[];
  warnings: string[];
  stats: {
    bodyChars: number;
    budget: number;
    descriptionChars: number;
    steps: number;
    judgments: number;
    transientHits: number;
    references: number;
  };
  /** M3 没做：路由自测需要 LLM/人工探针 */
  needsRoutingTest: boolean;
}

export interface SkillValidateOptions {
  /** 目标主题名（kebab-case）；默认取 frontmatter.name */
  domain?: string;
  /** 呈现的 doc_type，**第一个是主类型**（决定最小节子集与步骤阈值） */
  docTypes?: readonly string[];
  /** 覆盖正文预算；默认按 docTypes 计算 */
  bodyBudget?: number;
  /** references 清单（相对 skill 目录，如 references/02-操作SOP.md）；function 形式可查磁盘 */
  availableRefs?: Iterable<string> | ((rel: string) => boolean);
}

function refChecker(available: SkillValidateOptions["availableRefs"]): ((rel: string) => boolean) | undefined {
  if (!available) return undefined;
  if (typeof available === "function") return available;
  const set = new Set(available);
  return (rel) => set.has(rel);
}

export function validateSkillMd(input: string | ParsedSkill, opts: SkillValidateOptions = {}): SkillValidationReport {
  const parsed: ParseResult = typeof input === "string" ? parseSkillMd(input) : input;
  const checks: SkillCheck[] = [];
  const add = (id: CheckId, name: string, errors: string[] = [], warnings: string[] = []): void => {
    checks.push({ id, name, ok: errors.length === 0, errors, warnings });
  };

  if ("error" in parsed) {
    add("M1", "结构", [parsed.error]);
    return finish(checks, { bodyChars: 0, budget: opts.bodyBudget ?? DEFAULT_BODY_BUDGET, descriptionChars: 0, steps: 0, judgments: 0, transientHits: 0, references: 0 });
  }

  const { frontmatter, body, sections } = parsed;
  const domain = opts.domain ?? frontmatter.name;
  const docTypes = opts.docTypes ?? [];
  const primary = docTypes[0];
  const budget = opts.bodyBudget ?? (docTypes.length > 0 ? bodyBudgetFor(docTypes) : DEFAULT_BODY_BUDGET);

  // ---- M1 结构 ----
  const m1: string[] = [];
  if (frontmatter.name !== domain) m1.push(`frontmatter.name="${frontmatter.name}" 与目标主题 "${domain}" 不一致`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(frontmatter.name)) m1.push(`name 不是 kebab-case: ${frontmatter.name}`);
  if (!frontmatter.description.trim()) m1.push("description 为空");
  const required = requiredSectionsFor(primary);
  if (!primary && docTypes.length === 0) {
    // 没有类型信息就不强制最小节子集，避免把旧卡片主题误判死
  }
  for (const name of required) {
    if (findSection(sections, name) === undefined) m1.push(`缺章节：## ${name}`);
  }
  if (primary === "convention" && !/失效条件/.test(body)) m1.push("convention 未写失效条件");
  if (primary === "template" && !/```/.test(body) && !/骨架|模板/.test(body)) m1.push("template 未给骨架（代码块或“骨架/模板”段）");
  if (primary === "index" && tableRows(body).length === 0) m1.push("index 必须有分诊表（至少一行）");
  add("M1", "结构", m1);

  // ---- M2 可执行 ----
  const m2: string[] = [];
  const stepText = findSection(sections, "步骤") ?? "";
  const judgeText = findSection(sections, "判断") ?? "";
  const steps = countNumberedItems(stepText);
  const judgments = countJudgments(judgeText);
  if (primary === "sop" && steps < 3) m2.push(`sop 步骤不足 3 条（实为 ${steps}）`);
  if (primary === "template" && steps < 1) m2.push(`template 缺填写步骤（实为 ${steps}）`);
  if (primary === "spec" && judgments < 3) m2.push(`spec 判断不足 3 条（实为 ${judgments}）`);
  if (primary === "rubric" && judgments < 2) m2.push(`rubric 判断不足 2 条（实为 ${judgments}）`);
  if (primary === "index" && judgments < 1) m2.push(`index 分诊表不足 1 行（实为 ${judgments}）`);
  if (primary === "postmortem") {
    const fail = findSection(sections, "失败与回退") ?? "";
    const verify = findSection(sections, "验证") ?? "";
    if (countBullets(fail) + countNumberedItems(fail) < 1) m2.push("postmortem 缺“失败与回退”条目");
    if (countBullets(verify) + countNumberedItems(verify) < 1) m2.push("postmortem 缺“验证”条目");
  }
  add("M2", "可执行", m2);

  // ---- M4 去噪 ----
  const m4: string[] = [];
  for (const p of METADATA_PATTERNS) if (p.re.test(body)) m4.push(`正文含${p.label}`);
  for (const p of TEMPLATE_PHRASES) if (p.re.test(frontmatter.description)) m4.push(`description 含${p.label}`);
  const transientHits = countTransientWording(body);
  if (transientHits >= 2) m4.push(`正文短效表述出现 ${transientHits} 次（上限 1）：历史状态会变成过期指令`);
  add("M4", "去噪", m4);

  // ---- M5 预算与路由描述 ----
  const m5: string[] = [];
  const m5warn: string[] = [];
  const bodyChars = body.trim().length;
  if (primary !== "case" && bodyChars > budget) m5.push(`正文 ${bodyChars} 字，超预算 ${budget}（按 ${primary ?? "默认"} 档）`);
  const descChars = frontmatter.description.trim().length;
  if (descChars > 1_000) m5.push(`description ${descChars} 字，超过 1000 字硬上限`);
  if (descChars < 20) m5.push("description 过短，无法承担路由");
  if (descChars < 60 || descChars > 300) m5warn.push(`description ${descChars} 字，建议 60–300（§四）`);
  const triggers = triggerPhraseCount(frontmatter.description);
  if (triggers < 3) m5warn.push(`触发短语约 ${triggers} 个，契约要求 ≥3`);
  // 分诊表：每行必须带条件，不能只有文件名
  const triageTitles = Object.keys(sections).filter((k) => /references|分诊/.test(k));
  for (const title of triageTitles) {
    const rows = tableRows(sections[title]);
    for (const [i, row] of rows.entries()) {
      if (i === 0) continue; // 表头
      if (row.filter((c) => c.length > 0).length < 2) m5.push(`分诊表行缺少“读什么/何时读”两列：${row.join(" | ")}`);
      const first = row[0] ?? "";
      if (/^`?references\//.test(first) && REF_ONLY_RE.test(first)) m5.push(`分诊表行只有文件名、没有条件：${first}`);
    }
  }
  add("M5", "预算与描述", m5, m5warn);

  // ---- M6 引用闭合 ----
  const m6: string[] = [];
  const m6warn: string[] = [];
  const refs = referencePaths(body);
  const exists = refChecker(opts.availableRefs);
  if (refs.length > 0 && !exists) {
    m6warn.push(`正文引用 ${refs.length} 个 references 文件，但未提供清单，跳过闭合检查`);
  } else if (exists) {
    for (const rel of refs) if (!exists(rel)) m6.push(`引用的文件不存在：${rel}`);
  }
  add("M6", "引用闭合", m6, m6warn);

  // ---- M3：不假装做过 ----
  add("M3", "路由自测（未执行）", [], ["需要 LLM/人工探针：正样本 ≥4/5、负样本 ≤2/3 后才可发布"]);

  return finish(checks, { bodyChars, budget, descriptionChars: descChars, steps, judgments, transientHits, references: refs.length });
}

function finish(checks: SkillCheck[], stats: SkillValidationReport["stats"]): SkillValidationReport {
  const errors = checks.flatMap((c) => c.errors.map((e) => `${c.id} ${e}`));
  const warnings = checks.flatMap((c) => c.warnings.map((w) => `${c.id} ${w}`));
  return {
    ok: errors.length === 0,
    checks,
    errors,
    warnings,
    stats,
    needsRoutingTest: true,
  };
}

/** 人读报告（CLI 用） */
export function formatValidation(report: SkillValidationReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    const mark = c.id === "M3" ? "⏳" : c.ok ? "✅" : "❌";
    lines.push(`${mark} ${c.id} ${c.name}`);
    for (const e of c.errors) lines.push(`   ✗ ${e}`);
    for (const w of c.warnings) lines.push(`   ! ${w}`);
  }
  const s = report.stats;
  lines.push(
    `正文 ${s.bodyChars}/${s.budget} 字｜description ${s.descriptionChars} 字｜步骤 ${s.steps}｜判断 ${s.judgments}｜短效表述 ${s.transientHits}｜references ${s.references}`,
  );
  lines.push(report.ok ? "确定性关卡全部通过（M3 路由自测仍需执行）" : `未通过：${report.errors.length} 项`);
  return lines.join("\n");
}
