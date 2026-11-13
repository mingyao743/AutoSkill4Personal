/** 轮次判定：两个实测陷阱的回归测试 */
import { ok, eq, section, summary } from "./_harness.ts";
import { indexTurns, takeWindow, remainingTurns, windowEndTurn } from "../lib/trigger/turns.ts";

type Ev = Record<string, unknown>;

/** 造一个 dsh 会话：每轮 1 条真用户消息 + 2 条注入消息 */
function dshSession(turns: number, opts: { abortedTurns?: number[] } = {}): Ev[] {
  const ev: Ev[] = [];
  let seq = 1;
  for (let t = 1; t <= turns; t++) {
    const aborted = opts.abortedTurns?.includes(t) ?? false;
    ev.push({ type: "turn/start", seq: seq++, data: { turn: t } });
    ev.push({ type: "user/message", seq: seq++, data: { role: "user", source: { kind: "runtime-context" }, content: [{ type: "text", text: "runtime" }] } });
    ev.push({ type: "user/message", seq: seq++, data: { role: "user", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "skills" }] } });
    ev.push({ type: "user/message", seq: seq++, data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: `真问题 ${t}` }] } });
    if (!aborted) {
      ev.push({ type: "assistant/message", seq: seq++, data: { message: { role: "assistant", content: [{ type: "text", text: `答 ${t}` }] } } });
    }
    ev.push({ type: "turn/end", seq: seq++, data: { turn: t, reason: { kind: aborted ? "aborted" : "completed" } } });
  }
  return ev;
}

section("陷阱 1：dsh 注入消息被当成用户轮");
{
  const ev = dshSession(6);
  const idx = indexTurns(ev, "s", "dsh");
  const userMsgs = ev.filter((e) => e.type === "user/message").length;
  eq(userMsgs, 18, "原始 user/message 共 18 条（6 真 + 12 注入）");
  eq(idx.turns.length, 6, "按 source.kind 过滤后 = 6 轮（旧实现会数成 18）");
}

section("陷阱 2：空轮（aborted 且无动作）要剔除");
{
  const ev = dshSession(4, { abortedTurns: [2, 4] });
  const idx = indexTurns(ev, "s", "dsh");
  eq(idx.turns.length, 2, "4 轮里 2 轮空 → 只计 2 轮");
  eq(idx.turns.map((t) => t.index), [1, 2], "序号重排为 1,2");
}

section("aborted 但有工具动作 → 仍计入");
{
  const ev: Ev[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "跑测试" }] } },
    { type: "tool/call", seq: 3, data: { callId: "c1", name: "bash" } },
    { type: "tool/result", seq: 4, data: { callId: "c1", message: { toolCallId: "c1", content: [{ type: "text", text: "ok" }] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "aborted" } } },
  ];
  eq(indexTurns(ev, "s", "dsh").turns.length, 1, "有 tool/call → 不算空轮");
}

section("没有真用户输入的 turn 不计");
{
  const ev: Ev[] = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { role: "user", source: { kind: "system" }, content: [{ type: "text", text: "x" }] } },
    { type: "assistant/message", seq: 3, data: { message: { role: "assistant", content: [{ type: "text", text: "y" }] } } },
    { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  eq(indexTurns(ev, "s", "dsh").turns.length, 0, "只有注入消息的轮不计");
}

section("窗口切分：不足 N 轮返回空");
{
  const idx = indexTurns(dshSession(10), "s", "dsh");
  eq(takeWindow(idx, 0, 30).length, 0, "10 轮 < 30 → 空窗");
  eq(takeWindow(idx, 0, 10).length, 10, "10 轮 = 10 → 整窗");
  eq(windowEndTurn(takeWindow(idx, 0, 10)), 10, "水位 = 第 10 轮");
  eq(remainingTurns(idx, 0), 10, "剩余 10 轮");
  eq(takeWindow(idx, 5, 5).length, 5, "从第 5 轮之后取 5 轮");
}

section("pi 轮次：按 message.role === user");
{
  const ev: Ev[] = [
    { type: "message", seq: 1, message: { role: "user", content: [{ type: "text", text: "a" }] } },
    { type: "message", seq: 2, message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    { type: "message", seq: 3, message: { role: "user", content: [{ type: "text", text: "c" }] } },
    { type: "message", seq: 4, message: { role: "assistant", content: [{ type: "text", text: "d" }] } },
  ];
  const idx = indexTurns(ev, "p", "pi");
  eq(idx.turns.length, 2, "pi 数出 2 轮");
  eq(idx.turns[0].toSeq, 2, "第一轮止于 assistant 消息");
}


section("error 轮：无产出不计（凭据缺失场景）");
{
  // 实测形状：turn/end reason 是 error + MISSING_CREDENTIAL，轮内只有用户消息
  const ev: Ev[] = [
    { seq: 1, type: "turn/start", data: {} },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: "hi" } },
    { seq: 3, type: "turn/end", data: { reason: { kind: "error", error: { code: "MISSING_CREDENTIAL" } } } },
  ];
  eq(indexTurns(ev, "s", "dsh").turns.length, 0, "凭据缺失的空轮不计入");
}

section("error 轮：有产出仍计（中途失败）");
{
  const ev: Ev[] = [
    { seq: 1, type: "turn/start", data: {} },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: "查一下" } },
    { seq: 3, type: "tool/call", data: { name: "read_file" } },
    { seq: 4, type: "turn/end", data: { reason: { kind: "error", error: { code: "X" } } } },
  ];
  eq(indexTurns(ev, "s", "dsh").turns.length, 1, "有工具调用就算一轮");
}

section("error 轮：有助手消息仍计");
{
  const ev: Ev[] = [
    { seq: 1, type: "turn/start", data: {} },
    { seq: 2, type: "user/message", data: { source: { kind: "user" }, content: "hi" } },
    { seq: 3, type: "assistant/message", data: { content: "部分回答" } },
    { seq: 4, type: "turn/end", data: { reason: { kind: "error" } } },
  ];
  eq(indexTurns(ev, "s", "dsh").turns.length, 1, "有回答就算一轮");
}

process.exit(summary());
