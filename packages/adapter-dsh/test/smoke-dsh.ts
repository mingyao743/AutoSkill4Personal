/**
 * dsh 适配层回归（不调模型、不需要真 dsh 宿主）。
 *
 * 锁住三个曾经在真机上出过事的点：
 *  1. assemble-timer 的数据目录绝不再落回 `~/.pi`（跨宿主污染）
 *  2. provider 读得到 assemble.ts 写出的 `cards/01-business/...`，且多类目要拼全
 *  3. ctx.llm 桥：消息形状、usage 映射、finish error 转 throw
 *
 * 运行：node --experimental-strip-types packages/adapter-dsh/test/smoke-dsh.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHostContext, hostContext } from "../../core/lib/base/context.ts";
import { chatComplete, clearChatCompleter, activeConfigDescription } from "../../core/lib/base/llm.ts";
import { autoskillProvider } from "../src/skill-provider.ts";
import { buildAssembleArgs, resolveDataDir } from "../src/assemble-timer.ts";
import { installDshLlm, rememberedTarget } from "../src/llm-bridge.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` → ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown, name: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

const root = mkdtempSync(join(tmpdir(), "autoskill-dsh-"));
const dataDir = join(root, "knowledge");
mkdirSync(dataDir, { recursive: true });

// ---------- 1. 数据目录解析 ----------
console.log("\n--- 1. assemble-timer 数据目录 ---");
delete process.env.DSH_HOME;
setHostContext({ host: "dsh", dataDir });
eq(resolveDataDir({}), dataDir, "已有 HostContext 时沿用它");
const args = buildAssembleArgs(dataDir);
eq(args[2], "--data-dir", "spawn 参数显式带 --data-dir");
eq(args[3], dataDir, "--data-dir 的值是宿主数据目录");
ok(!args.join(" ").includes("/.pi/"), "spawn 参数里没有 pi 路径");

// ---------- 2. provider 组卡读取 ----------
console.log("\n--- 2. provider 组卡路径 ---");
const atoms = [
  { atom_id: "atom_aaaaaaaaaaaa", category: "01", atom_type: "规则切片", content: "spec 类知识", domain: "demo-domain", sources: [{ session_id: "s1", window_id: "sig_s1_001", msg_range: ["m1", "m1"] }], confidence: 0.8, version: 1, superseded_by: null, refs: [], status: "draft", extracted_at: "2026-11-01T00:00:00.000Z", extracted_by: "signal-distill" },
  { atom_id: "atom_bbbbbbbbbbbb", category: "05", atom_type: "根因切片", content: "postmortem 类知识", domain: "demo-domain", sources: [{ session_id: "s1", window_id: "sig_s1_002", msg_range: ["m2", "m2"] }], confidence: 0.8, version: 1, superseded_by: null, refs: [], status: "draft", extracted_at: "2026-11-02T00:00:00.000Z", extracted_by: "signal-distill" },
];
writeFileSync(join(dataDir, "atoms.jsonl"), atoms.map((a) => JSON.stringify(a)).join("\n") + "\n");
mkdirSync(join(dataDir, "cards", "01-business"), { recursive: true });
mkdirSync(join(dataDir, "cards", "05-lessons"), { recursive: true });
writeFileSync(join(dataDir, "cards", "01-business", "demo-domain.md"), "# demo-domain · 业务认知\n\nSPEC_BODY\n");
writeFileSync(join(dataDir, "cards", "05-lessons", "demo-domain.md"), "# demo-domain · 问题与复盘\n\nPOSTMORTEM_BODY\n");

const provider = autoskillProvider(hostContext()!);
const list = await provider.list();
ok(list.some((c) => c.name === "demo-domain"), "list 里出现该主题");
const got = await provider.get(list.find((c) => c.name === "demo-domain")!);
ok(!!got, "get 返回正文");
ok(!!got?.content.includes("SPEC_BODY"), "读到 01-business 的组卡");
ok(!!got?.content.includes("POSTMORTEM_BODY"), "多个类目的组卡都拼进来（不是只取第一个）");
ok(!got!.content.includes("知识卡片聚合"), "有组卡时不再走聚合兜底");
const usage = readFileSync(join(dataDir, "usage.jsonl"), "utf8");
ok(usage.includes('"event":"loaded"'), "get 记 loaded 使用账");

// 没有组卡 → 聚合兜底仍然要能出正文
rmSync(join(dataDir, "cards"), { recursive: true });
const fallback = await (autoskillProvider(hostContext()!).get({ name: "demo-domain" } as never));
ok(!!fallback?.content.includes("知识技能包"), "无组卡时退回聚合兜底");

// ---------- 3. ctx.llm 桥 ----------
console.log("\n--- 3. ctx.llm 桥 ---");
type Req = { provider: string; model: string; messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>; maxTokens?: number };
let seen: Req | undefined;
const ctx = {
  llm: {
    listProviders: () => [{ provider: "deepseek-official" }],
    listModels: async () => [{ provider: "deepseek-official", id: "deepseek-v4-flash", name: "Flash" }],
    stream: async function* (req: Req) {
      seen = req;
      yield { type: "text-delta", index: 0, text: '{"cards":' };
      yield { type: "text-delta", index: 0, text: "[]}" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
  effect: (_fn: () => () => void) => () => {},
} as never;

ok(installDshLlm(ctx, { maxTokens: 2048 }), "installDshLlm 返回 true");
eq(activeConfigDescription(), "宿主注入 completer 模式（dsh ctx.llm）", "诊断里报告桥模式");
const res = await chatComplete({ system: "SYS", user: "USR" });
eq(res.text, '{"cards":[]}', "拼出正文");
eq(res.model, "deepseek-official/deepseek-v4-flash", "model 带 provider 前缀");
eq(res.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, "usage 映射到 core 字段");
eq(seen?.messages[0].role, "system", "第一条是 system");
eq(seen?.messages[1].content[0].text, "USR", "user 消息内容透传");
eq(seen?.maxTokens, 2048, "maxTokens 来自配置");

// 显式 provider/model 覆盖
const memory = { options: { provider: "p2", model: "m2" } };
const ctx2 = {
  llm: {
    listProviders: () => [{ provider: "p1" }, { provider: "p2" }],
    listModels: async () => [{ provider: "p2", id: "m2", name: "M2" }],
    stream: async function* (req: Req) {
      seen = req;
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  },
  effect: () => () => {},
} as never;
installDshLlm(ctx2, {});
const { rememberLlmTarget } = await import("../src/llm-bridge.ts");
rememberLlmTarget(memory);
eq(rememberedTarget(), { provider: "p2", model: "m2" }, "从 agent 记住当前路由");
await chatComplete({ system: "s", user: "u" });
eq(seen?.provider, "p2", "未显式配置时跟随记住的路由");
eq(seen?.model, "m2", "模型跟随记住的路由");

// finish error → throw（core 会记 errors.log）
const ctxErr = {
  llm: {
    listProviders: () => [{ provider: "p" }],
    listModels: async () => [{ provider: "p", id: "m", name: "M" }],
    stream: async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { code: "MISSING_CREDENTIAL", message: "no key" } } };
    },
  },
  effect: () => () => {},
} as never;
installDshLlm(ctxErr, {});
let threw = "";
try { await chatComplete({ system: "s", user: "u" }); } catch (e) { threw = String(e); }
ok(threw.includes("MISSING_CREDENTIAL") && threw.includes("no key"), "宿主 error 转成带 code 的异常", threw);

clearChatCompleter();
eq(activeConfigDescription(), "standalone 模式（models.json/env 解析）", "撤掉桥后回到 standalone");

// ---------- 4. 会话文件定位（自定义 DSH_HOME） ----------
console.log("\n--- 4. 会话路径 ---");
const { sessionCwdSlug, dshSessionsRoot, sessionFileFor, latestSessionFileIn, sessionIdFromFile } = await import("../src/session-path.ts");
const fakeHome = join(root, "dsh-home");
const project = join(root, "proj");
const sessDir = join(dshSessionsRoot(fakeHome), sessionCwdSlug(project), "sid1");
mkdirSync(sessDir, { recursive: true });
const sessFile = join(sessDir, "session.v4.jsonl.zstd");
writeFileSync(sessFile, "x");
eq(dshSessionsRoot(fakeHome), join(fakeHome, "sessions"), "会话根跟随配置的 dshHome");
eq(sessionCwdSlug("/a/b c"), "--a-b-c--", "cwd slug 规则");
eq(sessionFileFor(fakeHome, project, "sid1"), sessFile, "按 session id 定位到 zstd 文件");
eq(latestSessionFileIn(fakeHome, project), sessFile, "mtime 兜底扫描同样只看配置的根");
ok(!dshSessionsRoot(fakeHome).includes("/.pi/"), "会话根不落到 ~/.pi");
eq(sessionIdFromFile(sessFile), "sid1", "dsh 的 session.v4.* 用父目录名当 id（旧实现一律返回 session.v4）");
eq(sessionIdFromFile("/s/2026-11-12_01a1ae83.jsonl"), "2026-11-12_01a1ae83", "pi 会话仍用文件名");

rmSync(root, { recursive: true, force: true });
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
