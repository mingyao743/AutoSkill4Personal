/**
 * 技能清单：`.qdoc/.ow/skill-manifest.json`。
 *
 * **「本机装了什么」的唯一真相**。为什么不靠扫目录：本地技能目录里混着
 * 「平台同步下来的」和「本地自己写的」和「别处拷来的」，只看目录分不清谁归谁管。
 * 没有清单，就不知道哪个技能该被平台更新覆盖、哪个绝不能被碰。
 *
 * 记四件事：
 *  - `skill_id`：平台侧 id（本地自建技能没有）
 *  - `version`：上次看到的平台版本
 *  - `sha`：落地文件的整体哈希（判断本地是否被改过）
 *  - `pending_enable`：**推上去但平台未启用**——平台硬限制，必须记着
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillFile } from "../publish/mcp.ts";

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
  /** 平台侧没有但本地有（被禁用/删除） */
  missing_on_platform?: boolean;
}

export interface SkillManifest {
  schema: 1;
  /** key = 技能名 */
  skills: Record<string, SkillRecord>;
}

export function manifestPath(vaultDir: string): string {
  return join(vaultDir, ".ow", "skill-manifest.json");
}

export function readManifest(vaultDir: string): SkillManifest {
  const p = manifestPath(vaultDir);
  if (!existsSync(p)) return { schema: 1, skills: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SkillManifest>;
    return { schema: 1, skills: raw.skills ?? {} };
  } catch {
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      /* 挪不动就算了 */
    }
    return { schema: 1, skills: {} };
  }
}

export function writeManifest(vaultDir: string, m: SkillManifest): void {
  const p = manifestPath(vaultDir);
  mkdirSync(join(vaultDir, ".ow"), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
  renameSync(tmp, p);
}

export function getRecord(vaultDir: string, name: string): SkillRecord | null {
  return readManifest(vaultDir).skills[name] ?? null;
}

/** 记一次拉取（平台 → 本地） */
export function recordPull(
  vaultDir: string,
  name: string,
  rec: { skill_id: string; version: number; sha: string; target: string },
): void {
  const m = readManifest(vaultDir);
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
  writeManifest(vaultDir, m);
}

/** 记一次推送（本地 → 平台） */
export function recordPush(
  vaultDir: string,
  name: string,
  rec: { skill_id: string | null; version: number; sha: string; target: string; pendingEnable: boolean },
): void {
  const m = readManifest(vaultDir);
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
  writeManifest(vaultDir, m);
}

/**
 * 平台启用自愈：轮询到某技能出现在 `list_available_skills` 里 → 清 `pending_enable`。
 * 这是唯一能自证的信号（平台没有「查询待启用列表」的接口）。
 */
export function healPendingEnable(vaultDir: string, availableNames: Set<string>): string[] {
  const m = readManifest(vaultDir);
  const healed: string[] = [];
  for (const [name, rec] of Object.entries(m.skills)) {
    if (!rec.pending_enable) continue;
    if (!availableNames.has(name)) continue;
    rec.pending_enable = false;
    rec.synced_at = new Date().toISOString();
    healed.push(name);
  }
  if (healed.length > 0) writeManifest(vaultDir, m);
  return healed;
}

/** 标记平台侧已消失（被禁用或删除）——只标记，不删本地 */
export function markMissing(vaultDir: string, name: string, missing: boolean): void {
  const m = readManifest(vaultDir);
  const rec = m.skills[name];
  if (!rec) return;
  rec.missing_on_platform = missing;
  writeManifest(vaultDir, m);
}

/**
 * 待启用超过 N 天 → 该升级成「待确认」，提示用户去平台点一下。
 * 平台不提供启用 API，只能靠人。
 */
export const PENDING_ENABLE_ESCALATE_DAYS = 7;

export function stalePendingEnable(vaultDir: string, days = PENDING_ENABLE_ESCALATE_DAYS): string[] {
  const m = readManifest(vaultDir);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out: string[] = [];
  for (const [name, rec] of Object.entries(m.skills)) {
    if (!rec.pending_enable || !rec.pushed_at) continue;
    if (Date.parse(rec.pushed_at) < cutoff) out.push(name);
  }
  return out;
}

/** 清单统计 */
export function manifestStats(vaultDir: string): {
  total: number; pulled: number; pushed: number; local: number;
  pendingEnable: number; missing: number;
} {
  const skills = Object.values(readManifest(vaultDir).skills);
  return {
    total: skills.length,
    pulled: skills.filter((s) => s.origin === "pulled").length,
    pushed: skills.filter((s) => s.origin === "pushed").length,
    local: skills.filter((s) => s.origin === "local").length,
    pendingEnable: skills.filter((s) => s.pending_enable).length,
    missing: skills.filter((s) => s.missing_on_platform).length,
  };
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
