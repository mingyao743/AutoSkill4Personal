/** 发布门禁：7 道关卡的行为 */
import { ok, eq, section, summary } from "./_harness.ts";
import { runGates } from "../lib/publish/gate.ts";

const fm = (over: Record<string, string> = {}): string => {
  const base: Record<string, string> = {
    title: "测试页面",
    summary: "一句话摘要",
    tags: "[a, b]",
    sources: "[session:x]",
    base_confidence: "0.8",
    lifecycle: "active",
    ...over,
  };
  return `---\n${Object.entries(base).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
};

const body = (n = 300): string => `${"这是一段足够长的正文内容，用来测试完整性门禁是否正常工作。".repeat(Math.ceil(n / 30))}`;

section("门禁 1：结构");
{
  const r = runGates({ path: "concepts/a.md", markdown: `${fm()}\n${body()}` });
  ok(r.pass, "正常页面通过");
  eq(r.action, "create", "无 existing → create");

  const bad = runGates({ path: "../etc/passwd.md", markdown: `${fm()}\n${body()}` });
  ok(!bad.pass, "路径含 .. 被拦");

  const bad2 = runGates({ path: "random/a.md", markdown: `${fm()}\n${body()}` });
  ok(!bad2.pass, "路径不在允许目录被拦");

  const noTitle = runGates({ path: "concepts/a.md", markdown: `---\nsummary: x\n---\n${body()}` });
  ok(!noTitle.pass, "缺 title 被拦");
}

section("门禁 2：大小");
{
  const huge = `${fm()}\n${"x".repeat(1024 * 1024 + 100)}`;
  const r = runGates({ path: "concepts/a.md", markdown: huge });
  ok(!r.pass, "超 1MB 被拦");
  ok(r.issues.some((i) => i.gate === "size"), "命中 size 门");
}

section("门禁 3：隐私");
{
  // 只拦 high 置信规则：这些都是特征明确、几乎不误报的
  // 夹具用拼接构造：GitHub push protection 会拦「形似真实密钥」的连续字面量，
  // 哪怕它只是测试数据。拼接后源码里没有可匹配的字面量，运行时拼出的值照样命中正则。
  const F = (...p: string[]): string => p.join("");
  const cases: Array<[string, string]> = [
    ["sk- 密钥", F("key: sk-", "abcdefghijklmnopqrstuvwxyz", "123456")],
    ["GitHub token", F("token ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789")],
    ["AWS key", F("AKIA", "IOSFODNN7EXAMPLE")],
    ["Google key", F("AIzaSyD-", "abcdefghijklmnopqrstuvwxyz", "123456")],
    ["Slack token", F("xoxb-", "1234567890", "-abcdefghij")],
    ["数据库串", F("postgres://", "user", ":", "pass", "@host/db")],
    ["Bearer", F("Authorization: Bearer ", "abcdefghijklmnopqrstuvwxyz", "0123")],
    ["私钥块", F("-----BEGIN RSA", " PRIVATE KEY-----", "\nMIIEowIBAAKCAQEA\n", "-----END RSA", " PRIVATE KEY-----")],
  ];
  for (const [name, snippet] of cases) {
    const r = runGates({ path: "concepts/a.md", markdown: `${fm()}\n${body()}\n\n${snippet}\n` });
    ok(!r.pass && r.issues.some((i) => i.gate === "privacy"), `拦下 ${name}`);
  }

  // 不误报
  const clean = runGates({ path: "concepts/a.md", markdown: `${fm()}\n${body()}\n\n这里的 sk- 只是举例说明前缀。\n` });
  ok(clean.pass, "短 sk- 前缀不误报");

  // `password=` 是 low 置信：技术文档里常作为反面例子出现，不能一刀切拦
  const pw = runGates({ path: "concepts/a.md", markdown: `${fm()}\n${body()}\n\n别写 password: hunter2secret 这种明文。\n` });
  ok(pw.pass, "password= 不拦（避免误伤技术讨论）");

  // 但 security/secrets.ts 能识别它（供 redact 与提示用）
  const { scanSecrets } = await import("../lib/security/secrets.ts");
  eq(scanSecrets("password: hunter2secret", { includeLow: true }).length, 1, "含 low 时能扫到");
  eq(scanSecrets("password: hunter2secret").length, 0, "默认只扫 high");
}

section("门禁 4：质量");
{
  const low = runGates({ path: "concepts/a.md", markdown: `${fm({ base_confidence: "0.3" })}\n${body()}` });
  ok(!low.pass, "置信度 0.3 < 0.45 被拦");

  const arch = runGates({ path: "concepts/a.md", markdown: `${fm({ lifecycle: "archived" })}\n${body()}` });
  ok(!arch.pass, "archived 被拦");

  const disp = runGates({ path: "concepts/a.md", markdown: `${fm({ lifecycle: "disputed" })}\n${body()}` });
  ok(!disp.pass, "disputed 被拦");
}

section("门禁 6：完整性");
{
  const thin = runGates({ path: "concepts/a.md", markdown: `${fm()}\n短。` });
  ok(!thin.pass, "正文 < 200 字符被拦");

  const outline = `${fm()}\n## 标题一\n\n## 标题二\n\n- 要点\n- 要点\n\n${"这是一段正常长度的正文段落，用来说明一些细节，长度超过八十个字符以便通过检测。".repeat(6)}`;
  const r = runGates({ path: "concepts/a.md", markdown: outline });
  ok(r.pass, "有正文段落 → 通过");
}

section("门禁 5 & 7：去重与未变");
{
  const md = `${fm()}\n${body()}`;
  const withExisting = runGates({
    path: "concepts/a.md",
    markdown: md,
    existing: { id: 7, filename: "qdoc-x-a.md", version: 2 },
  });
  eq(withExisting.action, "update", "有 existing → update");

  const blocked = runGates({
    path: "concepts/a.md",
    markdown: md,
    existing: { id: 7, filename: "qdoc-x-a.md" },
    allowUpdate: false,
  });
  ok(!blocked.pass && blocked.action === "skip", "不允许更新时拦下");

  // 未变：publishedHash 与当前正文哈希一致
  const first = runGates({ path: "concepts/a.md", markdown: md });
  const unchanged = runGates({ path: "concepts/a.md", markdown: md, publishedHash: first.hash });
  eq(unchanged.action, "skip", "哈希一致 → skip");
}

section("哈希稳定性");
{
  const md1 = `${fm()}\n${body()}`;
  const a = runGates({ path: "concepts/a.md", markdown: md1 });
  const b = runGates({ path: "concepts/a.md", markdown: md1 });
  eq(a.hash, b.hash, "同内容哈希相同");

  const c = runGates({ path: "concepts/a.md", markdown: `${fm({ title: "改名了" })}\n${body()}` });
  eq(a.hash, c.hash, "frontmatter 改动不影响正文哈希");
}

section("推断标记：两种语法都认");
{
  const mk = (marker: string): string => {
    const line = `- 这条是推断出来的结论 ${marker}`;
    return `${fm()}\n${body(300)}\n\n${Array.from({ length: 10 }, () => line).join("\n")}\n`;
  };
  const caret = runGates({ path: "concepts/a.md", markdown: mk("^[inferred]") });
  ok(caret.issues.some((i) => i.gate === "completeness"), "识别 ^[inferred]");

  const plain = runGates({ path: "concepts/a.md", markdown: mk("[inferred]") });
  ok(plain.issues.some((i) => i.gate === "completeness"), "识别 [inferred]");

  const cn = runGates({ path: "concepts/a.md", markdown: mk("（推断）") });
  ok(cn.issues.some((i) => i.gate === "completeness"), "识别（推断）");

  const clean = runGates({ path: "concepts/a.md", markdown: `${fm()}\n${body(300)}` });
  ok(!clean.issues.some((i) => i.gate === "completeness"), "无标记不误报");
}

process.exit(summary());
