/**
 * 一段式抽取：一次 LLM 调用做完 检测 + 成卡 + 定性 + drop 记账。
 *
 * 设计依据 design/ONE_STAGE_EXTRACT.md（§三 输入、§四 输出契约、§五 触发与降级）。
 * 取代旧的两段式（lib/trigger-scan.ts 发现候选 → lib/knowledge-extract.ts 写成卡片）：
 * 两段式实测 855 条消息花掉 入 79k / 出 156k token，而第一段的全部产出只是
 * "哪几条可能有货 + 一句理由"——成本与产出严重不匹配（TRIGGER_PLAN §4.6）。
 *
 * 三条防退化设计（详见 §四）：
 *  1. cards 可以为空，但 drops 或 no_value 必须有一个——"看了没抽"必须留痕
 *  2. value 不允许填 P3（模型自说自话）：P3 一律进 drops，写进契约而非建议
 *  3. system prompt 字节级稳定（不含时间戳/主题清单/批次号），变化内容全放 user
 *     message，以吃 prompt cache（§5.2.1）
 *  4. **每条 user 消息必须有归属**（进卡 or 进 drops），否则判不合格重跑；重跑仍缺就代码兜底补账
 *     （reason="模型未申报"）。加这条是因为实测抓到真漏检：两条 P0 用户消息（三项架构决策、
 *     一次术语纠正）确实进了批次、全文未压缩，模型却既没出卡也没记 drop——静默忽略。
 *     只强制 user 消息（量小、是 P0 信号主载体），assistant/tool 消息只统计 unaccounted 不强制。
 */
import { chatComplete, extractJsonFromText, type ChatUsage } from "./llm.ts";
import {
  categoryForType, defaultAtomType, isDocType, keepAsForType, requiresExpiry,
  COPY_RATIO_MAX, OVERLAP_MIN_BODY_CHARS, DOC_TYPE_SPEC,
} from "./admission.ts";
import { atomId, type AtomSource, type KnowledgeAtom } from "./atom-store.ts";
import type { ExtractLine } from "./compress.ts";
import type { MessageEntry } from "./types.ts";

// COPY_RATIO_MAX / OVERLAP_MIN_BODY_CHARS 定义在 admission.ts（准入规则是它的执行方）
export { COPY_RATIO_MAX, OVERLAP_MIN_BODY_CHARS };

export const VALUE_TIERS = ["P0", "P1", "P2"] as const;
export type ValueTier = (typeof VALUE_TIERS)[number];

export const DROP_AXES = ["稀缺性=0", "验证性=0", "复现性=0", "—"] as const;

export interface OneStageSource {
  msg_ids: string[];
  quote: string;
}

export interface OneStageCard {
  type: string;
  title?: string;
  body: string;
  why_lose: string;
  expires_when?: string | null;
  domain: string;
  source: OneStageSource;
  grounding?: string;
  value?: string;
  need_context?: string[];
  /** 结构化字段透传（step / concept_name / definition / problem / root_cause …） */
  [k: string]: unknown;
}

export interface OneStageDrop {
  msg_ids: string[];
  reason: string;
  axis?: string;
}

export interface OneStageOutput {
  cards: OneStageCard[];
  drops: OneStageDrop[];
  noValue: boolean;
  /** false = 格式不合格（JSON 解析失败 / 缺 drop 账 / user 消息没交代）→ 允许重跑一次；模型明确 no_value 不算不合格 */
  formatOk: boolean;
  formatError?: string;
  /** JSON 本身解析成功（false 时禁止兜底补账，否则会把整批伪造成"已审"而永久丢消息） */
  jsonOk: boolean;
  /** 批内既没进卡、也没进 drop、也没申请回读的 msg_id（观测指标，不强制） */
  unaccounted: string[];
  /** 其中属于 user 消息的：契约强制交代，非空即 formatOk=false */
  userUnaccounted: string[];
  /** 代码兜底补的账条数（reason="模型未申报"） */
  autoDropped: number;
}

export interface ParseOptions {
  /** 批内 user 消息 id 集合；传了就启用"每条 user 消息必须有归属"的契约检查 */
  userIds?: Set<string>;
}

/**
 * system prompt：**字节级稳定**，不接受任何参数。
 * 主题清单、已知卡片、批次内容一律放 user message，否则 prompt cache 全部失效（§5.2.1）。
 */
export function extractSystemPrompt(): string {
  return `你是知识抽取器。输入是一段 coding agent 会话的**一批消息**（已分级压缩，每条带真实 msg id）。一次调用里你要做完四件事：判断有没有值得长期留存的知识 → 写成知识卡片 → 定性（类型/失效/损失）→ 把"看了但没要"的记进 drop 账。

## 一、三条判定轴（任一为零就不值得存，进 drops）
- **稀缺性**：这段对话之外还能轻易得到吗？能 → 零。（通用最佳实践、官方文档里的常识、网上搜得到的，都是零）
- **验证性**：被现实检验过吗？跑通了、测过了、用户拍板了 → 有；只是模型推测 → 零。
- **复现性**：下次遇到同类情况还用得上吗？一次性的环境状态、当次进度 → 零。

## 二、价值分级（决定优先级，也决定能不能出卡）
- **P0 人 → 模型**：用户纠正/推翻模型、用户的决策与被否方案、用户给的口径与偏好。**最高价值，优先出卡。**
- **P1 世界 → 模型**：工具结果验证或推翻了假设、意外现象、报错与根因。
- **P2 文档 → 模型**：从资料/文件里读到的项目私有事实。
- **P3 模型自说自话**：模型自己流畅生成的解释、总结、方案陈述。**一律不许出卡，必须进 drops（reason 填 "P3自说自话"）。**

## 三、反摘要禁令（这一节最重要，违反即视为失败输出）
你在做的**不是总结这段对话**，而是筛选稀有的高价值信号。摘要求覆盖（漏了算失败），抽取求筛选（灌水算失败）。因此：
1. **不要叙述对话流程**（"用户先问了 X，然后助手做了 Y"）——这是摘要，不是知识。
2. **不要为每个话题都凑一条卡片**。这批消息出 0 张卡是完全正常的结果；855 条消息只出 38 张才是正常工作量。
3. **不要概括助手的解释性长文**（架构讲解、原理解释、方案陈述）——那是 P3。
4. 每张卡必须能回答：**下次遇到同样情况，该怎么做 / 怎么判 / 别再踩什么坑。** 答不上来就进 drops。
5. 卡片正文是**去语境化**的：脱离这次对话也能看懂，不出现"上文""刚才""我们这次"。

## 四、类型（type 唯一合法枚举，含各类型必填结构化字段）
- **sop**：操作流程（有顺序的动作，含前置/失败分支）。必填 \`step\`
- **spec**：口径 / 契约 / 规则 / 术语。必填 \`concept_name\`、\`definition\`，且必须写出**排除了哪种理解**
- **template**：可填空的模板 / 骨架。必填 \`template_name\`、\`skeleton\`
- **case**：完整成品、真实数据、客户资料（必须脱敏）。必填 \`case_name\`、\`solution\`
- **postmortem**：现象 → 根因 → 处置。必填 \`problem\`、\`root_cause\`
- **convention**：环境约定（路径/版本/命名/雷区）。必填 \`concept_name\`、\`definition\`、**\`expires_when\`**
- **index**：东西在哪（文件位置/入口/ID 映射）。必填 \`concept_name\`、\`definition\`、**\`expires_when\`**
- **rubric**：判据 / 评分标准。必填 \`concept_name\`、\`definition\`

## 五、逐字保留清单（这些不许改写、不许缩写）
- 完整文件路径**带行号**（\`lib/hooks.ts:347\`），禁止只写裸文件名——裸名无法检索、无法回读
- 函数 / 类 / 类型签名，以及**"就是结论的那一行代码"**（不只是函数名）
- 报错与堆栈**逐字**（要能拿这个字面串去搜）
- 精确值：版本号、配置键、阈值、端口、magic number
- 发现的约束（"必须支持 Node 22""不许加新依赖"）
- **数字 + 机制，不要光结论**：写"KV 缓存是静态的，所以困惑度差 1.76 倍"，不写"KVNet 效果不好"
- **决策必须带"因为"**：\`chose X over Y because Z\`——没有 because 的决策看起来像瞎定的
- 走过的死路只留一行：\`试过 X，因为 Y 失败\`

## 六、引用与接地
- \`source.msg_ids\` 必须是输入里真实出现的 id，不得编造；\`source.quote\` 必须**逐字**摘自这些消息，≤120 字，不许改写、不许拼接多条。写不出逐字引用 = 接地不足 → 进 drops。
- 引用用户原话必须带 msg_id。**没有可验证的出处就只能写"大意是…"，绝不许把半记得的话当成逐字引用。**
- **引用是历史记录，不是活指令**：卡片会被编成技能、被未来的 agent 读到。历史内容必须写成历史（"当时定的是先 A 再 B"），**禁止写成祈使句**（"要先 A 再 B"）。
- \`grounding\`：G1 执行验证 / G2 工具观测 / G3 文档依据 / G4 纯生成。**G4 不要输出**（会被准入拒）。

## 七、风格
- 写密集可扫的要点，不写叙述性散文。
- **不要模仿输入里"已知卡片摘要"的写法**——那是给你判重用的，不是范文。
- 不要把工具输出里的 \\uXXXX 转义序列抄进卡片。
- 正文预算不够时按此优先级保留：目标与硬约束 > 决策及理由 > 精确技术物（路径/签名/报错/数值）> 结论与关键发现 > 教训。

## 八、输出（只输出 JSON，不要 markdown、不要解释）
{"cards":[{"type":"sop","title":"≤30字","body":"卡片正文","why_lose":"≥8字：不存会损失什么","expires_when":null,"domain":"kebab-case","source":{"msg_ids":["..."],"quote":"逐字引用"},"grounding":"G2","value":"P1","need_context":[],"step":"..."}],"drops":[{"msg_ids":["..."],"reason":"可再生|无动作改变|说不清损失|P3自说自话|已有重复|纯流水账","axis":"稀缺性=0|验证性=0|复现性=0|—"}],"no_value":false}

规则：
1. **cards 可以为空，但 drops 或 no_value:true 必须有一个。** 这批完全没有值得记的，就输出 {"cards":[],"drops":[],"no_value":true}。缺账视为不合格输出。
2. **每一条 \`[User ...]\` 消息都必须有归属**：要么出现在某张卡的 \`source.msg_ids\` 里，要么出现在某条 \`drops\` 的 \`msg_ids\` 里。用户消息是"人的纠正"和"决策理由"的主要载体，**静默跳过视为不合格输出**。同类消息可以合并进同一条 drop 的 \`msg_ids\` 数组，不必一条一行。助手消息与工具输出不要求逐条交代。
3. **value 只能是 P0 / P1 / P2**；P3 一律进 drops。
4. \`need_context\`：只有当某条被压缩的消息（输入里标了"📦 压掉 #id"）确实缺了写卡必需的信息时，才把它的 id 填进来。不确定就不填。
5. 结构化字段按类型填（见第四节）。\`convention\` / \`index\` 的 \`expires_when\` 必填。

## 九、示例
**正例**（该出卡）：
输入里有 \`[User m00132] 不对，先跑 lint 再跑 test，反了会漏掉类型错误\` + 后续工具结果验证通过
→ {"cards":[{"type":"sop","title":"提交前先 lint 再 test","body":"顺序：1) lint 2) test。反过来会漏掉类型错误（用户 m00132 纠正，后经执行验证）。","why_lose":"顺序错了会漏检类型错误，返工一轮","domain":"ci-workflow","source":{"msg_ids":["m00132"],"quote":"不对，先跑 lint 再跑 test，反了会漏掉类型错误"},"grounding":"G1","value":"P0","need_context":[]}],"drops":[],"no_value":false}

**反例**（该进 drops，不要出卡）：
输入里有一段结构漂亮的架构讲解，全是助手自己写的
→ {"cards":[],"drops":[{"msg_ids":["m00210","m00211"],"reason":"P3自说自话","axis":"验证性=0"}],"no_value":false}`;
}

export interface UserPromptParts {
  /** 上一批最后 1 轮（只读，禁止从中出卡） */
  overlap?: ExtractLine[];
  /** 本批消息 */
  batch: ExtractLine[];
  /** 已有主题清单（防主题被拆碎） */
  domainOptions?: string[];
  /** 同主题近期卡片标题（判重用） */
  knownCards?: string[];
  domainHint?: string;
}

/** user prompt：所有会变化的内容都在这里，顺序固定（§3.3） */
export function buildUserPrompt(parts: UserPromptParts): string {
  const out: string[] = [];
  if (parts.overlap && parts.overlap.length > 0) {
    out.push(
      "[只读上下文：上一批的最后一轮，仅供理解跨批的因果关系，**禁止从中出卡**]\n" +
        parts.overlap.map((l) => l.text).join("\n\n"),
    );
  }
  out.push("[本批消息]\n" + parts.batch.map((l) => l.text).join("\n\n"));
  if (parts.domainOptions && parts.domainOptions.length > 0) {
    out.push(`[已有主题清单] domain **必须优先从下列里选一个，不要自拟**：${parts.domainOptions.join(" / ")}`);
  } else {
    out.push(`[主题] domain 用 kebab-case 英文；不确定就用 ${parts.domainHint ?? "general"}`);
  }
  if (parts.knownCards && parts.knownCards.length > 0) {
    out.push(`[已知卡片摘要（判重用，不要模仿其写法）]\n${parts.knownCards.map((t) => `- ${t}`).join("\n")}`);
  }
  out.push("请按 system 里的规则处理这批消息，只输出 JSON。");
  return out.join("\n\n");
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/**
 * 摘抄率：**卡片正文的 16 字碎片，有多大比例逐字出现在原文里**。
 *
 * 方向很要紧，这里写反过一次（2026-11-12 操作型会话实测抓到）：原先算的是"quote 的碎片
 * 有多少落在正文里"，于是"模型引一句 4 个字的原文、自己写 356 字分析"被判成 100% 摘抄。
 * 那轮 5 张被拒卡片的真实摘抄率是 5% / 10% / 13% / 20% / 38%，全在阈值内——闸门一张真摘抄
 * 没抓到，却制造了当轮 6 张被拒里的 5 张，其中 4 张是 P0。
 *
 * 比对对象也一并换了：原来是模型自己挑的那句 quote，现在传 msg_range 里的**全部原文**。
 * 只比 quote 太窄——正文可以抄区间内别处而绕过闸门；而且 quote 短的时候（≤16 字）
 * 旧实现直接返回 1，等于"引一句短话就必死"。
 */
export function copyRatio(source: string, body: string, shingle = 16): number {
  const s = String(source ?? "").replace(/\s+/g, "");
  const b = String(body ?? "").replace(/\s+/g, "");
  if (!s || !b) return 0;
  // 正文短于一个碎片时谈不上"比例"（短卡另有 OVERLAP_MIN_BODY_CHARS 豁免）
  if (b.length <= shingle) return s.includes(b) ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + shingle <= b.length; i += shingle) {
    total++;
    if (s.includes(b.slice(i, i + shingle))) hit++;
  }
  return total > 0 ? hit / total : 0;
}

interface RawCard {
  [k: string]: unknown;
}

/** 解析输出；formatOk=false 才允许重跑（模型明确 no_value 是行使否决权，绝不重跑） */
export function parseOneStageOutput(
  text: string,
  validIds: Set<string>,
  opts: ParseOptions = {},
): OneStageOutput {
  const json = extractJsonFromText(text);
  if (!json) {
    return {
      cards: [], drops: [], noValue: false, formatOk: false, formatError: "JSON 解析失败",
      jsonOk: false, unaccounted: [...validIds], userUnaccounted: [], autoDropped: 0,
    };
  }
  let parsed: { cards?: unknown; drops?: unknown; no_value?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch (e) {
    return {
      cards: [], drops: [], noValue: false, formatOk: false,
      formatError: `JSON 非法: ${String(e).slice(0, 80)}`,
      jsonOk: false, unaccounted: [...validIds], userUnaccounted: [], autoDropped: 0,
    };
  }

  const rawCards = Array.isArray(parsed.cards) ? (parsed.cards as RawCard[]) : [];
  const cards: OneStageCard[] = [];
  const p3Drops: OneStageDrop[] = [];
  for (const raw of rawCards) {
    if (!raw || typeof raw !== "object") continue;
    const src = (raw.source ?? {}) as { msg_ids?: unknown; quote?: unknown };
    const msgIds = (Array.isArray(src.msg_ids) ? src.msg_ids : [])
      .map((x) => String(x))
      .filter((x) => validIds.has(x));
    const body = String(raw.body ?? raw.content ?? "").trim();
    const value = String(raw.value ?? "").toUpperCase();
    // P3 一律不许出卡（契约级），降级成 drop 而不是静默丢弃
    if (value === "P3") {
      p3Drops.push({ msg_ids: msgIds, reason: "P3自说自话", axis: "验证性=0" });
      continue;
    }
    if (body.length < 8 || msgIds.length === 0) continue;
    cards.push({
      ...(raw as RawCard),
      type: String(raw.type ?? raw.doc_type ?? ""),
      title: raw.title == null ? undefined : String(raw.title),
      body,
      why_lose: String(raw.why_lose ?? raw.why ?? "").trim(),
      expires_when:
        typeof raw.expires_when === "string" && raw.expires_when.trim() ? raw.expires_when.trim() : null,
      domain: String(raw.domain ?? "").trim(),
      source: { msg_ids: msgIds, quote: clip(String(src.quote ?? "").trim(), 200) },
      grounding: ["G1", "G2", "G3", "G4"].includes(String(raw.grounding)) ? String(raw.grounding) : undefined,
      value: (VALUE_TIERS as readonly string[]).includes(value) ? value : undefined,
      need_context: Array.isArray(raw.need_context)
        ? (raw.need_context as unknown[]).map((x) => String(x)).filter((x) => validIds.has(x))
        : [],
    } as OneStageCard);
  }

  const rawDrops = Array.isArray(parsed.drops) ? (parsed.drops as Array<Record<string, unknown>>) : [];
  const drops: OneStageDrop[] = rawDrops
    .filter((d) => !!d && typeof d === "object")
    .map((d) => ({
      msg_ids: (Array.isArray(d.msg_ids) ? d.msg_ids : [])
        .map((x) => String(x))
        .filter((x) => validIds.has(x)),
      reason: clip(String(d.reason ?? "").trim(), 120),
      axis: (DROP_AXES as readonly string[]).includes(String(d.axis)) ? String(d.axis) : "—",
    }));

  const allDrops = [...drops, ...p3Drops];
  const noValue = parsed.no_value === true;

  // 归属核算：进卡 / 进 drop / 申请回读 都算"交代过了"
  const accounted = new Set<string>();
  for (const c of cards) {
    for (const id of c.source.msg_ids) accounted.add(id);
    for (const id of c.need_context ?? []) accounted.add(id);
  }
  for (const d of allDrops) for (const id of d.msg_ids) accounted.add(id);
  // no_value:true 是对整批的显式声明，等于全部交代（否决权边界：绝不因此重跑）
  const unaccounted = noValue ? [] : [...validIds].filter((id) => !accounted.has(id));
  const userUnaccounted = opts.userIds && !noValue
    ? unaccounted.filter((id) => opts.userIds!.has(id))
    : [];

  const reasons: string[] = [];
  // 缺账 = 不合格：cards 空且 drops 空且没声明 no_value
  if (cards.length === 0 && allDrops.length === 0 && !noValue) {
    reasons.push("缺 drop 账（cards/drops 皆空且未声明 no_value）");
  }
  if (userUnaccounted.length > 0) reasons.push(`${userUnaccounted.length} 条 user 消息未交代`);
  const formatOk = reasons.length === 0;

  return {
    cards,
    drops: allDrops,
    noValue,
    formatOk,
    formatError: formatOk ? undefined : reasons.join("；"),
    jsonOk: true,
    unaccounted,
    userUnaccounted,
    autoDropped: 0,
  };
}

/**
 * 代码兜底：重跑后仍有 user 消息没交代，就替模型补一条账，不让整批白跑。
 *
 * 只在 jsonOk 时可用——JSON 都没解析出来时 unaccounted 是全部消息，
 * 补账等于把整批伪造成"已审过"并推进水位，那批消息就永久丢了。
 * 补的账 reason 固定为"模型未申报"，与模型自己给的理由区分开，便于事后统计漏检率。
 */
export function autoFillDrops(out: OneStageOutput): OneStageOutput {
  if (!out.jsonOk || out.userUnaccounted.length === 0) return out;
  const filled: OneStageDrop[] = out.userUnaccounted.map((id) => ({
    msg_ids: [id],
    reason: "模型未申报",
    axis: "—",
  }));
  const drops = [...out.drops, ...filled];
  const missingAll = out.cards.length === 0 && drops.length === 0 && !out.noValue;
  return {
    ...out,
    drops,
    autoDropped: out.autoDropped + filled.length,
    userUnaccounted: [],
    formatOk: !missingAll,
    formatError: missingAll ? "缺 drop 账（cards/drops 皆空且未声明 no_value）" : undefined,
  };
}

/** msg_ids → 会话里的 [起, 止] 区间（按 entries 顺序取最小/最大） */
export function rangeFromIds(entries: MessageEntry[], ids: string[]): [string, string] | null {
  const idx = ids.map((id) => entries.findIndex((e) => e.id === id)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  return [entries[lo].id, entries[hi].id];
}

/** 卡片 → KnowledgeAtom（数据层字段名保持不变：content / why / doc_type / atom_*） */
export function cardToAtom(
  card: OneStageCard,
  entries: MessageEntry[],
  sessionId: string,
  seq: number,
  domainHint?: string,
): KnowledgeAtom | { error: string } {
  const docType = card.type;
  if (!isDocType(docType)) return { error: `doc_type 非法: ${docType}` };
  const range = rangeFromIds(entries, card.source.msg_ids);
  if (!range) return { error: "source.msg_ids 不在会话里" };
  if (requiresExpiry(docType) && !card.expires_when) return { error: `${docType} 缺 expires_when` };

  const source: AtomSource = {
    session_id: sessionId,
    window_id: `sig_${sessionId.replace(/^session-/, "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}_${String(seq).padStart(3, "0")}`,
    msg_range: range,
  };
  const atom: KnowledgeAtom = {
    atom_id: atomId(card.body, [source]),
    category: categoryForType(docType),
    atom_type: String(card.atom_type ?? "") || defaultAtomType(docType),
    content: card.body,
    domain: card.domain || domainHint || "general",
    sources: [source],
    confidence: typeof card.confidence === "number" ? card.confidence : 0.75,
    version: 1,
    superseded_by: null,
    refs: [],
    status: "draft",
    extracted_at: new Date().toISOString(),
    extracted_by: "signal-distill",
    doc_type: docType,
    keep_as: keepAsForType(docType),
    why: card.why_lose,
    expires_when: card.expires_when ?? null,
    origin: "signal",
  };
  if (card.title) atom.title = card.title;
  if (card.grounding) atom.grounding = card.grounding;
  if (card.value) atom.value_tier = card.value;
  if (card.source.quote) atom.source_quote = card.source.quote;
  // 结构化字段透传（只接受标量与标量数组，防模型塞嵌套垃圾）
  const skip = new Set([
    "type", "doc_type", "title", "body", "content", "why_lose", "why", "domain",
    "confidence", "grounding", "expires_when", "atom_type", "source", "value", "need_context",
  ]);
  for (const [k, v] of Object.entries(card)) {
    if (skip.has(k) || v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") atom[k] = v;
    else if (Array.isArray(v)) atom[k] = v.filter((x) => typeof x === "string" || typeof x === "number");
  }
  return atom;
}

export interface OneStageBatchOptions {
  model?: string;
  signal?: AbortSignal;
  overlap?: ExtractLine[];
  domainOptions?: string[];
  knownCards?: string[];
  domainHint?: string;
  /** 格式不合格时的重跑次数（默认 1；模型 no_value 不重跑） */
  retries?: number;
}

export interface OneStageBatchResult {
  output: OneStageOutput;
  usage?: ChatUsage;
  ms: number;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
}

/** 单批一次调用；只在格式不合格时重跑（veto 边界：模型说没货绝不追问） */
export async function runOneStageBatch(
  batch: ExtractLine[],
  opts: OneStageBatchOptions = {},
): Promise<OneStageBatchResult> {
  const retries = opts.retries ?? 1;
  const validIds = new Set(batch.map((l) => l.id));
  // 契约只对 user 消息强制交代（量小、是 P0 信号主载体）
  const userIds = new Set(batch.filter((l) => l.role === "user").map((l) => l.id));
  const system = extractSystemPrompt();
  const user = buildUserPrompt({
    overlap: opts.overlap,
    batch,
    domainOptions: opts.domainOptions,
    knownCards: opts.knownCards,
    domainHint: opts.domainHint,
  });

  let attempts = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let usage: ChatUsage | undefined;
  const t0 = Date.now();
  let last: OneStageOutput = {
    cards: [], drops: [], noValue: false, formatOk: false, formatError: "未调用",
    jsonOk: false, unaccounted: [...validIds], userUnaccounted: [], autoDropped: 0,
  };

  while (attempts <= retries) {
    attempts++;
    const res = await chatComplete({ system, user, model: opts.model, signal: opts.signal });
    usage = res.usage;
    tokensIn += res.usage?.promptTokens ?? 0;
    tokensOut += res.usage?.completionTokens ?? 0;
    last = parseOneStageOutput(res.text, validIds, { userIds });
    if (last.formatOk) break; // 合格（含 no_value）→ 立即返回，不追问
    if (opts.signal?.aborted) break;
  }
  // 重跑用尽仍不合格、但 JSON 是合法的 → 代码兜底补账，别让整批白跑
  if (!last.formatOk && last.jsonOk) last = autoFillDrops(last);
  return { output: last, usage, ms: Date.now() - t0, attempts, tokensIn, tokensOut };
}

/**
 * quote 是否逐字出自这些消息（模型实际看到的压缩文本）。
 *
 * **只打标记、不做硬闸门**（2026-11-12 决议）：实测违规 1/38，而那唯一一例是
 * "注释写默认 false，但代码是 if (config.enabled === false) return" ——注释和代码
 * 都在引用区间内，模型只是把两处合成了一句。这类卡往往最有价值（发现了代码与注释
 * 不一致），硬闸门会把它连同真摘抄一起杀掉。标记交给人确认环节判断。
 *
 * 比对时忽略所有空白差异：原文按行分隔，模型引用时可能把换行写成空格。
 */
export function quoteIsVerbatim(quote: string, sourceTexts: Array<string | undefined>): boolean {
  const norm = (x: string) => x.replace(/\s+/g, "");
  const q = norm(String(quote ?? ""));
  if (!q) return false;
  return sourceTexts.some((t) => !!t && norm(t).includes(q));
}

/** 名字类必填字段：可以用卡片自己的 title 代填（名字替代名字，不产生新信息也不丢信息） */
const NAME_FIELDS = new Set(["concept_name", "template_name", "case_name"]);

/**
 * 特化字段缺失时的代填与登记（2026-11-12 两次决议）。返回**待补字段清单**（同时写进 `pending_fields`）。
 *
 * 分两类处理，这个区分是实测逼出来的：
 * - **名字类**（`concept_name` / `template_name` / `case_name`）→ 用卡片自己的 `title` 代填
 *   （title 为空退回 `domain`）。名字替代名字是合理的。
 * - **内容类**（`definition` / `step` / `problem` / `root_cause` / `solution` / `skeleton` / `result`）
 *   → **不填，只记待补**。第一版拿正文全文去充，结果 `problem` 和 `root_cause` 变成同一段
 *   正文的副本（实测 6 处）——比缺字段更糟：字段看着有值，下游选材会被骗，人也不会再去补。
 *
 * 抽取路径已不再强制特化字段（`validateAtom(..., { requireSpecialized: false })`），所以这个
 * 函数现在的职责是「代填名字 + 登记观测指标」，不再是「救回被拒卡片」。
 * 回填 / 人工录入等其他入口仍然严格，缺字段照拒。
 */
export function fillMissingSpecialized(atom: KnowledgeAtom): string[] {
  if (!isDocType(atom.doc_type)) return [];
  const rec = atom as Record<string, unknown>;
  const title = String(rec.title ?? "").trim();
  const pending: string[] = [];
  for (const f of DOC_TYPE_SPEC[atom.doc_type].required) {
    const v = rec[f];
    if (v != null && !(typeof v === "string" && v.trim() === "")) continue;
    if (NAME_FIELDS.has(f)) {
      const sub = title || String(atom.domain ?? "").trim();
      if (sub) rec[f] = sub; // 代填成功；仍记进 pending 表示"推导来的、不是模型申报的"
    }
    pending.push(f);
  }
  if (pending.length) {
    const prev = Array.isArray(rec.pending_fields) ? (rec.pending_fields as unknown[]).map(String) : [];
    rec.pending_fields = [...new Set([...prev, ...pending])];
  }
  return pending;
}
