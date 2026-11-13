/**
 * 触发编排：**两个宿主适配器的唯一入口**。
 *
 * 顺序（方案 §5.4）：
 *   数轮次 → 判信号 → 抢机器锁 → 抢 vault 锁 → 切窗 → 编译 → 写页 → 发布 → 推进水位 → 释锁
 *
 * 为什么宿主无关：dsh 的定时器和 pi 的 `before_agent_start` 都调这一个函数，
 * 差别只在「怎么拿到会话事件」——那部分在各自适配器里。
 *
 * 为什么机器锁在 vault 锁之前：机器锁是全局的（跨项目并发 1），先抢它可以让
 * 抢不到的项目立刻退出，不必先占住自己的 vault 锁再等。
 */
import { logError } from "../base/atom-store.ts";
import { buildCompilePrompt } from "../compiler/prompt.ts";
import { runCompile } from "../compiler/run.ts";
import { writeCompileResult, type CompileReport } from "../compiler/report.ts";
import { rebuildHot, rebuildIndex, appendLog } from "../vault/index.ts";
import { resolveVault, type VaultInfo } from "../vault/init.ts";
import { buildWindowPayload, type WindowPayload } from "./window.ts";
import { evaluateSignal, type SignalResult } from "./signal.ts";
import { acquireLock, releaseLock, type LockHandle } from "./lock.ts";
import { checkBudget, recordUsage } from "./budget.ts";
import { advanceState, getSessionState, sessionKey } from "./state.ts";
import {
  indexTurns, remainingTurns, takeWindow, windowEndSeq, windowEndTurn,
  type Turn, type TurnIndex,
} from "./turns.ts";
import type { MessageEntry } from "../base/types.ts";

/** 默认 30 轮 */
export const EXTRACT_EVERY_N_TURNS = Number(process.env.OW_TURNS ?? 30);
/** 会话空闲多久才认为一轮结束（防打断后立刻编译半句话） */
export const IDLE_MS = Number(process.env.OW_IDLE_MS ?? 90_000);
/** 尾窗补跑门槛：剩余 ≥5 轮才补，否则只记 dropped_tail */
export const TAIL_MIN_TURNS = 5;

export type CycleOutcome =
  | { status: "no-vault" }
  | { status: "not-enough-turns"; pending: number; need: number }
  | { status: "self-trigger" }
  | { status: "machine-busy" }
  | { status: "vault-busy" }
  | { status: "budget-exhausted"; reason: string }
  | { status: "no-signal"; signal: SignalResult }
  | { status: "compiled"; report: CompileReport; window: WindowPayload }
  | { status: "error"; error: string };

export interface CycleInput {
  agent: "dsh" | "pi";
  sessionId: string;
  /** 会话事件（已归一：seq 必须存在） */
  events: Array<Record<string, unknown>>;
  /** 归一后的消息（与 events 对应，seq 对齐） */
  entries: Array<MessageEntry & { seq: number }>;
  /** 会话 cwd（决定 vault） */
  cwd: string;
  /** 编译内核技能目录 */
  skillDir: string;
  /** 覆盖轮次阈值（调试用） */
  turns?: number;
  /** 允许初始化 vault */
  autoInit?: boolean;
}

/**
 * 跑一轮判定 + 编译。
 *
 * 这是**唯一会烧 token 的入口**，调用前所有闸门都是纯计算。
 */
export async function maybeCompile(input: CycleInput): Promise<CycleOutcome> {
  const vault = resolveVault({ cwd: input.cwd, autoInit: input.autoInit ?? false });
  if (!vault) return { status: "no-vault" };

  // 防自触发：编译产生的会话 cwd 在 vault 内 → 跳过
  if (isInside(input.cwd, vault.dir)) return { status: "self-trigger" };

  const key = sessionKey(input.agent, input.sessionId);
  const index = indexTurns(input.events, input.sessionId, input.agent);
  const need = input.turns ?? EXTRACT_EVERY_N_TURNS;
  const state = getSessionState(vault.dir, key);
  const win = takeWindow(index, state.compiled_to_turn, need);

  if (win.length === 0) {
    // 不够一整窗：看是不是会话已结束、剩余够补跑
    const rest = remainingTurns(index, state.compiled_to_turn);
    const idle = isIdle(index);
    if (idle && rest >= TAIL_MIN_TURNS) {
      // 落到尾窗逻辑：取全部剩余
      const tail = takeWindow(index, state.compiled_to_turn, rest);
      if (tail.length > 0) return runWindow(input, vault, index, tail, key, rest);
    }
    return { status: "not-enough-turns", pending: rest, need };
  }

  return runWindow(input, vault, index, win, key, need);
}

async function runWindow(
  input: CycleInput,
  vault: VaultInfo,
  index: TurnIndex,
  win: Turn[],
  key: string,
  need: number,
): Promise<CycleOutcome> {
  // 切窗 + 信号门（都不烧 token，先做完再抢锁）
  const payload = buildWindowPayload({
    agent: input.agent,
    sessionId: input.sessionId,
    cwd: input.cwd,
    entries: input.entries,
    turns: win,
  });

  const signal = evaluateSignal(payload);
  if (!signal.keep) return { status: "no-signal", signal };

  const budget = checkBudget();
  if (!budget.allowed) return { status: "budget-exhausted", reason: budget.reason ?? "unknown" };

  // 机器锁 → vault 锁（顺序不能反）
  const machineLock = await acquireLock({
    level: "machine",
    agent: input.agent,
    session: input.sessionId,
    vault: vault.dir,
  });
  if (!machineLock) return { status: "machine-busy" };

  let vaultLock: LockHandle | null = null;
  try {
    vaultLock = await acquireLock({
      level: "vault",
      agent: input.agent,
      session: input.sessionId,
      vault: vault.dir,
    });
    if (!vaultLock) return { status: "vault-busy" };

    const prompt = buildCompilePrompt({
      vaultDir: vault.dir,
      window: payload,
      skillDir: input.skillDir,
    });

    const result = await runCompile({ prompt });
    const report = writeCompileResult({ vaultDir: vault.dir, window: payload, result });

    // 维护索引（持锁期间做，避免和手动入口并发写坏）
    rebuildIndex(vault.dir);
    rebuildHot(vault.dir);
    appendLog(
      vault.dir,
      `编译 ${payload.agent}/${payload.session_id} 第 ${payload.from_turn}–${payload.to_turn} 轮：` +
      `新增 ${report.pages_created}、更新 ${report.pages_updated}、跳过 ${report.pages_skipped.length}`,
    );

    advanceState(vault.dir, key, {
      compiled_to_turn: windowEndTurn(win),
      compiled_to_seq: windowEndSeq(win),
      pages: report.pages_created + report.pages_updated,
    });

    recordUsage({
      inputTokens: result.usage?.promptTokens,
      outputTokens: result.usage?.completionTokens,
      vault: vault.dir,
    });

    return { status: "compiled", report, window: payload };
  } catch (e) {
    logError(`[cycle] 编译失败 ${input.agent}/${input.sessionId}: ${String(e)}`);
    return { status: "error", error: String(e) };
  } finally {
    releaseLock(vaultLock);
    releaseLock(machineLock);
  }
}

/** cwd 是否在 dir 内（含自身） */
function isInside(cwd: string, dir: string): boolean {
  const a = cwd.replace(/\/+$/, "");
  const b = dir.replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

/** 最后一轮是否已结束够久（文件不再变） */
function isIdle(index: TurnIndex): boolean {
  const last = index.turns[index.turns.length - 1];
  if (!last?.endedAt) return false;
  return Date.now() - Date.parse(last.endedAt) >= IDLE_MS;
}
