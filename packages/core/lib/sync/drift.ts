/**
 * 自检：宿主里装的技能，和仓库里的源是不是同一份。
 *
 * 为什么需要：**代码会自动跟着仓库走，技能不会**。
 *   - dsh 插件是软链（`link:…/packages/adapter-dsh`），重启就吃到新代码
 *   - pi 扩展是本地路径，同理
 *   - 但 `agent-skills/` 是**实体拷贝**到各宿主技能目录
 *
 * 检测方式用**内容哈希**而不是 semver：手改的版本号不可靠，而哈希能精确
 * 反映「装的和源是不是同一份」。只读小文件，毫秒级、不联网。
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashDir, hostSkillDir, type HostName } from "./install.ts";

export { hashDir, hostSkillDir };
export type { HostName };

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
    `自动检查会尝试安全重装；也可跑 npm run install-skill 强制重装。`
  );
}
