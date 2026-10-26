/**
 * skill 使用账本：knowledge/usage.jsonl（追加日志，分析层只读）。
 *
 * 四类事件：
 *   loaded    — 模型读取了某 skill 的 SKILL.md（extension tool_call hook 实时记录，下界估计）
 *   edited    — agent 提案应用成功（apply-patches 落内容后追加）
 *   accepted  — 会话回扫判定：加载后 user/assistant 遵循了 skill 指引
 *   rejected  — 会话回扫判定：修正/推翻了 skill 指引
 *
 * 语义约定：
 *   - 纯日志：append 失败不影响主流程；允许极小概率重复行（不做原子替换）
 *   - 幂等键：window_id+skill+event 组合已存在则跳过（loaded/accepted/rejected 带 window_id；
 *     edited 无窗口概念，靠 appliedPatches 账本防重，这里不查重）
 *   - 与 skill-state.json 解耦：state 是"整合事务"的事实源，本文件只做使用分析
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kbDir } from "./atom-store.ts";

export type UsageEventType = "loaded" | "accepted" | "rejected" | "edited";

export interface UsageEvent {
  ts: string;
  session: string; // session 文件 basename 或短 id（loaded 实时记录时可能未知→"live"）
  window_id?: string; // 回扫判定时携带（幂等去重键的一半）
  skill: string; // domain 名（路径 skills/<domain>/SKILL.md 提取）
  event: UsageEventType;
  evidence?: string; // ≤200 字判据原文（accepted/rejected）/ 命中的工具名（loaded）
}

export function usagePath(): string {
  return join(kbDir(), "usage.jsonl");
}

/** 追加事件（append-and-forget：失败静默，绝不向上抛） */
export function appendUsage(events: UsageEvent[]): void {
  try {
    mkdirSync(kbDir(), { recursive: true });
    const lines = events
      .map((e) => JSON.stringify({ ...e, evidence: e.evidence?.slice(0, 200) }))
      .join("\n");
    if (lines) appendFileSync(usagePath(), lines + "\n");
  } catch {
    // 日志语义：写失败不影响主流程
  }
}

/** 已存在的幂等键集合：`${window_id}|${skill}|${event}`（edited 无 window_id，不参与） */
export function existingUsageKeys(): Set<string> {
  if (!existsSync(usagePath())) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(usagePath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as UsageEvent;
      if (e.window_id) keys.add(`${e.window_id}|${e.skill}|${e.event}`);
    } catch {
      // 损坏行跳过
    }
  }
  return keys;
}

export interface SkillUsage {
  loaded: number;
  accepted: number;
  rejected: number;
  edited: number;
}

/** 按 skill 汇总（edited 计数与 state.domainEdits 口径可能略有出入——日志有极小概率重行） */
export function usageSummary(): Map<string, SkillUsage> {
  const map = new Map<string, SkillUsage>();
  if (!existsSync(usagePath())) return map;
  for (const line of readFileSync(usagePath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: UsageEvent;
    try {
      e = JSON.parse(line) as UsageEvent;
    } catch {
      continue;
    }
    if (!e.skill || !e.event) continue;
    const u = map.get(e.skill) ?? { loaded: 0, accepted: 0, rejected: 0, edited: 0 };
    u[e.event]++;
    map.set(e.skill, u);
  }
  return map;
}
