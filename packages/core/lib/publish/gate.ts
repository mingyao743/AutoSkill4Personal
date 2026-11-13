/**
 * 发布门禁：7 道确定性关卡，**全在本地跑，不烧 token**。
 *
 * 为什么必须本地：平台没有 draft 概念——`create_document` 一调就是正式文档，
 * 发出去就是错的。所以所有能确定性判定的东西必须在发布前拦下。
 *
 * | # | 门 | 判什么 |
 * |---|---|---|
 * | 1 | structure | frontmatter 齐全、路径合法、标题非空 |
 * | 2 | size | 正文 ≤1MB（平台单文档上限） |
 * | 3 | privacy | `sk-` / `ghp_` / `AKIA` / 私钥头 / `password=` |
 * | 4 | quality | `base_confidence ≥ 0.45`、`^[inferred]` 占比 ≤0.7、生命周期可用 |
 * | 5 | dedup | 同标题已存在 → 转 update 或拦下 |
 * | 6 | completeness | 正文有结论段、不是纯大纲 |
 * | 7 | unchanged | 正文哈希与账本一致 → 跳过（不浪费一次 API） |
 */
import { splitFrontmatter, bodyHash, type Frontmatter } from "../vault/frontmatter.ts";
import { scanSecrets, describeHits } from "../security/secrets.ts";

export const MAX_DOC_BYTES = 1024 * 1024;
export const MIN_CONFIDENCE = 0.45;
export const MAX_INFERRED_RATIO = 0.7;
export const MIN_BODY_CHARS = 200;

export type GateName =
  | "structure" | "size" | "privacy" | "quality"
  | "dedup" | "completeness" | "unchanged";

export interface GateIssue {
  gate: GateName;
  severity: "block" | "warn";
  message: string;
}

export interface GateInput {
  /** vault 内相对路径 */
  path: string;
  /** 完整页面 markdown（含 frontmatter） */
  markdown: string;
  /** 平台侧同标题已有文档（dedup 用） */
  existing?: { id: number | string; filename: string; version?: number };
  /** 账本里记的已发布正文哈希（unchanged 用） */
  publishedHash?: string;
  /** 是否允许把「同标题已存在」自动转成更新 */
  allowUpdate?: boolean;
}

export interface GateResult {
  pass: boolean;
  /** 最终动作：create / update / skip */
  action: "create" | "update" | "skip";
  issues: GateIssue[];
  /** 正文哈希（账本用） */
  hash: string;
  /** 跳过隐私门禁（脱敏策略已处理过密钥时用） */
  skipPrivacyGate?: boolean;
}

/** 私钥头：多种格式都要拦 */
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/;

/** 凭据模式（宁可误报，不可漏报） */
// 密钥规则统一从 security/secrets.ts 取，避免两处漂移。
// gate 只关心「有没有高危命中」，误报率低的 low 置信规则不拦（文档里讨论配置写法很常见）。
/** 跑全部门禁 */
export function runGates(input: GateInput): GateResult {
  const issues: GateIssue[] = [];
  const { meta, body } = splitFrontmatter(input.markdown);
  const hash = bodyHash(body);

  gateStructure(input.path, meta, issues);
  gateSize(input.markdown, issues);
  if (!input.skipPrivacyGate) gatePrivacy(input.markdown, issues);
  gateQuality(meta, issues);
  gateCompleteness(body, issues);

  const action = decideAction(input, hash, issues);

  return {
    pass: !issues.some((i) => i.severity === "block"),
    action,
    issues,
    hash,
  };
}

// ---------------- 1. structure ----------------

const ALLOWED_PREFIX = ["concepts/", "entities/", "skills/", "references/", "synthesis/", "journal/"];

function gateStructure(path: string, meta: Frontmatter, issues: GateIssue[]): void {
  if (!path.endsWith(".md")) {
    issues.push({ gate: "structure", severity: "block", message: `路径不是 .md：${path}` });
  }
  if (!ALLOWED_PREFIX.some((p) => path.startsWith(p))) {
    issues.push({ gate: "structure", severity: "block", message: `路径不在允许目录：${path}` });
  }
  if (path.includes("..")) {
    issues.push({ gate: "structure", severity: "block", message: `路径含 ..：${path}` });
  }
  if (typeof meta.title !== "string" || !meta.title.trim()) {
    issues.push({ gate: "structure", severity: "block", message: "缺 title" });
  }
  if (typeof meta.summary !== "string" || !meta.summary.trim()) {
    issues.push({ gate: "structure", severity: "warn", message: "缺 summary（不影响发布，但搜索命中率低）" });
  }
  if (!Array.isArray(meta.tags) || meta.tags.length === 0) {
    issues.push({ gate: "structure", severity: "warn", message: "无 tags（平台侧无法分类）" });
  }
  if (!Array.isArray(meta.sources) || meta.sources.length === 0) {
    issues.push({ gate: "structure", severity: "warn", message: "无 sources（无法追溯来源）" });
  }
}

// ---------------- 2. size ----------------

function gateSize(markdown: string, issues: GateIssue[]): void {
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_DOC_BYTES) {
    issues.push({
      gate: "size",
      severity: "block",
      message: `正文 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过平台上限 1MB`,
    });
  }
}

// ---------------- 3. privacy ----------------

function gatePrivacy(markdown: string, issues: GateIssue[]): void {
  // 只扫 high 置信规则：`password=xxx` 这类在技术文档里常作为「反面例子」出现，
  // 一律拦会造成大量误伤。真密钥（sk-/ghp_/AKIA/私钥块/连接串）特征明确，几乎不误报。
  const hits = scanSecrets(markdown);
  if (hits.length === 0) return;
  for (const line of describeHits(markdown, hits)) {
    issues.push({ gate: "privacy", severity: "block", message: `疑似密钥，拒绝发布 —— ${line}` });
  }
}

// ---------------- 4. quality ----------------

function gateQuality(meta: Frontmatter, issues: GateIssue[]): void {
  const conf = meta.base_confidence;
  if (typeof conf !== "number") {
    issues.push({ gate: "quality", severity: "warn", message: "无 base_confidence，按 0.6 处理" });
  } else if (conf < MIN_CONFIDENCE) {
    issues.push({
      gate: "quality",
      severity: "block",
      message: `置信度 ${conf} < ${MIN_CONFIDENCE}，不发布`,
    });
  }

  const lifecycle = String(meta.lifecycle ?? "active");
  if (lifecycle === "archived" || lifecycle === "disputed") {
    issues.push({
      gate: "quality",
      severity: "block",
      message: `生命周期为 ${lifecycle}，不发布`,
    });
  }
}

/**
 * 正文里推断标记的占比。
 *
 * 两种语法都认：
 *  - `^[inferred]`（上游 obsidian-wiki 的写法，Obsidian 里渲染成脚注样式）
 *  - `[inferred]`（不带 `^`，模型经常漏掉）
 * 另外认中文「（推断）」。
 */
function checkInferredRatio(body: string): number {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;
  const inferred = lines.filter((l) =>
    /\^?\[(?:inferred|ambiguous)\]|（推断）|（存疑）|\((?:inferred|ambiguous)\)/i.test(l),
  ).length;
  return inferred / lines.length;
}

// ---------------- 6. completeness ----------------

function gateCompleteness(body: string, issues: GateIssue[]): void {
  if (body.trim().length < MIN_BODY_CHARS) {
    issues.push({
      gate: "completeness",
      severity: "block",
      message: `正文 ${body.trim().length} 字符 < ${MIN_BODY_CHARS}，太薄不值得发布`,
    });
    return;
  }
  const ratio = checkInferredRatio(body);
  if (ratio > MAX_INFERRED_RATIO) {
    issues.push({
      gate: "completeness",
      severity: "block",
      message: `推断内容占比 ${(ratio * 100).toFixed(0)}% > ${MAX_INFERRED_RATIO * 100}%，证据不足`,
    });
  }
  // 纯大纲：全是标题和短行，没有一段成句的正文
  const paragraphs = body.split(/\r?\n\r?\n/).filter((p) => {
    const t = p.trim();
    return t && !t.startsWith("#") && !t.startsWith("-") && !t.startsWith("*") && t.length > 80;
  });
  if (paragraphs.length === 0) {
    issues.push({
      gate: "completeness",
      severity: "warn",
      message: "没有成段正文（只有标题/列表），可读性差",
    });
  }
}

// ---------------- 5 & 7. dedup / unchanged ----------------

function decideAction(input: GateInput, hash: string, issues: GateIssue[]): GateResult["action"] {
  // 7. unchanged：正文没变就不必再调一次 API
  if (input.publishedHash && input.publishedHash === hash) {
    return "skip";
  }

  // 5. dedup：平台已有同标题文档
  if (input.existing) {
    if (input.allowUpdate !== false) {
      // 同标题 + 同内容已在 7 拦掉；到这里说明内容变了 → 更新
      return "update";
    }
    issues.push({
      gate: "dedup",
      severity: "block",
      message: `平台已有同名文档 ${input.existing.filename}（id=${input.existing.id}），且未允许更新`,
    });
    return "skip";
  }
  return "create";
}

/** 门禁结果 → 人话（CLI 与日志共用） */
export function describeGates(r: GateResult): string {
  const blocks = r.issues.filter((i) => i.severity === "block");
  const warns = r.issues.filter((i) => i.severity === "warn");
  const lines: string[] = [`门禁：${r.pass ? "通过" : "拦截"}，动作 ${r.action}`];
  for (const i of blocks) lines.push(`  ✗ [${i.gate}] ${i.message}`);
  for (const i of warns) lines.push(`  ! [${i.gate}] ${i.message}`);
  return lines.join("\n");
}
