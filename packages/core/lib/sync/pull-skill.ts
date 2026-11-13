/**
 * 技能拉取：平台 → 本地。
 *
 * **两级检查**（方案 §10.10）。为什么要两级，看实测成本：
 *
 * | 级别 | 频率 | 调用 | 成本 | 能发现 |
 * |---|---|---|---|---|
 * | 轻量 | 每 30 分钟 | `list_available_skills` | 29ms / 2.9KB | 新增、移除/禁用 |
 * | 全量 | 每天 03:00 | 逐个 `get_skill` | 3.7s / 1.27MB | **内容更新** |
 *
 * 全量不能勤跑：6 个技能 1.27MB，每小时一次就是 30MB/天。轻量查不出内容更新
 * （`list_available_skills` 不返回 version），所以必须每天至少一次全量。
 *
 * **落地策略是保守的**：
 *  - 本地没有 → 拉下来
 *  - 本地有且 sha 与清单一致（本地没改过）→ 平台更新就覆盖
 *  - 本地有但 sha 不一致（本地改过）→ **不覆盖**，报冲突交人工
 *  - 本地有但不在清单里（不是我们管的）→ 不碰
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { QdocMcpClient, SkillFile, SkillSummary } from "../publish/mcp.ts";
import {
  getRecord, hashSkillFiles, markMissing, recordPull, healPendingEnable,
  readManifest, type SkillRecord,
} from "./manifest.ts";

/** 平台技能文件的路径必须安全：不许绝对路径、不许 .. */
export function isSafeSkillPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("\\")) return false;
  if (p.includes("..")) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // Windows 盘符
  return true;
}

/** 从 `get_skill` 的返回里取文件列表（实测形状：`files: [{path, content}]`） */
export function extractSkillFiles(detail: unknown): SkillFile[] {
  if (!detail || typeof detail !== "object") return [];
  const d = detail as Record<string, unknown>;
  const raw = d.files ?? d.skill_files;
  if (!Array.isArray(raw)) return [];
  const out: SkillFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : "";
    const content = typeof o.content === "string" ? o.content : "";
    if (!path || !content) continue;
    if (!isSafeSkillPath(path)) continue; // 静默丢弃不安全路径，不写盘
    out.push({ path, content });
  }
  return out;
}

/** 读本地技能目录的文件（用于算 sha 与比对） */
export function readSkillDir(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const full = join(d, n);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join("/");
      try {
        out.push({ path: rel, content: readFileSync(full, "utf8") });
      } catch {
        /* 读不了就跳过 */
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type PullAction =
  | "created" | "updated" | "unchanged" | "conflict"
  | "skipped" | "failed" | "adopted" | "adoptable"
  /** 本地改过、平台没变：暂时无事可做，但**已分叉**，要提前告诉人 */
  | "diverged";

export interface PullResult {
  name: string;
  action: PullAction;
  skillId?: string;
  fromVersion?: number;
  toVersion?: number;
  files?: number;
  message?: string;
  /** 冲突时本地与平台各自的位置 */
  conflictDir?: string;
}

export interface PullOptions {
  client: QdocMcpClient;
  vaultDir: string;
  /** 本地技能根目录（如 ~/.dsh/skills） */
  skillsRoot: string;
  /** 干跑：只比对不写盘 */
  dryRun?: boolean;
  /** 只处理这些技能名（不传则全部） */
  only?: string[];
  /**
   * 接管本地已有但不在清单里的技能。
   *
   * 没有这个开关，老用户本地已装的技能**永远无法同步**——拉取逻辑见到「本地有但
   * 清单没记」就跳过（怕覆盖用户自己的东西），于是一直跳过。
   *
   * 接管只在**内容一致**时自动生效；内容有差异则报 `adoptable`，让人决定。
   */
  adopt?: boolean;
}

/**
 * 轻量检查：只调 `list_available_skills`，发现增减与待启用自愈。
 * **不拉内容**，所以查不出「内容更新」。
 */
export async function checkLight(
  opts: Pick<PullOptions, "client" | "vaultDir">,
): Promise<{
  available: SkillSummary[];
  names: Set<string>;
  healed: string[];
  newOnPlatform: string[];
  missingOnPlatform: string[];
}> {
  const available = await opts.client.listAvailableSkills();
  const names = new Set(available.map((s) => s.name));
  const healed = healPendingEnable(opts.vaultDir, names);

  const manifest = readManifest(opts.vaultDir);
  const newOnPlatform: string[] = [];
  const missingOnPlatform: string[] = [];
  for (const s of available) {
    const rec = manifest.skills[s.name];
    if (!rec || rec.origin === "local") newOnPlatform.push(s.name);
  }
  for (const [name, rec] of Object.entries(manifest.skills)) {
    if (rec.origin === "pulled" && !names.has(name)) {
      missingOnPlatform.push(name);
      markMissing(opts.vaultDir, name, true);
    }
  }
  return { available, names, healed, newOnPlatform, missingOnPlatform };
}

/** 全量检查 + 落地 */
export async function pullSkills(opts: PullOptions): Promise<PullResult[]> {
  const available = await opts.client.listAvailableSkills();
  const names = new Set(available.map((s) => s.name));
  healPendingEnable(opts.vaultDir, names);

  const targets = opts.only
    ? available.filter((s) => opts.only!.includes(s.name))
    : available;

  const results: PullResult[] = [];
  for (const s of targets) {
    results.push(await pullOne(opts, s));
  }

  // 平台已消失的：只标记，不删本地（删了没法恢复）
  for (const [name, rec] of Object.entries(readManifest(opts.vaultDir).skills)) {
    if (rec.origin !== "pulled") continue;
    if (names.has(name)) continue;
    markMissing(opts.vaultDir, name, true);
  }
  return results;
}

async function pullOne(opts: PullOptions, summary: SkillSummary): Promise<PullResult> {
  const target = join(opts.skillsRoot, summary.name);
  const rec = getRecord(opts.vaultDir, summary.name);

  let detail: Record<string, unknown>;
  try {
    detail = (await opts.client.getSkill(summary.id)) as Record<string, unknown>;
  } catch (e) {
    return { name: summary.name, action: "failed", skillId: summary.id, message: String(e).slice(0, 200) };
  }

  const files = extractSkillFiles(detail);
  if (files.length === 0) {
    return {
      name: summary.name,
      action: "failed",
      skillId: summary.id,
      message: "平台返回里没有可用文件（或全被路径安全过滤掉）",
    };
  }
  const remoteSha = hashSkillFiles(files);
  const remoteVersion = typeof detail.version === "number" ? detail.version : 0;

  // 本地不存在 → 新建
  if (!existsSync(target)) {
    if (opts.dryRun) {
      return {
        name: summary.name, action: "created", skillId: summary.id,
        fromVersion: undefined, toVersion: remoteVersion, files: files.length,
        message: "干跑：将新建",
      };
    }
    try {
      writeSkillDir(target, files);
    } catch (e) {
      return { name: summary.name, action: "failed", skillId: summary.id, message: String(e).slice(0, 200) };
    }
    recordPull(opts.vaultDir, summary.name, {
      skill_id: summary.id, version: remoteVersion, sha: remoteSha, target,
    });
    return {
      name: summary.name, action: "created", skillId: summary.id,
      toVersion: remoteVersion, files: files.length,
    };
  }

  // 本地存在：先判断是谁管的
  const localFiles = readSkillDir(target);
  const localSha = hashSkillFiles(localFiles);

  if (!rec) {
    // 本地有但清单没有 → 可能是用户自己写的，也可能是老版本手工同步的
    if (localSha === remoteSha) {
      // 内容完全一致：直接接管，之后就能正常同步
      if (!opts.dryRun) {
        recordPull(opts.vaultDir, summary.name, {
          skill_id: summary.id, version: remoteVersion, sha: remoteSha, target,
        });
      }
      return {
        name: summary.name, action: "adopted", skillId: summary.id,
        toVersion: remoteVersion, files: files.length,
        message: "本地内容与平台一致，已登记接管",
      };
    }
    if (opts.adopt) {
      // 用户显式要求接管：登记为 managed，本地内容先不动，下次平台更新才覆盖
      if (!opts.dryRun) {
        recordPull(opts.vaultDir, summary.name, {
          skill_id: summary.id, version: remoteVersion, sha: localSha, target,
        });
      }
      return {
        name: summary.name, action: "adopted", skillId: summary.id,
        toVersion: remoteVersion, files: files.length,
        message: "已接管（保留本地内容，后续平台更新会覆盖）",
      };
    }
    // 内容有差异又没开 adopt → 报出来让人决定，不擅自覆盖
    return {
      name: summary.name, action: "adoptable", skillId: summary.id,
      toVersion: remoteVersion, files: files.length,
      message: `本地已有且内容与平台不同（本地 ${localFiles.length} 文件 / 平台 ${files.length} 文件），加 --adopt 可接管`,
    };
  }

  // 本地被改过？
  const locallyModified = rec.sha !== localSha;

  const platformChanged = rec.sha !== remoteSha || remoteVersion !== rec.version;

  // 本地改过但平台没变 → 暂时无事可做，但已经分叉了。
  // **不能报 unchanged**：那会让人以为同步正常，等平台真更新时才突然爆冲突。
  if (locallyModified && !platformChanged) {
    return {
      name: summary.name, action: "diverged", skillId: summary.id,
      fromVersion: rec.version, toVersion: remoteVersion, files: files.length,
      message: "本地已修改、平台未变；平台下次更新会冲突",
    };
  }

  if (!platformChanged) {
    return {
      name: summary.name, action: "unchanged", skillId: summary.id,
      fromVersion: rec.version, toVersion: remoteVersion, files: files.length,
    };
  }

  if (locallyModified) {
    // 本地改过 + 平台也变了 → 冲突，落现场等人工
    const dir = opts.dryRun ? undefined : writeConflict(opts.vaultDir, summary.name, localFiles, files);
    return {
      name: summary.name, action: "conflict", skillId: summary.id,
      fromVersion: rec.version, toVersion: remoteVersion, files: files.length,
      conflictDir: dir,
      message: `本地已修改（sha ${localSha} ≠ 清单 ${rec.sha}），平台也有更新（v${rec.version} → v${remoteVersion}）`,
    };
  }

  // 本地没改、平台变了 → 覆盖
  if (opts.dryRun) {
    return {
      name: summary.name, action: "updated", skillId: summary.id,
      fromVersion: rec.version, toVersion: remoteVersion, files: files.length,
      message: "干跑：将更新",
    };
  }
  try {
    writeSkillDir(target, files);
  } catch (e) {
    return { name: summary.name, action: "failed", skillId: summary.id, message: String(e).slice(0, 200) };
  }
  recordPull(opts.vaultDir, summary.name, {
    skill_id: summary.id, version: remoteVersion, sha: remoteSha, target,
  });
  return {
    name: summary.name, action: "updated", skillId: summary.id,
    fromVersion: rec.version, toVersion: remoteVersion, files: files.length,
  };
}

/** 写技能目录（路径已过安全检查） */
export function writeSkillDir(target: string, files: SkillFile[]): void {
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) throw new Error(`不安全路径：${f.path}`);
    const abs = join(target, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
}

/** 冲突现场落盘（与文档冲突同一目录，`ow review` 一起处理） */
function writeConflict(
  vaultDir: string,
  name: string,
  local: SkillFile[],
  remote: SkillFile[],
): string {
  const dir = join(vaultDir, ".publish", "conflicts", `skill-${name}`);
  mkdirSync(dir, { recursive: true });
  for (const f of local) {
    const abs = join(dir, "local", f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  for (const f of remote) {
    const abs = join(dir, "remote", f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  return dir;
}

/** 结果 → 人话 */
export function describePull(r: PullResult): string {
  const mark: Record<PullAction, string> = {
    created: "↓", updated: "↻", unchanged: "＝",
    conflict: "⚠", skipped: "⊘", failed: "✗",
    adopted: "⊕", adoptable: "?", diverged: "✎",
  };
  const m = mark[r.action] ?? "·";
  const ver = r.fromVersion != null || r.toVersion != null
    ? ` v${r.fromVersion ?? "?"}→v${r.toVersion ?? "?"}`
    : "";
  const files = r.files != null ? ` ${r.files} 文件` : "";
  return `${m} ${r.name}：${r.action}${ver}${files}${r.message ? `（${r.message}）` : ""}`;
}
