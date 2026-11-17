/**
 * 技能清单：**机器级**，按宿主分文件。
 *
 * 为什么不能放项目 `.qdoc/.ow/`：技能是机器级资产，同一台机器的 dsh/pi/qoder
 * 共用平台账号却不共用目录。项目级清单会在 A 项目记 dsh、B 项目记 pi，
 * 互相覆盖 `target`，判断“本地改没改”时对不上。
 *
 * 位置：
 *   ~/.config/qdoc/skill-manifests/<host>.json     （新路径，按 host 分）
 *   <project>/.qdoc/.ow/skill-manifest.json        （旧路径，只读兼容 + 迁移兜底）
 *
 * 旧路径仍然可读：host 文件不存在时回退旧清单；下一次写入就落到新路径。
 * 迁移不删旧文件——多项目可能还在用它，保留只读兼容比“悄悄迁移一半”安全。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillFile } from "../publish/mcp.ts";
import { machineDir } from "../trigger/lock.ts";
import { HOST_DIRS, type HostName } from "./install.ts";

const HOSTS: HostName[] = ["dsh", "pi", "qoder", "codebuddy", "opencode"];

/** 一个技能在本机的状态 */
export interface SkillRecord {
  /** 平台 skill_id；本地独有技能为 null */
  skill_id: string | null;
  /** 上次见到的平台版本 */
  version: number;
  /** 落地内容哈希（判断本地是否被改过） */
  sha: string;
  /** 落地目录绝对路径 */
  target: string;
  /** 来源：平台拉取 / 本地推送 / 本地独有 */
  origin: "pulled" | "pushed" | "local";
  /** 推上去了但平台未启用（`list_available_skills` 看不见它） */
  pending_enable?: boolean;
  /** 首次推上去的时间，用于 7 天后升级为待确认 */
  pushed_at?: string;
  /** 最后一次与平台对齐的时间 */
  synced_at: string;
  missing_on_platform?: boolean;
  disabled_on_platform?: boolean;
  orphan?: boolean;
  local_changes?: boolean;
}

export interface SkillManifest {
  schema: 1;
  /** key = 技能名 */
  skills: Record<string, SkillRecord>;
}

/** 旧路径：项目级（只读兼容） */
export function legacyManifestPath(vaultDir: string): string {
  return join(vaultDir, ".ow", "skill-manifest.json");
}

/** 新路径：机器级按 host 分文件；不传 host 返回旧路径（测试/兼容） */
export function manifestPath(vaultDir: string, host?: HostName): string {
  if (!host) return legacyManifestPath(vaultDir);
  return join(machineDir(), "skill-manifests", `${host}.json`);
}

function readAt(path: string): SkillManifest | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillManifest>;
    return { schema: 1, skills: raw.skills ?? {} };
  } catch {
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* 挪不动就算了 */ }
    return null;
  }
}

/** 旧清单里的记录按 target 判断属于哪个宿主（/tmp 等不明目标返回 null） */
export function hostForTarget(target: string): HostName | null {
  for (const host of HOSTS) {
    const dir = HOST_DIRS[host].replace(/\/+$/, "");
    if (target === dir || target.startsWith(`${dir}/`)) return host;
  }
  return null;
}

function filterForHost(m: SkillManifest, host?: HostName): SkillManifest {
  if (!host) return m;
  const skills: Record<string, SkillRecord> = {};
  for (const [name, rec] of Object.entries(m.skills)) {
    if (hostForTarget(rec.target) === host) skills[name] = rec;
  }
  return { schema: 1, skills };
}

/** 读清单；host 文件不存在时回退旧项目清单（只取属于该 host 的记录） */
export function readManifest(vaultDir: string, host?: HostName): SkillManifest {
  if (host) {
    const machine = readAt(manifestPath(vaultDir, host));
    if (machine) return machine;
  }
  return filterForHost(readAt(legacyManifestPath(vaultDir)) ?? { schema: 1, skills: {} }, host);
}

export function writeManifest(vaultDir: string, m: SkillManifest, host?: HostName): void {
  const p = manifestPath(vaultDir, host);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
  renameSync(tmp, p);
}

/**
 * 聚合视图：旧清单 + 四个 host 的机器清单，同名时机器清单优先。
 * `ow status` 用这个，避免只看到某一个项目/宿主的旧状态。
 */
export function readAllManifests(vaultDir: string): SkillManifest {
  const merged: SkillManifest = { schema: 1, skills: {} };
  const legacy = readAt(legacyManifestPath(vaultDir));
  if (legacy) Object.assign(merged.skills, legacy.skills);

  for (const host of HOSTS) {
    const one = readAt(manifestPath(vaultDir, host));
    if (!one) continue;
    // 机器清单存在时，旧清单里属于该 host 的记录以机器清单为准
    for (const [name, rec] of Object.entries(merged.skills)) {
      if (hostForTarget(rec.target) === host) delete merged.skills[name];
    }
    Object.assign(merged.skills, one.skills);
  }
  return merged;
}

export function getRecord(vaultDir: string, name: string, host?: HostName): SkillRecord | null {
  return readManifest(vaultDir, host).skills[name] ?? null;
}

/** 记一次拉取（平台 → 本地） */
export function recordPull(
  vaultDir: string,
  name: string,
  rec: { skill_id: string; version: number; sha: string; target: string },
  host?: HostName,
): void {
  const m = readManifest(vaultDir, host);
  const prev = m.skills[name];
  m.skills[name] = {
    skill_id: rec.skill_id,
    version: rec.version,
    sha: rec.sha,
    target: rec.target,
    origin: "pulled",
    // 拉下来就说明平台已启用，pending_enable 清掉
    pending_enable: false,
    synced_at: new Date().toISOString(),
    pushed_at: prev?.pushed_at,
  };
  writeManifest(vaultDir, m, host);
}

/** 记一次推送（本地 → 平台） */
export function recordPush(
  vaultDir: string,
  name: string,
  rec: { skill_id: string | null; version: number; sha: string; target: string; pendingEnable: boolean },
  host?: HostName,
): void {
  const m = readManifest(vaultDir, host);
  const prev = m.skills[name];
  m.skills[name] = {
    skill_id: rec.skill_id,
    version: rec.version,
    sha: rec.sha,
    target: rec.target,
    origin: "pushed",
    pending_enable: rec.pendingEnable,
    pushed_at: prev?.pushed_at ?? new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };
  writeManifest(vaultDir, m, host);
}

/**
 * 平台启用自愈：轮询到某技能出现在 `list_available_skills` 里 → 清 `pending_enable`。
 * 这是唯一能自证的信号（平台没有「查询待启用列表」的接口）。
 */
export function healPendingEnable(
  vaultDir: string,
  availableNames: Set<string>,
  host?: HostName,
): string[] {
  const m = readManifest(vaultDir, host);
  const healed: string[] = [];
  for (const [name, rec] of Object.entries(m.skills)) {
    if (!rec.pending_enable) continue;
    if (!availableNames.has(name)) continue;
    rec.pending_enable = false;
    rec.synced_at = new Date().toISOString();
    healed.push(name);
  }
  if (healed.length > 0) writeManifest(vaultDir, m, host);
  return healed;
}

/** 标记平台侧已消失（被禁用或删除）——只标记，不删本地 */
export function markMissing(vaultDir: string, name: string, missing: boolean, host?: HostName): void {
  const m = readManifest(vaultDir, host);
  const rec = m.skills[name];
  if (!rec) return;
  rec.missing_on_platform = missing;
  writeManifest(vaultDir, m, host);
}

/**
 * 待启用超过 N 天 → 该升级成「待确认」，提示用户去平台点一下。
 * 平台不提供启用 API，只能靠人。
 */
export const PENDING_ENABLE_ESCALATE_DAYS = 7;

export function stalePendingEnable(
  vaultDir: string,
  days = PENDING_ENABLE_ESCALATE_DAYS,
  host?: HostName,
): string[] {
  return staleFrom(readManifest(vaultDir, host), days);
}

export function stalePendingEnableAll(vaultDir: string, days = PENDING_ENABLE_ESCALATE_DAYS): string[] {
  return staleFrom(readAllManifests(vaultDir), days);
}

function staleFrom(m: SkillManifest, days: number): string[] {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out: string[] = [];
  for (const [name, rec] of Object.entries(m.skills)) {
    if (!rec.pending_enable || !rec.pushed_at) continue;
    if (Date.parse(rec.pushed_at) < cutoff) out.push(name);
  }
  return out;
}

function statsOf(m: SkillManifest): {
  total: number; pulled: number; pushed: number; local: number;
  pendingEnable: number; missing: number;
} {
  const skills = Object.values(m.skills);
  return {
    total: skills.length,
    pulled: skills.filter((s) => s.origin === "pulled").length,
    pushed: skills.filter((s) => s.origin === "pushed").length,
    local: skills.filter((s) => s.origin === "local").length,
    pendingEnable: skills.filter((s) => s.pending_enable).length,
    missing: skills.filter((s) => s.missing_on_platform).length,
  };
}

/** 清单统计（不传 host 只统计旧项目清单；status 用 All） */
export function manifestStats(vaultDir: string, host?: HostName) {
  return statsOf(readManifest(vaultDir, host));
}

export function manifestStatsAll(vaultDir: string) {
  return statsOf(readAllManifests(vaultDir));
}

/** 文件集合 → 整体哈希（与 publish/skill.ts 的 hashFiles 同算法，便于比对） */
export function hashSkillFiles(files: SkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let h = 0;
  for (const f of sorted) {
    const s = `${f.path}\u0000${f.content}`;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return `h${(h >>> 0).toString(16)}`;
}
