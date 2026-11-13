import { scanPages } from "../../../core/lib/vault/index.ts";
import { readState } from "../../../core/lib/trigger/state.ts";
import { checkBudget } from "../../../core/lib/trigger/budget.ts";
import { inspectLock } from "../../../core/lib/trigger/lock.ts";
import { ledgerStats } from "../../../core/lib/publish/ledger.ts";
import { listConflicts } from "../../../core/lib/publish/conflict.ts";
import { readLastReport } from "../../../core/lib/compiler/report.ts";
import { collectStatus, skillRecords } from "../../../core/lib/sync/status.ts";
import { resolveToken } from "../../../core/lib/publish/mcp.ts";
import { needVault, out } from "../vault-ctx.ts";
import type { ParsedArgs } from "../args.ts";

export async function runStatus(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const pages = scanPages(v.dir);
  const state = readState(v.dir);
  const budget = checkBudget();
  const ledger = ledgerStats(v.dir);
  const conflicts = listConflicts(v.dir);
  const last = readLastReport(v.dir);
  const token = resolveToken({ vaultDir: v.dir });
  const vaultLock = inspectLock("vault", v.dir);
  const machineLock = inspectLock("machine");
  const sync = collectStatus(v.dir);
  const skills = skillRecords(v.dir);

  const sessions = Object.entries(state.sessions)
    .sort((a, b) => (b[1].last_run ?? "").localeCompare(a[1].last_run ?? ""))
    .slice(0, 5);

  const lines = [
    `知识库：${v.dir}`,
    `页面：${pages.length} 页`,
    "",
    "发布：",
    `  已发布 ${ledger.published} / 待发布 ${ledger.pending} / 墓碑 ${ledger.tombstone} / 失败 ${ledger.failing}`,
    `  冲突待裁决：${conflicts.length}`,
    "",
    "编译：",
    `  今日 ${budget.used.compiles}/${budget.limits.compiles} 次，token ${budget.used.tokens}/${budget.limits.tokens}`,
    budget.allowed ? "  预算：可用" : `  预算：已耗尽（${budget.reason}）`,
    last ? `  最近一次：${last.started_at}，新增 ${last.pages_created}、更新 ${last.pages_updated}，模型 ${last.model}` : "  最近一次：无",
    "",
    "会话水位：",
    ...(sessions.length
      ? sessions.map(([k, s]) => `  ${k} → 已编译到第 ${s.compiled_to_turn} 轮（${s.pages ?? 0} 页）`)
      : ["  （无）"]),
    "",
    "锁：",
    `  vault：${vaultLock ? `持有中 pid=${vaultLock.pid} agent=${vaultLock.agent}` : "空闲"}`,
    `  机器：${machineLock ? `持有中 pid=${machineLock.pid} agent=${machineLock.agent}` : "空闲"}`,
    "",
    "技能：",
    `  清单 ${sync.skills.total} 个（拉取 ${sync.skills.pulled} / 推送 ${sync.skills.pushed} / 本地 ${sync.skills.local}）`,
    ...(sync.skills.pendingEnable > 0
      ? [`  待启用 ${sync.skills.pendingEnable} 个 —— 平台没有启用 API，要去 qdoc.chat 手动点`]
      : []),
    ...(sync.skills.missing > 0
      ? [`  平台已禁用 ${sync.skills.missing} 个（本地保留）`]
      : []),
    ...(sync.stalePendingEnable.length > 0
      ? [`  ⚠ 超过 7 天仍未启用：${sync.stalePendingEnable.join(", ")}`]
      : []),
    ...(skills.length > 0
      ? skills.slice(0, 6).map(([n, r]) =>
          `    ${n} v${r.version}${r.pending_enable ? "（待启用）" : ""}${r.missing_on_platform ? "（平台已移除）" : ""}`)
      : []),
    "",
    `待确认：${sync.pendingSummary}${sync.pendingReview > 0 ? "（ow review）" : ""}`,
    `token：${token.token ? `已配置（${token.source}）` : "未配置"}`,
  ];

  out(args, lines.join("\n"), {
    vault: v.dir,
    pages: pages.length,
    ledger,
    conflicts: conflicts.length,
    budget: { used: budget.used, limits: budget.limits, allowed: budget.allowed },
    lastReport: last,
    sessions: Object.fromEntries(sessions),
    locks: { vault: vaultLock, machine: machineLock },
    token: { configured: !!token.token, source: token.source },
    sync,
  });
  return 0;
}
