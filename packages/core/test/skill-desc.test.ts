/** extractSkillDescription：frontmatter description 的三种 YAML 写法 */
import { ok, eq, section, summary } from "./_harness.ts";
import { extractSkillDescription } from "../lib/publish/skill.ts";

section("单行与引号");
eq(
  extractSkillDescription("---\nname: x\ndescription: 单行说明\n---\n\n正文"),
  "单行说明",
  "单行",
);
eq(
  extractSkillDescription('---\nname: x\ndescription: "带引号"\n---'),
  "带引号",
  "引号剥掉",
);
eq(extractSkillDescription("---\nname: x\n---"), null, "没有 description");

section("折叠标量（caveman 真实案例，曾是 bug：只抓到 >）");
eq(
  extractSkillDescription(
    '---\nname: caveman\ndescription: >\n  Terse caveman voice: answer first, fluff gone, every technical fact kept.\n  Use for /caveman, "caveman mode".\n---\n\n正文',
  ),
  'Terse caveman voice: answer first, fluff gone, every technical fact kept. Use for /caveman, "caveman mode".',
  "折叠成一行",
);
eq(
  extractSkillDescription("---\ndescription: >-\n  折叠带 chomping\n  第二行\n---"),
  "折叠带 chomping 第二行",
  ">- 同样处理",
);

section("字面标量与边界");
eq(
  extractSkillDescription("---\ndescription: |\n  第一行\n  第二行\n---"),
  "第一行\n第二行",
  "| 保留换行",
);
eq(
  extractSkillDescription("---\ndescription: >\n  很长".padEnd(600, "长") + "\n---").length,
  500,
  "截到 500",
);
ok(extractSkillDescription("no frontmatter") === null, "无 frontmatter");
ok(extractSkillDescription("---\nother: x\ndescription: >\n  缩进块\n  续行\nname: y\n---") !== null, "块后跟下一个 key 正常收束");

process.exit(summary());
