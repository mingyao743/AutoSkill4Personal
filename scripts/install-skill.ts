/**
 * 把 `agent-skills/` 下的技能装到各宿主的技能目录。
 *
 * 为什么要有脚本：手工 `cp -R` 的问题是**装完不知道装的是哪个版本**，改完仓库
 * 忘了重装，宿主跑的还是旧代码。这里做四件事：
 *  1. 覆盖安装（原子替换，避免读到半个技能）
 *  2. 打印每个技能的内容哈希，方便核对「装的和仓库里的是不是同一份」
 *  3. 记录安装基线（`~/.config/qdoc/skill-install.json`），自动检查才能安全重装
 *  4. `--check` 只比对不写，可进 CI / 定时任务
 *
 * 用法：
 *   node --experimental-strip-types scripts/install-skill.ts
 *   node --experimental-strip-types scripts/install-skill.ts --check
 *   node --experimental-strip-types scripts/install-skill.ts --host=dsh
 *   node --experimental-strip-types scripts/install-skill.ts --host=all
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_DIRS, installOwLauncher, installRepoSkills, type HostName, type RepoInstallResult,
} from "../packages/core/lib/sync/install.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const SRC = join(REPO_ROOT, "agent-skills");

function parseHost(arg: string | undefined): HostName[] | null {
  if (!arg || arg === "all") return Object.keys(HOST_DIRS) as HostName[];
  if (arg in HOST_DIRS) return [arg as HostName];
  return null;
}

function main(): number {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const hostArg = args.find((a) => a.startsWith("--host="))?.split("=")[1]
    ?? (args.includes("--host") ? args[args.indexOf("--host") + 1] : undefined);
  const hosts = parseHost(hostArg);
  if (!hosts) {
    process.stderr.write(`未知宿主：${hostArg}（可选 ${Object.keys(HOST_DIRS).join("|")}|all）\n`);
    return 2;
  }

  if (!existsSync(SRC)) {
    process.stderr.write(`找不到源目录：${SRC}\n`);
    return 2;
  }

  const results = installRepoSkills({ repoRoot: REPO_ROOT, hosts, checkOnly });
  if (results.length === 0) {
    process.stderr.write(`agent-skills/ 下没有含 SKILL.md 的技能\n`);
    return 2;
  }

  const lines: string[] = [];
  let drifted = 0;
  for (const host of hosts) {
    lines.push(`${host}：${HOST_DIRS[host]}`);
    const own = results.filter((r) => r.host === host);
    for (const r of own) lines.push(formatResult(r, checkOnly));
    lines.push("");
  }

  if (checkOnly) {
    drifted = results.filter((r) => r.action !== "unchanged").length;
    lines.push(drifted === 0 ? "全部一致。" : `${drifted} 个技能需要重装：跑不带 --check 的版本。`);
  } else {
    const launcher = installOwLauncher(REPO_ROOT);
    lines.push(
      launcher.ok
        ? `ow 入口：${launcher.path}`
        : `⚠ ow 入口创建失败：${launcher.error ?? "未知错误"}（可手动把 scripts/ow 加进 PATH）`,
    );
  }

  process.stdout.write(lines.join("\n") + "\n");
  return checkOnly && drifted > 0 ? 1 : 0;
}

function formatResult(r: RepoInstallResult, checkOnly: boolean): string {
  const repo = r.repoHash ?? "?";
  if (checkOnly) {
    if (r.action === "unchanged") return `  = ${r.name}  ${repo}（已是最新）`;
    return `  ≠ ${r.name}  仓库 ${repo} / 已装 ${r.hostHash ?? "未安装"}`;
  }
  if (r.action === "unchanged") return `  = ${r.name}  ${repo}（已是最新）`;
  if (r.action === "installed") return `  ↓ ${r.name}  未安装 → ${repo}`;
  if (r.action === "updated") return `  ↓ ${r.name}  ${r.hostHash ?? "未安装"} → ${repo}`;
  if (r.action === "pruned") return `  - ${r.name}  仓库已删除，清理宿主副本`;
  return `  ✗ ${r.name}  安装失败${r.error ? `：${r.error}` : ""}`;
}

process.exit(main());
