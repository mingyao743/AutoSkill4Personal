/**
 * 同步状态汇总：`ow status` 的数据源。
 *
 * 回答三个问题：**有多少待发布 / 能拉什么技能 / 有多少要人确认**。
 * 全部只读本地状态，不联网——`ow status` 要能秒回，且断网也能用。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest, manifestStats, stalePendingEnable, type SkillRecord } from "./manifest.ts";
import { readLedger, ledgerStats } from "../publish/ledger.ts";
import { scanPages } from "../vault/index.ts";
import { readState } from "../trigger/state.ts";
import { readMachineState } from "../trigger/budget.ts";
import { listConflicts } from "../publish/conflict.ts";
import { countPending, pendingSummary } from "../review/pending.ts";

export interface SyncStatus {
  /** vault 页数 */
  pages: number;
  /** 待发布页数（有内容但没发过 / 内容变过） */
  pendingPublish: number;
  /** 已发布页数 */
  published: number;
  /** 发布失败累计 */
  failures: number;
  /** 技能清单统计 */
  skills: ReturnType<typeof manifestStats>;
  /** 推上去超 7 天仍未启用（要人点） */
  stalePendingEnable: string[];
  /** 冲突现场数量 */
  conflicts: number;
  /** 待确认队列条数 */
  pendingReview: number;
  /** 一句话摘要（前门技能播报用） */
  pendingSummary: string;
  /** 本机预算用量 */
  budget: { compiles: number; tokens: number; date: string } | null;
  /** 各会话编译水位 */
  sessions: Array<{ key: string; compiledTo: number }>;
}

/**
 * 待确认条数。
 *
 * 两个来源合并计数：review 队列（`.ow/pending/*.json`）+ capture 队列
 * （`.ow/pending/capture.json`）。前者是「要不要覆盖线上」，后者是
 * 「CLI 没凭据、等宿主补跑」。
 */
function countPendingReview(vaultDir: string): number {
  let n = countPending(vaultDir);
  const capturePath = join(vaultDir, ".ow", "pending", "capture.json");
  if (existsSync(capturePath)) {
    try {
      const data = JSON.parse(readFileSync(capturePath, "utf8")) as { items?: unknown[] };
      n += data.items?.length ?? 0;
    } catch {
      /* 坏了不算 */
    }
  }
  return n;
}

export function collectStatus(vaultDir: string): SyncStatus {
  const pages = scanPages(vaultDir);
  const ledger = readLedger(vaultDir);
  const lStats = ledgerStats(vaultDir);

  // 待发布 = 账本里没有记录的页 + 内容哈希变过的页
  let pendingPublish = 0;
  let published = 0;
  for (const p of pages) {
    const entry = ledger.pages[p.path];
    if (!entry || entry.status === "failed") {
      pendingPublish++;
      continue;
    }
    if (entry.status === "published") {
      if (entry.body_hash && p.hash && entry.body_hash !== p.hash) pendingPublish++;
      else published++;
    }
  }

  const state = readState(vaultDir);
  const sessions = Object.entries(state.sessions ?? {}).map(([key, s]) => ({
    key,
    compiledTo: (s as { compiled_to_turn?: number }).compiled_to_turn ?? 0,
  }));

  let budget: SyncStatus["budget"] = null;
  try {
    const m = readMachineState();
    budget = { compiles: m.compiles ?? 0, tokens: m.tokens ?? 0, date: m.date ?? "" };
  } catch {
    /* 没有机器状态就当没有 */
  }

  return {
    pages: pages.length,
    pendingPublish,
    published,
    failures: lStats.failed ?? 0,
    skills: manifestStats(vaultDir),
    stalePendingEnable: stalePendingEnable(vaultDir),
    conflicts: safeConflicts(vaultDir),
    pendingReview: countPendingReview(vaultDir),
    pendingSummary: pendingSummary(vaultDir),
    budget,
    sessions,
  };
}

function safeConflicts(vaultDir: string): number {
  try {
    return listConflicts(vaultDir).length;
  } catch {
    return 0;
  }
}

/** 技能清单里所有记录（`ow status --skills` 用） */
export function skillRecords(vaultDir: string): Array<[string, SkillRecord]> {
  return Object.entries(readManifest(vaultDir).skills);
}
