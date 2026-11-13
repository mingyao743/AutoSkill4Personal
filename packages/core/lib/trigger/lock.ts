/**
 * 两级编译锁。
 *
 * 内嵌后**没有单实例了**——dsh 插件和 pi extension 是两个独立进程，都可能判断「满 30 轮」。
 * 所以并发控制从「靠单实例」变成「靠文件锁」，且需要两级：
 *
 *  | 级别 | 位置 | 管什么 |
 *  |---|---|---|
 *  | vault 锁 | `<project>/.qdoc/.ow/lock/` | 同一项目不同 agent 串行 |
 *  | 机器锁 | `~/.config/qdoc/machine.lock/` | 跨项目全局并发 1 |
 *
 * **为什么必须两级**：vault 锁只保护同一个 `.qdoc/`。A 项目和 B 项目同时满 30 轮时，
 * 两个进程拿的是不同目录的锁，互相看不见，会同时编译同时烧 token。
 *
 * 实现用 `mkdirSync` 做原子抢占（POSIX 与 Windows 都原子），不用 `open(..., 'wx')`
 * 是为了能顺手把持有者信息写进目录里的 owner.json。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 锁过期时间：进程被杀会留死锁，30 分钟后强制回收 */
export const LOCK_TTL_MS = 30 * 60 * 1000;

/** 拿不到锁时的退避序列（1s / 2s / 4s） */
export const LOCK_BACKOFF_MS = [1_000, 2_000, 4_000];

export interface LockOwner {
  pid: number;
  agent: string;
  session?: string;
  vault?: string;
  acquired_at: string;
  expires_at: string;
}

export interface LockHandle {
  /** 锁目录（释放时删它） */
  dir: string;
  level: "vault" | "machine";
  owner: LockOwner;
}

export interface AcquireOptions {
  level: "vault" | "machine";
  agent: string;
  session?: string;
  vault?: string;
  ttlMs?: number;
  /** 退避等待；false 则只试一次（供「已在编译中」的快速判定用） */
  wait?: boolean;
  /** 测试注入用 */
  sleep?: (ms: number) => Promise<void>;
}

/** 机器级配置目录（跨项目共享，不属于任何 vault） */
export function machineDir(override?: string): string {
  return override ?? process.env.QDOC_MACHINE_DIR ?? join(homedir(), ".config", "qdoc");
}

export function machineLockDir(override?: string): string {
  return join(machineDir(override), "machine.lock");
}

export function vaultLockDir(vaultDir: string): string {
  return join(vaultDir, ".ow", "lock");
}

function lockDirFor(opts: AcquireOptions): string {
  return opts.level === "machine" ? machineLockDir() : vaultLockDir(opts.vault ?? "");
}

/**
 * 抢锁。成功返回句柄，失败返回 null（不抛异常——调用方通常只想「这次先跳过」）。
 *
 * 死锁回收：若锁目录存在但 `expires_at` 已过，直接删掉重抢，并记 reclaimed。
 */
export async function acquireLock(opts: AcquireOptions): Promise<LockHandle | null> {
  const dir = lockDirFor(opts);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ttl = opts.ttlMs ?? LOCK_TTL_MS;
  const attempts = opts.wait === false ? 1 : LOCK_BACKOFF_MS.length + 1;

  for (let i = 0; i < attempts; i++) {
    const got = tryCreate(dir, opts, ttl);
    if (got) return got;

    // 抢不到：看是不是死锁
    const owner = readOwner(dir);
    if (owner && Date.now() > Date.parse(owner.expires_at)) {
      reclaim(dir);
      const retry = tryCreate(dir, opts, ttl);
      if (retry) return retry;
    }

    if (i < attempts - 1) await sleep(LOCK_BACKOFF_MS[i] ?? 4_000);
  }
  return null;
}

function tryCreate(dir: string, opts: AcquireOptions, ttl: number): LockHandle | null {
  try {
    mkdirp(dir);
    // mkdir 原子：已存在会抛 EEXIST
    mkdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    throw e;
  }
  const now = Date.now();
  const owner: LockOwner = {
    pid: process.pid,
    agent: opts.agent,
    session: opts.session,
    vault: opts.vault,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
  };
  try {
    writeFileSync(join(dir, "owner.json"), JSON.stringify(owner, null, 2), "utf8");
  } catch {
    // owner.json 写失败不影响锁本身的有效性
  }
  return { dir, level: opts.level, owner };
}

/**
 * 建目录（含所有祖先）。
 *
 * **只建 `dir` 的父级是不够的**：调用方紧接着要 `mkdirSync(dir)` 抢锁，
 * 所以这里必须保证 `dir` 的父目录存在。旧实现对 `~/.config/qdoc` 这种
 * 「`~/.config` 已存在、`qdoc` 不存在」的两级路径会直接返回，
 * 随后 `mkdirSync(dir)` 抛 ENOENT——**新机器第一次用必崩**。
 */
function mkdirp(dir: string): void {
  try {
    mkdirSync(dirname(dir), { recursive: true });
  } catch {
    /* 并发建同一父目录，忽略 */
  }
}

export function readOwner(dir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as LockOwner;
  } catch {
    // 锁目录存在但 owner.json 还没写（抢锁与写 owner 之间有微小窗口）
    try {
      const st = statSync(dir);
      const age = Date.now() - st.mtimeMs;
      if (age > LOCK_TTL_MS) return { pid: -1, agent: "?", acquired_at: "", expires_at: "" };
    } catch {
      /* 目录已经没了 */
    }
    return null;
  }
}

function reclaim(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 回收失败就等下次 */
  }
}

/** 释放锁（幂等；不是自己的锁不删） */
export function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  const owner = readOwner(handle.dir);
  if (owner && owner.pid !== process.pid) return; // 别人的锁，不动
  reclaim(handle.dir);
}

/** 当前锁持有者（诊断 / `ow status` 用） */
export function inspectLock(level: "vault" | "machine", vaultDir?: string): LockOwner | null {
  const dir = level === "machine" ? machineLockDir() : vaultLockDir(vaultDir ?? "");
  return readOwner(dir);
}

/** 持锁跑一段逻辑；拿不到锁返回 null（不执行 fn） */
export async function withLock<T>(
  opts: AcquireOptions,
  fn: () => Promise<T>,
): Promise<T | null> {
  const handle = await acquireLock(opts);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    releaseLock(handle);
  }
}
