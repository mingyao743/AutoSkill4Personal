/**
 * `ow review`：唯一需要人交互的入口（方案 §11.3）。
 *
 * 为什么需要：后台跑着的东西**不能弹对话框**。能做的只有「告知 + 可撤销」。
 * 唯一真正不可撤销的操作是「覆盖平台侧技能」，所以只有它必须问人。
 *
 * 非 tty 环境降级成只列不交互——CI / agent 调用的场景。
 */
import {
  listPending, pendingSummary, resetPolicy, policyPath, readPolicy,
  addPending, type PendingEntry, type PendingKind,
} from "../../../core/lib/review/pending.ts";
import { runReview, isInteractive } from "../../../core/lib/review/review.ts";
import { maybeNotify } from "../../../core/lib/review/notify.ts";
import { listConflicts } from "../../../core/lib/publish/conflict.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, type ParsedArgs } from "../args.ts";

export async function runReviewCmd(args: ParsedArgs): Promise<number> {
  const v = needVault(args);

  // --reset：清空「以后不再问」规则
  if (flagBool(args, "reset")) {
    resetPolicy(v.dir);
    out(args, "已清空所有「以后不再问」规则，之后会重新逐条询问。", { reset: true });
    return 0;
  }

  // --policy：看当前放行规则
  if (flagBool(args, "policy")) {
    const p = readPolicy(v.dir);
    if (p.allow.length === 0 && p.allowKinds.length === 0) {
      out(args, "当前没有放行规则。", { policy: p });
      return 0;
    }
    const lines = [`放行规则（${policyPath(v.dir)}）：`];
    if (p.allowKinds.length > 0) lines.push(`  整个类型不再问：${p.allowKinds.join(", ")}`);
    if (p.allow.length > 0) {
      lines.push("  单条不再问：");
      for (const k of p.allow) lines.push(`    ${k}`);
    }
    lines.push("", "清空用 `ow review --reset`");
    out(args, lines.join("\n"), { policy: p });
    return 0;
  }

  // 冲突现场单独提示（它们不在 pending 队列里，存在 .publish/conflicts/）
  const conflicts = listConflicts(v.dir);

  const listOnly = flagBool(args, "list") || !isInteractive();
  const yes = flagBool(args, "yes");

  const pending = listPending(v.dir);
  if (pending.length === 0 && conflicts.length === 0) {
    out(args, "没有待确认事项。", { total: 0, conflicts: 0 });
    return 0;
  }

  const header: string[] = [];
  if (pending.length > 0) header.push(pendingSummary(v.dir));
  if (conflicts.length > 0) {
    header.push(`另有 ${conflicts.length} 个冲突现场（.publish/conflicts/），重新发布可覆盖`);
  }

  const result = await runReview({
    vaultDir: v.dir,
    listOnly,
    yes,
    showAllowed: flagBool(args, "all"),
  });

  // 高危项尝试桌面通知（默认关，OW_NOTIFY=1 才开）
  if (process.env.OW_NOTIFY === "1") {
    for (const item of pending.filter((p) => p.severity === "high").slice(0, 1)) {
      maybeNotify(v.dir, item, true);
    }
  }

  const lines = [header.join("\n"), ""];
  if (listOnly && conflicts.length > 0) {
    lines.push("冲突现场：");
    for (const c of conflicts.slice(0, 10)) {
      lines.push(`  ${c.pagePath}  本地 v${c.localVersion ?? "?"} / 平台 v${c.remoteVersion ?? "?"}`);
    }
  }

  out(args, lines.filter(Boolean).join("\n"), {
    total: result.total,
    applied: result.applied,
    skipped: result.skipped,
    allowed: result.allowed,
    remaining: result.remaining,
    failed: result.failed.map((f) => ({ title: f.item.title, error: f.error })),
    conflicts: conflicts.length,
  });
  return result.failed.length > 0 ? 1 : 0;
}

// ---------------- 供 sync / publish 调用的入队接口 ----------------

/**
 * 记一条「推技能会覆盖线上」——**唯一不可回滚的操作**，必须问人。
 *
 * 调用方（`ow sync --direction push`）只在**真的会覆盖**时调用它，
 * 而不是无条件推。
 */
export function queueSkillOverwrite(
  vaultDir: string,
  info: { skill: string; skillId?: string; from?: number; to?: number; files?: number; diff?: string },
): void {
  addPending(vaultDir, {
    kind: "skill-overwrite",
    created_at: new Date().toISOString(),
    severity: "high",
    title: "技能推送会覆盖线上",
    detail: {
      skill: info.skill,
      skill_id: info.skillId,
      from: info.from,
      to: info.to,
      files: info.files,
      diff: info.diff,
    },
    action: {
      cli: `ow sync --direction push --only ${info.skill} --yes`,
      reversible: false,
      effect: `平台上的 ${info.skill} 会被本地版本覆盖，无法回滚`,
    },
  });
}

/** 记一条「推上去但平台未启用」——无副作用，只是要人去点 */
export function queueSkillPendingEnable(
  vaultDir: string,
  info: { skill: string; skillId?: string; files?: number },
): void {
  addPending(vaultDir, {
    kind: "skill-pending-enable",
    created_at: new Date().toISOString(),
    severity: "normal",
    title: "技能已推但平台未启用",
    detail: { skill: info.skill, skill_id: info.skillId, files: info.files },
    action: {
      reversible: true,
      effect: "到 qdoc.chat 技能页点「启用」后，其他机器才能拉到",
    },
  });
}

export type { PendingEntry, PendingKind };
