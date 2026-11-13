/**
 * 发布前脱敏策略。
 *
 * **默认策略是「拦」，不是「替换」**。原因：
 * 静默替换会让人以为发出去的是原文，实际上平台上是打了码的版本，两边不一致且
 * 没人知道。所以只有用户显式选择 `replace` 时才替换，且必须能看见替换了几处。
 *
 * 三种策略：
 * | 策略 | 行为 | 什么时候用 |
 * |---|---|---|
 * | `block`（默认） | 有高危命中就拒绝发布 | 正常情况 |
 * | `replace` | 替换成占位符后放行 | 明知文档里必须带示例 |
 * | `warn` | 只警告不拦 | 本地预览、dry-run |
 */
import { scanSecrets, redactSecrets, describeHits } from "./secrets.ts";
import type { SecretHit } from "./secrets.ts";

export type RedactPolicy = "block" | "replace" | "warn";

export interface RedactResult {
  /** 处理后的文本（replace 策略下已替换；其他策略原样返回） */
  text: string;
  /** 是否允许继续发布 */
  allowed: boolean;
  /** 命中数 */
  hits: SecretHit[];
  /** 实际替换了几处 */
  replaced: number;
  /** 人话说明 */
  messages: string[];
}

/**
 * 按策略处理一段要发布的正文。
 *
 * @param includeLow 是否连 `password=` 这类低置信规则也算（默认不算，避免误伤技术讨论）
 */
export function applyRedactPolicy(
  text: string,
  policy: RedactPolicy = "block",
  opts: { includeLow?: boolean; placeholder?: string } = {},
): RedactResult {
  const hits = scanSecrets(text, { includeLow: opts.includeLow });
  const messages: string[] = [];

  if (hits.length === 0) {
    return { text, allowed: true, hits: [], replaced: 0, messages: [] };
  }

  const detail = describeHits(text, hits);
  const high = hits.filter((h) => h.confidence === "high").length;

  switch (policy) {
    case "warn":
      messages.push(`发现 ${hits.length} 处疑似密钥（仅警告，未拦截）：`, ...detail.map((d) => `  ${d}`));
      return { text, allowed: true, hits, replaced: 0, messages };

    case "replace": {
      const r = redactSecrets(text, { includeLow: opts.includeLow, placeholder: opts.placeholder });
      messages.push(
        `已替换 ${r.replaced} 处疑似密钥为「${opts.placeholder ?? "[已脱敏]"}」`,
        ...detail.map((d) => `  ${d}`),
        "注意：发布的是替换后的版本，与本地原文不同。",
      );
      return { text: r.text, allowed: true, hits, replaced: r.replaced, messages };
    }

    case "block":
    default:
      messages.push(
        `发现 ${hits.length} 处疑似密钥（其中 ${high} 处高危），拒绝发布：`,
        ...detail.map((d) => `  ${d}`),
        "",
        "处理方式：",
        "  · 把密钥从知识页里删掉（推荐——知识页不该记凭据）",
        "  · 改成占位符示例：sk-xxxx / <your-token>",
        "  · 确实要原样发布：ow publish --redact replace",
      );
      return { text, allowed: false, hits, replaced: 0, messages };
  }
}

/** 从环境或配置读默认策略 */
export function defaultRedactPolicy(): RedactPolicy {
  const env = (process.env.OW_REDACT ?? "").toLowerCase();
  if (env === "replace" || env === "warn" || env === "block") return env;
  return "block";
}

/** 给 CLI 用的摘要（一行） */
export function redactSummary(r: RedactResult): string {
  if (r.hits.length === 0) return "无密钥命中";
  if (!r.allowed) return `${r.hits.length} 处密钥，已拦截`;
  if (r.replaced > 0) return `${r.hits.length} 处密钥，已替换 ${r.replaced} 处`;
  return `${r.hits.length} 处密钥，仅警告`;
}
