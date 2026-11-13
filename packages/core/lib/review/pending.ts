/**
 * 待确认队列：`.ow/pending/<ts>-<kind>.json`。
 *
 * **核心原则**：后台流程不能「问」，只能「**告知 + 可撤销**」（方案 §11.1）。
 * 所以 agent 侧只**写文件**，不等人；人下次跑 `ow review` 时才处理。
 *
 * 哪些进队列？只有**不可回滚**的动作。其余默认放行：
 *
 * | 事项 | 有副作用 | 处置 |
 * |---|---|---|
 * | 门禁拒绝 | 无 | 静默进 `_staging/rejected/` |
 * | 技能推送覆盖线上 | **有，不可回滚** | **必须确认** |
 * | 技能拉取冲突 | 无（本地留副本） | 进队列 |
 * | 首次推技能后未启用 | 无 | 进队列，提示去平台点 |
 * | 预算超限 | 无 | 通知一次 |
 *
 * 队列里的条目**去重**：同一 `<kind>+<target>` 只留最新一条，避免每天刷屏。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 事项类型。新增类型要同时加进 `KIND_LABELS`，否则 UI 显示原始 key。 */
export type PendingKind =
  | "skill-overwrite"      // 推技能会覆盖线上（不可回滚）
  | "skill-conflict"       // 拉技能时本地与平台都改了
  | "skill-pending-enable" // 推上去了但平台未启用
  | "doc-conflict"         // 发布时平台侧已被别人改过
  | "budget-exhausted"     // 预算耗尽
  | "gate-rejected";       // 门禁拒绝（通常静默，聚合后提示）

export type Severity = "high" | "normal" | "low";

export interface PendingItem {
  kind: PendingKind;
  created_at: string;
  severity: Severity;
  title: string;
  /** 供 UI 展示的结构化细节 */
  detail: Record<string, unknown>;
  /** 怎么处理；`reversible: false` 的才必须问人 */
  action: {
    /** 建议执行的命令（`ow review` 里按 [a] 就跑它） */
    cli?: string;
    reversible: boolean;
    /** 应用后会发生什么，一句话 */
    effect?: string;
  };
}

/** 带文件路径的条目（内部用） */
export interface PendingEntry extends PendingItem {
  /** 队列文件绝对路径 */
  file: string;
}

const KIND_LABELS: Record<PendingKind, string> = {
  "skill-overwrite": "技能推送会覆盖线上",
  "skill-conflict": "技能本地与平台都改过",
  "skill-pending-enable": "技能已推但平台未启用",
  "doc-conflict": "文档平台侧已被改过",
  "budget-exhausted": "编译预算已耗尽",
  "gate-rejected": "有页面未过门禁",
};

export function kindLabel(kind: PendingKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function pendingDir(vaultDir: string): string {
  return join(vaultDir, ".ow", "pending");
}

/** 条目的去重键：同 kind + 同目标视为同一件事 */
export function dedupeKey(item: PendingItem): string {
  const target =
    (item.detail.skill as string) ??
    (item.detail.path as string) ??
    (item.detail.doc_id as string) ??
    (item.detail.target as string) ??
    "";
  return `${item.kind}::${target}`;
}

/** 读全部条目，按 severity 再按时间排序（high 在前，新的在前） */
export function listPending(vaultDir: string): PendingEntry[] {
  const dir = pendingDir(vaultDir);
  if (!existsSync(dir)) return [];

  const out: PendingEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const item = JSON.parse(readFileSync(file, "utf8")) as PendingItem;
      if (!item || typeof item.kind !== "string") continue;
      out.push({ ...item, file });
    } catch {
      // 坏文件挪走，别一直碍事
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* 挪不动就忽略 */
      }
    }
  }

  const rank: Record<Severity, number> = { high: 0, normal: 1, low: 2 };
  return out.sort((a, b) => {
    const s = (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1);
    if (s !== 0) return s;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

/**
 * 文件名：时间戳 + kind + 唯一后缀（可读且天然有序）。
 *
 * **唯一后缀不能省**：只按「毫秒时间戳 + kind」命名时，同一毫秒创建的同类条目
 * 会得到同一个文件名，后写的把先写的**静默覆盖**——队列看着有两条，实际只剩一条。
 * 实测批量入队时必然触发。
 */
function fileNameFor(item: PendingItem): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeKind = item.kind.replace(/[^a-z-]/g, "");
  const uniq = Math.random().toString(36).slice(2, 8);
  return `${ts}-${safeKind}-${uniq}.json`;
}

/**
 * 入队。同 `dedupeKey` 的旧条目会被**删除**（不是保留两条），
 * 这样反复触发不会把队列堆满。
 */
export function addPending(vaultDir: string, item: PendingItem): string {
  const dir = pendingDir(vaultDir);
  mkdirSync(dir, { recursive: true });

  const key = dedupeKey(item);
  for (const old of listPending(vaultDir)) {
    if (dedupeKey(old) !== key) continue;
    try {
      unlinkSync(old.file);
    } catch {
      /* 删不掉就算了 */
    }
  }

  const file = join(dir, fileNameFor(item));
  writeFileSync(file, JSON.stringify(item, null, 2), "utf8");
  return file;
}

/** 移除一条（处理完或用户选跳过） */
export function removePending(entry: PendingEntry): void {
  try {
    unlinkSync(entry.file);
  } catch {
    /* 已不存在 */
  }
}

/** 待确认条数（`ow status` 用） */
export function countPending(vaultDir: string): number {
  return listPending(vaultDir).length;
}

/** 只取需要人决策的（不可回滚） */
export function requiresDecision(vaultDir: string): PendingEntry[] {
  return listPending(vaultDir).filter((e) => e.action?.reversible === false);
}

/** 按 kind 统计 */
export function pendingByKind(vaultDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of listPending(vaultDir)) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

// ---------------- 策略：`[x] 以后不再问` ----------------

export interface ReviewPolicy {
  schema: 1;
  /** 已放行的 dedupeKey 集合（kind::target） */
  allow: string[];
  /** 已放行的 kind 集合（整个类型都不再问） */
  allowKinds: string[];
}

export function policyPath(vaultDir: string): string {
  return join(vaultDir, ".ow", "policy.json");
}

export function readPolicy(vaultDir: string): ReviewPolicy {
  const p = policyPath(vaultDir);
  if (!existsSync(p)) return { schema: 1, allow: [], allowKinds: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ReviewPolicy>;
    return { schema: 1, allow: raw.allow ?? [], allowKinds: raw.allowKinds ?? [] };
  } catch {
    return { schema: 1, allow: [], allowKinds: [] };
  }
}

export function writePolicy(vaultDir: string, p: ReviewPolicy): void {
  mkdirSync(join(vaultDir, ".ow"), { recursive: true });
  writeFileSync(policyPath(vaultDir), JSON.stringify(p, null, 2), "utf8");
}

/** 该条目是否已被策略放行 */
export function isAllowed(vaultDir: string, item: PendingItem, policy?: ReviewPolicy): boolean {
  const p = policy ?? readPolicy(vaultDir);
  if (p.allowKinds.includes(item.kind)) return true;
  return p.allow.includes(dedupeKey(item));
}

/**
 * `[x] 以后不再问`。
 *
 * `scope: "kind"` 表示整个类型都不再问（更激进，UI 要明说）；
 * 默认只放行这一条（同 kind + 同目标）。
 */
export function allowItem(vaultDir: string, item: PendingItem, scope: "item" | "kind" = "item"): void {
  const p = readPolicy(vaultDir);
  if (scope === "kind") {
    if (!p.allowKinds.includes(item.kind)) p.allowKinds.push(item.kind);
  } else {
    const k = dedupeKey(item);
    if (!p.allow.includes(k)) p.allow.push(k);
  }
  writePolicy(vaultDir, p);
}

/** `ow review --reset`：清空所有放行规则 */
export function resetPolicy(vaultDir: string): void {
  writePolicy(vaultDir, { schema: 1, allow: [], allowKinds: [] });
}

// ---------------- 7 天升级 ----------------

export const ESCALATE_AFTER_DAYS = 7;

/**
 * 超过 N 天没处理的条目。
 *
 * 为什么要升级：`pending` 里躺着不动的东西等于没人知道。7 天后
 * `ow status` 会把它顶到显眼位置，前门技能播报时也会带上。
 */
export function stalePending(vaultDir: string, days = ESCALATE_AFTER_DAYS): PendingEntry[] {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return listPending(vaultDir).filter((e) => {
    const t = Date.parse(e.created_at);
    return Number.isFinite(t) && t < cutoff;
  });
}

/** 队列摘要（给 `ow status` 与前门技能用的一句话） */
export function pendingSummary(vaultDir: string): string {
  const all = listPending(vaultDir);
  if (all.length === 0) return "没有待确认事项";
  const need = all.filter((e) => e.action?.reversible === false).length;
  const stale = stalePending(vaultDir).length;
  const parts = [`${all.length} 项待确认`];
  if (need > 0) parts.push(`其中 ${need} 项需人决策`);
  if (stale > 0) parts.push(`${stale} 项已超 7 天`);
  return parts.join("，");
}
