/**
 * skill-state：原子的"已进 skill"账本（方案 1 无锁并发的幂等基石）。
 *
 * 知识不会丢的保证：applier 把"写 skill 文件"和"标记原子已整合"绑在同一事务里
 *（state 文件原子写，见 apply-patches.ts）。任何失败路径最坏结果是重做，不是丢知识。
 *
 * 并发语义：state 写入用 tmp+rename 原子替换；两个 applier 并发时后者可能覆盖前者的标记
 * → 丢标记 ≠ 丢知识，原子回 pending 下轮重做（幂等），最终一致。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbDir, loadAtoms, type KnowledgeAtom } from "./atom-store.ts";
import { usageSummary } from "./usage-store.ts";

export interface SkillState {
  /** 已整合进 skill 的 atom_id */
  integrated: string[];
  /** 已应用的 patch_id → 时间（防重放） */
  appliedPatches: Record<string, string>;
  /** 各 skill 自上次 darwin 体检以来的增量修改次数（触发体检用） */
  domainEdits: Record<string, number>;
  /** 各 skill 上次 darwin 体检时间 */
  lastDarwinCheck: Record<string, string>;
  updated_at?: string;
}

export function statePath(): string {
  return join(kbDir(), "skill-state.json");
}

export function loadSkillState(): SkillState {
  if (!existsSync(statePath())) return emptyState();
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<SkillState>;
    // 形状防御：外手写/旧版本可能把对象字段写成数组（JSON 序列化后键会静默丢失）
    const asRecord = (v: unknown): Record<string, string> =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
    return {
      integrated: Array.isArray(s.integrated) ? s.integrated : [],
      appliedPatches: asRecord(s.appliedPatches),
      domainEdits: asRecord(s.domainEdits),
      lastDarwinCheck: asRecord(s.lastDarwinCheck),
    };
  } catch {
    return emptyState(); // 损坏视为空账本 → 全部重做，安全方向
  }
}
const emptyState = (): SkillState => ({ integrated: [], appliedPatches: {}, domainEdits: {}, lastDarwinCheck: {} });

/** 原子写：tmp + rename（读方永远看到完整文件） */
export function saveSkillState(state: SkillState): void {
  mkdirSync(kbDir(), { recursive: true });
  state.updated_at = new Date().toISOString();
  const tmp = statePath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath());
}

export function markIntegrated(atomIds: string[]): SkillState {
  const st = loadSkillState();
  const set = new Set(st.integrated);
  for (const id of atomIds) set.add(id);
  st.integrated = [...set];
  saveSkillState(st);
  return st;
}

/** 待整合原子 = 池中未标记的（agent 增量整合的待办队列，就是原子本身） */
export function pendingAtoms(): KnowledgeAtom[] {
  const integrated = new Set(loadSkillState().integrated);
  return loadAtoms().filter((a) => !integrated.has(a.atom_id));
}

/** darwin 体检触发阈值（某 skill 增量修改达到该次数建议体检） */
export function darwinThreshold(): number {
  return Number(process.env.AUTOSKILL_DARWIN_THRESHOLD ?? 10);
}

/** 使用次数触发阈值（loaded ≥ 此值建议体检；env 可调） */
export function darwinUseThreshold(): number {
  return Number(process.env.AUTOSKILL_DARWIN_USE_THRESHOLD ?? 5);
}

/** 劣化检测反馈样本下限（accepted+rejected 达此值才计算拒绝率，防小样本误报） */
const REJECT_RATE_MIN_SAMPLES = 5;

export interface DarwinDueItem {
  domain: string;
  edits: number;
  lastCheck: string | undefined;
  /** 命中的触发轨（多轨命中用空格连接） */
  trigger: string;
}

/**
 * 双轨体检触发：
 *   原轨 edits  — 增量修改达阈值（改动多了需要体检）
 *   使用轨 loaded — 加载次数达阈值（用得多就该检查质量）
 *   劣化轨 reject — 反馈样本≥下限且拒绝率>50%（早发现劣化，比修改计数更敏感）
 */
export function darwinDue(): DarwinDueItem[] {
  const st = loadSkillState();
  const th = darwinThreshold();
  const useTh = darwinUseThreshold();
  const due = new Map<string, DarwinDueItem>();
  // 原轨：修改次数
  for (const [domain, edits] of Object.entries(st.domainEdits)) {
    if (edits >= th) {
      due.set(domain, { domain, edits, lastCheck: st.lastDarwinCheck[domain], trigger: "edits" });
    }
  }
  // 新轨：使用/劣化（usage 日志里 accepted/rejected/loaded 达标的都纳入）
  for (const [domain, u] of usageSummary()) {
    const item = due.get(domain) ?? { domain, edits: st.domainEdits[domain] ?? 0, lastCheck: st.lastDarwinCheck[domain], trigger: "" };
    const triggers: string[] = item.trigger ? item.trigger.split(" ") : [];
    if (u.loaded >= useTh && !triggers.includes("loaded")) triggers.push("loaded");
    const feedback = u.accepted + u.rejected;
    if (feedback >= REJECT_RATE_MIN_SAMPLES && u.rejected / feedback > 0.5 && !triggers.includes("reject")) {
      triggers.push("reject");
    }
    item.trigger = triggers.join(" ");
    if (item.trigger) due.set(domain, item);
  }
  return [...due.values()];
}

/** 体检完成：记录时间、清零计数（agent 跑完 darwin 流程后调） */
export function darwinCheckDone(domain: string): void {
  const st = loadSkillState();
  st.lastDarwinCheck[domain] = new Date().toISOString();
  st.domainEdits[domain] = 0;
  saveSkillState(st);
}
export function pendingSummary(): { total: number; byDomain: Record<string, number>; byStatus: Record<string, number> } {
  const pend = pendingAtoms();
  const byDomain: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const a of pend) {
    const d = a.domain || "general";
    byDomain[d] = (byDomain[d] ?? 0) + 1;
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  }
  return { total: pend.length, byDomain, byStatus };
}
