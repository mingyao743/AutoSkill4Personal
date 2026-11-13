/**
 * 准入层：把"该不该存 / 是什么 / 存到哪"里能机械化的部分从模型判断中剥离。
 *
 * 三条边界（对应 design/STORE_PLAN 的核心判断）：
 *  - 类型（doc_type）是模型判的，但类型→分类、类型→去向是查表推的，模型不能自由发挥
 *  - 抓地性、来源、敏感信息是代码判的，模型自报不可信
 *  - 价值理由（why）强制模型写"不存会损失什么"，写不出就不入库
 *
 * 8 个类型是顶层上限。新增类型必须同时满足：用法不同 / 落的区块不同 / 校验不同。
 * diagnostic 是 sop 的子型；decision 是 spec 的 rationale+rejected 字段；
 * preference 跨主题，属于"全局层"，暂不建模。
 */
import type { AtomSource, KnowledgeAtom } from "./atom-store.ts";

export const DOC_TYPES = [
  "sop", // 操作流程：按什么顺序做
  "spec", // 口径/契约/规则：什么算对、必须遵守什么
  "template", // 骨架/模板：填空就能用
  "case", // 案例/资料：照着它做
  "postmortem", // 复盘：上次为什么炸
  "convention", // 环境约定：这环境的规矩
  "index", // 索引/线索：东西在哪
  "rubric", // 判据/评分标准：怎么算合格
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const KEEP_AS = ["instruction", "reference", "data"] as const;
export type KeepAs = (typeof KEEP_AS)[number];

interface DocTypeSpec {
  /** 展示分组（沿用 01-05，仅用于卡片目录与少量旧展示逻辑） */
  category: string;
  /** 默认去向 */
  keepAs: KeepAs;
  /** 中文名（日志与错误提示用） */
  label: string;
  /** 该类型必填的特化字段（validate 用；不进 schema 的通用字段） */
  required: string[];
  /** 细标签兜底（模型没给 atom_type 时用） */
  defaultAtomType: string;
}

/** 类型 → 分类 / 去向 / 必填字段。模型只判类型，其余查表。 */
export const DOC_TYPE_SPEC: Record<DocType, DocTypeSpec> = {
  sop: { category: "02", keepAs: "instruction", label: "操作SOP", required: ["step"], defaultAtomType: "动作切片" },
  spec: {
    category: "01",
    keepAs: "instruction",
    label: "口径契约",
    required: ["concept_name", "definition"],
    defaultAtomType: "规则切片",
  },
  template: {
    category: "03",
    keepAs: "instruction",
    label: "模板骨架",
    required: ["template_name", "skeleton"],
    defaultAtomType: "格式规范切片",
  },
  case: {
    category: "04",
    keepAs: "reference",
    label: "案例资料",
    required: ["case_name", "solution"],
    defaultAtomType: "案例基础信息切片",
  },
  postmortem: {
    category: "05",
    keepAs: "instruction",
    label: "问题复盘",
    required: ["problem", "root_cause"],
    defaultAtomType: "问题现象切片",
  },
  convention: {
    category: "01",
    keepAs: "instruction",
    label: "环境约定",
    required: ["concept_name", "definition"],
    defaultAtomType: "边界切片",
  },
  index: {
    category: "01",
    keepAs: "data",
    label: "索引线索",
    required: ["concept_name", "definition"],
    defaultAtomType: "关联对象切片",
  },
  rubric: {
    category: "01",
    keepAs: "instruction",
    label: "判据标准",
    required: ["concept_name", "definition"],
    defaultAtomType: "口径切片",
  },
};

export function isDocType(v: unknown): v is DocType {
  return typeof v === "string" && (DOC_TYPES as readonly string[]).includes(v);
}

export function isKeepAs(v: unknown): v is KeepAs {
  return typeof v === "string" && (KEEP_AS as readonly string[]).includes(v);
}

export function categoryForType(t: DocType): string {
  return DOC_TYPE_SPEC[t].category;
}

export function keepAsForType(t: DocType): KeepAs {
  return DOC_TYPE_SPEC[t].keepAs;
}

/** 模型没给细标签时的兜底（保证 atom_type 非空） */
export function defaultAtomType(t: DocType): string {
  return DOC_TYPE_SPEC[t].defaultAtomType;
}

/** 该类型是否必须写失效条件（易腐型） */
export function requiresExpiry(t: DocType): boolean {
  return t === "convention" || t === "index";
}

// ---------------- 准入规则 ----------------

/** key 泄漏（任何类型都拦） */
const SECRET_RE = /sk-[A-Za-z0-9]{20,}/;

/** 个人可识别信息（只对 data 类硬拦：资料层会被跨主题检索与转发） */
const PII_RULES: Array<{ name: string; re: RegExp }> = [
  { name: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "身份证号", re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
];

export function checkSensitive(text: string, opts: { pii?: boolean } = {}): string[] {
  const reasons: string[] = [];
  if (SECRET_RE.test(text)) reasons.push("疑似含 API key");
  if (opts.pii) {
    for (const r of PII_RULES) if (r.re.test(text)) reasons.push(`data 类疑似含${r.name}（需脱敏）`);
  }
  return reasons;
}

/**
 * 摘抄率上限（正文逐字抄自原文的比例）；超过判为"摘抄不是提炼"。
 * 借鉴 billion-context 的 net-benefit gate（摘要不比原文小就拒）。
 *
 * **0.6 这个阈值有实测支撑**（2026-11-12，操作型会话 49 张落库卡）：真实摘抄率
 * 中位 32%、P90 32%、最大 46%——阈值 0.6 留了足够余量，不误杀正常卡片；而真正
 * 逐字照抄的卡会远超 0.6。注意这是"方向纠正后"的分布，纠正前的旧指标不可比。
 */
export const COPY_RATIO_MAX = 0.6;

/** 短卡豁免：正文这么短就不查摘抄率（短卡天然接近原文，查了只会误杀） */
export const OVERLAP_MIN_BODY_CHARS = 100;

/**
 * 历史被写成祈使句的粗判（默认不拦，见 GateOptions.checkImperative）。
 * 卡片会进技能正文、被未来的 agent 读到——"要先 A 再 B" 会被当成当前指令执行，
 * "当时定的是先 A 再 B" 才是历史记录。billion-context 的生产事故 #309 就是这个。
 */
export function looksImperative(body: string): boolean {
  const t = String(body ?? "").trim();
  if (!t) return false;
  // 有历史标记就认为是历史记录
  if (/(当时|此前|原本|曾经|上次|后来改成|历史上|那会儿|彼时)/.test(t)) return false;
  // 祈使开头（含引用用户口吻）
  return /^(要|必须|应该|应当|请|别|不要|不得|务必|一定要|记住|注意[:：])/m.test(t);
}

/**
 * 状态快照 / 已结案复盘的粗判（默认不拦，见 GateOptions.checkTransience）。
 *
 * §三bis 的 prompt 约束才是主防线；这个函数是 prompt 漏判时的兜底，且**默认关**——
 * 中文机械判定误杀率高（§七#4：路径/数字正则有分词误报），开了会误伤
 * "含库存数字的恒久口径"这类。现阶段只产出 flag 供人工/观测，不作硬拒。
 *
 * 三类高置信信号：
 *  - 当前缺口/TODO（头部命中"补齐清单/缺口/待补/缺…表"）
 *  - 库存清单（正文有计数 + ≥2 个文件路径，且非 postmortem）
 *  - 已结案复盘（postmortem 且有"处置/已补/已修"标记、无可分离"失效模式/防范"）
 */
const TRANSIENT_GAP_RE = /(补齐清单|五缺口|缺口|待补|未实现|缺.{0,6}表|TODO|待办)/;
const TRANSIENT_COUNT_RE = /\d+\s*(主题|张|条|个|库|字段)/;
const TRANSIENT_PATH_RE =
  /(?:[\/~][^\s/]+\.(?:json|md|ts|js|py|yml|yaml|sh))|(?:theories|personas|records|scene-templates|归档)[\/ ]/g;
const TRANSIENT_RESOLVED_RE = /(处置[（(]?[A-Za-z批]?[)）]?[:：]|已补|已加|已修|已上线|已落地|修复后)/;
const TRANSIENT_LESSON_RE = /(失效模式|防范|下次.{0,6}还|同类.{0,4}复现|规律)/;

export interface TransienceFlag {
  transient: true;
  reason: string;
}

export function transienceFlag(atom: Pick<KnowledgeAtom, "content" | "doc_type">): TransienceFlag | null {
  const body = String(atom.content ?? "");
  if (!body) return null;
  const head = body.slice(0, 160);
  // 1. 当前缺口 / TODO（头部命中即可，置信最高）
  if (TRANSIENT_GAP_RE.test(head)) return { transient: true, reason: "状态快照：当前缺口/TODO（会过期）" };
  // 2. 库存清单：计数短语 + ≥2 路径（postmortem 走第 3 条，不在这里判）
  if (atom.doc_type !== "postmortem" && TRANSIENT_COUNT_RE.test(body)) {
    const pathCount = (body.match(TRANSIENT_PATH_RE) || []).length;
    if (pathCount >= 2) return { transient: true, reason: "状态快照：库存清单（计数+多路径，会过期）" };
  }
  // 3. 已结案复盘：postmortem + 处置标记 + 无可分离教训
  if (atom.doc_type === "postmortem" && TRANSIENT_RESOLVED_RE.test(body) && !TRANSIENT_LESSON_RE.test(body)) {
    return { transient: true, reason: "已结案复盘：修复 saga，无可分离失效模式" };
  }
  return null;
}

export interface GateOptions {
  /** msg_range 区间是否真的有接地（含 user 或 toolResult）。不传 = 无法判定，放行 */
  hasGrounding?: boolean;
  /** 是否强制价值理由（抽取/声明入口都要） */
  requireWhy?: boolean;
  /**
   * 摘抄率（0–1）：**正文**的碎片有多少逐字出现在**原文**里。用 `copyRatio(原文, 正文)` 算。
   * 注意参数顺序——反了会把"引一句短原文 + 自己写长分析"误判成摘抄（踩过的坑）。
   * 超过 copyMax 判为摘抄。
   */
  copyRatio?: number;
  /** 摘抄率阈值（默认 COPY_RATIO_MAX） */
  copyMax?: number;
  /**
   * 是否拦"历史写成祈使句"。**默认关**：looksImperative 是粗判，误杀率高，
   * 现阶段只做 prompt 约束 + 人工抽检；等误杀率数据出来再决定要不要常开。
   */
  checkImperative?: boolean;
  /**
   * 是否拦"状态快照 / 已结案复盘"（§三bis）。**默认关**：transienceFlag 是粗判，
   * 中文机械判定的路径/数字正则有分词误报（§七#4），会误伤"含库存数字的恒久口径"。
   * 现阶段靠 prompt 约束；这条只作观测/人工抽检的兜底，开了需复核被拦样本。
   */
  checkTransience?: boolean;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

/**
 * 准入规则：只回答"合不合法"，不回答"值不值得"。
 * 前置跑可以省一次 LLM 调用；后置跑防模型编造。
 */
export function admissionGate(atom: Pick<KnowledgeAtom, "content" | "sources" | "why" | "keep_as" | "doc_type">, opts: GateOptions = {}): GateResult {
  const reasons: string[] = [];

  if (!Array.isArray(atom.sources) || atom.sources.length === 0) {
    reasons.push("无来源（sources 为空）");
  }
  // 资料层与案例/客户资料都必须脱敏（含真实数据的文档最先泄露的就是 PII）
  reasons.push(...checkSensitive(String(atom.content ?? ""), { pii: atom.keep_as === "data" || atom.doc_type === "case" }));

  if (opts.hasGrounding === false) {
    reasons.push("无接地（区间内既无 user 消息也无工具结果，G4 纯生成）");
  }
  if (opts.requireWhy) {
    const why = String(atom.why ?? "").trim();
    if (why.length < 8) reasons.push("缺价值理由（why 必须写明不存会损失什么，≥8 字）");
  }

  // 反摘要闸门：正文大量逐字抄自原文 = 摘抄不是提炼（零成本，可常驻）
  const bodyLen = String(atom.content ?? "").replace(/\s+/g, "").length;
  if (typeof opts.copyRatio === "number" && bodyLen >= OVERLAP_MIN_BODY_CHARS) {
    const max = opts.copyMax ?? COPY_RATIO_MAX;
    if (opts.copyRatio > max) {
      reasons.push(
        `正文 ${Math.round(opts.copyRatio * 100)}% 逐字抄自原文（上限 ${Math.round(max * 100)}%）：摘抄不是提炼`,
      );
    }
  }

  // 历史写成祈使句（默认关，见 GateOptions.checkImperative）
  if (opts.checkImperative && looksImperative(String(atom.content ?? ""))) {
    reasons.push("历史写成了祈使句（会被未来 agent 当成当前指令执行），改写成\"当时定的是…\"");
  }

  // 状态快照 / 已结案复盘（默认关，见 GateOptions.checkTransience）
  if (opts.checkTransience) {
    const tf = transienceFlag(atom);
    if (tf) reasons.push(tf.reason);
  }

  return { ok: reasons.length === 0, reasons };
}

// ---------------- 来源合成（agent 主动声明入口） ----------------

/** agent 声明型来源的窗口前缀：与抽取窗口（win_*）区分，避免污染幂等判重 */
export const DECLARED_WINDOW_PREFIX = "decl_";

/**
 * 声明型来源（无"窗口"概念）合成可溯源来源。
 * window_id 用 decl_ 前缀，extractedWindowIds() 永远不会把它当成已抽过的抽取窗口。
 * 注：capture_knowledge 工具已去掉，本函数保留供 smoke 及未来声明型入口（如 save_intent）复用。
 */
export function declaredSource(sessionId: string, messageId?: string): AtomSource {
  const short =
    sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "unknown";
  const id = messageId ?? sessionId;
  return {
    session_id: sessionId,
    window_id: `${DECLARED_WINDOW_PREFIX}${short}_001`,
    msg_range: [id, id],
  };
}
