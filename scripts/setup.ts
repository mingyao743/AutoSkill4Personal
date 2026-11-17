/**
 * 一键宿主安装（pi / dsh）：
 *   预检 → init vault → 平台技能 → 仓库技能 → ow launcher → doctor
 *
 * 设计目标：
 *  - **不需要 npm/pnpm install**：core/cli/adapter 只用 node 内置模块；
 *  - 顺序固定：平台技能先拉，仓库的 qdoc/ow-compiler 最后强制装，避免被平台旧版覆盖；
 *  - 幂等：重复跑不重复写；失败只报具体步骤；
 *  - `--json` 供 agent 直接读。
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { findGitRoot, initVault, resolveVault } from "../packages/core/lib/vault/init.ts";
import { QdocMcpClient, resolveToken } from "../packages/core/lib/publish/mcp.ts";
import { pullSkills } from "../packages/core/lib/sync/pull-skill.ts";
import {
  HOST_DIRS, hostSkillDir, installOwLauncher, installRepoSkills, type HostName,
} from "../packages/core/lib/sync/install.ts";
import { checkSkillDrift } from "../packages/core/lib/sync/drift.ts";
import { zstdStatus } from "../packages/core/lib/trigger/session-file.ts";

const REPO_ROOT = join(import.meta.dirname, "..");

interface Step { name: string; ok: boolean; detail: string }
interface SetupResult {
  ok: boolean;
  project: string;
  vault: string | null;
  hosts: HostName[];
  steps: Step[];
  warnings: string[];
  errors: string[];
}

function parseArgs(argv: string[]) {
  const has = (f: string): boolean => argv.includes(`--${f}`);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  return {
    host: opt("host") ?? "pi",
    json: has("json"),
    dryRun: has("dry-run"),
    noLauncher: has("no-launcher") || opt("launcher") === "no",
    forceLauncher: has("force-launcher"),
    skipPlatform: has("skip-platform"),
    project: opt("project"),
    help: has("help"),
  };
}

function resolveHosts(raw: string): HostName[] | null {
  if (raw === "all") return ["dsh", "pi"];
  if (raw in HOST_DIRS) return [raw as HostName];
  return null;
}

function line(out: string[], s: string): void {
  out.push(s);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`用法：node --experimental-strip-types scripts/setup.ts [--host pi|dsh|all]

  --host <h>        目标宿主，默认 pi；all = dsh + pi
  --project <dir>   项目根（默认当前目录）
  --dry-run         只打印计划，不写文件/不联网
  --skip-platform   不拉平台技能（只装仓库技能）
  --no-launcher     不创建/更新 ~/.config/qdoc/bin/ow
  --force-launcher  覆盖已有的自定义 ow 入口
  --json            输出 JSON
`);
    return 0;
  }

  const hosts = resolveHosts(args.host);
  if (!hosts) {
    process.stderr.write(`未知宿主：${args.host}（可选 pi|dsh|all；qoder/codebuddy 用 npm run install-skill）\n`);
    return 2;
  }

  const project = args.project ? resolve(process.cwd(), args.project) : process.cwd();
  const out: string[] = [];
  const result: SetupResult = {
    ok: true, project, vault: null, hosts, steps: [], warnings: [], errors: [],
  };
  const step = (name: string, ok: boolean, detail: string): void => {
    result.steps.push({ name, ok, detail });
    line(out, `${ok ? "✓" : "✗"} ${name}：${detail}`);
    if (!ok) result.errors.push(`${name}: ${detail}`);
  };
  const warn = (s: string): void => {
    result.warnings.push(s);
    line(out, `⚠ ${s}`);
  };

  // 1. 预检
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) {
    step("预检", false, `Node ${process.version} 低于 22.6`);
    result.ok = false;
    return finish(result, out, args.json, 1);
  }
  const zstd = zstdStatus();
  if (!zstd.builtin && !zstd.external) {
    warn("Node 没有内置 zstd，也没有 zstd 命令；ow capture 读 dsh 会话会失败");
  } else if (!zstd.builtin) {
    warn(`Node ${process.version} 无内置 zstd，capture 将走外部 zstd`);
  }
  step("预检", true, `Node ${process.version}${zstd.builtin ? "（内置 zstd）" : zstd.external ? "（外部 zstd）" : "（无 zstd）"}`);

  // 2. vault
  const existing = resolveVault({ cwd: project, autoInit: false });
  if (existing) {
    result.vault = existing.dir;
    step("vault", true, `已存在 ${existing.dir}`);
  } else if (args.dryRun) {
    result.vault = join(findGitRoot(project) ?? project, ".qdoc");
    step("vault", true, `干跑：将初始化 ${result.vault}`);
  } else {
    const v = initVault(findGitRoot(project) ?? project);
    result.vault = v.dir;
    step("vault", true, `已初始化 ${v.dir}`);
  }

  const hostDirs = hosts.map((h) => `${h}=${hostSkillDir(h)}`).join(", ");
  step("宿主目录", true, hostDirs);

  // 3. 平台技能（先拉）
  if (!args.skipPlatform && result.vault) {
    if (args.dryRun) {
      step("平台技能", true, `干跑：将拉取平台技能到 ${hostDirs}`);
    } else {
      const { token, source } = resolveToken({ vaultDir: result.vault });
      if (!token) {
        warn(`未配置 qdoc token（${source}），跳过平台技能；稍后跑 ow sync --host ${args.host} --direction pull`);
      } else {
        try {
          const client = new QdocMcpClient({ token });
          await client.initialize();
          for (const host of hosts) {
            const results = await pullSkills({
              client, vaultDir: result.vault, skillsRoot: hostSkillDir(host), host,
            });
            const created = results.filter((r) => r.action === "created").length;
            const updated = results.filter((r) => r.action === "updated" || r.action === "adopted").length;
            const failed = results.filter((r) => r.action === "failed").length;
            step(`平台技能（${host}）`, failed === 0, `新增 ${created} / 更新 ${updated}${failed ? ` / 失败 ${failed}` : ""}`);
          }
        } catch (e) {
          step("平台技能", false, String(e).slice(0, 300));
        }
      }
    }
  } else if (args.skipPlatform) {
    step("平台技能", true, "已跳过（--skip-platform）");
  }

  // 4. 仓库技能（最后装，覆盖平台旧版 qdoc/ow-compiler）
  if (args.dryRun) {
    step("仓库技能", true, `干跑：将安装 agent-skills 到 ${hosts.join(", ")}`);
  } else {
    try {
      const results = installRepoSkills({ repoRoot: REPO_ROOT, hosts });
      const changed = results.filter((r) => r.action !== "unchanged" && r.action !== "pruned").length;
      const failed = results.filter((r) => r.action === "modified" && r.error).length;
      step("仓库技能", failed === 0, `安装 ${changed} 个变更${failed ? ` / 失败 ${failed}` : ""}`);
      for (const r of results) {
        if (r.action === "modified" && r.error) warn(`${r.name}: ${r.error}`);
      }
    } catch (e) {
      step("仓库技能", false, String(e).slice(0, 300));
    }
  }

  // 5. launcher
  if (!args.noLauncher && !args.dryRun) {
    const launcher = installOwLauncher(REPO_ROOT, { force: args.forceLauncher });
    if (launcher.ok) step("ow 入口", true, launcher.preserved ? `保留已有 ${launcher.path}` : launcher.path);
    else step("ow 入口", false, launcher.error ?? "未知错误");
  } else {
    step("ow 入口", true, args.noLauncher ? "已跳过（--no-launcher）" : "干跑：将创建 ~/.config/qdoc/bin/ow");
  }

  // 6. drift（doctor 的轻量前置；完整检查引导用户跑 ow doctor）
  const drift = checkSkillDrift(hosts.length === 1 ? { host: hosts[0] } : {});
  if (!drift.repoFound) warn("仓库根未找到，跳过技能漂移检查");
  else if (drift.drifted.length > 0) {
    const names = drift.drifted.map((d) => d.name).join("、");
    // 干跑时“重装”是计划的一部分，不应当成失败；真实运行后仍有漂移才是问题
    step("技能漂移", args.dryRun, args.dryRun ? `干跑：将重装 ${names}` : names);
  } else step("技能漂移", true, `${hosts.join("/")} 与仓库一致`);

  const ok = result.errors.length === 0;
  result.ok = ok;
  line(out, "", ok ? "安装完成。" : "安装完成，但有错误需要处理。");
  line(out, `下一步：重启 ${hosts.join(" / ")}；然后跑 ow doctor --host ${args.host}`);
  return finish(result, out, args.json, ok ? 0 : 1);
}

function finish(result: SetupResult, lines: string[], json: boolean, code: number): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return code;
}

process.exit(await main());
