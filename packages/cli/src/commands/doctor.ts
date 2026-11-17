/**
 * `ow doctor`：宿主接入自检。
 *
 * 解决的问题：仓库改名/搬家后，dsh profile 的软链、pi 的 package 路径会悄悄断；
 * Node 版本/ zstd 不可用会让 ow capture 静默失效。doctor 把这些“运行环境事实”
 * 一次查完，并支持 `--host pi` 只看目标宿主，避免 pi-only 机器被 dsh 误报。
 *
 * 只读，不修；修法打印在问题下面。
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { checkSkillDrift, describeDrift, findRepoRoot, hostSkillDir, type HostName } from "../../../core/lib/sync/drift.ts";
import { zstdStatus } from "../../../core/lib/trigger/session-file.ts";
import { readAutoSyncState, localTime } from "../../../core/lib/sync/auto-check.ts";
import { resolveToken } from "../../../core/lib/publish/mcp.ts";
import { out } from "../vault-ctx.ts";
import { flagString, type ParsedArgs } from "../args.ts";

interface Issue { level: "error" | "warn"; area: string; message: string; fix?: string }

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function checkDshProfiles(issues: Issue[], lines: string[]): void {
  const root = join(homedir(), ".dsh", "profiles");
  let names: string[];
  try { names = readdirSync(root); } catch {
    lines.push("  未发现 ~/.dsh/profiles（当前机器可能只装了 pi）");
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg) continue;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const dsh = (pkg.dsh ?? {}) as { profile?: { bundles?: string[] } };
    const bundles = dsh.profile?.bundles ?? [];
    const declared = Boolean(deps["dsh-autoskill"]);
    const bundled = bundles.includes("dsh-autoskill");
    if (!declared && !bundled) continue;

    const link = join(dir, "node_modules", "dsh-autoskill");
    let status = "缺失";
    let target = "";
    try {
      target = readlinkSync(link);
      status = existsSync(realpathSync(link)) ? "ok" : "断链";
    } catch {
      if (existsSync(link)) status = "目录（非软链）";
    }
    lines.push(`  dsh/${name}: 声明=${declared ? "是" : "否"} bundle=${bundled ? "是" : "否"} 软链=${status}`);
    if (!bundled) {
      issues.push({
        level: "warn", area: `dsh/${name}`,
        message: "声明了 dsh-autoskill 但没有放进 dsh.profile.bundles，插件不会加载",
        fix: `在 ${join(dir, "package.json")} 的 dsh.profile.bundles 里加 "dsh-autoskill"`,
      });
    }
    if (status === "断链" || status === "缺失") {
      issues.push({
        level: "error", area: `dsh/${name}`,
        message: `dsh-autoskill 软链${status}${target ? `（→ ${target}）` : ""}`,
        fix: `cd ${dir} && pnpm install；或 ln -sfn <本仓库>/packages/adapter-dsh ${link}`,
      });
    }
  }
}

function expandPiPackage(p: string, settingsDir: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(settingsDir, p);
}

function checkPi(issues: Issue[], lines: string[]): void {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  const settings = readJson(settingsPath);
  if (!settings) {
    lines.push("  未找到 ~/.pi/agent/settings.json");
    issues.push({
      level: "warn", area: "pi", message: "找不到 pi settings.json（pi 未安装或首次未运行）",
      fix: "先跑一次 pi，再回来 doctor",
    });
    return;
  }
  const pkgs = (settings.packages ?? []) as string[];
  const autoskill = pkgs.filter((p) => p.includes("AutoSkill") || p.toLowerCase().includes("autoskill"));
  if (autoskill.length === 0) {
    lines.push("  未登记 AutoSkill 包");
    issues.push({
      level: "warn", area: "pi", message: "settings.json 的 packages 里没有 AutoSkill",
      fix: "pi install <本仓库>",
    });
    return;
  }
  const settingsDir = dirname(settingsPath);
  for (const p of autoskill) {
    if (p.startsWith("npm:") || p.startsWith("git:") || p.startsWith("http")) {
      lines.push(`  ${p}（非本地路径，跳过存在性检查）`);
      continue;
    }
    const abs = expandPiPackage(p, settingsDir);
    const ok = existsSync(join(abs, "package.json"));
    lines.push(`  ${p} → ${abs}（${ok ? "ok" : "不存在"}）`);
    if (!ok) {
      issues.push({
        level: "error", area: "pi",
        message: `package 路径不存在：${abs}`,
        fix: `pi remove ${p} && pi install <本仓库>`,
      });
    }
  }
}

/** opencode：目录在不在 + 插件装没装（opencode 本体没装时只提示，不算错误） */
function checkOpencode(issues: Issue[], lines: string[]): void {
  const skillsDir = hostSkillDir("opencode");
  const skillsOk = existsSync(skillsDir);
  lines.push(`  skills 目录: ${skillsDir}（${skillsOk ? "ok" : "未安装"}）`);
  if (!skillsOk) {
    issues.push({
      level: "warn", area: "opencode",
      message: `opencode 技能目录不存在：${skillsDir}`,
      fix: `npm run install-skill -- --host opencode`,
    });
  }
  const dataDir = join(homedir(), ".config", "qdoc", "knowledge", "opencode");
  lines.push(`  知识数据目录: ${dataDir}（${existsSync(dataDir) ? "ok" : "首跑自动创建"}）`);
  const pluginDir = join(homedir(), ".config", "opencode", "plugins", "autoskill-opencode");
  const pluginOk = existsSync(pluginDir);
  lines.push(`  插件目录: ${pluginDir}（${pluginOk ? "ok" : "未安装"}）`);
  if (!pluginOk) {
    issues.push({
      level: "warn", area: "opencode",
      message: "adapter-opencode 插件未安装到 ~/.config/opencode/plugins",
      fix: "见 packages/adapter-opencode/README.md（软链或复制 packages/adapter-opencode）",
    });
  }
}

function checkRuntime(issues: Issue[], lines: string[]): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 6);
  lines.push(`  Node: ${process.version}${nodeOk ? " ok" : "（需要 ≥22.6）"}`);
  if (!nodeOk) {
    issues.push({
      level: "error", area: "runtime",
      message: `Node ${process.version} 低于 22.6，--experimental-strip-types 不可用`,
      fix: "升级 Node 或设置 OW_NODE=<node≥22.6 的路径>",
    });
  }
  const zstd = zstdStatus();
  lines.push(`  zstd: 内置=${zstd.builtin ? "有" : "无"} 外部=${zstd.external ? "有" : "无"}`);
  if (!zstd.builtin && !zstd.external) {
    issues.push({
      level: "warn", area: "runtime",
      message: "Node 没有内置 zstd，也没有 zstd 命令；ow capture 无法读 dsh 会话",
      fix: "升级 Node ≥22.15，或安装 zstd（brew install zstd / apt install zstd）",
    });
  }
}

function checkLauncher(issues: Issue[], lines: string[]): void {
  const p = join(homedir(), ".config", "qdoc", "bin", "ow");
  let target = "";
  try { target = realpathSync(p); } catch { /* 缺失 */ }
  const ok = Boolean(target) && existsSync(target);
  lines.push(`  ow 入口: ${p}（${ok ? `ok → ${target}` : "缺失"}）`);
  if (!ok) {
    issues.push({
      level: "warn", area: "cli",
      message: "ow 启动器不存在，qdoc 技能里的裸 `ow` 会 command not found",
      fix: "跑 npm run install-skill（会创建 ~/.config/qdoc/bin/ow）",
    });
    return;
  }
  const repo = findRepoRoot();
  if (repo && !target.startsWith(join(repo, "scripts", "ow"))) {
    issues.push({
      level: "warn", area: "cli",
      message: `ow 入口没有指向当前仓库：${target}`,
      fix: `npm run install-skill -- --force-launcher（或设置 OW_NODE 后保留自定义 wrapper）`,
    });
  }
}

function checkToken(issues: Issue[], lines: string[]): void {
  const { token, source } = resolveToken();
  if (!token) {
    lines.push("  token: 未配置");
    issues.push({
      level: "warn", area: "token",
      message: "未配置 qdoc token，平台同步会跳过",
      fix: "echo qdoc_… > ~/.config/qdoc/token && chmod 600 ~/.config/qdoc/token",
    });
    return;
  }
  let mode = "";
  try { mode = (statSync(source).mode & 0o777).toString(8); } catch { /* env token 没有文件 */ }
  lines.push(`  token: ${source}${mode ? `（${mode}）` : ""}`);
  if (mode && mode !== "600") {
    issues.push({ level: "warn", area: "token", message: `token 文件权限是 ${mode}，建议 600`, fix: `chmod 600 ${source}` });
  }
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const hostArg = flagString(args, "host") ?? "all";
  if (!["all", "dsh", "pi", "opencode"].includes(hostArg)) {
    process.stderr.write(`未知宿主：${hostArg}（可选 all|dsh|pi|opencode）\n`);
    return 2;
  }
  const hosts: HostName[] =
    hostArg === "all" ? ["dsh", "pi", "opencode"] : [hostArg as HostName];
  const lines: string[] = [`环境自检（host=${hostArg}）：`, ""];
  const issues: Issue[] = [];

  lines.push("运行时：");
  checkRuntime(issues, lines);

  if (hosts.includes("dsh")) {
    lines.push("", "dsh：");
    checkDshProfiles(issues, lines);
  }
  if (hosts.includes("pi")) {
    lines.push("", "pi：");
    checkPi(issues, lines);
  }
  if (hosts.includes("opencode")) {
    lines.push("", "opencode：");
    checkOpencode(issues, lines);
  }

  lines.push("", "CLI / 凭据：");
  checkLauncher(issues, lines);
  checkToken(issues, lines);

  const drift = hostArg === "all" ? checkSkillDrift() : checkSkillDrift({ host: hosts[0] });
  lines.push("", "技能漂移：");
  if (!drift.repoFound) {
    lines.push("  仓库根未找到（npm 安装形态？），跳过");
  } else if (drift.drifted.length === 0) {
    lines.push(`  ${hosts.join("/")} 与仓库一致`);
  } else {
    lines.push(`  ${describeDrift(drift) ?? ""}`);
    issues.push({
      level: "warn", area: "skills",
      message: `技能漂移：${drift.drifted.map((d) => d.name).join("、")}`,
      fix: `npm run install-skill -- --host ${hostArg}`,
    });
  }

  const auto = readAutoSyncState();
  lines.push("", "自动检查：");
  for (const h of hosts) {
    const r = auto.hosts[h]?.lastResult;
    lines.push(`  ${h}: ${r ? `${localTime(new Date(r.checked_at)).slice(0, 16).replace("T", " ")}（平台新增 ${r.platform.created} / 更新 ${r.platform.updated} / 冲突 ${r.platform.conflicts.length}）` : "未检查"}`);
  }

  if (issues.length === 0) {
    lines.push("", "结论：未发现问题。");
  } else {
    lines.push("", `发现 ${issues.length} 个问题：`);
    for (const i of issues) {
      lines.push(`  [${i.level}] ${i.area}：${i.message}`);
      if (i.fix) lines.push(`       修：${i.fix}`);
    }
  }

  out(args, lines.join("\n"), { issues, drift, autoSync: auto, host: hostArg });
  return issues.some((i) => i.level === "error") ? 1 : 0;
}
