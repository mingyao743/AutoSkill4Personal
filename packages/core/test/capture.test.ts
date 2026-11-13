/** 手动捕获：切窗、信号门、排队 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { planWindows, runCapture, queueForHost, describeCredentialSituation } from "../lib/trigger/capture.ts";
import { initVault } from "../lib/vault/init.ts";
import { advanceState, sessionKey } from "../lib/trigger/state.ts";

/** 造一个 dsh 会话文件（N 轮，每轮有工具调用与结论） */
function makeSession(dir: string, turns: number, id = "session-t1"): string {
  const lines: string[] = [];
  let seq = 1;
  lines.push(JSON.stringify({ type: "session", version: 4, id, cwd: "/proj", delegationDepth: 0 }));
  for (let t = 1; t <= turns; t++) {
    lines.push(JSON.stringify({ type: "turn/start", seq: seq++, data: { turn: t } }));
    lines.push(JSON.stringify({
      type: "user/message", seq: seq++,
      data: { role: "user", source: { kind: "user" }, id: `u${t}`, content: [{ type: "text", text: `帮我修第 ${t} 个报错：cannot find module` }] },
    }));
    lines.push(JSON.stringify({ type: "tool/call", seq: seq++, data: { callId: `c${t}`, name: "bash", input: { command: "npm test" } } }));
    lines.push(JSON.stringify({
      type: "tool/result", seq: seq++,
      data: { callId: `c${t}`, message: { toolCallId: `c${t}`, role: "tool", content: [{ type: "text", text: "Error: cannot find module foo" }] } },
    }));
    lines.push(JSON.stringify({
      type: "assistant/message", seq: seq++,
      data: { message: { role: "assistant", id: `a${t}`, content: [{ type: "text", text: `原因是依赖没装，跑 npm i foo 即可。第 ${t} 次验证。` }] } },
    }));
    lines.push(JSON.stringify({ type: "turn/end", seq: seq++, data: { turn: t, reason: { kind: "completed" } } }));
  }
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  const p = join(d, "session.v4.jsonl");
  writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

/** 造一个「纯闲聊」会话：没有工具调用，信号门会判 short-chatter 拦下 */
function makeChatter(dir: string, turns: number, id = "session-chat"): string {
  const lines: string[] = [];
  let seq = 1;
  lines.push(JSON.stringify({ type: "session", version: 4, id, cwd: "/proj", delegationDepth: 0 }));
  for (let t = 1; t <= turns; t++) {
    lines.push(JSON.stringify({ type: "turn/start", seq: seq++, data: { turn: t } }));
    lines.push(JSON.stringify({
      type: "user/message", seq: seq++,
      data: { role: "user", source: { kind: "user" }, id: `u${t}`, content: [{ type: "text", text: `在吗 ${t}` }] },
    }));
    lines.push(JSON.stringify({
      type: "assistant/message", seq: seq++,
      data: { message: { role: "assistant", id: `a${t}`, content: [{ type: "text", text: "在的。" }] } },
    }));
    lines.push(JSON.stringify({ type: "turn/end", seq: seq++, data: { turn: t, reason: { kind: "completed" } } }));
  }
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  const p = join(d, "session.v4.jsonl");
  writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-cap-"));

section("切窗：按 turns 分批");
{
  const root = tmp();
  const file = makeSession(root, 5);
  const vault = initVault(join(root, "proj"));
  const wins = planWindows({ sessionFile: file, vaultDir: vault.dir, skillDir: "/nonexistent", turns: 2 });
  eq(wins.length, 2, "5 轮按每窗 2 轮 → 2 个完整窗（剩 1 轮不够）");
  eq(wins[0].from_turn, 1, "第一窗从第 1 轮");
  eq(wins[0].to_turn, 2, "第一窗到第 2 轮");
  eq(wins[1].from_turn, 3, "第二窗从第 3 轮");
  ok(wins.every((w) => w.signal.keep), "有工具动作 → 全部通过信号门");
  rmSync(root, { recursive: true, force: true });
}

section("切窗：全部轮次已编译 → 无窗口");
{
  const root = tmp();
  const file = makeSession(root, 3);
  const vault = initVault(join(root, "proj"));
  // 手动把水位推到 3
  advanceState(vault.dir, sessionKey("dsh", "session-t1"), { compiled_to_turn: 3 });
  eq(planWindows({ sessionFile: file, vaultDir: vault.dir, skillDir: "/x", turns: 2 }).length, 0,
    "水位已到 3 → 无待编译窗口");
  rmSync(root, { recursive: true, force: true });
}

section("子代理会话被拒");
{
  const root = tmp();
  const d = join(root, "sub");
  mkdirSync(d, { recursive: true });
  const p = join(d, "session.v4.jsonl");
  writeFileSync(p, JSON.stringify({ type: "session", id: "sub1", delegationDepth: 1 }), "utf8");
  const vault = initVault(join(root, "proj"));
  const r = await runCapture({ sessionFile: p, vaultDir: vault.dir, skillDir: "/x" });
  eq(r.status, "subagent", "delegationDepth>=1 → 拒绝");
  rmSync(root, { recursive: true, force: true });
}

section("空会话");
{
  const root = tmp();
  const d = join(root, "empty");
  mkdirSync(d, { recursive: true });
  const p = join(d, "session.v4.jsonl");
  writeFileSync(p, "", "utf8");
  const vault = initVault(join(root, "proj"));
  const r = await runCapture({ sessionFile: p, vaultDir: vault.dir, skillDir: "/x" });
  eq(r.status, "empty", "空文件 → empty");
  rmSync(root, { recursive: true, force: true });
}

section("文件不存在");
{
  const root = tmp();
  const vault = initVault(join(root, "proj"));
  const r = await runCapture({ sessionFile: "/no/such/file.jsonl", vaultDir: vault.dir, skillDir: "/x" });
  eq(r.status, "error", "缺文件 → error");
  rmSync(root, { recursive: true, force: true });
}

section("planOnly：只切窗不编译");
{
  const root = tmp();
  const file = makeSession(root, 4);
  const vault = initVault(join(root, "proj"));
  const r = await runCapture({ sessionFile: file, vaultDir: vault.dir, skillDir: "/x", turns: 2, planOnly: true });
  eq(r.status, "planned", "planOnly 返回 planned");
  if (r.status === "planned") {
    eq(r.windows.length, 2, "两个窗口");
    eq(r.queued.length, 2, "两个都通过信号门");
  }
  rmSync(root, { recursive: true, force: true });
}

section("排队：同会话覆盖不累积");
{
  const root = tmp();
  const vault = initVault(join(root, "proj"));
  const win = {
    from_turn: 1, to_turn: 2, turns: 2, hash: "sha256:x",
    signal: { keep: true, reason: "has-tool-actions", stats: { userMessages: 2, assistantMessages: 2, toolCalls: 2, userChars: 40 } },
    chars: 100,
  };
  queueForHost(vault.dir, { sessionFile: "/a", sessionId: "s1", cwd: "/p", windows: [win], reason: "no-llm" });
  queueForHost(vault.dir, { sessionFile: "/a", sessionId: "s1", cwd: "/p", windows: [win], reason: "no-llm" });
  queueForHost(vault.dir, { sessionFile: "/b", sessionId: "s2", cwd: "/p", windows: [win], reason: "no-llm" });

  const p = join(vault.dir, ".ow", "pending", "capture.json");
  ok(existsSync(p), "队列文件已建");
  const data = JSON.parse(readFileSync(p, "utf8")) as { items: Array<{ session_id: string }> };
  eq(data.items.length, 2, "同会话只留一条 + 另一会话一条");
  eq(data.items.map((i) => i.session_id).sort(), ["s1", "s2"], "两个不同会话");
  rmSync(root, { recursive: true, force: true });
}

section("凭据描述");
{
  const d = describeCredentialSituation();
  ok(typeof d === "string" && d.length > 0, "能给出凭据状态描述");
}

section("手动触发跳过信号门（§6.5）");
{
  const root = tmp();
  const file = makeChatter(root, 3);
  const vault = initVault(join(root, "proj"));
  const base = { sessionFile: file, vaultDir: vault.dir, skillDir: "/x", turns: 3 };

  // 自动：纯闲聊被信号门拦下
  const autoWins = planWindows(base);
  eq(autoWins.length, 1, "切出 1 个窗口");
  ok(!autoWins[0].signal.keep, "自动判定：不通过");
  ok(!autoWins[0].forced, "自动：没有 forced 标记");

  // 手动：forced 标记，且仍然保留真实信号判定
  const manWins = planWindows({ ...base, manual: true });
  eq(manWins.length, 1, "手动也切出 1 个窗口");
  eq(manWins[0].forced, true, "手动：带 forced 标记");
  ok(!manWins[0].signal.keep, "手动：signal 仍记真实判定（供 --plan 展示）");

  rmSync(root, { recursive: true, force: true });
}

section("手动触发：纯闲聊也会被编译（不被信号门拒）");
{
  const root = tmp();
  const file = makeChatter(root, 3);
  const vault = initVault(join(root, "proj"));
  const base = { sessionFile: file, vaultDir: vault.dir, skillDir: "/x", turns: 3, planOnly: true };

  // 自动 plan：keep 为空
  const auto = await runCapture(base);
  ok(auto.status === "planned" && auto.queued.length === 0, "自动：没有窗口入队");

  // 手动 plan：forced 生效
  const man = await runCapture({ ...base, manual: true });
  ok(man.status === "planned" && man.queued.length === 1, "手动：窗口入队（跳过信号门）", JSON.stringify(man));

  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
