/**
 * dsh 适配层回归（不调模型、不需要真 dsh 宿主）。
 *
 * 旧版本的三个用例（assemble-timer 数据目录、skill provider 读 cards、ctx.llm 桥）
 * 里，前两个随旧 autoskill 架构一起删掉了。现在锁住的是**新架构真正依赖**的三件事：
 *
 *  1. 插件形状对：`apply` / `inject` / `name` 齐全，且 `inject` 只声明 `llm`
 *     （不再依赖 `skills`——skill provider 已移除）
 *  2. 会话路径解析：DSH_HOME 可覆盖、cwd → slug、目录 → session.v4.jsonl(.zstd)
 *  3. ctx.llm 桥：消息形状、usage 映射、finish error 转 throw
 *
 * 运行：node --experimental-strip-types packages/adapter-dsh/test/smoke-dsh.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDshHome,
  dshSessionsRoot,
  sessionCwdSlug,
  sessionIdFromFile,
  latestSessionFileIn,
} from "../src/session-path.ts";
import { installDshLlm, rememberedTarget, rememberLlmTarget } from "../src/llm-bridge.ts";
import { clearChatCompleter, chatComplete } from "../../core/lib/base/llm.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` → ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown, name: string): void =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    name,
    `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`,
  );

const root = mkdtempSync(join(tmpdir(), "autoskill-dsh-"));

// ── 1. 插件形状 ────────────────────────────────────────────────
{
  const mod = (await import("../src/index.ts")) as Record<string, unknown>;
  ok(typeof mod.apply === "function", "插件导出 apply");
  ok(typeof mod.name === "string" && mod.name.length > 0, "插件导出 name");
  ok(Array.isArray(mod.inject), "插件导出 inject");
  eq(mod.inject, ["llm"], "inject 只声明 llm（不再需要 skills）");
  ok(!("autoskillProvider" in mod), "不再导出 skill provider");
}

// ── 2. 会话路径 ────────────────────────────────────────────────
{
  eq(resolveDshHome("/tmp/x"), "/tmp/x", "DSH_HOME 可覆盖");
  ok(resolveDshHome().includes(".dsh"), "默认指向 ~/.dsh");

  eq(dshSessionsRoot("/tmp/x"), "/tmp/x/sessions", "sessions 根目录");

  const slug = sessionCwdSlug("/Users/me/proj");
  ok(slug.startsWith("--") && slug.endsWith("--"), "cwd slug 两端有 --", slug);
  ok(!slug.includes("/"), "slug 不含斜杠", slug);

  eq(
    sessionIdFromFile("/a/session-abc-123/session.v4.jsonl"),
    "session-abc-123",
    "从目录取 sessionId",
  );

  // 目录形态：优先 .zstd
  const projDir = join(root, "sessions", sessionCwdSlug("/Users/me/proj"), "session-abc");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "session.v4.jsonl"), "{}\n");
  const got = latestSessionFileIn(root, "/Users/me/proj");
  ok(got?.endsWith("session.v4.jsonl") === true, "目录 → 找到会话文件", String(got));
}

// ── 3. ctx.llm 桥 ─────────────────────────────────────────────
{
  const requests: Array<Record<string, unknown>> = [];

  /** 造一个形状合法的 dsh llm 服务：只实现桥真正用到的 stream / listProviders */
  function fakeLlm(reply: { text?: string; reasoning?: string; fail?: string }) {
    return {
      listProviders: () => [{ provider: "testprov" }],
      async *stream(req: Record<string, unknown>) {
        requests.push(req);
        if (reply.fail) {
          yield { type: "finish", reason: { kind: "error", failure: { code: "X", message: reply.fail } } };
          return;
        }
        if (reply.reasoning) yield { type: "reasoning-delta", text: reply.reasoning };
        if (reply.text) yield { type: "text-delta", text: reply.text };
        yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7 } };
        yield { type: "finish", reason: { kind: "completed" } };
      },
    };
  }

  function fakeCtx(llm: unknown) {
    return { llm, effect: () => {} } as never;
  }

  ok(installDshLlm(fakeCtx(fakeLlm({ text: "好的" })), { provider: "testprov", model: "m1" }), "installDshLlm 成功接管");

  const r = await chatComplete({ system: "S", user: "U", maxTokens: 128 });
  eq(r.text, "好的", "返回值透传");
  eq(r.model, "testprov/m1", "模型标识带 provider 前缀");
  eq(r.usage?.promptTokens, 11, "usage 映射 promptTokens");
  eq(r.usage?.completionTokens, 7, "usage 映射 completionTokens");

  eq(requests.length, 1, "调了一次宿主 llm");
  const req = requests[0] as {
    provider?: string;
    model?: string;
    maxTokens?: number;
    messages?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  };
  eq(req.provider, "testprov", "provider 透传");
  eq(req.model, "m1", "model 透传");
  eq(req.maxTokens, 128, "maxTokens 透传");
  eq(req.messages?.[0]?.role, "system", "system 消息在最前");
  eq(req.messages?.[1]?.content?.[0]?.text, "U", "user 内容在 text 块里");

  // 宿主 finish=error 必须变成 throw，不能静默返回空
  installDshLlm(fakeCtx(fakeLlm({ fail: "宿主模型不可用" })), { provider: "testprov", model: "m1" });
  let threw = "";
  try {
    await chatComplete({ system: "S", user: "U", maxTokens: 8 });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("宿主模型不可用"), "finish=error 转 throw", threw);

  // 正文为空时从 reasoning 抢救（思考型模型）
  installDshLlm(fakeCtx(fakeLlm({ reasoning: '{"a":1}' })), { provider: "testprov", model: "m1" });
  const salvaged = await chatComplete({ system: "S", user: "U", maxTokens: 8 });
  eq(salvaged.text, '{"a":1}', "reasoning 里抢救 JSON");

  // 宿主没有 llm 服务时返回 false（调用方据此退回 standalone 链）
  eq(installDshLlm(fakeCtx(undefined), {}), false, "无 llm 服务返回 false");

  clearChatCompleter();
}

// ── 4. 记忆目标 ────────────────────────────────────────────────
{
  // 从 agent.options 取
  rememberLlmTarget({ options: { provider: "p", model: "m" } });
  eq(rememberedTarget(), { provider: "p", model: "m" }, "从 options 记住路由");

  // 从 session.requestHeader() 取（options 没给时的退路）
  rememberLlmTarget({ session: { requestHeader: () => ({ config: { provider: "p2", model: "m2" } }) } });
  eq(rememberedTarget(), { provider: "p2", model: "m2" }, "从 requestHeader 记住路由");

  // 信息不全时保持上一次的值，不清空
  rememberLlmTarget({ options: { provider: "p3" } });
  eq(rememberedTarget(), { provider: "p2", model: "m2" }, "缺 model 时不覆盖");

  // 形状不对也不炸
  rememberLlmTarget(null);
  rememberLlmTarget({ options: {} });
  eq(rememberedTarget(), { provider: "p2", model: "m2" }, "异常输入不破坏已有值");
}

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
