/**
 * 仓库技能 → 宿主技能目录（安装/重装/基线）。
 *
 * 为什么从 scripts/install-skill.ts 抽到 core：
 *  - 自动检查要在 agent 进程内安全重装，不能 exec 脚本；
 *  - 重装必须知道「上次装的是什么」，否则分不清「仓库更新」和「用户手改」；
 *  - 写入必须原子，避免 agent 正好读技能时读到半个目录。
 *
 * 基线落在机器级 `~/.config/qdoc/skill-install.json`（QDOC_MACHINE_DIR 可覆盖，
 * 测试用）。它不跟项目走：技能是机器级资产。
 */
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { machineDir } from "../trigger/lock.ts";

export type HostName = "dsh" | "pi" | "qoder" | "codebuddy" | "opencode";

/** 各宿主放技能的位置（与 install-skill 原来同一口径） */
export const HOST_DIRS: Record<HostName, string> = {
  dsh: join(homedir(), ".dsh", "skills"),
  pi: join(homedir(), ".pi", "agent", "skills"),
  qoder: join(homedir(), ".qoder-cn", "skills"),
  codebuddy: join(homedir(), ".codebuddy", "skills"),
  opencode: join(homedir(), ".config", "opencode", "skills"),
};

export function hostSkillDir(host: HostName): string {
  return HOST_DIRS[host];
}

/** 目录内容哈希：路径 + 内容，与遍历顺序无关 */
export function hashDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = walkFiles(dir);
  if (files.length === 0) return null;
  // 用 Node crypto 保持与 install-skill 原来的 12 位短哈希一致
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update(readFileSync(join(dir, rel)));
  }
  return h.digest("hex").slice(0, 12);
}

/** 目录内的相对文件路径（跳过点文件），排序保证稳定 */
export function walkFiles(dir: string, base = dir): string[] {
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
    if (isDir) out.push(...walkFiles(abs, base));
    else out.push(relative(base, abs));
  }
  return out;
}

/** 仓库里有哪些技能（含根 SKILL.md 的目录） */
export function readRepoSkills(repoRoot: string): string[] {
  const src = join(repoRoot, "agent-skills");
  try {
    return readdirSync(src)
      .filter((n) => existsSync(join(src, n, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

export interface InstallRecord {
  /** 上次安装时的仓库内容哈希 */
  installed_hash: string;
  installed_at: string;
}

export interface InstallState {
  schema: 1;
  hosts: Record<string, Record<string, InstallRecord>>;
}

export function installStatePath(override?: string): string {
  return join(machineDir(override), "skill-install.json");
}

export function readInstallState(override?: string): InstallState {
  const p = installStatePath(override);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<InstallState>;
    return { schema: 1, hosts: raw.hosts ?? {} };
  } catch {
    return { schema: 1, hosts: {} };
  }
}

export function writeInstallState(st: InstallState, override?: string): void {
  const p = installStatePath(override);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  renameSync(tmp, p);
}

export type InstallAction = "unchanged" | "installed" | "updated" | "reinstalled" | "pruned" | "modified" | "missing";

export interface RepoInstallResult {
  host: HostName;
  dir: string;
  name: string;
  action: InstallAction;
  repoHash: string | null;
  hostHash: string | null;
  installedHash: string | null;
  error?: string;
}

/** 原子替换：先拷到同级临时目录，再 rename；失败时保留旧目录 */
function replaceDir(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const tmp = `${dst}.tmp-${token}`;
  const backup = `${dst}.bak-${token}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(src, tmp, { recursive: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  let moved = false;
  try {
    if (existsSync(dst)) {
      renameSync(dst, backup);
      moved = true;
    }
    renameSync(tmp, dst);
  } catch (e) {
    if (moved) {
      try { renameSync(backup, dst); } catch { /* 尽力恢复 */ }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (moved) rmSync(backup, { recursive: true, force: true });
}

/** 强制安装（install-skill 脚本路径）：覆盖并记录基线 */
export function installRepoSkills(opts: {
  repoRoot: string;
  hosts?: HostName[];
  hostDir?: string;
  checkOnly?: boolean;
  machineDir?: string;
}): RepoInstallResult[] {
  const hosts = opts.hosts ?? (Object.keys(HOST_DIRS) as HostName[]);
  const state = readInstallState(opts.machineDir);
  const skills = readRepoSkills(opts.repoRoot);
  const results: RepoInstallResult[] = [];
  let dirty = false;

  for (const host of hosts) {
    const dest = opts.hostDir ?? hostSkillDir(host);
    state.hosts[host] ??= {};
    for (const name of skills) {
      const srcDir = join(opts.repoRoot, "agent-skills", name);
      const dstDir = join(dest, name);
      const repoHash = hashDir(srcDir);
      const hostHash = hashDir(dstDir);
      const rec = state.hosts[host][name];
      let action: InstallAction = hostHash === repoHash ? "unchanged" : (hostHash ? "updated" : "installed");

      if (!opts.checkOnly && hostHash !== repoHash) {
        try {
          replaceDir(srcDir, dstDir);
          action = hostHash ? "updated" : "installed";
        } catch (e) {
          results.push({ host, dir: dest, name, action: "modified", repoHash, hostHash, installedHash: rec?.installed_hash ?? null, error: String(e) });
          continue;
        }
      }

      if (!opts.checkOnly && repoHash) {
        state.hosts[host][name] = { installed_hash: repoHash, installed_at: new Date().toISOString() };
        dirty = true;
      } else if (!opts.checkOnly && !rec && repoHash && hostHash === repoHash) {
        // 首次接管一份本来一致的副本，也记基线，后续才能自动重装
        state.hosts[host][name] = { installed_hash: repoHash, installed_at: new Date().toISOString() };
        dirty = true;
      }

      results.push({ host, dir: dest, name, action, repoHash, hostHash, installedHash: rec?.installed_hash ?? null });
    }

    // 强制安装（非 check）时清理仓库已删除的技能；只删未手改过的
    if (!opts.checkOnly) {
      const repoSet = new Set(skills);
      for (const [name, rec] of Object.entries(state.hosts[host])) {
        if (repoSet.has(name)) continue;
        const dstDir = join(dest, name);
        const hostHash = hashDir(dstDir);
        if (!hostHash) {
          delete state.hosts[host][name];
          dirty = true;
          continue;
        }
        if (rec.installed_hash === hostHash) {
          try {
            rmSync(dstDir, { recursive: true, force: true });
            delete state.hosts[host][name];
            dirty = true;
            results.push({ host, dir: dest, name, action: "pruned", repoHash: null, hostHash, installedHash: rec.installed_hash });
          } catch {
            /* 删不掉就留着 */
          }
        }
      }
    }
  }
  if (dirty) writeInstallState(state, opts.machineDir);
  return results;
}

/**
 * 安全重装：只覆盖「宿主内容 == 上次安装基线」的技能。
 *
 * 判定：
 *  - 宿主 hash = 仓库 hash      → 无事，补基线
 *  - 宿主不存在                  → 安装（没有可丢的本地内容）
 *  - 宿主 hash = 基线 hash       → 仓库变了，自动重装
 *  - 其余（用户手改过）          → 不动，返回 modified 交给通知
 */
export function reinstallSafeSkills(opts: {
  repoRoot: string;
  host: HostName;
  hostDir?: string;
  machineDir?: string;
}): RepoInstallResult[] {
  const state = readInstallState(opts.machineDir);
  const dest = opts.hostDir ?? hostSkillDir(opts.host);
  state.hosts[opts.host] ??= {};
  const results: RepoInstallResult[] = [];
  const repoSkills = readRepoSkills(opts.repoRoot);
  const repoSet = new Set(repoSkills);
  let dirty = false;

  for (const name of repoSkills) {
    const srcDir = join(opts.repoRoot, "agent-skills", name);
    const dstDir = join(dest, name);
    const repoHash = hashDir(srcDir);
    const hostHash = hashDir(dstDir);
    const rec = state.hosts[opts.host][name];
    const installedHash = rec?.installed_hash ?? null;
    let action: InstallAction = "unchanged";

    if (!repoHash) continue;

    if (hostHash === repoHash) {
      action = "unchanged";
      if (!rec || rec.installed_hash !== repoHash) {
        state.hosts[opts.host][name] = { installed_hash: repoHash, installed_at: new Date().toISOString() };
        dirty = true;
      }
    } else if (hostHash === null) {
      try {
        replaceDir(srcDir, dstDir);
        action = "installed";
        state.hosts[opts.host][name] = { installed_hash: repoHash, installed_at: new Date().toISOString() };
        dirty = true;
      } catch (e) {
        action = "modified";
        results.push({ host: opts.host, dir: dest, name, action, repoHash, hostHash, installedHash, error: String(e) });
        continue;
      }
    } else if (installedHash && hostHash === installedHash) {
      try {
        replaceDir(srcDir, dstDir);
        action = "reinstalled";
        state.hosts[opts.host][name] = { installed_hash: repoHash, installed_at: new Date().toISOString() };
        dirty = true;
      } catch (e) {
        action = "modified";
        results.push({ host: opts.host, dir: dest, name, action, repoHash, hostHash, installedHash, error: String(e) });
        continue;
      }
    } else {
      // 没有基线（老安装）或用户手改过：不覆盖
      action = "modified";
    }

    results.push({ host: opts.host, dir: dest, name, action, repoHash, hostHash, installedHash });
  }
  // 仓库删掉的技能：只有宿主内容仍等于安装基线时才删；手改过的不动
  for (const [name, rec] of Object.entries(state.hosts[opts.host])) {
    if (repoSet.has(name)) continue;
    const dstDir = join(dest, name);
    const hostHash = hashDir(dstDir);
    if (!hostHash) {
      delete state.hosts[opts.host][name];
      dirty = true;
      continue;
    }
    if (rec.installed_hash === hostHash) {
      try {
        rmSync(dstDir, { recursive: true, force: true });
        delete state.hosts[opts.host][name];
        dirty = true;
        results.push({ host: opts.host, dir: dest, name, action: "pruned", repoHash: null, hostHash, installedHash: rec.installed_hash });
      } catch (e) {
        results.push({ host: opts.host, dir: dest, name, action: "modified", repoHash: null, hostHash, installedHash: rec.installed_hash, error: String(e) });
      }
    } else {
      results.push({ host: opts.host, dir: dest, name, action: "modified", repoHash: null, hostHash, installedHash: rec.installed_hash });
    }
  }

  if (dirty) writeInstallState(state, opts.machineDir);
  return results;
}

/**
 * 把 scripts/ow 软链到 ~/.config/qdoc/bin/ow。
 *
 * **默认不覆盖已有入口**：老机器上可能有用户自定义的 wrapper（例如指向
 * brew node@24）。只有 `force:true` 才替换。失败不致命，调用方决定是否提示。
 */
export function installOwLauncher(
  repoRoot: string,
  opts: { force?: boolean } = {},
): { path: string; ok: boolean; preserved?: boolean; error?: string } {
  const dir = join(homedir(), ".config", "qdoc", "bin");
  const link = join(dir, "ow");
  const target = join(repoRoot, "scripts", "ow");
  try {
    mkdirSync(dir, { recursive: true });
    let exists = false;
    try { lstatSync(link); exists = true; } catch { /* 不存在 */ }

    if (exists) {
      let same = false;
      let ours = false;
      try {
        same = realpathSync(link) === realpathSync(target);
        const raw = readlinkSync(link).replace(/\\/g, "/");
        ours = raw.endsWith("/scripts/ow") || raw.endsWith("scripts/ow");
      } catch { /* 断链/普通文件 */ }
      if (same) {
        try { chmodSync(target, 0o755); } catch { /* 可忽略 */ }
        return { path: link, ok: true, preserved: true };
      }
      // 自定义 wrapper 默认保留；指向旧仓库 scripts/ow 的软链是我们自己的，可自动修
      if (!opts.force && !ours) return { path: link, ok: true, preserved: true };
      rmSync(link, { force: true }); // 删软链/普通文件本身，不删 target
    }

    symlinkSync(target, link);
    try { chmodSync(target, 0o755); } catch { /* 已有可执行位即可 */ }
    return { path: link, ok: true };
  } catch (e) {
    return { path: link, ok: false, error: String(e) };
  }
}
