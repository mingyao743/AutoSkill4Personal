/**
 * 覆盖派生：哪些消息已经被抽过。
 *
 * 不新增状态文件——从 atoms.sources[].msg_range 反推（与 extractedWindowIds 同一思路）。
 * 语义：一条消息只要落在任一知识卡片的溯源区间里，就算"已被看过"；
 *       剩余的才交给触发扫描/终采/抢救，保证每条消息一辈子只被处理一次。
 *
 * 已知边界：
 *  - msg_range 里的 id 不在当前会话 entries 里（如 agent 声明型的 session 级占位）→ 跳过
 *  - 会话 id 形态不统一（pi CLI 用 8 位短 id，compaction 用完整 uuid）→ 按去连字符前缀匹配
 */
import { loadAtoms, type KnowledgeAtom } from "./atom-store.ts";
import { reviewedRanges } from "./review-log.ts";
import type { MessageEntry } from "./types.ts";

export interface CoverageReport {
  total: number;
  covered: number;
  unreviewed: number;
}

/** 会话 id 归一：pi "01a1ae83-57bc…" 与 "01a1ae83" 视为同一会话 */
export function shortSessionId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^session-/, "")
    .replace(/-/g, "")
    .slice(0, 8);
}

export function sameSession(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return shortSessionId(a) === shortSessionId(b);
}

/** 已覆盖的消息 id 集合（只统计指定会话的知识卡片） */
export function coveredIds(
  entries: MessageEntry[],
  sessionId: string,
  atoms: KnowledgeAtom[] = loadAtoms(),
): Set<string> {
  const idx = new Map<string, number>();
  entries.forEach((e, i) => idx.set(e.id, i));

  const covered = new Set<string>();
  for (const atom of atoms) {
    for (const s of atom.sources ?? []) {
      if (!sameSession(s.session_id, sessionId)) continue;
      const range = s.msg_range ?? [];
      const i0 = idx.get(range[0]);
      const i1 = idx.get(range[1]);
      if (i0 == null && i1 == null) continue;
      if (i0 == null || i1 == null) {
        // 只有一端可定位：保守起见只标记这一端
        const only = i0 ?? i1!;
        covered.add(entries[only].id);
        continue;
      }
      const [lo, hi] = i0 <= i1 ? [i0, i1] : [i1, i0];
      for (let i = lo; i <= hi; i++) covered.add(entries[i].id);
    }
  }

  // 已审但没产出知识卡片的区间（丢弃/合并的候选）也要算覆盖，否则会被无限重扫
  for (const [start, end] of reviewedRanges(sessionId)) {
    const i0 = idx.get(start);
    const i1 = idx.get(end);
    if (i0 == null || i1 == null) continue;
    const [lo, hi] = i0 <= i1 ? [i0, i1] : [i1, i0];
    for (let i = lo; i <= hi; i++) covered.add(entries[i].id);
  }
  return covered;
}

/** 未覆盖的消息（保持原顺序）——触发扫描/终采/抢救的输入 */
export function uncoveredEntries(
  entries: MessageEntry[],
  sessionId: string,
  atoms: KnowledgeAtom[] = loadAtoms(),
): MessageEntry[] {
  const covered = coveredIds(entries, sessionId, atoms);
  return entries.filter((e) => !covered.has(e.id));
}

export function coverageReport(
  entries: MessageEntry[],
  sessionId: string,
  atoms: KnowledgeAtom[] = loadAtoms(),
): CoverageReport {
  const covered = coveredIds(entries, sessionId, atoms).size;
  return { total: entries.length, covered, unreviewed: entries.length - covered };
}
