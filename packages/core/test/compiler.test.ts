/** 编译产物解析：模型写坏 JSON 的容错 */
import { ok, eq, section, summary } from "./_harness.ts";
import { parseCompileOutput, repairJson } from "../lib/compiler/run.ts";

const page = (body: string): string =>
  `{"pages":[{"path":"concepts/a.md","title":"标题","summary":"摘要","tags":["x"],"body":${JSON.stringify(body)}}],"skipped":[]}`;

section("正常 JSON");
{
  const r = parseCompileOutput(page("## 是什么\n\n正文内容"));
  eq(r.pages.length, 1, "解析出一页");
  eq(r.pages[0].path, "concepts/a.md", "路径");
  ok(r.pages[0].body.includes("正文内容"), "正文");
}

section("代码围栏包裹");
{
  const r = parseCompileOutput("```json\n" + page("正文") + "\n```");
  eq(r.pages.length, 1, "剥掉围栏");
}

section("前后有解释文字");
{
  const r = parseCompileOutput("好的，结果如下：\n" + page("正文") + "\n以上就是全部内容。");
  eq(r.pages.length, 1, "取首尾花括号");
}

section("修复：字符串里的裸换行");
{
  // 模型常把 markdown 正文直接塞进 JSON，换行没转义
  const broken = '{"pages":[{"path":"concepts/a.md","title":"t","summary":"s","body":"第一行\n第二行\n第三行"}]}';
  let threw = false;
  try { JSON.parse(broken); } catch { threw = true; }
  ok(threw, "前置：裸换行确实非法");

  const r = parseCompileOutput(broken);
  eq(r.pages.length, 1, "修复后能解析");
  ok(r.pages[0].body.includes("第一行"), "内容保留");
  ok(r.pages[0].body.includes("第二行"), "第二行也在");
}

section("修复：正文里未转义的双引号");
{
  const broken = '{"pages":[{"path":"concepts/a.md","title":"t","summary":"s","body":"他说"你好"然后走了"}]}';
  let threw = false;
  try { JSON.parse(broken); } catch { threw = true; }
  ok(threw, "前置：裸引号确实非法");

  const r = parseCompileOutput(broken);
  eq(r.pages.length, 1, "修复后能解析");
  ok(r.pages[0].body.includes("你好"), "引号内内容保留");
}

section("修复不影响正常 JSON");
{
  eq(JSON.stringify(repairJson('{"a":1}')), '{"a":1}', "简单对象不变");
  eq(JSON.stringify(repairJson('{"a":"x\\ny"}')), '{"a":"x\\ny"}', "已转义的换行不变");
  eq(JSON.stringify(repairJson('{"a":"he said \\"hi\\""}')), '{"a":"he said \\"hi\\""}', "已转义的引号不变");
}

section("修复不了的仍然报错，且指出位置");
{
  const badly = '{"pages":[{"path":"concepts/a.md",,,}]}';
  let msg = "";
  try { parseCompileOutput(badly); } catch (e) { msg = String(e); }
  ok(msg.includes("不是合法 JSON"), "报错");
  ok(msg.includes("第 "), "指出行号");
  ok(msg.includes("^"), "标出位置");
}

section("路径校验：拒绝越界与非法目录");
{
  const mk = (p: string): string => `{"pages":[{"path":${JSON.stringify(p)},"title":"t","summary":"s","body":"正文内容"}]}`;
  eq(parseCompileOutput(mk("concepts/ok.md")).pages.length, 1, "允许目录通过");
  eq(parseCompileOutput(mk("../etc/passwd.md")).pages.length, 0, "拒绝 ..");
  eq(parseCompileOutput(mk("/etc/passwd.md")).pages.length, 0, "拒绝绝对路径");
  eq(parseCompileOutput(mk("random/a.md")).pages.length, 0, "拒绝非白名单目录");
  eq(parseCompileOutput(mk("concepts/a.txt")).pages.length, 0, "拒绝非 .md");
}

section("skipped 透传");
{
  const r = parseCompileOutput('{"pages":[],"skipped":[{"reason":"chatter","detail":"闲聊"}]}');
  eq(r.pages.length, 0, "无页面");
  eq(r.skipped.length, 1, "一条 skipped");
  eq(r.skipped[0].reason, "chatter", "原因");
}

process.exit(summary());
