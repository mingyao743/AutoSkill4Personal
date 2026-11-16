/**
 * 自检：宿主里装的技能，和仓库里的源是不是同一份。
 *
 * 为什么需要：**代码会自动跟着仓库走，技能不会**。
 *   - dsh 插件是软链（`link:…/packages/adapter-dsh`），重启就吃到新代码
 *   - pi 扩展是本地路径，同理
 *   - 但 `agent-skills/` 是**实体拷贝**到 `~/.dsh/skills` 与 `~/.pi/agent/skills`
 *
 * 于是改完仓库忘了重装，宿主跑的还是旧版本——这个坑已经踩过一次
 * （改完 qdoc 技能没重装，宿主读到的仍是旧文本）。
 *
 * 检测方式用**内容哈希**而不是 semver：手改的版本号不可靠，而哈希能精确
 * 反映「装的和源是不是同一份」。整个比对只读小文件，毫秒级、不联网。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type HostName = "dsh" | "pi";

/** 各宿主放技能的位置（与 scripts/install-skill.ts 同一口径） */
export function hostSkillDir(host: HostName): string {
  return host === "dsh"
    ? join(homedir(), ".dsh", "skills")
    : join(homedir(), ".pi", "agent", "skills");
}

/**
 * 仓库根：本文件在 `packages/core/lib/sync/drift.ts`，向上四级。
 *
 * 找不到（比如插件是 npm 装进宿主、没有仓库）时返回 null——此时**不做任何
 * 判断**，而不是误报「全部漂移」。
 */
export function findRepoRoot(from?: string): string | null {
  const start = from ?? dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "agent-skills")) && existsSync(join(dir, "packages", "core"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

/** 目录内容哈希：路径 + 内容，与遍历顺序无关 */
export function hashDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    h.update(rel);
    try {
      h.update(readFileSync(join(dir, rel)));
    } catch {
      return null;
    }
  }
  return h.digest("hex").slice(0, 12);
}

export interface DriftItem {
  name: string;
  /** 仓库里的哈希 */
  repoHash: string;
  /** 宿主里装的哈希；null = 没装 */
  installedHash: string | null;
}

export interface DriftReport {
  /** 仓库里有哪些技能 */
  repoSkills: string[];
  /** 有漂移的（内容不同或未安装） */
  drifted: DriftItem[];
  /** 仓库不可用时为 false，此时 drifted 一定是空 */
  repoFound: boolean;
  /** 检查过的宿主 */
  hosts: HostName[];
}

export interface DriftOptions {
  /** 只查某个宿主；缺省查 dsh + pi */
  host?: HostName;
  /** 覆盖仓库根（测试用） */
  repoRoot?: string;
  /** 覆盖宿主技能目录（测试用） */
  hostDir?: string;
}

/** 比对仓库与宿主，返回漂移清单。纯本地、不联网。 */
export function checkSkillDrift(opts: DriftOptions = {}): DriftReport {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const hosts: HostName[] = opts.host ? [opts.host] : ["dsh", "pi"];
  if (!repoRoot) return { repoSkills: [], drifted: [], repoFound: false, hosts };

  const srcRoot = join(repoRoot, "agent-skills");
  let repoSkills: string[] = [];
  try {
    repoSkills = readdirSync(srcRoot)
      .filter((n) => existsSync(join(srcRoot, n, "SKILL.md")))
      .sort();
  } catch {
    return { repoSkills: [], drifted: [], repoFound: false, hosts };
  }

  const drifted: DriftItem[] = [];
  for (const name of repoSkills) {
    const repoHash = hashDir(join(srcRoot, name));
    if (!repoHash) continue;
    for (const host of hosts) {
      const dest = opts.hostDir ?? hostSkillDir(host);
      const installedHash = hashDir(join(dest, name));
      if (installedHash !== repoHash) {
        // 同一技能在多个宿主漂移时只记一条（detail 里由调用方按宿主展开）
        const existing = drifted.find((d) => d.name === name);
        if (!existing) drifted.push({ name, repoHash, installedHash });
        break;
      }
    }
  }

  return { repoSkills, drifted, repoFound: true, hosts };
}

/**
 * 给用户看的一句话。没有漂移返回 null（**一致时保持安静**，
 * 启动路径上不该有噪音）。
 */
export function describeDrift(r: DriftReport): string | null {
  if (!r.repoFound || r.drifted.length === 0) return null;
  const names = r.drifted.map((d) => d.name).join("、");
  const missing = r.drifted.filter((d) => d.installedHash === null).map((d) => d.name);
  const stale = r.drifted.filter((d) => d.installedHash !== null).map((d) => d.name);
  const parts: string[] = [];
  if (stale.length > 0) parts.push(`内容已更新：${stale.join("、")}`);
  if (missing.length > 0) parts.push(`未安装：${missing.join("、")}`);
  return (
    `[autoskill] 宿主里的技能与仓库不一致（${names}）——${parts.join("；")}。` +
    `跑 npm run install-skill 重装。`
  );
}
