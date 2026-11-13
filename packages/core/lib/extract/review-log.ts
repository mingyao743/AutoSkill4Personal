/**
 * 审阅水位：记录“这段消息已经被发现+抽取处理过”。
 *
 * 为什么不能只靠 atoms.sources 派生覆盖：
 * 触发扫描发现了候选、但抽取阶段判定丢弃（一次性进度/寒暄/凭据）时，不会产生知识卡片，
 * 如果只按知识卡片算覆盖，这些消息每次都会被重新发现 → 无限重扫。
 *
 * 所以“覆盖”= 知识卡片区间 ∪ 审阅区间。只在整批（发现+抽取）成功后推进，
 * 预算中断/失败不推进，下次从断点继续。
 *
 * 存储：<dataDir>/reviewed.jsonl（append-only，一行一个区间）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kbDir } from "../base/atom-store.ts";

export interface ReviewRecord {
  ts: string;
  session_id: string;
  start: string;
  end: string;
  kind: string;
}

export function reviewLogPath(): string {
  return join(kbDir(), "reviewed.jsonl");
}

function norm(id: string): string {
  return id.trim().toLowerCase().replace(/^session-/, "").replace(/-/g, "").slice(0, 8);
}

export function appendReviewed(rec: Omit<ReviewRecord, "ts">): void {
  try {
    mkdirSync(kbDir(), { recursive: true });
    appendFileSync(reviewLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch {
    // 水位写失败不影响主流程，下次最多重扫这一段
  }
}

/** 指定会话的已审区间（按 session id 前缀匹配，兼容 8 位短 id 与完整 uuid） */
export function reviewedRanges(sessionId: string): Array<[string, string]> {
  if (!existsSync(reviewLogPath())) return [];
  const want = norm(sessionId);
  const out: Array<[string, string]> = [];
  for (const line of readFileSync(reviewLogPath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReviewRecord;
      if (!r.session_id || !r.start || !r.end) continue;
      if (norm(r.session_id) !== want) continue;
      out.push([r.start, r.end]);
    } catch {
      // 损坏行跳过
    }
  }
  return out;
}
