/**
 * 桌面通知（方案 §11.6）。
 *
 * **默认关闭**，`config.notify = true` 才开。原因：后台定时任务弹系统通知很烦，
 * 而且只有两类事值得打断人：**覆盖线上技能**（不可回滚）、**预算耗尽**。
 *
 * 限流：一天最多 3 条，同类不重复。超了就静默——`ow review` 里还在，不会丢。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingItem, Severity } from "./pending.ts";

export const MAX_PER_DAY = 3;

/** 只有这两类值得打断人 */
export const NOTIFY_KINDS = new Set(["skill-overwrite", "budget-exhausted"]);

export interface NotifyState {
  date: string;
  count: number;
  /** 今天已通知过的 dedupeKey，避免同类重复 */
  sent: string[];
}

export function notifyStatePath(vaultDir: string): string {
  return join(vaultDir, ".ow", "notify-state.json");
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function readNotifyState(vaultDir: string): NotifyState {
  const p = notifyStatePath(vaultDir);
  const fresh: NotifyState = { date: today(), count: 0, sent: [] };
  if (!existsSync(p)) return fresh;
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as NotifyState;
    // 跨天重置
    if (s.date !== today()) return fresh;
    return { date: s.date, count: s.count ?? 0, sent: s.sent ?? [] };
  } catch {
    return fresh;
  }
}

export function writeNotifyState(vaultDir: string, s: NotifyState): void {
  mkdirSync(join(vaultDir, ".ow"), { recursive: true });
  writeFileSync(notifyStatePath(vaultDir), JSON.stringify(s, null, 2), "utf8");
}

/** 当前平台可用的通知命令 */
export function detectNotifier(): { cmd: string; args: string[] } | null {
  const which = (bin: string): boolean => {
    const r = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" });
    return r.status === 0 && Boolean(r.stdout.trim());
  };
  if (process.platform === "darwin") {
    if (which("terminal-notifier")) return { cmd: "terminal-notifier", args: ["-title"] };
    // 没有 terminal-notifier 时退回 osascript（系统自带）
    if (which("osascript")) return { cmd: "osascript", args: [] };
    return null;
  }
  if (which("notify-send")) return { cmd: "notify-send", args: [] };
  return null;
}

/** 实际发一条系统通知；返回是否发出 */
export function sendDesktop(title: string, body: string): boolean {
  const n = detectNotifier();
  if (!n) return false;

  let argv: string[];
  if (n.cmd === "terminal-notifier") {
    argv = ["-title", "qdoc", "-message", `${title}\n${body}`];
  } else if (n.cmd === "osascript") {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify("qdoc")}`;
    argv = ["-e", script];
  } else {
    argv = ["qdoc", `${title}\n${body}`];
  }
  const r = spawnSync(n.cmd, argv, { encoding: "utf8", stdio: "pipe" });
  return r.status === 0;
}

export interface NotifyDecision {
  should: boolean;
  reason: string;
}

/** 该不该为这条通知（纯逻辑，不发送，方便测试） */
export function shouldNotify(
  item: PendingItem,
  state: NotifyState,
  enabled: boolean,
): NotifyDecision {
  if (!enabled) return { should: false, reason: "通知未开启" };
  if (!NOTIFY_KINDS.has(item.kind)) return { should: false, reason: "这类不值得打断人" };
  if (item.severity !== "high") return { should: false, reason: "只报 high" };
  if (state.count >= MAX_PER_DAY) return { should: false, reason: `今天已发 ${state.count} 条（上限 ${MAX_PER_DAY}）` };
  const key = `${item.kind}::${String(item.detail?.skill ?? item.detail?.target ?? "")}`;
  if (state.sent.includes(key)) return { should: false, reason: "同类今天已通知过" };
  return { should: true, reason: "值得通知" };
}

/**
 * 尝试通知一条。返回是否真的发出（发出才计数）。
 *
 * 注意：`sendDesktop` 失败（没装通知工具）**不消耗配额**，也不会报错——
 * 桌面通知是锦上添花，缺了不影响主流程。
 */
export function maybeNotify(
  vaultDir: string,
  item: PendingItem,
  enabled: boolean,
): { sent: boolean; reason: string } {
  const state = readNotifyState(vaultDir);
  const d = shouldNotify(item, state, enabled);
  if (!d.should) return { sent: false, reason: d.reason };

  const body = summarize(item);
  const ok = sendDesktop(item.title, body);
  if (!ok) return { sent: false, reason: "没有可用的通知工具（terminal-notifier / notify-send）" };

  const key = `${item.kind}::${String(item.detail?.skill ?? item.detail?.target ?? "")}`;
  writeNotifyState(vaultDir, {
    date: state.date,
    count: state.count + 1,
    sent: [...state.sent, key],
  });
  return { sent: true, reason: "已通知" };
}

/** 通知正文：一句话，不展开 */
export function summarize(item: PendingItem): string {
  const d = item.detail ?? {};
  if (item.kind === "skill-overwrite") {
    const ver = d.from != null || d.to != null ? ` v${d.from ?? "?"}→v${d.to ?? "?"}` : "";
    return `${d.skill ?? "技能"}${ver}，跑 ow review 处理`;
  }
  if (item.kind === "budget-exhausted") {
    return `${d.reason ?? "预算耗尽"}，今日不再自动编译`;
  }
  return `${item.title}，跑 ow review 处理`;
}

export type { Severity };
