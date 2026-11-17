/**
 * 每日首次访问检查（替代“每天 03:00 + 每 30 分钟”的定时器）。
 *
 * 触发点由宿主决定（pi: before_agent_start；dsh: 定时器发现会话 mtime 变了），
 * 本模块只负责：
 *   1. 当天是否已经成功检查过（机器级、按 host 分账）
 *   2. 抢锁，避免 dsh / pi 同时跑
 *   3. 仓库技能漂移 → 安全重装（只覆盖没被手改的）
 *   4. 平台技能 → 拉取（只覆盖本地未改的；冲突落现场）
 *   5. 失败退避（1h/2h/4h），不每轮重试
 *
 * 全部本地判断不烧 token；唯一网络请求是平台技能列表/内容。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { machineDir } from "../trigger/lock.ts";
import { QdocMcpClient, resolveToken } from "../publish/mcp.ts";
import { pullSkills, type PullResult } from "./pull-skill.ts";
import { findRepoRoot } from "./drift.ts";
import {
  hostSkillDir, reinstallSafeSkills, type HostName,
} from "./install.ts";

/** 锁过期：检查最多 3.7s / 1.27MB，10 分钟足够兜住崩溃 */
const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_DAY = 3;
const execFileAsync = promisify(execFile);

export interface AutoSyncSummary {
  host: HostName;
  checked_at: string;
  repo: {
    reinstalled: string[];
    installed: string[];
    pruned: string[];
    modified: string[];
    unchanged: number;
    errors: string[];
    /** 仓库 git 状态；不是 git 仓库时为 undefined */
    git?: { branch?: string; behind?: number; error?: string };
  };
  platform: {
    status: "ok" | "skipped" | "error";
    reason?: string;
    created: number;
    updated: number;
    unchanged: number;
    conflicts: string[];
    failed: string[];
    warnings: string[];
  };
}

export type AutoSyncStatus = "checked" | "already-checked" | "busy" | "backoff" | "error";

export interface AutoSyncResult {
  status: AutoSyncStatus;
  summary?: AutoSyncSummary;
  error?: string;
  retryAt?: string;
}

interface HostState {
  lastSuccessDate?: string;
  lastFullAt?: string;
  attemptDate?: string;
  attemptsToday?: number;
  nextRetryAt?: string;
  lastResult?: AutoSyncSummary;
}

export interface AutoSyncState {
  schema: 1;
  hosts: Record<string, HostState>;
}

export interface AutoSyncOptions {
  host: HostName;
  /** 仓库根；不传则自动向上找 */
  repoRoot?: string | null;
  /** 当前项目 vault；没有 vault 时跳过平台同步，只做本地漂移检查 */
  vaultDir?: string;
  /** 本地技能目录；缺省按 host 推 */
  skillsRoot?: string;
  /** 测试覆盖机器目录 */
  machineDir?: string;
  /** 测试注入时间 */
  now?: Date;
  /** 跳过日期/退避闸（手动触发用） */
  force?: boolean;
  /** 测试注入平台拉取；不传则走真实 MCP */
  pull?: (opts: { vaultDir: string; skillsRoot: string; host: HostName }) => Promise<PullResult[]>;
  /** 可见提示；只在有变化/冲突/错误时调用 */
  notify?: (msg: string, level: "info" | "warning") => void;
}

export function autoSyncStatePath(override?: string): string {
  return join(machineDir(override), "auto-sync.json");
}

export function lockDirPath(override?: string): string {
  return join(machineDir(override), "auto-sync.lock");
}

export function readAutoSyncState(override?: string): AutoSyncState {
  try {
    const raw = JSON.parse(readFileSync(autoSyncStatePath(override), "utf8")) as Partial<AutoSyncState>;
    return { schema: 1, hosts: raw.hosts ?? {} };
  } catch {
    return { schema: 1, hosts: {} };
  }
}

export function writeAutoSyncState(st: AutoSyncState, override?: string): void {
  const p = autoSyncStatePath(override);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  renameSync(tmp, p);
}

/** 本地日期（用户所在时区），不用 UTC——否则晚上 8 点会被算成第二天 */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localTime(d: Date): string {
  return `${localDate(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function backoffMs(attempts: number): number {
  return Math.min(4, Math.max(1, attempts)) * 3600_000;
}

interface HeldLock {
  dir: string;
  token: string;
  release: () => void;
}

function acquireLock(override: string | undefined, host: HostName, now: Date): HeldLock | null {
  const dir = lockDirPath(override);
  const token = `${process.pid}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dirname(dir), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner.json"), JSON.stringify({
        pid: process.pid, host, token,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
      }), "utf8");
      return {
        dir,
        token,
        release: () => {
          try {
            const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { token?: string };
            if (owner.token === token) rmSync(dir, { recursive: true, force: true });
          } catch {
            /* 已经不是我们的锁 */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 锁存在：过期就回收，否则放弃
      let expired = false;
      try {
        const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as { expires_at?: string };
        expired = !owner.expires_at || Date.parse(owner.expires_at) < now.getTime();
      } catch {
        try { expired = now.getTime() - statSync(dir).mtimeMs > LOCK_TTL_MS; } catch { expired = true; }
      }
      if (!expired) return null;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}

/** 今日失败次数是否已用完（用完就等到明天） */
function retryAllowed(st: HostState, now: Date, today: string): boolean {
  if (!st.nextRetryAt) return true;
  if (Date.parse(st.nextRetryAt) > now.getTime()) return false;
  return (st.attemptsToday ?? 0) < MAX_ATTEMPTS_PER_DAY || st.attemptDate !== today;
}

function notifySafe(
  fn: AutoSyncOptions["notify"],
  msg: string,
  level: "info" | "warning",
): void {
  try {
    fn?.(msg, level);
  } catch {
    /* 提示失败不影响检查结果 */
  }
}

async function checkGit(repoRoot: string): Promise<AutoSyncSummary["repo"]["git"]> {
  if (process.env.OW_GIT_CHECK === "0") return undefined;
  if (!existsSync(join(repoRoot, ".git"))) return undefined;
  try {
    const opts = { encoding: "utf8" as const, timeout: 8_000 };
    const branch = (await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], opts)).stdout.trim();
    const head = (await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], opts)).stdout.trim();
    const remoteLine = (await execFileAsync("git", ["-C", repoRoot, "ls-remote", "origin", "HEAD"], opts)).stdout.trim();
    const remote = remoteLine.split(/\s+/)[0];
    if (!remote) return { branch, error: "origin 没有 HEAD" };
    if (remote === head) return { branch, behind: 0 };
    try {
      await execFileAsync("git", ["-C", repoRoot, "fetch", "--quiet", "origin", branch], { ...opts, timeout: 15_000 });
    } catch {
      /* fetch 失败也还能用 ls-remote 的结果 */
    }
    const behindRaw = (await execFileAsync("git", ["-C", repoRoot, "rev-list", "--count", `HEAD..origin/${branch}`], opts)).stdout.trim();
    const behind = Number(behindRaw);
    return { branch, behind: Number.isFinite(behind) ? behind : undefined };
  } catch (e) {
    return { error: String(e).slice(0, 160) };
  }
}

function summarize(
  host: HostName,
  repoResults: ReturnType<typeof reinstallSafeSkills>,
  pulls: PullResult[] | null,
  platformReason: string | undefined,
  pullError: string | undefined,
  now: Date,
  git?: AutoSyncSummary["repo"]["git"],
): AutoSyncSummary {
  const summary: AutoSyncSummary = {
    host,
    checked_at: now.toISOString(),
    repo: { reinstalled: [], installed: [], pruned: [], modified: [], unchanged: 0, errors: [], git },
    platform: {
      status: pullError ? "error" : pulls ? "ok" : "skipped",
      reason: pullError ?? platformReason,
      created: 0, updated: 0, unchanged: 0, conflicts: [], failed: [], warnings: [],
    },
  };

  for (const r of repoResults) {
    if (r.error) summary.repo.errors.push(`${r.name}: ${r.error}`);
    if (r.action === "reinstalled") summary.repo.reinstalled.push(r.name);
    else if (r.action === "installed") summary.repo.installed.push(r.name);
    else if (r.action === "pruned") summary.repo.pruned.push(r.name);
    else if (r.action === "modified") summary.repo.modified.push(r.name);
    else summary.repo.unchanged++;
  }

  for (const p of pulls ?? []) {
    if (p.action === "created") summary.platform.created++;
    else if (p.action === "updated" || p.action === "adopted") summary.platform.updated++;
    else if (p.action === "conflict") summary.platform.conflicts.push(p.name);
    else if (p.action === "failed") summary.platform.failed.push(`${p.name}: ${p.message ?? "失败"}`);
    else if (p.action === "diverged" || p.action === "adoptable") summary.platform.warnings.push(`${p.name}: ${p.message ?? p.action}`);
    else summary.platform.unchanged++;
  }

  return summary;
}

function describe(summary: AutoSyncSummary): string | null {
  const parts: string[] = [];
  const r = summary.repo;
  if (r.reinstalled.length) parts.push(`仓库重装 ${r.reinstalled.length}`);
  if (r.installed.length) parts.push(`仓库新装 ${r.installed.length}`);
  if (r.pruned.length) parts.push(`仓库清理 ${r.pruned.length}`);
  if (r.modified.length) parts.push(`本地手改 ${r.modified.length}（未覆盖）`);
  if (r.errors.length) parts.push(`重装失败 ${r.errors.length}`);
  if (r.git?.behind && r.git.behind > 0) parts.push(`仓库落后 origin/${r.git.branch ?? "main"} ${r.git.behind} 个提交`);
  const p = summary.platform;
  if (p.status === "ok") {
    if (p.created) parts.push(`平台新增 ${p.created}`);
    if (p.updated) parts.push(`平台更新 ${p.updated}`);
    if (p.conflicts.length) parts.push(`冲突 ${p.conflicts.length}`);
    if (p.failed.length) parts.push(`拉取失败 ${p.failed.length}`);
    // `diverged/adoptable` 只记进 lastResult，不进每日通知：
    // 本地手改是常见状态，每天播报一次只会变成噪音；平台真更新时会落冲突。
  } else if (p.status === "error") {
    parts.push(`平台检查失败：${p.reason ?? "未知错误"}`);
  }
  return parts.length ? `[技能检查] ${parts.join("；")}` : null;
}

/**
 * 当天第一次有用户活动时调用。幂等：同一天第二次直接返回 already-checked。
 *
 * 注意：平台拉取仍然使用当前 vault 的 `.ow/skill-manifest.json`（项目级）。
 * 机器级 manifest 的迁移是后续项；这里先把“每日首次检查 + 安全重装”跑起来。
 */
export async function maybeAutoSync(opts: AutoSyncOptions): Promise<AutoSyncResult> {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const state = readAutoSyncState(opts.machineDir);
  const st: HostState = state.hosts[opts.host] ?? {};
  state.hosts[opts.host] = st;

  if (!opts.force && st.lastSuccessDate === today) return { status: "already-checked" };
  if (!opts.force && !retryAllowed(st, now, today)) {
    return { status: "backoff", retryAt: st.nextRetryAt };
  }

  const lock = acquireLock(opts.machineDir, opts.host, now);
  if (!lock) return { status: "busy" };

  let summary: AutoSyncSummary | undefined;
  try {
    const repoRoot = opts.repoRoot === undefined ? findRepoRoot() : opts.repoRoot;
    const hostDir = opts.skillsRoot ?? hostSkillDir(opts.host);

    // 1) 仓库技能：只覆盖没被手改过的
    const repoResults = repoRoot && existsSync(join(repoRoot, "agent-skills"))
      ? reinstallSafeSkills({ repoRoot, host: opts.host, hostDir, machineDir: opts.machineDir })
      : [];
    const git = repoRoot ? await checkGit(repoRoot) : undefined;

    // 2) 平台技能：没有 vault / 没有 token 就跳过，不影响本地检查
    let pulls: PullResult[] | null = null;
    let platformReason: string | undefined;
    let pullError: string | undefined;
    if (!opts.vaultDir) {
      platformReason = "当前项目没有 .qdoc vault";
    } else if (!opts.pull) {
      const { token } = resolveToken({ vaultDir: opts.vaultDir });
      if (!token) platformReason = "未配置 qdoc token";
      else {
        try {
          const client = new QdocMcpClient({ token });
          await client.initialize();
          pulls = await pullSkills({ client, vaultDir: opts.vaultDir, skillsRoot: hostDir, host: opts.host });
        } catch (e) {
          pullError = String(e).slice(0, 300);
        }
      }
    } else {
      try {
        pulls = await opts.pull({ vaultDir: opts.vaultDir, skillsRoot: hostDir, host: opts.host });
      } catch (e) {
        pullError = String(e).slice(0, 300);
      }
    }

    summary = summarize(opts.host, repoResults, pulls, platformReason, pullError, now, git);

    if (!pullError) {
      st.lastSuccessDate = today;
      st.lastFullAt = now.toISOString();
      st.attemptDate = today;
      st.attemptsToday = 0;
      st.nextRetryAt = undefined;
      st.lastResult = summary;
      writeAutoSyncState(state, opts.machineDir);
      const msg = describe(summary);
      if (msg) notifySafe(opts.notify, msg, summary.repo.modified.length ? "warning" : "info");
      return { status: "checked", summary };
    }

    // 平台失败：本地重装已生效，但当天还要按退避重试
    st.attemptDate = today;
    st.attemptsToday = (st.attemptsToday ?? 0) + 1;
    st.nextRetryAt = new Date(now.getTime() + backoffMs(st.attemptsToday)).toISOString();
    st.lastResult = summary;
    writeAutoSyncState(state, opts.machineDir);
    notifySafe(opts.notify, `[技能检查] 平台检查失败，稍后重试：${pullError}`, "warning");
    return { status: "error", summary, error: pullError, retryAt: st.nextRetryAt };
  } catch (e) {
    st.attemptDate = today;
    st.attemptsToday = (st.attemptsToday ?? 0) + 1;
    st.nextRetryAt = new Date(now.getTime() + backoffMs(st.attemptsToday)).toISOString();
    writeAutoSyncState(state, opts.machineDir);
    const error = String(e).slice(0, 300);
    notifySafe(opts.notify, `[技能检查] 失败：${error}`, "warning");
    return { status: "error", error, retryAt: st.nextRetryAt };
  } finally {
    lock.release();
  }
}

/** 给 `ow status` 用：读各 host 上次结果（不联网） */
export function readAutoSyncSummary(host: HostName, override?: string): AutoSyncSummary | null {
  return readAutoSyncState(override).hosts[host]?.lastResult ?? null;
}

export { describe as describeAutoSyncSummary, localTime };
