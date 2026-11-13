/**
 * 密钥扫描：发布前的最后一道隐私防线。
 *
 * 从 `publish/gate.ts` 抽出来单独成模块，因为**三处都要用**：
 *  - 发布门禁（拦下整页）
 *  - 技能推送（拦下整个技能）
 *  - 知识页编译后自检（提示模型重写）
 *
 * **误报是真实成本**：知识页里合法出现 `password=` 的讨论很常见（比如写「别用
 * `password=xxx` 明文」这种建议）。所以每条命中都带 `confidence`，低置信的
 * 由调用方决定是拦还是只警告。
 */

export interface SecretPattern {
  name: string;
  re: RegExp;
  /** 命中即拦（high）还是提示（low） */
  confidence: "high" | "low";
  /** 这条规则为什么存在 */
  why: string;
}

/** PEM 私钥块（可能跨多行） */
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/;

/**
 * 模式表。
 *
 * 排序按「越具体越前」，避免 `sk-` 规则先吃掉别的。`confidence: "low"` 的
 * 是容易误伤的（文档里讨论配置写法时常见）。
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "私钥块",
    re: PRIVATE_KEY_RE,
    confidence: "high",
    why: "PEM 私钥一旦泄露无法挽回",
  },
  {
    name: "OpenAI/DeepSeek 风格 key",
    re: /\bsk-[A-Za-z0-9_-]{20,}/,
    confidence: "high",
    why: "sk- 前缀是主流 LLM 服务的 key 格式",
  },
  {
    name: "GitHub token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    confidence: "high",
    why: "ghp_/gho_/ghu_/ghs_/ghr_ 是 GitHub 各类 token",
  },
  {
    name: "AWS access key",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    confidence: "high",
    why: "AKIA 前缀 + 16 位大写字母数字是 AWS access key id",
  },
  {
    name: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{30,}/,
    confidence: "high",
    why: "AIza 是 Google API key 固定前缀",
  },
  {
    name: "Slack token",
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/,
    confidence: "high",
    why: "xox* 是 Slack token 格式",
  },
  {
    name: "Stripe key",
    re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/,
    confidence: "high",
    why: "Stripe 的 sk_live_/rk_live_ 直接可扣款",
  },
  {
    name: "数据库连接串含密码",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/,
    confidence: "high",
    why: "连接串里的明文密码",
  },
  {
    name: "Bearer token",
    re: /\bBearer\s+[A-Za-z0-9._-]{20,}/,
    confidence: "high",
    why: "HTTP 头里的实际令牌",
  },
  {
    name: "password 赋值",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?([^\s"',;]{8,})/i,
    confidence: "low",
    why: "文档里常讨论配置写法，容易误伤；要结合上下文看",
  },
];

/** 一条命中 */
export interface SecretHit {
  /** 规则名 */
  pattern: string;
  /** 命中位置（字符偏移） */
  index: number;
  /** 命中片段（已打码，可安全打印） */
  preview: string;
  confidence: "high" | "low";
  why: string;
  /** 真实命中片段。**只在内存里用于脱敏，绝不打印/落盘** */
  raw?: string;
}

/** 打码：只留前 4 后 2，中间用 * 代替 */
export function mask(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}${"*".repeat(Math.min(12, s.length - 6))}${s.slice(-2)}`;
}

/**
 * 扫描一段文本。
 *
 * `includeLow: false` 时只返回 high 置信命中（发布门禁用这个，避免误拦）。
 */
export function scanSecrets(text: string, opts: { includeLow?: boolean } = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const includeLow = opts.includeLow ?? false;

  for (const p of SECRET_PATTERNS) {
    if (!includeLow && p.confidence === "low") continue;
    // 用带 g 的副本，避免共享正则的 lastIndex 状态
    const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`);
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 100) {
      hits.push({
        pattern: p.name,
        index: m.index,
        preview: mask(m[0]),
        confidence: p.confidence,
        why: p.why,
        raw: m[0],
      });
      // 零宽匹配保护
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

/** 有没有高危密钥（发布门禁的布尔判断） */
export function hasHighRiskSecret(text: string): boolean {
  return scanSecrets(text).length > 0;
}

/** 命中 → 人话（带行号，方便定位） */
export function describeHits(text: string, hits: SecretHit[]): string[] {
  if (hits.length === 0) return [];
  const lineOf = (idx: number): number => {
    let n = 1;
    for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n++;
    return n;
  };
  return hits.map((h) => `第 ${lineOf(h.index)} 行：${h.pattern} → ${h.preview}`);
}

/**
 * 脱敏：把命中替换成占位符。
 *
 * **只在明确要求时用**（`redact.ts`）。默认策略是「命中就拦」，因为静默替换会让
 * 人以为发出去的是原文。
 */
export function redactSecrets(text: string, opts: { includeLow?: boolean; placeholder?: string } = {}): {
  text: string;
  replaced: number;
} {
  const hits = scanSecrets(text, opts);
  if (hits.length === 0) return { text, replaced: 0 };

  const placeholder = opts.placeholder ?? "[已脱敏]";
  // 从后往前替换，避免前面的替换让后面偏移失效。
  // 用扫描时记下的 raw，不再重扫——重扫要猜上下文窗口，容易错位。
  const sorted = [...hits].filter((h) => h.raw).sort((a, b) => b.index - a.index);
  let out = text;
  let replaced = 0;
  for (const h of sorted) {
    const raw = h.raw!;
    if (out.slice(h.index, h.index + raw.length) !== raw) continue; // 已被前一次替换影响
    out = out.slice(0, h.index) + placeholder + out.slice(h.index + raw.length);
    replaced++;
  }
  return { text: out, replaced };
}
