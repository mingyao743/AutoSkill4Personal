/** 密钥扫描与脱敏策略 */
import { ok, eq, section, summary } from "./_harness.ts";
import {
  scanSecrets, redactSecrets, hasHighRiskSecret, mask, describeHits, SECRET_PATTERNS,
} from "../lib/security/secrets.ts";
import {
  applyRedactPolicy, defaultRedactPolicy, redactSummary,
} from "../lib/security/redact.ts";

// 测试夹具用**拼接**构造，不在源码里留完整字面量：
// GitHub push protection 会把「形似真实密钥」的字符串拦下来（sk_live_ + 20 位以上
// 字母数字就是 Stripe 的真实格式），哪怕是测试夹具也一样拦。拼接后源码里没有
// 可被匹配的连续字面量，扫描器放行，而运行时拼出来的值仍然命中我们的正则。
const FIX = (...parts: string[]): string => parts.join("");
const SK = FIX("sk-", "abcdefghijklmnopqrstuvwxyz", "123456");

section("能识别的密钥类型");
{
  const cases: Array<[string, string]> = [
    ["OpenAI/DeepSeek", SK],
    ["GitHub", FIX("ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789")],
    ["AWS", FIX("AKIA", "IOSFODNN7EXAMPLE")],
    ["Google", FIX("AIzaSyD-", "abcdefghijklmnopqrstuvwxyz", "123456")],
    ["Slack", FIX("xoxb-", "1234567890", "-abcdefghij")],
    ["Stripe", FIX("sk_", "live_", "abcdefghijklmnopqrstuvwx")],
    ["数据库串", FIX("postgres://", "user", ":", "pass", "@host:5432/db")],
    ["Bearer", FIX("Bearer ", "abcdefghijklmnopqrstuvwxyz", "0123")],
    ["私钥块", FIX("-----BEGIN RSA", " PRIVATE KEY-----", "\nMIIE\n", "-----END RSA", " PRIVATE KEY-----")],
  ];
  for (const [name, s] of cases) {
    ok(scanSecrets(`前缀 ${s} 后缀`).length > 0, `识别 ${name}`);
  }
}

section("高危判定");
{
  ok(hasHighRiskSecret(`key: ${SK}`), "有 sk- → 高危");
  ok(!hasHighRiskSecret("这里只是讨论 sk- 前缀的含义"), "短前缀不算");
  ok(!hasHighRiskSecret("普通文本，没有任何密钥"), "干净文本");
}

section("low 置信规则默认不返回");
{
  const t = "配置 password: hunter2secret 即可";
  eq(scanSecrets(t).length, 0, "默认不报 password=");
  eq(scanSecrets(t, { includeLow: true }).length, 1, "显式要求才报");
}

section("打码不泄露原文");
{
  const m = mask(SK);
  ok(!m.includes(SK), "不含原文");
  ok(m.startsWith("sk-a"), "保留前 4 位便于辨认");
  ok(m.includes("*"), "含星号");
  eq(mask("short"), "*****", "短串全打码");
}

section("命中带位置与原因");
{
  const hits = scanSecrets(`第一行\n第二行 ${SK}\n第三行`);
  eq(hits.length, 1, "一处命中");
  ok(hits[0].index > 0, "有字符偏移");
  ok(hits[0].why.length > 0, "说明了为什么");
  eq(hits[0].confidence, "high", "置信度");
  ok(!hits[0].preview.includes(SK), "preview 已打码");
}

section("describeHits 给出行号");
{
  const t = `第一行\n第二行\n第三行 ${SK}\n`;
  const lines = describeHits(t, scanSecrets(t));
  eq(lines.length, 1, "一行");
  ok(lines[0].includes("第 3 行"), "行号正确");
  ok(!lines[0].includes(SK), "不打码不打印原文");
}

section("多个命中都返回且按位置排序");
{
  const t = `${SK} 然后 ${FIX("ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789")} 再 ${FIX("AKIA", "IOSFODNN7EXAMPLE")}`;
  const hits = scanSecrets(t);
  eq(hits.length, 3, "三处");
  ok(hits[0].index < hits[1].index && hits[1].index < hits[2].index, "按位置升序");
}

section("脱敏：替换全部命中");
{
  const t = `key1: ${SK}\nkey2: ${FIX("ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789")}`;
  const r = redactSecrets(t);
  ok(!r.text.includes(SK), "第一处已替换");
  ok(r.text.includes("[已脱敏]"), "有占位符");
  ok(r.replaced >= 1, "至少替换一处");
}

section("脱敏：可自定义占位符");
{
  const r = redactSecrets(`key: ${SK}`, { placeholder: "<REMOVED>" });
  ok(r.text.includes("<REMOVED>"), "用了自定义占位符");
  ok(!r.text.includes(SK), "原文已消失");
}

section("脱敏：无命中时原样返回");
{
  const t = "完全没有密钥的一段话";
  const r = redactSecrets(t);
  eq(r.text, t, "文本不变");
  eq(r.replaced, 0, "替换 0 处");
}

section("脱敏：includeLow 才处理 password");
{
  const t = "password: hunter2secret";
  eq(redactSecrets(t).replaced, 0, "默认不动");
  eq(redactSecrets(t, { includeLow: true }).replaced, 1, "显式要求才替换");
}

// ---------------- 策略 ----------------

section("策略 block：默认拦截");
{
  const r = applyRedactPolicy(`key: ${SK}`);
  eq(r.allowed, false, "拒绝发布");
  eq(r.replaced, 0, "未替换");
  eq(r.text, `key: ${SK}`, "文本原样");
  ok(r.messages.join(" ").includes("拒绝发布"), "说明拒绝");
  ok(r.messages.join(" ").includes("ow publish --redact replace"), "给出出路");
}

section("策略 replace：替换后放行");
{
  const r = applyRedactPolicy(`key: ${SK}`, "replace");
  eq(r.allowed, true, "允许发布");
  eq(r.replaced, 1, "替换一处");
  ok(!r.text.includes(SK), "原文已消失");
  ok(r.messages.join(" ").includes("与本地原文不同"), "警告两边不一致");
}

section("策略 warn：只警告");
{
  const r = applyRedactPolicy(`key: ${SK}`, "warn");
  eq(r.allowed, true, "允许发布");
  eq(r.replaced, 0, "不替换");
  eq(r.text, `key: ${SK}`, "文本原样");
  ok(r.messages.join(" ").includes("未拦截"), "说明只警告");
}

section("策略：无命中时三种都放行");
{
  for (const p of ["block", "replace", "warn"] as const) {
    const r = applyRedactPolicy("干净文本", p);
    eq(r.allowed, true, `${p} 放行`);
    eq(r.hits.length, 0, `${p} 无命中`);
  }
}

section("默认策略是 block");
{
  const old = process.env.OW_REDACT;
  delete process.env.OW_REDACT;
  eq(defaultRedactPolicy(), "block", "默认拦");
  process.env.OW_REDACT = "replace";
  eq(defaultRedactPolicy(), "replace", "环境变量可改");
  process.env.OW_REDACT = "乱写";
  eq(defaultRedactPolicy(), "block", "非法值回退 block");
  if (old === undefined) delete process.env.OW_REDACT; else process.env.OW_REDACT = old;
}

section("策略摘要");
{
  eq(redactSummary(applyRedactPolicy("干净")), "无密钥命中", "干净");
  ok(redactSummary(applyRedactPolicy(`k ${SK}`)).includes("已拦截"), "拦截");
  ok(redactSummary(applyRedactPolicy(`k ${SK}`, "replace")).includes("已替换"), "替换");
  ok(redactSummary(applyRedactPolicy(`k ${SK}`, "warn")).includes("仅警告"), "警告");
}

section("规则表自身一致性");
{
  ok(SECRET_PATTERNS.length >= 9, "至少 9 条规则");
  for (const p of SECRET_PATTERNS) {
    ok(p.name.length > 0, `规则有名字: ${p.name}`);
    ok(p.why.length > 0, `规则有说明: ${p.name}`);
    ok(p.confidence === "high" || p.confidence === "low", `置信度合法: ${p.name}`);
  }
}

section("多次扫描不互相污染（正则 lastIndex）");
{
  const t = `key ${SK}`;
  eq(scanSecrets(t).length, 1, "第一次");
  eq(scanSecrets(t).length, 1, "第二次仍然");
  eq(scanSecrets(t).length, 1, "第三次仍然");
}

process.exit(summary());
