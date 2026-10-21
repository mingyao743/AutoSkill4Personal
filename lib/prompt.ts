/**
 * 抽取 prompt 构造：注入 SLICE_CATALOG.json（44 切片合法枚举）。
 * catalog 路径相对本模块解析，CLI 与 extension 共用。
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCatalog(): CatalogCategory[] {
  const raw = readFileSync(join(REPO_ROOT, "design", "SLICE_CATALOG.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed.categories as CatalogCategory[];
}

/** 已知业务域提示（LLM 可自拟 kebab-case 英文名） */
const DOMAIN_HINTS = `fault-diag-rl / trans-term-retrieve / pi-ops / gpu-train-ops / eval-methodology / xeno-agent / rl-training / 其他（自拟 kebab-case 英文名）`;

export function buildSystemPrompt(catalog: CatalogCategory[]): string {
  const catalogText = catalog
    .map(
      (c) =>
        `### ${c.category} ${c.name}（${c.purpose}）\n` +
        c.slices.map((s) => `- ${s.atom_type}：${s.definition}`).join("\n")
    )
    .join("\n\n");

  return `你是知识抽取器。输入是一段 pi coding agent 的对话窗口（含 user 提问、assistant 回答、工具调用与结果，每条消息方括号内是其真实消息 id）。
从窗口中抽取可复用的知识原子。

## 5 类知识 × 44 切片清单（atom_type 唯一合法枚举）
${catalogText}

## 抽取规则（严格遵守）
1. category 只能是两位数字码 "01"~"05"（不得带类名文字，如写 "01" 而非 "01 业务认知"）；atom_type 从清单原样取中文名，按类匹配（如"根因切片"只能出现在 05 类），不得发明新切片。
2. 每个原子按其切片的 schema_fields 填结构化字段：
   - 01 类必填 concept_name、definition；02 类必填 step；03 类必填 template_name、skeleton；04 类必填 case_name、solution、result；05 类必填 problem、root_cause。
   - 其余 schema_fields（如 02 的 command/checkpoints/exceptions、05 的 temp_fix/permanent_fix/improvements）有内容就填。
3. content：简洁、可独立复用（脱离本对话也能看懂）、去会话噪音、去掉敏感信息（API key、内部地址、人名邮箱）。
4. domain：推断业务域，取值参考：${DOMAIN_HINTS}。
5. confidence：0-1，自评**抽取动作**的把握（不衡量知识真伪——真伪由 grounding 分级与人工 review 承担）。
6. msg_range：[起始消息id, 结束消息id]，必须使用窗口内出现过的真实消息 id（方括号里的）；结论与其佐证（工具结果/用户陈述）应落在同一区间内。
7. 准入判定（宁缺毋滥，详见 design/EXTRACTION_PRINCIPLES.md）：每条候选过三轴——稀缺性（不在模型参数知识里、不可随取随再生）、验证性（被现实检验过）、复现性（未来任务会再遇到），任一为零不抽。优先抽六类高价值内容：
   - C1 人对模型的否定与修正（必须保留修正前后对照：错在哪、改成什么）
   - C2 决策及其理由（必须含被否路径与代价，孤立结论不抽）
   - C3 被验证过的经验性事实（命令执行/复测通过的世界反馈）
   - C4 人的领域知识与口径定义（多轮拉扯后收敛的最终表述优先）
   - C5 预期违背/惊讶时刻（归因已验证才可作 root_cause，未验证只能标注为假设）
   - C6 跨会话复现的隐性上下文（环境、约定、雷区）
   不抽：参数知识复述（通用问答）、正确但通用的建议、未验证的推测、任务流水账、闲聊/简单问答/纯环境检查。**专业感不是验证性**：推理流畅、术语准确但无证据链的内容不抽。
8. grounding（必填）：自评证据链分级，取值只能是 G1/G2/G3/G4：
   - G1 执行验证：结论与工具执行结果直接对应（复测通过更强）
   - G2 工具观测：读文件/日志/指标后归纳
   - G3 文档依据：复述项目文档/代码口径
   - G4 纯生成：区间无任何工具结果且无用户陈述佐证——默认不输出此类原子，除非确属 C1/C2/C4（人的陈述/决策/口径）价值。
   注意：msg_range 区间会被机械校验——区间内既无 toolResult 又无 user 消息的原子将被直接拒绝入库。
9. 先验规则：环境/版本/机器绑定的知识**必须**把成立前提写入先验字段（01 类 boundary / 02 类 prerequisites / 04 类 applicable_conditions / 05 类 scenario）；content 去语境化改写时，环境限定词要**迁移到先验字段而不是删除**；无证据不编造万金油先验（"适用于大多数系统"式假先验比缺失更糟）。
10. 权重与取优：优先扫描 user 消息及其紧邻上下文、否定与转折处（"不对""不是这个意思"）；同一口径多轮演化只抽最终收敛表述，中间版本丢弃；同一切片多处命中可分别输出（事后判重合并）。
11. 输出格式：只输出一个 JSON 对象 {"atoms":[...]}，不要 markdown 代码块、不要解释文字。字段：category, atom_type, content, domain, confidence, grounding, msg_range, 以及该切片的结构化字段。atoms 为空时输出 {"atoms":[]}。`;
}

export function buildUserPrompt(windowText: string): string {
  return `以下是对话窗口内容：\n\n${windowText}\n\n请抽取知识原子，只输出 JSON。`;
}
