/** frontmatter 解析/序列化：手写 YAML 子集的边界 */
import { ok, eq, section, summary } from "./_harness.ts";
import {
  splitFrontmatter, renderFrontmatter, bodyHash, pageHash,
} from "../lib/vault/frontmatter.ts";

section("解析标量");
{
  const { meta } = splitFrontmatter(`---\ntitle: 标题\nbase_confidence: 0.75\nlifecycle: active\n---\n正文`);
  eq(meta.title, "标题", "字符串");
  eq(meta.base_confidence, 0.75, "浮点数");
  eq(meta.lifecycle, "active", "普通字符串");
}

section("解析数组");
{
  const { meta } = splitFrontmatter(`---\ntags: [a, b, c]\nsources: []\n---\n`);
  eq(meta.tags, ["a", "b", "c"], "单行数组");
  eq(meta.sources, [], "空数组");
}

section("解析引号");
{
  const { meta } = splitFrontmatter(`---\ntitle: "带: 冒号的标题"\nsummary: '单引号'\n---\n`);
  eq(meta.title, "带: 冒号的标题", "双引号剥掉");
  eq(meta.summary, "单引号", "单引号剥掉");
}

section("无 frontmatter");
{
  const r = splitFrontmatter("就是正文，没有元数据");
  eq(r.meta, {}, "meta 为空对象");
  eq(r.body, "就是正文，没有元数据", "body 原样");
}

section("序列化：字段顺序固定");
{
  const out = renderFrontmatter({
    publish_status: "pending",
    title: "标题",
    tags: ["a"],
    base_confidence: 0.8,
  });
  const lines = out.split("\n");
  eq(lines[0], "---", "开头分隔符");
  eq(lines[1], "title: 标题", "title 排第一");
  ok(out.indexOf("tags:") < out.indexOf("base_confidence:"), "tags 在 confidence 之前");
  ok(out.indexOf("publish_status:") > out.indexOf("base_confidence:"), "publish_status 在后");
}

section("序列化：特殊字符加引号");
{
  const out = renderFrontmatter({ title: "含: 冒号", summary: "带 # 号" });
  ok(out.includes('"含: 冒号"'), "冒号触发引号");
  ok(out.includes('"带 # 号"'), "井号触发引号");
}

section("往返一致");
{
  const meta = { title: "测试", tags: ["x", "y"], base_confidence: 0.6, lifecycle: "active" };
  const text = `${renderFrontmatter(meta)}正文内容`;
  const back = splitFrontmatter(text).meta;
  eq(back.title, "测试", "title 往返");
  eq(back.tags, ["x", "y"], "数组往返");
  eq(back.base_confidence, 0.6, "数字往返");
}

section("未知字段不丢");
{
  const { meta } = splitFrontmatter(`---\ntitle: t\ncustom_field: 自定义值\n---\n`);
  eq(meta.custom_field, "自定义值", "未知字段保留");
  const out = renderFrontmatter(meta);
  ok(out.includes("custom_field: 自定义值"), "未知字段能写回");
}

section("哈希");
{
  eq(bodyHash("abc"), bodyHash("abc"), "同正文同哈希");
  ok(bodyHash("abc") !== bodyHash("abd"), "不同正文不同哈希");
  ok(bodyHash("abc").startsWith("sha256:"), "带算法前缀");
  ok(pageHash("全文") !== pageHash("全文2"), "整页哈希区分");
}

process.exit(summary());
