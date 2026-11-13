/** 技能推送：内容比对、根目录文件、上限 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { readLocalSkill, scanSkillsDir, pushSkill, checkEligibility } from "../lib/publish/skill.ts";
import type { QdocMcpClient, SkillSummary } from "../lib/publish/mcp.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-push-"));

/** 造一个技能目录 */
function makeSkill(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

section("readLocalSkill：读整棵目录树，含根目录文件");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", {
    "SKILL.md": "# s1",
    "README.md": "说明",           // 根目录文件：曾被漏掉
    "manifest.json": "{}",         // 同上
    "references/a.md": "参考",
    "references/deep/b.md": "深层",
    "scripts/run.sh": "echo hi",
  });
  const s = readLocalSkill(dir)!;
  eq(s.files.length, 6, "六个文件全读到");
  const paths = s.files.map((f) => f.path).sort();
  eq(paths, ["README.md", "SKILL.md", "manifest.json", "references/a.md", "references/deep/b.md", "scripts/run.sh"],
    "路径完整且保留嵌套");
  rmSync(root, { recursive: true, force: true });
}

section("readLocalSkill：跳过二进制与隐藏文件");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", {
    "SKILL.md": "# s1",
    "logo.png": "binary",
    ".DS_Store": "junk",
    "references/ok.md": "文本",
  });
  const s = readLocalSkill(dir)!;
  eq(s.files.map((f) => f.path).sort(), ["SKILL.md", "references/ok.md"], "只留文本文件");
  rmSync(root, { recursive: true, force: true });
}

section("readLocalSkill：无 SKILL.md → null");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", { "README.md": "没有 SKILL" });
  eq(readLocalSkill(dir), null, "缺根 SKILL.md 返回 null");
  rmSync(root, { recursive: true, force: true });
}

section("checkEligibility：文件数上限");
{
  const root = tmp();
  const files: Record<string, string> = { "SKILL.md": "# s" };
  for (let i = 0; i < 55; i++) files[`references/f${i}.md`] = "x";
  const s = readLocalSkill(makeSkill(root, "big", files))!;
  const e = checkEligibility(s);
  ok(!e.ok, "55 文件超限");
  ok(e.reasons.some((r) => r.includes("50")), "报出 50 上限");
  rmSync(root, { recursive: true, force: true });
}

section("scanSkillsDir：只扫目录，跳过隐藏");
{
  const root = tmp();
  makeSkill(root, "a", { "SKILL.md": "# a" });
  makeSkill(root, "b", { "SKILL.md": "# b" });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, "notadir.txt"), "x", "utf8");
  const list = scanSkillsDir(root);
  eq(list.map((s) => s.name), ["a", "b"], "两个技能，按名排序");
  rmSync(root, { recursive: true, force: true });
}

// ---------------- 假 client ----------------

function fakeClient(platformFiles: Array<{ path: string; content: string }>, version = 1): QdocMcpClient {
  let updated = 0;
  return {
    getSkill: async (id: string) => ({ id, name: "s1", version, files: platformFiles }),
    updateSkill: async () => {
      updated++;
      return { version: version + 1 };
    },
    importSkillFromFiles: async () => ({ skill_id: "new-id", version: 1 }),
    // 暴露计数
    __updated: () => updated,
  } as unknown as QdocMcpClient & { __updated: () => number };
}

const platformSkill: SkillSummary[] = [{ id: "id1", name: "s1", description: "d", source: "MCP", builtin: false }];

section("pushSkill：内容一致 → unchanged，不调平台");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", { "SKILL.md": "# s1", "README.md": "说明" });
  const s = readLocalSkill(dir)!;
  const client = fakeClient([{ path: "SKILL.md", content: "# s1" }, { path: "README.md", content: "说明" }]);
  const r = await pushSkill({ client, skill: s, platformSkills: platformSkill, description: "d" });
  eq(r.action, "unchanged", "内容一致 → unchanged");
  eq((client as unknown as { __updated: () => number }).__updated(), 0, "没调用 update_skill");
  rmSync(root, { recursive: true, force: true });
}

section("pushSkill：内容不同 → updated");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", { "SKILL.md": "# 新内容" });
  const s = readLocalSkill(dir)!;
  const client = fakeClient([{ path: "SKILL.md", content: "# 旧内容" }]);
  const r = await pushSkill({ client, skill: s, platformSkills: platformSkill, description: "d" });
  eq(r.action, "updated", "内容不同 → updated");
  eq((client as unknown as { __updated: () => number }).__updated(), 1, "调用了 update_skill");
  rmSync(root, { recursive: true, force: true });
}

section("pushSkill：平台没有 → imported，记 needsEnable");
{
  const root = tmp();
  const dir = makeSkill(root, "s1", { "SKILL.md": "# s1" });
  const s = readLocalSkill(dir)!;
  const client = fakeClient([]);
  const r = await pushSkill({ client, skill: s, platformSkills: [], description: "d" });
  eq(r.action, "imported", "平台没有 → imported");
  eq(r.needsEnable, true, "平台导入后是未启用状态");
  rmSync(root, { recursive: true, force: true });
}

section("pushSkill：不可推时不调平台");
{
  const root = tmp();
  const files: Record<string, string> = { "SKILL.md": "# s" };
  for (let i = 0; i < 55; i++) files[`references/f${i}.md`] = "x";
  const s = readLocalSkill(makeSkill(root, "big", files))!;
  const client = fakeClient([]);
  const r = await pushSkill({ client, skill: s, platformSkills: [], description: "d" });
  eq(r.action, "blocked", "超限 → blocked");
  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
