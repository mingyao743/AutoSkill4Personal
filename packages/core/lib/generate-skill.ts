/**
 * ③ 正文生成（SKILL_COMPILER §三 第三步）。
 *
 * 把"编译简报 + 选中卡片完整正文 + 写法指引"交给一次 LLM 调用，产出 SKILL.md draft。
 *
 * - 输入：编译简报（CompileBrief）+ 选中卡片的**完整**正文（简报里只截了 400 字，
 *   这里从 atoms.jsonl 按 atom_id 取全量）+ packages/core/skills/create-skill/SKILL.md 作为写法指引；
 * - 输出：SKILL.md draft 字符串（**不直接落技能文件**；由 CLI 写到
 *   `<briefDir>/<skill>.draft.md`）；
 * - 质量环：调 validateSkillMd；不过就把 report.errors 回喂重写，**最多 2 次**；
 *   仍不过则保留 draft、返回 ok=false（CLI 打印错误、不生成提案）；
 * - 依赖注入：只调 chatComplete（llm.ts）。测试用 setChatCompleter 注入 mock，不碰
 *   真实凭据；宿主内走 ctx.llm 注入、CLI 走 standalone 降级链。
 *
 * 不做的事（NEXT_STEPS §三）：不自动 --apply；不绕过 --validate；不覆盖 agent-maintained。
 */
import { chatComplete } from "./llm.ts";
import {
  validateSkillMd,
  type SkillValidationReport,
  type SkillValidateOptions,
} from "./skill-contract.ts";
import type { CompileBrief } from "./compile-skill.ts";
import type { KnowledgeAtom } from "./atom-store.ts";

/** 单次重写上限（NEXT_STEPS §三：最多 2 次；初始 + 2 次重写 = 最多 3 次调用） */
export const DEFAULT_MAX_REWRITES = 2;

export interface GenerateCard {
  atom_id: string;
  content: string;
  doc_type: string;
  score?: number;
}

export interface GenerateInput {
  brief: CompileBrief;
  /** 选中卡片的完整正文（从 atoms.jsonl 按 atom_id 取；简报里只截了 400 字） */
  cards: GenerateCard[];
  /** 写法指引（packages/core/skills/create-skill/SKILL.md 全文） */
  writingGuide: string;
  /** 校验选项：domain / docTypes（主类型在前）/ bodyBudget / availableRefs */
  validateOpts: SkillValidateOptions;
  maxRewrites?: number;
  /** 模型覆盖（CLI/宿主可指定；缺省跟随配置） */
  model?: string;
}

export interface GenerateAttempt {
  /** 1 起的尝试序号 */
  attempt: number;
  ok: boolean;
  errors: string[];
}

export interface GenerateResult {
  /** 最终 draft（无论是否通过校验都保留——失败时供人工修） */
  draft: string;
  report: SkillValidationReport;
  /** LLM 调用总次数（1 = 一次通过） */
  attempts: number;
  ok: boolean;
  /** 每次尝试的校验结果（成功那次是最后一项） */
  history: GenerateAttempt[];
}

/**
 * 生成 SKILL.md draft。最多 1 + maxRewrites 次调用：第一次直出，后续把上一次的
 * 校验错误回喂重写。任何一次通过即停；全失败则保留最后一次的 draft、ok=false。
 */
export async function generateSkill(input: GenerateInput): Promise<GenerateResult> {
  const maxRewrites = input.maxRewrites ?? DEFAULT_MAX_REWRITES;
  const history: GenerateAttempt[] = [];
  let draft = "";
  let report: SkillValidationReport | null = null;

  for (let attempt = 1; attempt <= 1 + maxRewrites; attempt++) {
    const prevErrors = attempt > 1 ? history[history.length - 1].errors : [];
    draft = await callGenerator(input, attempt, prevErrors);
    report = validateSkillMd(draft, input.validateOpts);
    history.push({ attempt, ok: report.ok, errors: report.errors });
    if (report.ok) {
      return { draft, report, attempts: attempt, ok: true, history };
    }
  }
  // 全部尝试都未通过：保留最后一次 draft，交人工
  return { draft, report: report!, attempts: history.length, ok: false, history };
}

async function callGenerator(
  input: GenerateInput,
  attempt: number,
  prevErrors: string[],
): Promise<string> {
  const res = await chatComplete({
    system: buildSystemPrompt(input),
    user: buildUserPrompt(input, attempt, prevErrors),
    model: input.model,
    temperature: 0.2,
  });
  return extractSkillMd(res.text);
}

function buildSystemPrompt(input: GenerateInput): string {
  const b = input.brief;
  const required = b.contract.requiredSections;
  return [
    "你是技能编译器，把知识卡片编译成可执行的 SKILL.md（决策程序，不是知识快照）。",
    "",
    "核心原则：技能正文是「以后照着做的操作指令」，不是「当时发生了什么的记录」。",
    "- 把卡片里的经验改写成步骤、判断表、失败回退；可复现的动作/判断/口径进正文，证据/案例不进正文。",
    "- 历史事实（某次定了什么）用历史语气写（「当时定的是…」），不要包装成现状指令。",
    "- frontmatter.description 只写「何时用」：触发条件 + 症状 + 工具名 + 同义词，≥3 个触发短语，60–300 字；不写「做什么」。",
    "- 分诊表（## 何时读 references）每行必须有「你现在的处境 → 读这个」两列，不能只写文件名。",
    "  分诊表里引用的 references 文件必须真实存在于技能目录；不存在就不要引用、或省略该章节。",
    "- 禁止元数据：atom_、置信度、status:、来源:。",
    "- 禁止短效表述在正文出现 ≥2 次：已实现、实施完成、本次、今天、这轮、上次运行、当前状态、M0–M3。",
    "- 禁止模板句式：领域知识库、由 AutoSkill、涉及…时加载。",
    `- 必含章节：${required.length > 0 ? required.map((s) => "## " + s).join(" / ") : "（按主类型的最小节子集）"}。`,
    `- 正文 ≤ ${b.bodyBudget} 字（按 ${b.readiness.primaryDocType ?? "默认"} 档预算）；装不下的进 references。`,
    "- 只输出 SKILL.md 全文，必须以 --- 开头，不要任何解释、前后缀或代码围栏。",
  ].join("\n");
}

function buildUserPrompt(input: GenerateInput, attempt: number, prevErrors: string[]): string {
  const b = input.brief;
  const lines: string[] = [];

  lines.push("# 编译简报");
  lines.push(`- 主题：${b.domain}（技能名 ${b.skillName}）`);
  lines.push(`- 主类型：${b.readiness.primaryDocType ?? "未知"}｜卡片 ${b.readiness.atomCount} 张｜会话 ${b.readiness.sessionCount} 个`);
  lines.push(`- 正文预算：${b.bodyBudget} 字｜进正文 ${b.selection.picked.length} 张 / 进 references ${b.selection.overflow.length} 张`);
  const groups = b.selection.groups.filter((g) => g.atomIds.length >= 2);
  if (groups.length > 0) {
    lines.push("- 同类多卡聚合提示：");
    for (const g of groups) {
      const how =
        g.docType === "postmortem" ? "合成排障清单（现象 → 根因 → 处置）"
        : g.docType === "spec" ? "合成对比矩阵 / 口径表（含排除了哪种理解）"
        : "合并同节，保留每条适用条件";
      lines.push(`  - ${g.docType} ×${g.atomIds.length} → ${how}`);
    }
  }
  lines.push("");

  lines.push("# 选中知识卡片（完整正文，按分数排序）");
  for (const c of input.cards) {
    lines.push("");
    lines.push(`### [${c.doc_type}] ${c.atom_id}${c.score != null ? `（score ${c.score.toFixed(2)}）` : ""}`);
    lines.push(String(c.content ?? "").trim());
  }
  lines.push("");

  lines.push("# 写法指引（create-skill）");
  lines.push(String(input.writingGuide ?? "").trim());
  lines.push("");

  lines.push("# 生成契约（硬约束，校验器会逐条查）");
  lines.push(`- frontmatter：name: ${b.skillName}；description ${b.contract.description}`);
  lines.push(`- 禁止：${b.contract.banned.join("；")}`);
  lines.push("- 分诊表每一行都要有「你现在的处境 → 读这个」，不能只写文件名");
  lines.push("- case / index / data 不进正文，只进 references 或知识库");
  lines.push("");

  if (attempt > 1 && prevErrors.length > 0) {
    lines.push(`# 上一次（第 ${attempt - 1} 次）输出未通过校验`);
    lines.push(`错误（${prevErrors.length} 条）：`);
    for (const e of prevErrors) lines.push(`- ${e}`);
    lines.push("");
    lines.push("只针对以上错误修正，重新输出完整的 SKILL.md（从 --- 开始）。不要重复上次的问题。");
  } else {
    lines.push("请生成 SKILL.md（从 --- 开始）。");
  }
  return lines.join("\n");
}

/**
 * 从 LLM 输出里取 SKILL.md 全文：
 * - 剥掉包裹的代码围栏（```markdown … ``` / ``` … ```）；
 * - 剥掉 --- frontmatter 之前的前导文字（LLM 寒暄）。
 * frontmatter 必须以行首 --- 开头；找不到 --- 则原样返回（交校验器报“缺 frontmatter”）。
 */
export function extractSkillMd(text: string): string {
  let t = String(text ?? "").trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  if (t.startsWith("---")) return t;
  const idx = t.search(/^---\s*$/m);
  if (idx > 0) t = t.slice(idx);
  return t.trim();
}

/**
 * 从简报的 picked（content 已截断到 400 字）+ 全量 atoms，拼出完整正文的卡片清单。
 * 简报里找不到匹配 atom_id 的卡片跳过（atoms.jsonl 被清理过等情形）。
 */
export function cardsForBrief(brief: CompileBrief, atoms: readonly KnowledgeAtom[]): GenerateCard[] {
  const byId = new Map<string, KnowledgeAtom>();
  for (const a of atoms) byId.set(a.atom_id, a);
  const out: GenerateCard[] = [];
  for (const r of brief.selection.picked) {
    const a = byId.get(r.atom.atom_id);
    if (!a) continue;
    out.push({
      atom_id: a.atom_id,
      content: String(a.content ?? ""),
      doc_type: r.docType,
      score: r.score,
    });
  }
  return out;
}

/** 校验用的 docTypes：主类型在前（决定最小节子集与步骤阈值） */
export function docTypesForValidation(brief: CompileBrief): string[] {
  const primary = brief.selection.primaryDocType ?? brief.readiness.primaryDocType;
  const all = brief.readiness.docTypes;
  if (!primary) return all;
  return [primary, ...all.filter((t) => t !== primary)];
}
