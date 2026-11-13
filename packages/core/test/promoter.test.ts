/** 技能晋升：候选扫描、打包转换、平台限制检查 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  scanCandidates, explainPage, extractWikilinks, normalizeTitle,
  computeLineage, hasProcedure, MIN_LINEAGE, MIN_REFS,
} from "../lib/promoter/scan.ts";
import {
  toSkillName, isValidSkillName, stripAbsolutePaths, stripWikilinks,
  packageSkill, writePackage, describePackage, checkPackage,
} from "../lib/promoter/package.ts";
import { initVault } from "../lib/vault/init.ts";
import { splitFrontmatter } from "../lib/vault/frontmatter.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-pm-"));

/** 造一个 vault 加页面 */
function makeVault(pages: Record<string, string>): string {
  const root = tmp();
  const v = initVault(join(root, "proj"));
  for (const [path, content] of Object.entries(pages)) {
    const abs = join(v.dir, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return v.dir;
}

const GOOD_BODY = `
## 是什么

一段说明，讲清楚这个东西是什么以及为什么重要。需要足够长让扫描器认为内容充实。

## 怎么做

1. 第一步扫描魔数
2. 第二步逐段解压
3. 第三步合并结果

## 验证

跑对比命令确认行数一致即可。
`;

function page(title: string, sources: string[], body = GOOD_BODY, extra = ""): string {
  const src = sources.length > 0
    ? `sources:\n${sources.map((s) => `  - ${s}`).join("\n")}\n`
    : "";
  return `---
title: ${title}
summary: 关于 ${title} 的说明
tags: [测试]
category: concepts
confidence: 0.9
status: active
${src}${extra}---

# ${title}
${body}`;
}

section("frontmatter 多行列表（关键：不解析则 lineage 永远 0）");
{
  const fm = `title: T\nsources:\n  - a\n  - b\n  - c\nstatus: active`;
  const { meta } = splitFrontmatter(`---\n${fm}\n---\n正文`);
  eq(meta.sources, ["a", "b", "c"], "多行列表解析成数组");
  eq(meta.status, "active", "后续字段不受影响");
}

section("frontmatter 行内列表仍然可用");
{
  const { meta } = splitFrontmatter(`---\ntitle: T\ntags: [x, y]\n---\n正文`);
  eq(meta.tags, ["x", "y"], "行内列表");
}

section("frontmatter 空值字段");
{
  const { meta } = splitFrontmatter(`---\ntitle: T\nempty:\nnext: 1\n---\n正文`);
  eq(meta.empty, "", "空值当空串");
  eq(meta.next, 1, "下一个字段正常");
}

section("wikilink 提取");
{
  eq(extractWikilinks("见 [[页面A]] 和 [[页面B|别名]] 以及 [[页C#小节]]"),
    ["页面A", "页面B", "页C"], "三种形式都提取");
  eq(extractWikilinks("没有链接"), [], "无链接");
  eq(extractWikilinks("[[a]] [[a]]"), ["a", "a"], "重复也返回（计数由调用方做）");
}

section("标题归一化");
{
  eq(normalizeTitle("Zstd 多帧解压"), normalizeTitle("zstd多帧解压"), "大小写与空格无关");
  eq(normalizeTitle("A-B_C"), normalizeTitle("abc"), "标点无关");
}

section("lineage 计算");
{
  eq(computeLineage({ sources: ["dsh/session-abc/第 1-30 轮", "dsh/session-def/第 5-12 轮"] }), 2, "两个不同会话");
  eq(computeLineage({ sources: ["dsh/session-abc/第 1-10 轮", "dsh/session-abc/第 11-20 轮"] }), 1, "同会话两段算一次");
  eq(computeLineage({ sources: [] }), 0, "空");
  eq(computeLineage({}), 0, "无字段");
  eq(computeLineage({ sources: ["a", "b", "c"] }), 3, "无会话 id 时按原串");
}

section("可执行步骤识别");
{
  ok(hasProcedure("## 怎么做\n\n1. 第一步\n"), "中文标题 + 有序列表");
  ok(hasProcedure("## How to\n\n1. step one\n"), "英文标题");
  ok(hasProcedure("## 说明\n\n1. 只有列表也算\n"), "只有有序列表");
  ok(!hasProcedure("## 是什么\n\n只是描述，没有步骤。\n"), "纯描述不算");
}

section("扫描：够格的页面");
{
  const vault = makeVault({
    "concepts/target.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]),
    "concepts/r1.md": page("引用1", ["dsh/session-c/第 1-5 轮"], "\n见 [[目标页]]\n"),
    "concepts/r2.md": page("引用2", ["dsh/session-d/第 1-5 轮"], "\n见 [[目标页]]\n"),
    "concepts/r3.md": page("引用3", ["dsh/session-e/第 1-5 轮"], "\n见 [[目标页]]\n"),
  });
  const c = scanCandidates(vault);
  const target = c.find((x) => x.title === "目标页");
  ok(target != null, "找到目标页");
  eq(target!.lineage, 2, "lineage 2");
  eq(target!.refs, 3, "被引用 3 次");
  ok(target!.hasProcedure, "有步骤");
  ok(target!.score > 0, "有得分");
  rmSync(vault, { recursive: true, force: true });
}

section("扫描：lineage 不够被排除");
{
  const vault = makeVault({
    "concepts/t.md": page("单次页", ["dsh/session-a/第 1-10 轮"]),
    "concepts/r1.md": page("R1", [], "\n[[单次页]]\n"),
    "concepts/r2.md": page("R2", [], "\n[[单次页]]\n"),
    "concepts/r3.md": page("R3", [], "\n[[单次页]]\n"),
  });
  eq(scanCandidates(vault).filter((c) => c.title === "单次页").length, 0, "lineage 1 → 排除");
  rmSync(vault, { recursive: true, force: true });
}

section("扫描：引用不够被排除");
{
  const vault = makeVault({
    "concepts/t.md": page("少引用", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]),
    "concepts/r1.md": page("R1", [], "\n[[少引用]]\n"),
  });
  eq(scanCandidates(vault).filter((c) => c.title === "少引用").length, 0, "引用 1 → 排除");
  rmSync(vault, { recursive: true, force: true });
}

section("扫描：archived 不升级");
{
  const vault = makeVault({
    "concepts/t.md": page("归档页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"], GOOD_BODY, "archived_note: x\n").replace("status: active", "status: archived"),
    "concepts/r1.md": page("R1", [], "\n[[归档页]]\n"),
    "concepts/r2.md": page("R2", [], "\n[[归档页]]\n"),
    "concepts/r3.md": page("R3", [], "\n[[归档页]]\n"),
  });
  eq(scanCandidates(vault).filter((c) => c.title === "归档页").length, 0, "archived → 排除");
  rmSync(vault, { recursive: true, force: true });
}

section("explain：说清差什么");
{
  const vault = makeVault({ "concepts/t.md": page("单次页", ["dsh/session-a/第 1-10 轮"]) });
  const r = explainPage(vault, "concepts/t.md");
  eq(r.lineage, 1, "lineage 1");
  ok(r.missing.some((m) => m.includes("lineage")), "指出 lineage 不足");
  ok(r.missing.some((m) => m.includes("引用")), "指出引用不足");
  rmSync(vault, { recursive: true, force: true });
}

section("explain：页面不存在");
{
  const vault = makeVault({});
  const r = explainPage(vault, "concepts/nope.md");
  eq(r.page, null, "page 为 null");
  ok(r.missing[0].includes("不存在"), "说明不存在");
  rmSync(vault, { recursive: true, force: true });
}

// ---------------- 打包 ----------------

section("技能名：保留中文可读性");
{
  eq(toSkillName("Zstd Multi Frame"), "zstd-multi-frame", "英文");
  eq(toSkillName("zstd 多帧解压"), "zstd-多帧解压", "中英混合");
  eq(toSkillName("多帧解压"), "多帧解压", "纯中文不被哈希化");
  ok(isValidSkillName(toSkillName("多帧解压")), "合法");
  ok(!isValidSkillName("has space"), "空格非法");
  ok(!isValidSkillName(""), "空非法");
  ok(!isValidSkillName("a/b"), "路径分隔符非法");
}

section("去 wikilink");
{
  eq(stripWikilinks("[[A]]").text, "A", "简单");
  eq(stripWikilinks("[[A|显示]]").text, "显示", "带别名用别名");
  eq(stripWikilinks("[[A#节]]").text, "A · 节", "带小节");
  eq(stripWikilinks("[[A]] [[B]]").count, 2, "计数");
  eq(stripWikilinks("无链接").count, 0, "无链接不计数");
}

section("去绝对路径");
{
  const r = stripAbsolutePaths("改 /Users/me/proj/src/x.ts 这个文件");
  ok(!r.text.includes("/Users/me"), "绝对路径已去掉");
  ok(r.text.includes("src/x.ts"), "保留末两段");
  eq(r.count, 1, "计数");

  const h = stripAbsolutePaths("配置在 ~/.dsh/skills 里");
  ok(!h.text.includes("~/"), "家目录已去掉");

  eq(stripAbsolutePaths("普通文本没有路径").count, 0, "无误伤");
}

section("打包：生成 SKILL.md 带必填字段");
{
  const vault = makeVault({
    "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]),
  });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c);
  eq(pkg.files.length, 1, "一个文件");
  eq(pkg.files[0].path, "SKILL.md", "根 SKILL.md");
  ok(pkg.files[0].content.includes("name: "), "有 name");
  ok(pkg.files[0].content.includes("description: "), "有 description");
  ok(pkg.name.length > 0, "有技能名");
  eq(pkg.sourcePage, "concepts/t.md", "记录源页面");
  rmSync(vault, { recursive: true, force: true });
}

section("打包：转换被记录");
{
  const vault = makeVault({
    "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"],
      "\n## 怎么做\n\n1. 见 [[另一页]]\n2. 路径 /Users/me/a/b.ts\n"),
  });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c);
  ok(pkg.transforms.some((t) => t.includes("wikilink")), "记录了 wikilink 转换");
  ok(pkg.transforms.some((t) => t.includes("绝对路径")), "记录了路径转换");
  ok(!pkg.files[0].content.includes("[[另一页]]"), "wikilink 已去掉");
  ok(!pkg.files[0].content.includes("/Users/me"), "绝对路径已去掉");
  rmSync(vault, { recursive: true, force: true });
}

section("打包：不重复 H1");
{
  const vault = makeVault({ "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]) });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c);
  const h1Count = (pkg.files[0].content.match(/^# /gm) ?? []).length;
  eq(h1Count, 1, "只有一个 H1");
  rmSync(vault, { recursive: true, force: true });
}

section("打包：附加 references");
{
  const vault = makeVault({
    "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]),
    "references/extra.md": page("额外参考", [], "\n参考内容 [[目标页]]\n"),
  });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c, { references: [{ title: "额外参考", pagePath: "references/extra.md" }] });
  eq(pkg.files.length, 2, "两个文件");
  ok(pkg.files[1].path.startsWith("references/"), "在 references 下");
  ok(!pkg.files[1].content.includes("[["), "references 里的 wikilink 也去掉了");
  rmSync(vault, { recursive: true, force: true });
}

section("写盘");
{
  const vault = makeVault({ "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]) });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c);
  const dir = tmp();
  const written = writePackage(dir, pkg);
  eq(written.length, 1, "写了一个文件");
  ok(readFileSync(written[0], "utf8").includes("name: "), "内容正确");
  rmSync(vault, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

section("包检查：平台限制");
{
  const vault = makeVault({ "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]) });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const pkg = packageSkill(vault, c);
  eq(checkPackage(pkg).ok, true, "正常包通过");

  const tooMany = { ...pkg, files: [...pkg.files, ...Array.from({ length: 55 }, (_, i) => ({ path: `references/f${i}.md`, content: "x" }))] };
  ok(!checkPackage(tooMany).ok, "超 50 文件被拒");

  const noSkill = { ...pkg, files: pkg.files.filter((f) => f.path !== "SKILL.md") };
  ok(!checkPackage(noSkill).ok, "缺 SKILL.md 被拒");

  const noDesc = { ...pkg, description: "" };
  ok(!checkPackage(noDesc).ok, "缺 description 被拒");
  rmSync(vault, { recursive: true, force: true });
}

section("包摘要");
{
  const vault = makeVault({ "concepts/t.md": page("目标页", ["dsh/session-a/第 1-10 轮", "dsh/session-b/第 1-10 轮"]) });
  const c = scanCandidates(vault, { minRefs: 0 }).find((x) => x.title === "目标页")!;
  const s = describePackage(packageSkill(vault, c));
  ok(s.includes("1 文件"), "含文件数");
  ok(s.includes("KB"), "含大小");
  rmSync(vault, { recursive: true, force: true });
}

section("门槛常量");
{
  eq(MIN_LINEAGE, 2, "lineage 门槛");
  eq(MIN_REFS, 3, "引用门槛");
}

process.exit(summary());
