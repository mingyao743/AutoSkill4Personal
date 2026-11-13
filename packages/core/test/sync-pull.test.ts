/** 技能拉取：两级检查、路径安全、冲突不覆盖 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  extractSkillFiles, isSafeSkillPath, readSkillDir, writeSkillDir, pullSkills,
} from "../lib/sync/pull-skill.ts";
import {
  readManifest, writeManifest, recordPull, recordPush, healPendingEnable,
  stalePendingEnable, manifestStats, hashSkillFiles, markMissing,
} from "../lib/sync/manifest.ts";
import type { QdocMcpClient, SkillSummary } from "../lib/publish/mcp.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-sync-"));

section("路径安全：拒绝穿越与绝对路径");
{
  ok(isSafeSkillPath("SKILL.md"), "根文件");
  ok(isSafeSkillPath("references/a/b.md"), "嵌套路径");
  ok(!isSafeSkillPath("../etc/passwd"), "拒绝 ..");
  ok(!isSafeSkillPath("/etc/passwd"), "拒绝绝对路径");
  ok(!isSafeSkillPath("C:/Windows/x"), "拒绝盘符");
  ok(!isSafeSkillPath("a/../../b"), "拒绝中间 ..");
  ok(!isSafeSkillPath(""), "拒绝空路径");
}

section("extractSkillFiles：实测形状 files:[{path,content}]");
{
  const files = extractSkillFiles({
    id: "x", version: 3,
    files: [
      { path: "SKILL.md", content: "# 技能" },
      { path: "references/a.md", content: "参考" },
      { path: "../../evil", content: "坏" },
      { path: "空内容.md", content: "" },
      { path: "SKILL.md" },
    ],
  });
  eq(files.length, 2, "只留两个合法且有内容的");
  eq(files[0].path, "SKILL.md", "第一个");
  eq(files[1].path, "references/a.md", "第二个");
}

section("extractSkillFiles：非预期形状返回空");
{
  eq(extractSkillFiles(null), [], "null");
  eq(extractSkillFiles({}), [], "无 files");
  eq(extractSkillFiles({ files: "不是数组" }), [], "files 不是数组");
}

section("writeSkillDir + readSkillDir 往返");
{
  const dir = tmp();
  writeSkillDir(dir, [
    { path: "SKILL.md", content: "# A" },
    { path: "references/x/y.md", content: "深层" },
  ]);
  const back = readSkillDir(dir);
  eq(back.length, 2, "两个文件");
  eq(back.map((f) => f.path).sort(), ["SKILL.md", "references/x/y.md"], "路径保留嵌套");
  ok(existsSync(join(dir, "references/x/y.md")), "深层目录已建");
  rmSync(dir, { recursive: true, force: true });
}

section("清单：拉取/推送/统计");
{
  const vault = tmp();
  recordPull(vault, "s1", { skill_id: "id1", version: 2, sha: "h1", target: "/t/s1" });
  recordPush(vault, "s2", { skill_id: "id2", version: 1, sha: "h2", target: "/t/s2", pendingEnable: true });

  const st = manifestStats(vault);
  eq(st.total, 2, "共 2 个");
  eq(st.pulled, 1, "拉取 1 个");
  eq(st.pushed, 1, "推送 1 个");
  eq(st.pendingEnable, 1, "待启用 1 个");

  const m = readManifest(vault);
  eq(m.skills.s1.version, 2, "版本记录");
  eq(m.skills.s2.pending_enable, true, "待启用标记");
  rmSync(vault, { recursive: true, force: true });
}

section("待启用自愈");
{
  const vault = tmp();
  recordPush(vault, "s1", { skill_id: "id1", version: 1, sha: "h1", target: "/t", pendingEnable: true });
  eq(healPendingEnable(vault, new Set(["s1"])), ["s1"], "出现在列表里 → 自愈");
  eq(readManifest(vault).skills.s1.pending_enable, false, "标记已清");

  recordPush(vault, "s2", { skill_id: "id2", version: 1, sha: "h2", target: "/t", pendingEnable: true });
  eq(healPendingEnable(vault, new Set()), [], "不在列表里 → 不自愈");
  eq(readManifest(vault).skills.s2.pending_enable, true, "标记保留");
  rmSync(vault, { recursive: true, force: true });
}

section("待启用超期升级");
{
  const vault = tmp();
  recordPush(vault, "old", { skill_id: "i", version: 1, sha: "h", target: "/t", pendingEnable: true });
  const m = readManifest(vault);
  m.skills.old.pushed_at = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  writeManifest(vault, m);
  eq(stalePendingEnable(vault, 7), ["old"], "10 天前推的 → 超期");
  eq(stalePendingEnable(vault, 30), [], "30 天阈值下不算超期");
  rmSync(vault, { recursive: true, force: true });
}

section("markMissing 只标记不删");
{
  const vault = tmp();
  recordPull(vault, "s", { skill_id: "i", version: 1, sha: "h", target: "/t" });
  markMissing(vault, "s", true);
  eq(readManifest(vault).skills.s.missing_on_platform, true, "已标记");
  eq(manifestStats(vault).missing, 1, "统计反映");
  rmSync(vault, { recursive: true, force: true });
}

section("哈希：同内容同哈希，路径顺序无关");
{
  const a = hashSkillFiles([{ path: "a.md", content: "1" }, { path: "b.md", content: "2" }]);
  const b = hashSkillFiles([{ path: "b.md", content: "2" }, { path: "a.md", content: "1" }]);
  eq(a, b, "顺序不影响");
  ok(hashSkillFiles([{ path: "a.md", content: "改" }]) !== a, "内容变则哈希变");
}

// ---------------- 用假 client 跑 pullSkills 全路径 ----------------

function fakeClient(skills: Array<{ name: string; id: string; version: number; files: Array<{ path: string; content: string }> }>): QdocMcpClient {
  return {
    listAvailableSkills: async (): Promise<SkillSummary[]> =>
      skills.map((s) => ({ id: s.id, name: s.name, description: "d", source: "MCP", builtin: false })),
    getSkill: async (id: string) => {
      const s = skills.find((x) => x.id === id);
      if (!s) throw new Error("技能不存在");
      return { id: s.id, name: s.name, version: s.version, files: s.files };
    },
  } as unknown as QdocMcpClient;
}

section("pullSkills：新建");
{
  const root = tmp();
  const vault = tmp();
  const client = fakeClient([
    { name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# s1" }] },
  ]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  eq(r.length, 1, "一个技能");
  eq(r[0].action, "created", "新建");
  eq(r[0].toVersion, 1, "版本 1");
  ok(existsSync(join(root, "s1", "SKILL.md")), "文件已落盘");
  eq(readManifest(vault).skills.s1.version, 1, "清单已记");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：幂等 unchanged");
{
  const root = tmp();
  const vault = tmp();
  const client = fakeClient([
    { name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# s1" }] },
  ]);
  await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  const r2 = await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  eq(r2[0].action, "unchanged", "第二次 unchanged");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：平台更新 + 本地未改 → 覆盖");
{
  const root = tmp();
  const vault = tmp();
  const v1 = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# v1" }] }]);
  await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root });

  const v2 = fakeClient([{ name: "s1", id: "id1", version: 2, files: [{ path: "SKILL.md", content: "# v2" }] }]);
  const r = await pullSkills({ client: v2, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "updated", "更新");
  eq(r[0].fromVersion, 1, "从 v1");
  eq(r[0].toVersion, 2, "到 v2");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("# v2"), "内容已更新");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：本地改过 + 平台更新 → 冲突，不覆盖");
{
  const root = tmp();
  const vault = tmp();
  const v1 = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# v1" }] }]);
  await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root });

  // 本地改
  writeFileSync(join(root, "s1", "SKILL.md"), "# 本地改过的内容", "utf8");

  const v2 = fakeClient([{ name: "s1", id: "id1", version: 2, files: [{ path: "SKILL.md", content: "# v2" }] }]);
  const r = await pullSkills({ client: v2, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "conflict", "冲突");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("本地改过"), "本地改动未被覆盖");
  ok(r[0].conflictDir != null, "冲突现场路径");
  ok(existsSync(join(r[0].conflictDir!, "local", "SKILL.md")), "本地版本已存档");
  ok(existsSync(join(r[0].conflictDir!, "remote", "SKILL.md")), "平台版本已存档");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：本地有但清单没有且内容不同 → 只报不碰");
{
  const root = tmp();
  const vault = tmp();
  mkdirSync(join(root, "s1"), { recursive: true });
  writeFileSync(join(root, "s1", "SKILL.md"), "# 我自己写的", "utf8");

  const client = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# 平台版" }] }]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "adoptable", "报可接管，不擅自覆盖");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("我自己写的"), "本地内容未动");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：干跑不写盘");
{
  const root = tmp();
  const vault = tmp();
  const client = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# s1" }] }]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root, dryRun: true });
  eq(r[0].action, "created", "报告将新建");
  ok(!existsSync(join(root, "s1")), "但没真的建目录");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("pullSkills：平台技能消失 → 标记 missing 不删本地");
{
  const root = tmp();
  const vault = tmp();
  const v1 = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# s1" }] }]);
  await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root });

  const empty = fakeClient([]);
  await pullSkills({ client: empty, vaultDir: vault, skillsRoot: root });
  eq(readManifest(vault).skills.s1.missing_on_platform, true, "标记 missing");
  ok(existsSync(join(root, "s1", "SKILL.md")), "本地文件保留");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("接管：本地内容与平台一致 → adopted");
{
  const root = tmp();
  const vault = tmp();
  mkdirSync(join(root, "s1"), { recursive: true });
  writeFileSync(join(root, "s1", "SKILL.md"), "# 一样的内容", "utf8");

  const client = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# 一样的内容" }] }]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "adopted", "内容一致 → 自动接管");
  eq(readManifest(vault).skills.s1.skill_id, "id1", "清单已登记");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("接管：内容不同且未开 adopt → adoptable，不动本地");
{
  const root = tmp();
  const vault = tmp();
  mkdirSync(join(root, "s1"), { recursive: true });
  writeFileSync(join(root, "s1", "SKILL.md"), "# 我的版本", "utf8");

  const client = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# 平台版本" }] }]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "adoptable", "报可接管");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("我的版本"), "本地未动");
  eq(readManifest(vault).skills.s1, undefined, "未登记");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("接管：--adopt 显式接管，保留本地内容");
{
  const root = tmp();
  const vault = tmp();
  mkdirSync(join(root, "s1"), { recursive: true });
  writeFileSync(join(root, "s1", "SKILL.md"), "# 我的版本", "utf8");

  const client = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# 平台版本" }] }]);
  const r = await pullSkills({ client, vaultDir: vault, skillsRoot: root, adopt: true });
  eq(r[0].action, "adopted", "已接管");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("我的版本"), "本地内容保留");
  eq(readManifest(vault).skills.s1.origin, "pulled", "登记为受管");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("接管后：平台更新会覆盖（因为 sha 记的是本地）");
{
  const root = tmp();
  const vault = tmp();
  mkdirSync(join(root, "s1"), { recursive: true });
  writeFileSync(join(root, "s1", "SKILL.md"), "# 我的版本", "utf8");
  const v1 = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# 平台版本" }] }]);
  await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root, adopt: true });

  // 平台发新版本
  const v2 = fakeClient([{ name: "s1", id: "id1", version: 2, files: [{ path: "SKILL.md", content: "# 平台新版本" }] }]);
  const r = await pullSkills({ client: v2, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "updated", "平台更新 → 覆盖");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("平台新版本"), "内容已更新");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

section("本地改过但平台没变 → diverged，不报 unchanged");
{
  const root = tmp();
  const vault = tmp();
  const v1 = fakeClient([{ name: "s1", id: "id1", version: 1, files: [{ path: "SKILL.md", content: "# v1" }] }]);
  await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root });

  writeFileSync(join(root, "s1", "SKILL.md"), "# 我改了", "utf8");

  // 平台没变，再拉一次
  const r = await pullSkills({ client: v1, vaultDir: vault, skillsRoot: root });
  eq(r[0].action, "diverged", "报分叉，不报 unchanged");
  ok(r[0].message?.includes("冲突"), "提示会冲突");
  ok(readFileSync(join(root, "s1", "SKILL.md"), "utf8").includes("我改了"), "本地内容未动");
  rmSync(root, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
}

process.exit(summary());
