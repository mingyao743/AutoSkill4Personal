/** 触发编排：dsh 满窗但未空闲时不编译 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { maybeCompile } from "../lib/trigger/cycle.ts";
import { initVault } from "../lib/vault/init.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-cycle-"));

function makeEvents(turns: number, endedAt: number): { events: Array<Record<string, unknown>>; entries: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const entries: Array<Record<string, unknown>> = [];
  let seq = 1;
  for (let t = 1; t <= turns; t++) {
    events.push({ type: "turn/start", seq: seq++, data: { turn: t } });
    events.push({ type: "user/message", seq: seq++, data: { role: "user", source: { kind: "user" }, id: `u${t}`, content: [{ type: "text", text: `第 ${t} 轮：帮我修复 cannot find module 报错，依赖没装` }] } });
    entries.push({ type: "message", id: `u${t}`, parentId: null, timestamp: "", message: { role: "user", content: [{ type: "text", text: `第 ${t} 轮：帮我修复 cannot find module 报错，依赖没装` }] }, seq: seq - 1 });
    events.push({ type: "tool/call", seq: seq++, data: { callId: `c${t}`, name: "bash", input: { command: "npm test" } } });
    events.push({ type: "tool/result", seq: seq++, data: { callId: `c${t}`, message: { toolCallId: `c${t}`, role: "tool", content: [{ type: "text", text: "Error: cannot find module foo" }] } } });
    const aSeq = seq;
    events.push({ type: "assistant/message", seq: seq++, data: { message: { role: "assistant", id: `a${t}`, content: [{ type: "text", text: `原因是依赖没装，跑 npm i foo 即可。第 ${t} 次验证。` }] } } });
    entries.push({ type: "message", id: `a${t}`, parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "text", text: `原因是依赖没装，跑 npm i foo 即可。第 ${t} 次验证。` }] }, seq: aSeq });
    events.push({ type: "turn/end", seq: seq++, time: endedAt, data: { turn: t, reason: { kind: "completed" } } });
  }
  return { events, entries };
}

section("dsh 满 30 轮但刚结束 → not-idle");
{
  const root = tmp();
  const vault = initVault(root);
  const { events, entries } = makeEvents(30, Date.now());
  const r = await maybeCompile({
    agent: "dsh", sessionId: "s1", events, entries: entries as never,
    cwd: root, skillDir: "/x", turns: 30,
  });
  eq(r.status, "not-idle", "未空闲不编译");
  rmSync(root, { recursive: true, force: true });
}

section("turn/end 没有时间戳 → 按可编译处理（避免永久重试）");
{
  const root = tmp();
  const vault = initVault(root);
  const machine = join(root, "machine");
  mkdirSync(machine, { recursive: true });
  writeFileSync(join(machine, "machine.json"), JSON.stringify({
    schema: 1,
    budget: { date: new Date().toISOString().slice(0, 10), compiles: 50, input_tokens: 0, output_tokens: 0, by_vault: {} },
  }), "utf8");
  const old = process.env.QDOC_MACHINE_DIR;
  process.env.QDOC_MACHINE_DIR = machine;
  try {
    const { events, entries } = makeEvents(30, NaN);
    // NaN 会让 JSON 时间字段缺失；直接删掉 time
    for (const e of events) if (e.type === "turn/end") delete e.time;
    const r = await maybeCompile({
      agent: "dsh", sessionId: "s2", events, entries: entries as never,
      cwd: root, skillDir: "/x", turns: 30,
    });
    // 没有时间戳时会继续往下走；预算被故意耗尽，用来证明 idle 闸已通过
    eq(r.status, "budget-exhausted", "不应卡在 not-idle");
  } finally {
    if (old === undefined) delete process.env.QDOC_MACHINE_DIR;
    else process.env.QDOC_MACHINE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(summary());
