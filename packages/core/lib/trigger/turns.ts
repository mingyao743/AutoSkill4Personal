/**
 * 轮次判定：数「已完成的用户轮次」，给 30 轮闸用。
 *
 * 两个实测陷阱（本机 9 个真实会话验证，见方案 §5.3 / §5.8）：
 *  1. dsh 把 runtime-context / time-context / skill-catalog / agent-instructions /
 *     model-selection 也存成 `user/message`，`role` 全是 "user"。一个 17 条
 *     `user/message` 的会话只有 6 条是真用户输入 → 轮数虚高约 3 倍。
 *     必须按 `data.source.kind === "user"` 过滤。
 *  2. `turn/end` 数量 ≈ 真用户消息数（实测 9/9、5/5、6/6、34/34、26/26），
 *     但空轮要剔：`aborted` 且该 turn 内 0 次 assistant/message、0 次 tool/call。
 *
 * 本模块只做纯计算，不读文件、不碰宿主 ctx。
 */
import type { SessionEntry } from "../base/types.ts";

/** 一轮的边界（按 seq 切片用） */
export interface Turn {
  /** 轮次序号，从 1 开始（该会话内单调递增） */
  index: number;
  /** 该轮起始事件的 seq（含） */
  fromSeq: number;
  /** 该轮结束事件的 seq（含） */
  toSeq: number;
  /** 该轮里真用户输入的首个 seq（dsh 用于定位窗口起点） */
  userSeq?: number;
  /** 结束时间（ISO），用于空闲判定 */
  endedAt?: string;
}

export interface TurnIndex {
  sessionId: string;
  turns: Turn[];
  /** 最后一个 turn/end 的 seq；用于增量水位 */
  lastSeq: number;
}

/** 事件的最小形状（dsh 原始行 / 归一后的 pi 行都吃） */
interface RawEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  message?: { role?: string };
  [k: string]: unknown;
}

const isDshUserMessage = (e: RawEvent): boolean => {
  if (e.type !== "user/message") return false;
  const src = e.data?.source as Record<string, unknown> | undefined;
  // 关键过滤：只认真正的用户输入；缺 source 时保守认为不是（宁可少算）
  return src?.kind === "user";
};

const isPiUserMessage = (e: RawEvent): boolean =>
  e.type === "message" && e.message?.role === "user";

/**
 * 从原始事件流数轮次。
 *
 * dsh：以 `turn/end` 为轮界（`data.turn` 递增），剔空轮。
 * pi ：以 `message.role === "user"` 开轮，下一轮 user 之前算一轮结束。
 *
 * @param events 原始会话事件（已按行序）
 * @param sessionId 会话 id（只写进结果，不参与计算）
 * @param agent 宿主类型；决定用哪套轮次信号
 */
export function indexTurns(
  events: RawEvent[],
  sessionId: string,
  agent: "dsh" | "pi",
): TurnIndex {
  return agent === "dsh"
    ? indexDshTurns(events, sessionId)
    : indexPiTurns(events, sessionId);
}

/** dsh：turn/start → turn/end 配对；turn/end 的 reason 与轮内动作决定是否计入 */
function indexDshTurns(events: RawEvent[], sessionId: string): TurnIndex {
  const turns: Turn[] = [];
  let open: { seq: number; userSeq?: number } | null = null;
  let lastSeq = 0;
  let idx = 0;

  for (const e of events) {
    const seq = typeof e.seq === "number" ? e.seq : 0;
    if (seq > lastSeq) lastSeq = seq;

    if (e.type === "turn/start") {
      open = { seq };
      continue;
    }

    // 记录本 turn 内的真用户消息 seq（窗口起点用）
    if (open && isDshUserMessage(e)) {
      if (open.userSeq == null) open.userSeq = seq;
      continue;
    }

    if (e.type !== "turn/end") continue;

    const fromSeq = open?.seq ?? seq;
    const userSeq = open?.userSeq;
    open = null;

    // 空轮剔除：异常结束（aborted / error）且本 turn 内无 assistant 消息、无 tool/call。
    //
    // 为什么把 error 也算进来：实测模型凭据缺失时 `turn/end` 的 reason 是
    // `{kind:"error", error:{code:"MISSING_CREDENTIAL"}}`，这一轮里只有用户消息、
    // 没有任何产出。算进轮数会让水位虚涨——用户重试时才发现「明明没聊几句
    // 却说已经编译过了」。
    // 但 error 轮也可能已经跑了工具（中途失败），所以判据是「有没有产出」而非 reason。
    const reason = e.data?.reason as Record<string, unknown> | undefined;
    const kind = reason?.kind;
    const abnormal = kind === "aborted" || kind === "error";
    if (abnormal && !hasWorkInRange(events, fromSeq, seq)) continue;

    // 没有真用户输入就结束的 turn（纯系统轮）不计
    if (userSeq == null) continue;

    idx += 1;
    turns.push({
      index: idx,
      fromSeq,
      toSeq: seq,
      userSeq,
      endedAt: typeof e.time === "number" ? new Date(e.time).toISOString() : undefined,
    });
  }
  return { sessionId, turns, lastSeq };
}

/** 轮内是否有实际动作（assistant 消息或工具调用） */
function hasWorkInRange(events: RawEvent[], fromSeq: number, toSeq: number): boolean {
  for (const e of events) {
    const seq = typeof e.seq === "number" ? e.seq : 0;
    if (seq < fromSeq || seq > toSeq) continue;
    if (e.type === "assistant/message" || e.type === "tool/call") return true;
  }
  return false;
}

/**
 * pi：一条 `message.role === "user"` 开一轮，下一条 user 之前的所有内容算本轮。
 * pi 的会话文件是 `id/parentId` 树，调用方需先沿活跃分支线性化（见 adapter-pi）。
 */
function indexPiTurns(events: RawEvent[], sessionId: string): TurnIndex {
  const turns: Turn[] = [];
  let cur: { index: number; fromSeq: number; userSeq?: number; lastSeq: number } | null = null;
  let lastSeq = 0;
  let idx = 0;

  const close = (endedAt?: string): void => {
    if (!cur) return;
    turns.push({
      index: cur.index,
      fromSeq: cur.fromSeq,
      toSeq: cur.lastSeq,
      userSeq: cur.userSeq,
      endedAt,
    });
    cur = null;
  };

  for (const e of events) {
    const seq = typeof e.seq === "number" ? e.seq : 0;
    if (seq > lastSeq) lastSeq = seq;

    if (isPiUserMessage(e)) {
      close();
      idx += 1;
      cur = { index: idx, fromSeq: seq, userSeq: seq, lastSeq: seq };
      continue;
    }
    if (cur) cur.lastSeq = seq;
  }
  close();
  return { sessionId, turns, lastSeq };
}

/**
 * 从 `compiledToTurn` 之后取下一个窗口（最多 n 轮）。
 *
 * @returns 窗口内的轮次切片；不足 n 轮时返回空数组（不编译半窗）
 */
export function takeWindow(
  index: TurnIndex,
  compiledToTurn: number,
  n: number,
): Turn[] {
  const pending = index.turns.filter((t) => t.index > compiledToTurn);
  if (pending.length < n) return [];
  return pending.slice(0, n);
}

/** 水位：窗口最后一轮的 index */
export function windowEndTurn(win: Turn[]): number {
  return win.length ? win[win.length - 1].index : 0;
}

/** 水位：窗口最后一轮的 seq */
export function windowEndSeq(win: Turn[]): number {
  return win.length ? win[win.length - 1].toSeq : 0;
}

/** 剩余未编译轮数（会话结束结算用：≥5 才补跑尾巴） */
export function remainingTurns(index: TurnIndex, compiledToTurn: number): number {
  return index.turns.filter((t) => t.index > compiledToTurn).length;
}
