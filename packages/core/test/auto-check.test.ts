/** 每日首次访问检查 + 安全重装 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  installRepoSkills, reinstallSafeSkills, readInstallState, hashDir,
} from "../lib/sync/install.ts";
import {
  maybeAutoSync, readAutoSyncState, autoSyncStatePath, localDate,
} from "../lib/sync/auto-check.ts";
import type { PullResult } from "../lib/sync/pull-skill.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-auto-"));

function makeRepo(root: string, content = "# 演示技能 v1\n"): string {
  mkdirSync(join(root, "agent-skills", "demo"), { recursive: true });
  writeFileSync(join(root, "agent-skills", "demo", "SKILL.md"), content, "utf8");
  return root;
}

function makeVault(root: string): string {
  const v = join(root, "proj", ".qdoc");
  mkdirSync(v, { recursive: true });
  return v;
}

section("安装基线 + 安全重装");
{
  const root = tmp();
  const repo = makeRepo(join(root, "repo"));
  const host = join(root, "host");
  const machine = join(root, "machine");

  const first = installRepoSkills({ repoRoot: repo, hosts: ["dsh"], hostDir: host, machineDir: machine });
  eq(first[0].action, "installed", "首次安装");
  eq(readFileSync(join(host, "demo", "SKILL.md"), "utf8"), "# 演示技能 v1\n", "内容落盘");
  const st = readInstallState(machine);
  eq(!!st.hosts.dsh.demo?.installed_hash, true, "记录安装基线");

  // 仓库更新，宿主未改 → 自动重装
  writeFileSync(join(repo, "agent-skills", "demo", "SKILL.md"), "# 演示技能 v2\n", "utf8");
  const r2 = reinstallSafeSkills({ repoRoot: repo, host: "dsh", hostDir: host, machineDir: machine });
  eq(r2[0].action, "reinstalled", "仓库更新 → 自动重装");
  eq(readFileSync(join(host, "demo", "SKILL.md"), "utf8"), "# 演示技能 v2\n", "重装后内容更新");

  // 用户手改，仓库再更新 → 不覆盖
  writeFileSync(join(host, "demo", "SKILL.md"), "# 我手改的版本\n", "utf8");
  writeFileSync(join(repo, "agent-skills", "demo", "SKILL.md"), "# 演示技能 v3\n", "utf8");
  const r3 = reinstallSafeSkills({ repoRoot: repo, host: "dsh", hostDir: host, machineDir: machine });
  eq(r3[0].action, "modified", "手改 → 不覆盖");
  eq(readFileSync(join(host, "demo", "SKILL.md"), "utf8"), "# 我手改的版本\n", "手改内容保留");

  // 原子替换不留下临时/备份目录
  const leftovers = readdirSync(host).filter((n) => n.includes(".tmp-") || n.includes(".bak-"));
  eq(leftovers, [], "无临时/备份残留");

  rmSync(root, { recursive: true, force: true });
}

section("仓库删除技能：安全 prune");
{
  const root = tmp();
  const repo = makeRepo(join(root, "repo"));
  const host = join(root, "host");
  const machine = join(root, "machine");
  installRepoSkills({ repoRoot: repo, hosts: ["dsh"], hostDir: host, machineDir: machine });
  rmSync(join(repo, "agent-skills", "demo"), { recursive: true, force: true });

  const r = reinstallSafeSkills({ repoRoot: repo, host: "dsh", hostDir: host, machineDir: machine });
  eq(r.find((x) => x.name === "demo")?.action, "pruned", "从未改动 → 删除");
  eq(existsSync(join(host, "demo")), false, "宿主目录已清理");
  eq(readInstallState(machine).hosts.dsh.demo, undefined, "安装基线已移除");
  rmSync(root, { recursive: true, force: true });
}

section("仓库删除但宿主手改 → 不 prune");
{
  const root = tmp();
  const repo = makeRepo(join(root, "repo"));
  const host = join(root, "host");
  const machine = join(root, "machine");
  installRepoSkills({ repoRoot: repo, hosts: ["dsh"], hostDir: host, machineDir: machine });
  writeFileSync(join(host, "demo", "SKILL.md"), "# 我改过\n", "utf8");
  rmSync(join(repo, "agent-skills", "demo"), { recursive: true, force: true });

  const r = reinstallSafeSkills({ repoRoot: repo, host: "dsh", hostDir: host, machineDir: machine });
  eq(r.find((x) => x.name === "demo")?.action, "modified", "手改 → 不删");
  eq(existsSync(join(host, "demo")), true, "宿主目录保留");
  rmSync(root, { recursive: true, force: true });
}

section("首次访问检查：同日只一次、跨日再检查");
{
  const root = tmp();
  const repo = makeRepo(join(root, "repo"));
  const host = join(root, "host");
  const machine = join(root, "machine");
  const vault = makeVault(root);
  let pulls = 0;
  const pull = async (): Promise<PullResult[]> => {
    pulls++;
    return [{ name: "demo", action: "unchanged" }];
  };

  const day1 = new Date(2026, 10, 17, 9, 0, 0);
  const r1 = await maybeAutoSync({ host: "dsh", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: day1, pull } as never);
  eq(r1.status, "checked", "当天第一次：执行");
  eq(pulls, 1, "平台检查一次");
  eq(r1.summary?.repo.installed.includes("demo"), true, "仓库技能自动安装");
  eq(r1.summary?.repo.git, undefined, "非 git 仓库不加 git 状态");

  const r2 = await maybeAutoSync({ host: "dsh", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 17, 18, 0, 0), pull });
  eq(r2.status, "already-checked", "同一天第二次：跳过");
  eq(pulls, 1, "不再联网");

  const r3 = await maybeAutoSync({ host: "dsh", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 18, 8, 0, 0), pull });
  eq(r3.status, "checked", "跨天：再检查");
  eq(pulls, 2, "跨天联网一次");
  rmSync(root, { recursive: true, force: true });
}

section("失败退避 + 锁冲突");
{
  const root = tmp();
  const repo = makeRepo(join(root, "repo"));
  const host = join(root, "host");
  const machine = join(root, "machine");
  const vault = makeVault(root);
  const pull = async (): Promise<PullResult[]> => { throw new Error("offline"); };

  const r1 = await maybeAutoSync({ host: "pi", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 17, 9, 0, 0), pull });
  eq(r1.status, "error", "平台失败 → error");
  ok(!!r1.retryAt, "给出重试时间");

  const r2 = await maybeAutoSync({ host: "pi", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 17, 9, 10, 0), pull });
  eq(r2.status, "backoff", "退避期内不再试");

  const r3 = await maybeAutoSync({ host: "pi", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 17, 10, 30, 0), pull });
  eq(r3.status, "error", "退避到期后重试");

  // 模拟另一宿主持锁：dsh 应直接 busy
  const lock = join(machine, "auto-sync.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ expanded: false, expires_at: new Date(2026, 10, 17, 12, 0, 0).toISOString() }));
  const r4 = await maybeAutoSync({ host: "dsh", repoRoot: repo, skillsRoot: host, vaultDir: vault, machineDir: machine, now: new Date(2026, 10, 17, 11, 0, 0), pull });
  eq(r4.status, "busy", "锁被占用 → busy");
  rmSync(root, { recursive: true, force: true });
}

section("状态与日期");
{
  eq(localDate(new Date(2026, 0, 2, 23, 59, 0)), "2026-01-02", "本地日期格式化");
  const root = tmp();
  const p = autoSyncStatePath(join(root, "m"));
  ok(p.endsWith("auto-sync.json"), "状态文件路径", p);
  const st = readAutoSyncState(join(root, "m"));
  eq(st.hosts, {}, "无状态时为空");
  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
