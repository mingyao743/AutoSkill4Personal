/** 一源一主页守卫 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { guardPage } from "../lib/vault/guard.ts";

function makeVault(pages: Record<string, string>): string {
  const v = mkdtempSync(join(tmpdir(), "qdoc-guard-"));
  for (const [rel, content] of Object.entries(pages)) {
    const abs = join(v, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return v;
}

const page = (title: string, sources: string[]): string =>
  `---\ntitle: ${title}\nsources: [${sources.join(", ")}]\n---\n\n正文内容。\n`;

section("空库：create");
{
  const v = makeVault({});
  const r = guardPage({ vaultDir: v, candidatePath: "concepts/a.md", sources: ["s1"], title: "新页面" });
  eq(r.decision, "create", "空库新建");
  rmSync(v, { recursive: true, force: true });
}

section("路径已存在：update");
{
  const v = makeVault({ "concepts/a.md": page("已有页", ["s1"]) });
  const r = guardPage({ vaultDir: v, candidatePath: "concepts/a.md", sources: ["s9"], title: "完全不同的标题" });
  eq(r.decision, "update", "同路径 → 更新");
  eq(r.existingPath, "concepts/a.md", "指出撞上的路径");
  rmSync(v, { recursive: true, force: true });
}

section("标题完全相同：blocked");
{
  const v = makeVault({ "concepts/a.md": page("部署流程", ["s1"]) });
  const r = guardPage({ vaultDir: v, candidatePath: "concepts/b.md", sources: ["s2"], title: "部署流程" });
  eq(r.decision, "blocked", "同标题不同路径 → 拦下");
  eq(r.reason, "duplicate-title", "原因是重复标题");
  rmSync(v, { recursive: true, force: true });
}

section("标题近似（忽略空格标点大小写）");
{
  const v = makeVault({ "concepts/a.md": page("MCP Param Naming", ["s1"]) });
  const r = guardPage({ vaultDir: v, candidatePath: "concepts/b.md", sources: ["s2"], title: "mcp-param naming" });
  eq(r.decision, "blocked", "归一后同标题 → 拦下");
  rmSync(v, { recursive: true, force: true });
}

section("同源 + 标题近似：update");
{
  const v = makeVault({ "concepts/a.md": page("MCP 参数命名", ["session:s1"]) });
  const r = guardPage({
    vaultDir: v,
    candidatePath: "concepts/b.md",
    sources: ["session:s1"],
    title: "MCP 参数命名法",
  });
  eq(r.decision, "update", "同源近似 → 合并更新");
  eq(r.reason, "same-source-similar-title", "原因正确");
  rmSync(v, { recursive: true, force: true });
}

section("不同源 + 标题不同：create");
{
  const v = makeVault({ "concepts/a.md": page("部署流程", ["session:s1"]) });
  const r = guardPage({
    vaultDir: v,
    candidatePath: "concepts/b.md",
    sources: ["session:s2"],
    title: "回滚流程",
  });
  eq(r.decision, "create", "不同源不同题 → 新建");
  rmSync(v, { recursive: true, force: true });
}

section("只扫知识目录，忽略 .ow");
{
  const v = makeVault({
    "concepts/a.md": page("A", ["s1"]),
    ".ow/notes.md": page("A", ["s1"]),
  });
  const r = guardPage({ vaultDir: v, candidatePath: "concepts/b.md", sources: ["s2"], title: "A" });
  eq(r.decision, "blocked", "concepts/a.md 被扫到");
  eq(r.existingPath, "concepts/a.md", "撞的是知识页不是 .ow");
  rmSync(v, { recursive: true, force: true });
}

process.exit(summary());
