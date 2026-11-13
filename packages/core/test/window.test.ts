/** 窗口切分与信号门 */
import { ok, eq, section, summary } from "./_harness.ts";
import { buildWindowPayload, renderWindowText, hashWindow, MAX_WINDOW_CHARS } from "../lib/trigger/window.ts";
import { evaluateSignal } from "../lib/trigger/signal.ts";
import type { Turn } from "../lib/trigger/turns.ts";

const turn = (i: number, from: number, to: number): Turn => ({
  index: i, fromSeq: from, toSeq: to, userSeq: from, endedAt: new Date().toISOString(),
});

const entry = (seq: number, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  seq,
  type: "message",
  id: `m${seq}`,
  parentId: null,
  timestamp: "",
  message: { role, content: [{ type: "text", text }], ...extra },
}) as never;

section("窗口基本切分");
{
  const entries = [
    entry(1, "user", "问题一"),
    entry(2, "assistant", "答一"),
    entry(3, "user", "问题二"),
    entry(4, "assistant", "答二"),
  ];
  const w = buildWindowPayload({
    agent: "dsh", sessionId: "s1", cwd: "/p",
    entries, turns: [turn(1, 1, 2), turn(2, 3, 4)],
  });
  eq(w.messages.length, 4, "四段消息全收");
  eq(w.from_turn, 1, "起始轮");
  eq(w.to_turn, 2, "结束轮");
  eq(w.from_seq, 1, "起始 seq");
  eq(w.to_seq, 4, "结束 seq");
  ok(w.hash.startsWith("sha256:"), "带哈希");
}

section("工具结果截断");
{
  const long = "x".repeat(5000);
  const entries = [entry(1, "user", "跑命令"), entry(2, "toolResult", long, { toolName: "bash" })];
  const w = buildWindowPayload({
    agent: "dsh", sessionId: "s", cwd: "/", entries, turns: [turn(1, 1, 2)],
  });
  const tool = w.messages.find((m) => m.role === "tool");
  eq(tool?.text.length, 2000, "工具结果截到 2000 字符");
  eq(tool?.truncated, 5000, "记录原长度");
  eq(tool?.name, "bash", "保留工具名");
}

section("assistant 只留文本块（丢 thinking）");
{
  const e = {
    seq: 1, type: "message", id: "m1", parentId: null, timestamp: "",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "内部推理不该进窗口" },
        { type: "text", text: "对外结论" },
      ],
    },
  } as never;
  const w = buildWindowPayload({ agent: "pi", sessionId: "s", cwd: "/", entries: [e], turns: [turn(1, 1, 1)] });
  ok(!w.messages[0].text.includes("内部推理"), "thinking 被丢弃");
  ok(w.messages[0].text.includes("对外结论"), "text 保留");
}

section("哈希稳定：时间戳不影响");
{
  const mk = (t: string) => ({
    agent: "dsh" as const, sessionId: "s", cwd: "/",
    entries: [entry(1, "user", "同一内容")],
    turns: [{ index: 1, fromSeq: 1, toSeq: 1, userSeq: 1, endedAt: t }],
  });
  const a = buildWindowPayload(mk("2020-01-01T00:00:00Z"));
  const b = buildWindowPayload(mk("2025-12-31T23:59:59Z"));
  eq(a.hash, b.hash, "同样内容不同时间 → 同哈希");
  eq(hashWindow(a), a.hash, "重新计算一致");
}

section("预算裁剪：保住用户消息");
{
  const entries: Array<ReturnType<typeof entry>> = [];
  let seq = 1;
  for (let i = 0; i < 40; i++) {
    entries.push(entry(seq++, "user", `用户问题 ${i} ${"细节".repeat(50)}`));
    entries.push(entry(seq++, "toolResult", "y".repeat(4000), { toolName: "bash" }));
  }
  const turns = Array.from({ length: 40 }, (_, i) => turn(i + 1, i * 2 + 1, i * 2 + 2));
  const w = buildWindowPayload({ agent: "dsh", sessionId: "s", cwd: "/", entries, turns, maxChars: 50_000 });
  const total = w.messages.reduce((n, m) => n + m.text.length, 0);
  ok(total <= 50_000, `裁剪后总长 ${total} ≤ 50000`);
  eq(w.messages.filter((m) => m.role === "user").length, 40, "40 条用户消息全保住");
}

section("渲染成文本");
{
  const w = buildWindowPayload({
    agent: "dsh", sessionId: "s", cwd: "/",
    entries: [entry(1, "user", "问题"), entry(2, "toolResult", "输出", { toolName: "bash" })],
    turns: [turn(1, 1, 2)],
  });
  const text = renderWindowText(w);
  ok(text.includes("### [1] user"), "用户段带 seq 与角色");
  ok(text.includes("### [2] tool:bash"), "工具段带工具名");
}

section("信号门");
{
  const mk = (msgs: Array<[string, string, Record<string, unknown>?]>) => {
    const entries = msgs.map(([role, text, extra], i) => entry(i + 1, role, text, extra));
    return buildWindowPayload({
      agent: "dsh", sessionId: "s", cwd: "/", entries,
      turns: [turn(1, 1, msgs.length)],
    });
  };

  // 有工具动作 → 保留
  ok(evaluateSignal(mk([["user", "跑一下测试"], ["toolResult", "ok", { toolName: "bash" }], ["assistant", "过了"]])).keep,
    "有工具动作 → 保留");

  // 纯闲聊 → 剔除
  const chatter = evaluateSignal(mk([["user", "好"], ["assistant", "好的"]]));
  ok(!chatter.keep && chatter.reason === "short-chatter", "短应答 → 剔除");

  // 无助手输出 → 剔除
  ok(!evaluateSignal(mk([["user", "这是一段足够长的用户输入，但没有助手回复"]])).keep, "无助手输出 → 剔除");

  // 实质讨论 → 保留
  ok(evaluateSignal(mk([
    ["user", "我想搞清楚这个架构为什么要分三层，各层的职责边界该怎么划，以及层与层之间的数据怎么流动"],
    ["assistant", "因为原始层要保留现场，知识层要可改，规则层要稳定。数据从上往下单向流动。"],
  ])).keep, "实质讨论 → 保留");

  // 纯检索 → 剔除
  const lookup = evaluateSignal(mk([
    ["user", "帮我查一下有哪些可用的技能，列一下名字就行，谢谢"],
    ["assistant", "有六个技能：a、b、c、d、e、f。"],
  ]));
  ok(!lookup.keep, "纯检索 → 剔除");
  eq(lookup.reason, "pure-lookup", "原因是 pure-lookup");
}

process.exit(summary());
