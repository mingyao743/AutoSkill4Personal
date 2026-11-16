/** 平台文件名规则：去前缀（2026-11-16）+ 旧名对账 */
import { ok, eq, section, summary } from "./_harness.ts";
import {
  toPlatformFilename, projectTag, projectSlug, legacyFilename, guessPagePath,
} from "../lib/publish/naming.ts";

section("新规则：无前缀、扁平化、保留中英文");
eq(toPlatformFilename("skills/mcp-streamable-http-probe.md"), "skills-mcp-streamable-http-probe.md",
  "路径 → 扁平化");
eq(toPlatformFilename("概念/知识编译.md"), "概念-知识编译.md", "中文保留");
eq(toPlatformFilename("References/QDoc MCP.md"), "references-qdoc-mcp.md",
  "小写化，空格转连字符");
ok(toPlatformFilename("a/b/c.md").startsWith("a-b-c"), "不再带 qdoc- 前缀");
ok(!toPlatformFilename("a/b.md").includes("qdoc-"), "任何路径都不产生前缀");

section("项目短名与 tag");
eq(projectSlug("/Users/x/Documents/cmy-only/AutoSkill4Personal"), "autoskill4personal", "取目录名");
eq(projectTag("/Users/x/Documents/cmy-only/AutoSkill4Personal"), "p:autoskill4personal",
  "tag 形如 p:<短名>（平台 tag 上限 20 字符）");
ok(projectTag("/some/very-long-project-name-here").length <= 20, "tag 不超过平台 20 字符上限");
ok(/^p[0-9a-f]{8}$/.test(projectSlug("/中文目录/知识库")), "全中文目录名退化为哈希");

section("旧名对账：guessPagePath 只认旧前缀形式");
const root = "/Users/x/Documents/cmy-only/AutoSkill4Personal";
eq(legacyFilename("skills/mcp-streamable-http-probe.md", root),
  "qdoc-autoskill4personal-skills-mcp-streamable-http-probe.md", "旧规则可再生");
eq(guessPagePath("qdoc-autoskill4personal-skills-x.md", root), "skills-x.md", "旧名可反解");
eq(guessPagePath("skills-x.md", root), null, "新名有损，不反解（对账靠台账 doc_id）");

process.exit(summary());
