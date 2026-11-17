/**
 * `ow doctor`：宿主接入自检。
 *
 * 解决的问题：仓库改名/搬家后，dsh profile 的软链、pi 的 package 路径会悄悄断，
 * 宿主启动不报错，只是安静地少功能。doctor 把这些“运行环境事实”一次查完。
 *
 * 只读，不修；修法打印在问题下面。
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkSkillDrift, describeDrift } from "../../../core/lib/sync/drift.ts";
import { readAutoSyncState, localTime } from "../../../core/lib/sync/auto-check.ts";
import { resolveToken } from "../../../core/lib/publish/mcp.ts";
import { needVault, out } from "../vault-ctx.ts";
import type { ParsedArgs } from "../args.ts";

interface Issue { level: "error" | "warn"; area: string; message: string; fix?: string }

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function checkDshProfiles(issues: Issue[], lines: string[]): void {
  const root = join(homedir(), ".dsh", "profiles");
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
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

function checkPi(issues: Issue[], lines: string[]): void {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  const settings = readJson(settingsPath);
  if (!settings) {
    lines.push("  pi: 未找到 settings.json");
    return;
  }
  const pkgs = (settings.packages ?? []) as string[];
  const autoskill = pkgs.filter((p) => p.includes("AutoSkill") || p.includes("autoskill"));
  if (autoskill.length === 0) {
    lines.push("  pi: 未登记 AutoSkill 包");
    issues.push({
      level: "warn", area: "pi", message: "settings.json 的 packages 里没有 AutoSkill",
      fix: `pi install <本仓库>`,
    });
    return;
  }
  for (const p of autoskill) {
    const abs = p.startsWith("/") ? p : join(homedir(), p);
    const ok = existsSync(join(abs, "package.json"));
    lines.push(`  pi: ${p} → ${abs}（${ok ? "ok" : "不存在"}）`);
    if (!ok) {
      issues.push({
        level: "error", area: "pi",
        message: `package 路径不存在：${abs}`,
        fix: `pi remove ${p} && pi install <本仓库>`,
      });
    }
  }
}

function checkLauncher(issues: Issue[], lines: string[]): void {
  const p = join(homedir(), ".config", "qdoc", "bin", "ow");
  let ok = false;
  try { ok = existsSync(realpathSync(p)); } catch { /* 不存在 */ }
  lines.push(`  ow 入口: ${p}（${ok ? "ok" : "缺失"}）`);
  if (!ok) {
    issues.push({
      level: "warn", area: "cli",
      message: "ow 启动器不存在，qdoc 技能里的裸 `ow` 会 command not found",
      fix: "跑 npm run install-skill（会创建 ~/.config/qdoc/bin/ow）",
    });
  }
}

function checkToken(issues: Issue[], lines: string[]): void {
  const { token, source } = resolveToken();
  if (!token) {
    lines.push("  token: 未配置");
    issues.push({ level: "warn", area: "token", message: "未配置 qdoc token，平台同步会跳过", fix: "echo qdoc_… > ~/.config/qdoc/token && chmod 600 ~/.config/qdoc/token" });
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
  const lines: string[] = ["环境自检：", ""];
  const issues: Issue[] = [];

  lines.push("dsh：");
  checkDshProfiles(issues, lines);

  lines.push("", "pi：");
  checkPi(issues, lines);

  lines.push("", "CLI / 凭据：");
  checkLauncher(issues, lines);
  checkToken(issues, lines);

  const drift = checkSkillDrift();
  lines.push("", "技能漂移：");
  if (!drift.repoFound) {
    lines.push("  仓库根未找到（npm 安装形态？），跳过");
  } else if (drift.drifted.length === 0) {
    lines.push("  dsh/pi 与仓库一致");
  } else {
    lines.push(`  ${describeDrift(drift) ?? ""}`);
    issues.push({ level: "warn", area: "skills", message: `技能漂移：${drift.drifted.map((d) => d.name).join("、")}`, fix: "npm run install-skill" });
  }

  const auto = readAutoSyncState();
  lines.push("", "自动检查：");
  for (const h of ["dsh", "pi"]) {
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

  out(args, lines.join("\n"), { issues, drift, autoSync: auto });
  return issues.some((i) => i.level === "error") ? 1 : 0;
}
