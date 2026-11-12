/**
 * drop 账：把"看了但没抽"记进 knowledge/extract-drops.jsonl。
 *
 * 为什么必须有（design/ONE_STAGE_EXTRACT.md §4.3、§十一）：
 * 旧两段式只记录抽出了什么，漏检完全是盲区——覆盖率 100% 只能证明"每条都被看过"，
 * 证明不了"看过的都被正确判断过"。drop 账让漏检可见、可抽样复核、可按判定轴统计。
 *
 * 粒度：按价值候选记（一次判断一条），不按每条消息记（输出成本高、噪音大）。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { kbDir } from "./atom-store.ts";
import type { OneStageDrop } from "./one-stage.ts";

export interface DropRecord {
  ts: string;
  session_id: string;
  batch: number;
  msg_ids: string[];
  reason: string;
  axis: string;
  /** 本批是否声明"整批无价值" */
  no_value: boolean;
  /** 本批同时产出的卡片数（用于算出卡率） */
  cards: number;
}

export function dropLogPath(): string {
  return join(kbDir(), "extract-drops.jsonl");
}

/** 追加一批 drop 记录；写失败只吞掉不阻塞主流程（与 runs.jsonl 同一策略） */
export function appendDrops(
  sessionId: string,
  batch: number,
  drops: OneStageDrop[],
  info: { noValue: boolean; cards: number },
): number {
  const ts = new Date().toISOString();
  const rows: DropRecord[] = drops.map((d) => ({
    ts,
    session_id: sessionId,
    batch,
    msg_ids: d.msg_ids,
    reason: d.reason,
    axis: d.axis ?? "—",
    no_value: info.noValue,
    cards: info.cards,
  }));
  // 整批无价值也要留一行，否则"跑了但什么都没发生"和"根本没跑"分不开
  if (rows.length === 0 && info.noValue) {
    rows.push({
      ts,
      session_id: sessionId,
      batch,
      msg_ids: [],
      reason: "整批无价值",
      axis: "—",
      no_value: true,
      cards: 0,
    });
  }
  if (rows.length === 0) return 0;
  try {
    mkdirSync(kbDir(), { recursive: true });
    appendFileSync(dropLogPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    return 0;
  }
  return rows.length;
}

export function readDrops(): DropRecord[] {
  const p = dropLogPath();
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as DropRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is DropRecord => !!r);
  } catch {
    return [];
  }
}

/** 按理由聚合（校准工具与验收 §七#1 用：漏检是否集中在某一类） */
export function dropStats(rows: DropRecord[]): { total: number; byReason: Record<string, number>; byAxis: Record<string, number> } {
  const byReason: Record<string, number> = {};
  const byAxis: Record<string, number> = {};
  for (const r of rows) {
    const k = r.reason || "(空)";
    byReason[k] = (byReason[k] ?? 0) + 1;
    const a = r.axis || "—";
    byAxis[a] = (byAxis[a] ?? 0) + 1;
  }
  return { total: rows.length, byReason, byAxis };
}

// ---------- 被拒卡片留档 ----------
// 准入/校验拒掉的卡片以前只计数、内容直接丢弃，导致"闸门是不是误杀"无法事后判断
// （实测出现过一批 4 张卡全被拒，只留下 4 个计数）。留档到 extract-rejected.jsonl。

export interface RejectedRecord {
  ts: string;
  session_id: string;
  batch: number;
  /** 拒绝原因（准入 reasons 或 validate 错误，分号连接） */
  reason: string;
  /** 哪一道拦的：admission | validate | build */
  stage: "admission" | "validate" | "build";
  doc_type: string;
  domain: string;
  value: string | null;
  grounding: string | null;
  content: string;
  quote: string;
  msg_ids: string[];
}

export function rejectedLogPath(): string {
  return join(kbDir(), "extract-rejected.jsonl");
}

export function appendRejected(sessionId: string, batch: number, rec: Omit<RejectedRecord, "ts" | "session_id" | "batch">): void {
  try {
    mkdirSync(kbDir(), { recursive: true });
    appendFileSync(rejectedLogPath(), JSON.stringify({
      ts: new Date().toISOString(), session_id: sessionId, batch, ...rec,
    }) + "\n");
  } catch {
    // 留档失败不影响主流程
  }
}

export function readRejected(): RejectedRecord[] {
  try {
    if (!existsSync(rejectedLogPath())) return [];
    return readFileSync(rejectedLogPath(), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as RejectedRecord; } catch { return null; } })
      .filter((x): x is RejectedRecord => !!x);
  } catch {
    return [];
  }
}
