/**
 * 仓库 Git 自动更新（设计文档 §3.6）：默认关，`AUTOSKILL_AUTO_UPDATE=1` 开。
 *
 * 为什么默认关：技能目录的实体拷贝不会跟仓库自动走，忘了更新会慢慢漂移；
 * 但自动 pull 动的是用户工作区，未经同意的写操作必须显式开。
 *
 * 安全边界（硬约束）：
 *  - 只 `git pull --ff-only`——分叉/冲突时**必然失败**，绝不 reset/checkout/force，
 *    用户的 fork 改动永远不会被覆盖；
 *  - 失败写退避状态（1h → 2h → 4h 封顶），不每轮重试刷屏；
 *  - 成功后 reinstallSafeSkills（复用安装基线，只重装「上次装过的」），
 *    再交宿主 ctx.skill.reload() 热载；
 *  - 插件代码本身更新需要重启 OpenCode 服务进程（模块已加载），文档里写明。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { reinstallSafeSkills, type HostName } from "../../packages/core/lib/sync/install.ts";
import { findRepoRoot } from "../../packages/core/lib/sync/drift.ts";
import { machineDir } from "../../packages/core/lib/trigger/lock.ts";

const execFileAsync = promisify(execFile);

const BACKOFF_MS = [0, 3_600_000, 7_200_000, 14_400_000]; // 1h / 2h / 4h 封顶

export interface AutoUpdateOptions {
  /** 默认 "opencode" */
  host?: HostName;
  /** 默认 findRepoRoot() */
  repoRoot?: string | null;
  /** 测试注入时间 */
  now?: Date;
  /** 测试覆盖状态文件路径 */
  statePath?: string;
  /** 测试/非标布局覆盖技能落盘目录（缺省 hostSkillDir(host)） */
  hostDir?: string;
  /** 宿主技能热载（成功后调用；缺省跳过） */
  reloadSkills?: () => Promise<void> | void;
  /** 可见提示：只在真的拉了/失败时调用 */
  notify?: (msg: string, level: "info" | "warning") => void;
  /** git 命令超时 */
  timeoutMs?: number;
}

export type AutoUpdateStatus =
  | "disabled"     // 开关没开
  | "no-repo"      // 找不到仓库根
  | "backoff"      // 上次失败还在退避窗口内
  | "up-to-date"   // 远端无新提交
  | "pulled"       // 拉取 + 重装 + 热载成功
  | "error";       // pull 失败（分叉/网络/权限），已写退避

export interface AutoUpdateResult {
  status: AutoUpdateStatus;
  behind?: number;
  error?: string;
  retryAt?: string;
}

interface UpdateState {
  schema: 1;
  attempts?: number;
  lastSuccessAt?: string;
  lastError?: string;
  nextRetryAt?: string;
}

export function autoUpdateStatePath(override?: string): string {
  return override ?? join(machineDir(undefined), "auto-update.json");
}

function readState(path: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateState>;
    return { schema: 1, attempts: raw.attempts, lastSuccessAt: raw.lastSuccessAt, lastError: raw.lastError, nextRetryAt: raw.nextRetryAt };
  } catch {
    return { schema: 1 };
  }
}

function writeState(path: string, st: UpdateState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  renameSync(tmp, path);
}

async function git(repo: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { timeout: timeoutMs });
  return (stdout ?? "").trim();
}

/**
 * 条件触发：开关 + 退避闸 + 远端检查 + ff-only 拉取 + 安全重装 + 热载。
 * 所有失败都不上抛——调用方 fire-and-forget，自动更新失败不能影响主对话。
 */
export async function maybeAutoUpdate(opts: AutoUpdateOptions = {}): Promise<AutoUpdateResult> {
  if (process.env.AUTOSKILL_AUTO_UPDATE !== "1") return { status: "disabled" };

  const now = opts.now ?? new Date();
  const repo = opts.repoRoot !== undefined ? opts.repoRoot : findRepoRoot();
  if (!repo || !existsSync(join(repo, ".git"))) return { status: "no-repo" };

  const path = autoUpdateStatePath(opts.statePath);
  const st = readState(path);
  if (st.nextRetryAt && Date.parse(st.nextRetryAt) > now.getTime()) {
    return { status: "backoff", retryAt: st.nextRetryAt, error: st.lastError };
  }

  const host: HostName = opts.host ?? "opencode";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const record = (u: Partial<UpdateState>): void => writeState(path, { schema: 1, ...st, ...u });

  try {
    const branch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
    if (!branch) return { status: "no-repo" };

    await git(repo, ["fetch", "--quiet", "origin", branch], timeoutMs);
    const behindRaw = await git(repo, ["rev-list", "--count", `HEAD..origin/${branch}`], timeoutMs);
    const behind = Number.parseInt(behindRaw || "0", 10) || 0;
    if (behind === 0) {
      record({ attempts: 0, lastError: undefined, nextRetryAt: undefined, lastSuccessAt: now.toISOString() });
      return { status: "up-to-date", behind: 0 };
    }

    // ff-only：分叉时失败并落到 catch——那正是我们要的保护行为
    await git(repo, ["pull", "--ff-only", "origin", branch], timeoutMs);
    const installed = reinstallSafeSkills({ repoRoot: repo, host, ...(opts.hostDir ? { hostDir: opts.hostDir } : {}) });
    try {
      await opts.reloadSkills?.();
    } catch (e) {
      // 热载失败不影响已落盘的技能（下轮对话自会生效），只记提示
      opts.notify?.(`技能已更新但热载失败：${String(e).slice(0, 120)}`, "warning");
    }
    record({ attempts: 0, lastError: undefined, nextRetryAt: undefined, lastSuccessAt: now.toISOString() });
    opts.notify?.(`仓库已自动更新（落后 ${behind} 个提交），重装 ${installed.length} 个技能到 ${host}`, "info");
    return { status: "pulled", behind };
  } catch (e) {
    const error = String(e).slice(0, 300);
    const attempts = (st.attempts ?? 0) + 1;
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    const retryAt = new Date(now.getTime() + wait).toISOString();
    record({ attempts, lastError: error, nextRetryAt: retryAt });
    opts.notify?.(`自动更新失败（${attempts} 次，${Math.round(wait / 60_000)} 分钟后重试）：${error.split("\n")[0]}`, "warning");
    return { status: "error", error, retryAt };
  }
}
