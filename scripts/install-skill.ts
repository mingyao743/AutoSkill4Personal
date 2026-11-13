/**
 * 把 `agent-skills/` 下的技能装到各宿主的技能目录。
 *
 * 为什么要有脚本：手工 `cp -R` 的问题是**装完不知道装的是哪个版本**，改完仓库
 * 忘了重装，宿主跑的还是旧代码。这里做三件事：
 *  1. 覆盖安装（先删目标再拷，避免残留旧文件）
 *  2. 打印每个技能的内容哈希，方便核对「装的和仓库里的是不是同一份」
 *  3. `--check` 只比对不写，可进 CI / 定时任务
 *
 * 用法：
 *   node --experimental-strip-types scripts/install-skill.ts
 *   node --experimental-strip-types scripts/install-skill.ts --check
 *   node --experimental-strip-types scripts/install-skill.ts --host dsh
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const REPO_ROOT = join(import.meta.dirname, "..");
const SRC = join(REPO_ROOT, "agent-skills");

type Host = "dsh" | "pi";

const HOST_DIRS: Record<Host, string> = {
  dsh: join(homedir(), ".dsh", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
};

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs));
  }
  return out.sort();
}

/** 目录内容哈希（路径 + 内容，与顺序无关） */
function hashDir(dir: string): string {
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    h.update(rel);
    h.update(readFileSync(join(dir, rel)));
  }
  return h.digest("hex").slice(0, 12);
}

function main(): number {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const hostArg = args.find((a) => a.startsWith("--host="))?.split("=")[1] as Host | undefined;
  const hosts: Host[] = hostArg ? [hostArg] : ["dsh", "pi"];

  if (!existsSync(SRC)) {
    process.stderr.write(`找不到源目录：${SRC}\n`);
    return 2;
  }

  const skills = readdirSync(SRC).filter((n) => existsSync(join(SRC, n, "SKILL.md")));
  if (skills.length === 0) {
    process.stderr.write(`agent-skills/ 下没有含 SKILL.md 的技能\n`);
    return 2;
  }

  let drifted = 0;
  const lines: string[] = [];

  for (const host of hosts) {
    const dest = HOST_DIRS[host];
    lines.push(`${host}：${dest}`);

    for (const name of skills) {
      const srcDir = join(SRC, name);
      const dstDir = join(dest, name);
      const srcHash = hashDir(srcDir);
      const installed = existsSync(dstDir) ? hashDir(dstDir) : null;

      if (installed === srcHash) {
        lines.push(`  = ${name}  ${srcHash}（已是最新）`);
        continue;
      }

      if (checkOnly) {
        drifted++;
        lines.push(`  ≠ ${name}  仓库 ${srcHash} / 已装 ${installed ?? "未安装"}`);
        continue;
      }

      // 先删再拷：避免旧版本多出来的文件残留
      if (existsSync(dstDir)) rmSync(dstDir, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      cpSync(srcDir, dstDir, { recursive: true });
      lines.push(`  ↓ ${name}  ${installed ?? "未安装"} → ${srcHash}`);
    }
    lines.push("");
  }

  if (checkOnly) {
    lines.push(drifted === 0 ? "全部一致。" : `${drifted} 个技能需要重装：跑不带 --check 的版本。`);
    process.stdout.write(lines.join("\n") + "\n");
    return drifted === 0 ? 0 : 1;
  }

  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

process.exit(main());
