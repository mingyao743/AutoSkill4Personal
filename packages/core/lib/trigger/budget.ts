/**
 * 机器级预算：`~/.config/qdoc/machine.json`。
 *
 * **为什么不是按 vault**：「每日 ≤200k token」是整机总量。放在 vault 里的话，
 * A 项目用完 200k、B 项目还能再用 200k，实际上限变成 N×200k。
 *
 * 同时也记 `by_vault` 分摊，用于回答「哪个项目最费」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineDir } from "./lock.ts";

export interface DayBudget {
  date: string;
  compiles: number;
  input_tokens: number;
  output_tokens: number;
  by_vault: Record<string, number>;
}

export interface MachineState {
  schema: 1;
  budget: DayBudget;
}

/** 默认上限（方案 §13） */
export const DEFAULT_MAX_COMPILES = 50;
export const DEFAULT_MAX_TOKENS = 200_000;

export function machineStatePath(override?: string): string {
  return join(machineDir(override), "machine.json");
}

const today = (): string => new Date().toISOString().slice(0, 10);

function emptyBudget(): DayBudget {
  return { date: today(), compiles: 0, input_tokens: 0, output_tokens: 0, by_vault: {} };
}

export function readMachineState(override?: string): MachineState {
  const p = machineStatePath(override);
  if (!existsSync(p)) return { schema: 1, budget: emptyBudget() };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<MachineState>;
    const b = raw.budget;
    // 跨天自动归零（不做定时任务，读到就重置）
    if (!b || b.date !== today()) return { schema: 1, budget: emptyBudget() };
    return {
      schema: 1,
      budget: {
        date: b.date,
        compiles: b.compiles ?? 0,
        input_tokens: b.input_tokens ?? 0,
        output_tokens: b.output_tokens ?? 0,
        by_vault: b.by_vault ?? {},
      },
    };
  } catch {
    return { schema: 1, budget: emptyBudget() };
  }
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: "daily-compiles" | "daily-tokens";
  used: { compiles: number; tokens: number };
  limits: { compiles: number; tokens: number };
}

/** 是否还能再编译一次 */
export function checkBudget(
  opts: { maxCompiles?: number; maxTokens?: number; override?: string } = {},
): BudgetCheck {
  const st = readMachineState(opts.override);
  const maxCompiles = opts.maxCompiles ?? DEFAULT_MAX_COMPILES;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const tokens = st.budget.input_tokens + st.budget.output_tokens;

  if (st.budget.compiles >= maxCompiles) {
    return {
      allowed: false,
      reason: "daily-compiles",
      used: { compiles: st.budget.compiles, tokens },
      limits: { compiles: maxCompiles, tokens: maxTokens },
    };
  }
  if (tokens >= maxTokens) {
    return {
      allowed: false,
      reason: "daily-tokens",
      used: { compiles: st.budget.compiles, tokens },
      limits: { compiles: maxCompiles, tokens: maxTokens },
    };
  }
  return {
    allowed: true,
    used: { compiles: st.budget.compiles, tokens },
    limits: { compiles: maxCompiles, tokens: maxTokens },
  };
}

/** 编译完成后记账 */
export function recordUsage(
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    vault?: string;
    override?: string;
  } = {},
): void {
  const st = readMachineState(opts.override);
  st.budget.compiles += 1;
  st.budget.input_tokens += opts.inputTokens ?? 0;
  st.budget.output_tokens += opts.outputTokens ?? 0;
  if (opts.vault) {
    st.budget.by_vault[opts.vault] = (st.budget.by_vault[opts.vault] ?? 0) + 1;
  }
  writeMachineState(st, opts.override);
}

export function writeMachineState(st: MachineState, override?: string): void {
  const p = machineStatePath(override);
  mkdirSync(machineDir(override), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  renameSync(tmp, p);
}
