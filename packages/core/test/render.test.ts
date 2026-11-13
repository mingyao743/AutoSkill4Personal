/** 发布渲染：本地字段剥离、wikilink 改写、meta 注释 */
import { ok, eq, section, summary } from "./_harness.ts";
import { renderForPublish, rewriteWikilinks, parseMetaComment, stripMetaComment } from "../lib/vault/render.ts";

const page = `---
title: 测试页
summary: 摘要
tags: [a, b]
sources: [session:s1]
provenance: dsh:s1#1-30
base_confidence: 0.8
lifecycle: active
publish_as: document
publish_status: pending
source_agent: dsh
source_session: s1
source_turns: 1-30
---

# 正文标题

参考 [[concepts/other|另一页]] 和 [[entities/foo]]。

<!-- ow:meta {"schema":1,"page":"old"} -->
`;

section("本地字段不进平台正文");
{
  const r = renderForPublish(page, { pagePath: "concepts/test.md" });
  ok(!r.text.includes("publish_as"), "publish_as 被剥");
  ok(!r.text.includes("publish_status"), "publish_status 被剥");
  ok(!r.text.includes("source_agent"), "source_agent 被剥");
  ok(!r.text.includes("source_session"), "source_session 被剥");
  ok(!r.text.includes("source_turns"), "source_turns 被剥");
  // 该保留的还在
  ok(r.text.includes("title: 测试页"), "title 保留");
  ok(r.text.includes("provenance:"), "provenance 保留");
  ok(r.text.includes("base_confidence: 0.8"), "置信度保留");
}

section("wikilink 改写");
{
  eq(rewriteWikilinks("见 [[a/b|显示名]]"), "见 显示名", "带别名取别名");
  eq(rewriteWikilinks("见 [[a/b/c]]"), "见 c", "不带别名取末段");
  eq(rewriteWikilinks("[[x.md]]"), "x", "去掉 .md");
  eq(rewriteWikilinks("没有链接"), "没有链接", "无链接原样");
  eq(rewriteWikilinks("[[a]] 和 [[b|B]]"), "a 和 B", "多个链接");
}

section("meta 注释：追加与解析");
{
  const r = renderForPublish(page, { pagePath: "concepts/test.md", contentHash: "sha256:abc" });
  ok(r.text.trimEnd().endsWith("-->"), "注释在末尾");
  ok(r.text.includes("<!-- ow:meta"), "含注释标记");

  const meta = parseMetaComment(r.text);
  ok(meta !== null, "能解析回来");
  eq(meta?.page, "concepts/test.md", "page 字段");
  eq(meta?.agent, "dsh", "agent 字段");
  eq(meta?.session, "s1", "session 字段");
  eq(meta?.turns, "1-30", "turns 字段");
  eq(meta?.confidence, 0.8, "confidence 字段");
  eq(meta?.hash, "sha256:abc", "hash 字段");
}

section("重复发布不叠加注释");
{
  const once = renderForPublish(page, { pagePath: "concepts/test.md" });
  const twice = renderForPublish(once.text, { pagePath: "concepts/test.md" });
  const count = (twice.text.match(/<!-- ow:meta/g) ?? []).length;
  eq(count, 1, "只有一条 meta 注释");
}

section("stripMetaComment");
{
  const withMeta = `正文\n\n<!-- ow:meta {"a":1} -->\n`;
  eq(stripMetaComment(withMeta), "正文", "剥掉注释与尾部空白");
  eq(stripMetaComment("没有注释"), "没有注释", "无注释原样");
}

section("标题回退");
{
  const noTitle = `---\nsummary: x\n---\n正文`;
  const r = renderForPublish(noTitle, { pagePath: "concepts/my-page.md" });
  eq(r.title, "my-page", "无 title 时用文件名");
}

section("tags 传递");
{
  const r = renderForPublish(page, { pagePath: "concepts/test.md" });
  eq(r.tags, ["a", "b"], "tags 取出供 create 用");
}

process.exit(summary());
