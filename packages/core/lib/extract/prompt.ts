/**
 * 抽取 prompt 构造（存的分诊版）。
 *
 * 与旧版的三处关键差异：
 *  1. 不再注入 44 切片清单——实测 41% 的知识卡片切片名是模型自造的，该枚举已失效；
 *     改为 8 个文档类型，模型只判类型，分类/去向由 admission.ts 查表。
 *  2. 强制 why（不存会损失什么）作为价值证据，写不出就不输出。
 *  3. 明确承认"人给的工件"（模板/资料/客户材料）是独立价值来源，不再只盯摩擦点。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface CatalogSlice {
  atom_type: string;
  definition: string;
  schema_fields: string[];
  optional?: boolean;
}
export interface CatalogCategory {
  category: string;
  name: string;
  purpose: string;
  assembly: string;
  slices: CatalogSlice[];
}

const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // lib/ → packages/core → packages → 仓库根

/** 旧版 44 切片清单：保留给 legacy 校验与展示，不再进抽取 prompt */
export function loadCatalog(): CatalogCategory[] {
  const raw = readFileSync(join(MONOREPO_ROOT, "design", "SLICE_CATALOG.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed.categories as CatalogCategory[];
}

/** 已知业务主题提示（LLM 可自拟 kebab-case 英文名） */
const DOMAIN_HINTS = `fault-diag-rl / trans-term-retrieve / pi-ops / gpu-train-ops / eval-methodology / xeno-agent / rl-training / 其他（自拟 kebab-case 英文名）`;

/** 8 类型清单（文档形态，不是内容碎片） */
const TYPE_TABLE = `- sop（操作SOP）：按时间顺序的动作序列，含前置条件、失败分支、回滚。必填 step，可填 command/checkpoints/exceptions。
- spec（口径契约）：判定标准、字段契约、硬性规则、术语定义。必须写出"排除了哪种看似合理的理解"。必填 concept_name、definition，可填 boundary、rules。
- template（模板骨架）：可填空的交付物骨架 / 提示词模板 / 检查清单。必填 template_name、skeleton，可填 fields。
- case（案例资料）：完整成品、真实数据、客户材料（脱敏）。必填 case_name、solution、result，可填 background/applicable_conditions。
- postmortem（问题复盘）：现象 → 根因 → 处置。根因必须有证据支持，未验证只能写"假设：…"。必填 problem、root_cause，可填 scenario/impact/temp_fix/permanent_fix。
- convention（环境约定）：路径、版本、命名、雷区等环境事实。必填 concept_name、definition，且必须写 expires_when。
- index（索引线索）：东西在哪（文件位置、服务入口、ID 映射）。definition 写位置。必填 concept_name、definition，且必须写 expires_when。
- rubric（判据标准）：评分维度、等级定义、gold 示例。必填 concept_name、definition，可填 rules。`;

export function buildSystemPrompt(): string {
  return `你是知识库的分诊器。输入是一段 coding agent 对话窗口（每条消息方括号内是真实消息 id）。
你的工作分两步：先把窗口里的知识拆成**最小可复用单元**，再判断每个单元该不该入库、属于哪种文档。

## 第一关：三个问题（任一答"否"就不抽，不要输出）
1. **可再生吗**：不存它，未来能不能低成本重新得到？（模型本来就会 / 跑一次命令就有 / 代码文档里已写 → 不抽）
2. **会改变动作吗**：未来会不会影响某个做法或判断？（只是提供背景、不影响怎么做 → 不抽）
3. **说得出损失吗**：能不能写出一句"不存会导致什么"的具体后果？（写不出 → 不抽）

注意：**不要只盯"人的纠正/决策/验证"**。人给的模板、资料、客户材料同样是高价值工件——只要它们过上面三问。

## 第二关：拆解
一段对话常含好几件事。典型：用户贴了一份客户资料 + 解释了一个口径 + 要求照着做成模板 = **三件事**，拆成三条知识卡片。
一个单元只讲一件事；不要把三件事塞进一个 content。

## 第三关：定类型（doc_type 唯一合法枚举，8 选 1）
${TYPE_TABLE}

## 硬规则
1. why **必填**（≥8 字）：写"不存会损失什么"的具体后果。禁止"有价值""重要""可复用"这类空话。
2. convention / index 的 expires_when **必填**（版本升级 / 路径迁移 / 系统下线等）；写不出失效条件就不要用这两个类型。
3. spec 必须体现排他性：写出被排除的那种理解（打进 definition 或 boundary）。没有排他性的定义等于常识，不抽。
4. postmortem 的 root_cause 必须有证据；未验证只能写"假设：…"，并降 confidence。
5. 不要写 category——分类由系统按类型查表推出。
6. ground：G1 执行验证 / G2 工具观测 / G3 文档依据 / G4 纯生成。**G4 默认不抽**（人的陈述、决策、口径例外）。
7. msg_range 用窗口内真实消息 id；结论与它的证据（工具结果 / 用户原话）应落在同一区间。
8. content 要脱离本对话也能看懂；去掉 API key、手机号、邮箱、证件号等敏感信息。若一条内容本身是客户资料（case + data），**必须彻底脱敏**，否则系统会拒收。
9. domain 用 kebab-case 英文：${DOMAIN_HINTS}
10. 宁缺毋滥。一条窗口抽出 0 条也是正常结果。

## 输出
只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"atoms":[{"doc_type":"sop","content":"...","why":"...","domain":"...","confidence":0.8,"grounding":"G1","msg_range":["id1","id2"],"expires_when":null,"atom_type":"可选细标签","step":"...","command":"..."}]}
字段说明：doc_type / content / why / domain / confidence / grounding / msg_range 必填；expires_when 与 atom_type 可选；其余为该类型的结构化字段。atoms 为空输出 {"atoms":[]}。`;
}

export function buildUserPrompt(windowText: string): string {
  return `以下是对话窗口内容：\n\n${windowText}\n\n请按三关分诊并抽取，只输出 JSON。`;
}

// ---------------- skill 使用反馈判定（usage 审计用） ----------------

/** 窗口是否可能含 skill 使用（无 SKILL.md 字样则直接跳过反馈扫描，零额外成本） */
export function windowMentionsSkill(windowText: string): boolean {
  return windowText.includes("SKILL.md");
}

export interface SkillVerdictRaw {
  skill: string; // domain 名（从路径 skills/<domain>/SKILL.md 提取）
  verdict: "accepted" | "rejected" | "unclear";
  evidence: string; // ≤200 字，窗口内的原文依据
}

export function buildSkillFeedbackSystemPrompt(): string {
  return `你是 skill 使用审计器。输入是一段 pi coding agent 的对话窗口文本。
窗口中若模型读取了某个 skill 的 SKILL.md（形如 skills/<domain>/SKILL.md），判断后续走向：

- accepted：读取后，user 或 assistant 的言行**遵循**了该 skill 的指引/流程/概念体系（按其步骤执行、引用其术语、产出符合其产出契约）。
- rejected：读取后，user **修正或推翻**了该 skill 的指引（明确说不对/换方案），或后续行为明显背离其流程且被现实打回。
- unclear：读而未用（加载后没走它的流程）、证据不足、或读取后窗口就结束了。

规则：
1. 只判定窗口内真实出现过的 skill；路径没匹配到 <domain> 的忽略。
2. verdict 必须有原文依据：accepted 引述遵循动作，rejected 引述修正言论。没有依据就不判。
3. 一个 skill 在窗口内只输出一条结论性判定（多处交互取最终权重最大的一次）。
4. 宁可 unclear 也不要猜。
5. 只输出一个 JSON 对象 {"verdicts":[...]}，不要 markdown 代码块、不要解释文字；窗口内没有使用任何 skill 则输出 {"verdicts":[]}。
字段：skill, verdict, evidence（≤200字）。`;
}

export function buildSkillFeedbackUserPrompt(windowText: string): string {
  return `以下是对话窗口内容：\n\n${windowText}\n\n请判定 skill 使用反馈，只输出 JSON。`;
}
