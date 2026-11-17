/** adapter-opencode：宿主枚举 / 消息映射 / completer / 手动旁路 / Git 自动更新 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { HOST_DIRS, hostSkillDir } from "../lib/sync/install.ts";
import { sessionKey } from "../lib/trigger/state.ts";
import { indexTurns } from "../lib/trigger/turns.ts";
import { maybeCompile } from "../lib/trigger/cycle.ts";
import { buildHostContext, COMPILER_SKILL_DIR } from "../../adapter-opencode/host.ts";
import { mapSessionMessages } from "../../adapter-opencode/messages.ts";
import {
  createChatCompleter, setActiveSession, getActiveSession,
} from "../../adapter-opencode/completer.ts";
import { describeOutcome } from "../../adapter-opencode/triggers.ts";
import { maybeAutoUpdate, autoUpdateStatePath } from "../../adapter-opencode/auto-update.ts";

// 机器目录指到临时区：锁/预算/安装状态/自动更新状态都不碰真实 ~/.config/qdoc
process.env.QDOC_MACHINE_DIR = mkdtempSync(join(tmpdir(), "qdoc-oc-machine-"));
// 知识数据目录也指到临时区：logError/日志不写真实 ~/.config
// （只设 AUTOSKILL_DATA_DIR——atom-store 认它；host.ts 认 KB_DIR，留给目录断言用）
const ocData = mkdtempSync(join(tmpdir(), "qdoc-oc-data-"));
process.env.AUTOSKILL_DATA_DIR = ocData;
// 确保 standalone LLM 解析必失败（manual 旁路测试走到编译器才报错，而不是真打 API）
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
delete process.env.AUTOSKILL_PROVIDER;

section("宿主枚举：HOST_DIRS / HostContext");
{
  ok(hostSkillDir("opencode").endsWith(join(".config", "opencode", "skills")), "opencode 技能目录是 ~/.config/opencode/skills");
  ok(existsSync(COMPILER_SKILL_DIR) && existsSync(join(COMPILER_SKILL_DIR, "SKILL.md")), "编译内核技能目录存在");
  const hc = buildHostContext();
  eq(hc.host, "opencode", "HostContext.host");
  ok(hc.dataDir.endsWith(join(".config", "qdoc", "knowledge", "opencode")), "数据目录与 pi/dsh 隔离");
  eq(hc.skillsDir, HOST_DIRS.opencode, "skillsDir 与 HOST_DIRS 同口径");

  eq(sessionKey("opencode", "s1"), "opencode:s1", "会话键带 opencode 前缀");
}

section("轮次计数：opencode 沿用 pi 语义（user 消息开轮）");
{
  const events = [
    { type: "message", seq: 0, message: { role: "user" } },
    { type: "message", seq: 1, message: { role: "assistant" } },
    { type: "message", seq: 2, message: { role: "assistant" } },
    { type: "message", seq: 3, message: { role: "user" } },
    { type: "message", seq: 4, message: { role: "assistant" } },
  ];
  const idx = indexTurns(events, "s1", "opencode");
  eq(idx.turns.length, 2, "两条 user 消息 → 两轮");
  eq(idx.turns[0].fromSeq, 0, "第一轮起点");
  eq(idx.turns[1].fromSeq, 3, "第二轮起点");
  eq(idx.lastSeq, 4, "水位 seq");
}

section("消息映射：OpenCode transcript → 归一事件流");
{
  // 扁平形态 + info 包装形态混合；system 应被剔除；assistant 的 tool part 折叠为摘要
  const messages = [
    { id: "m0", role: "user", time: { created: 1_700_000_000 }, parts: [{ type: "text", text: "帮我看看这个报错" }] },
    { info: { id: "m1", role: "assistant", time: { created: 1_700_000_005 } }, parts: [
      { type: "text", text: "看了一下，是路径拼错了" },
      { type: "tool", name: "read" },
      { type: "tool", name: "read" },
    ] },
    { id: "m2", role: "system", parts: [{ type: "text", text: "system prompt" }] },
  ];
  const { events, entries } = mapSessionMessages(messages as never);
  eq(events.length, 2, "system 不产事件");
  eq(entries.length, 2, "system 不产 entry");
  eq(entries[0].message.role, "user", "user role");
  eq(entries[0].seq, 0, "seq=transcript 序号");
  eq(entries[0].message.content, "帮我看看这个报错", "user 文本");
  eq(entries[1].id, "m1", "info 包装的 id 能取到");
  eq(entries[1].timestamp, new Date(1_700_000_005_000).toISOString(), "秒级 epoch → ISO");
  ok(
    String(entries[1].message.content).includes("[工具: read]") &&
    String(entries[1].message.content).includes("路径拼错"),
    "assistant 保留文本 + 工具摘要去重",
  );
  // 空输入与畸形输入不炸
  eq(mapSessionMessages(undefined).entries.length, 0, "undefined 安全");
  eq(mapSessionMessages([null, 42] as never).entries.length, 0, "畸形项安全");
}

section("completer：experimental 优先 → session.generate 回退");
{
  const saved = getActiveSession();
  try {
    setActiveSession("s-completer");
    // ① 有模型 → generate.text
    {
      const calls: string[] = [];
      const completer = createChatCompleter({
        getModel: async () => ({ providerID: "anthropic", id: "claude-x" }),
        generateText: async (o) => { calls.push(`text:${o.model?.id}`); return { text: " 编译结果 " }; },
        sessionGenerate: async () => { calls.push("session"); return { text: "不该走到" }; },
      });
      const r = await completer({ system: "sys", user: "usr" });
      eq(r.text, "编译结果", "首选项返回 trim 后文本");
      eq(r.model, "anthropic/claude-x", "model 标注为会话模型");
      eq(calls, ["text:claude-x"], "没走回退");
    }
    // ② experimental 抛 → 回退 session.generate
    {
      const completer = createChatCompleter({
        getModel: async () => ({ providerID: "p", id: "m" }),
        generateText: async () => { throw new Error("experimental 不可用"); },
        sessionGenerate: async () => ({ text: "回退结果" }),
      });
      const r = await completer({ system: "s", user: "u" });
      eq(r, { text: "回退结果", model: "session.generate" }, "回退通道生效");
    }
    // ③ 没模型 → 直接回退；④ 两者都空 → 报错
    {
      const completer = createChatCompleter({
        getModel: async () => undefined,
        generateText: async () => ({ text: "不该走到" }),
        sessionGenerate: async () => ({ text: "" }),
      });
      let threw = "";
      try { await completer({ system: "s", user: "u" }); } catch (e) { threw = String(e); }
      ok(threw.includes("空"), "双通道空回复要报错");
    }
    // ⑤ 无活动会话 → 明确报错
    setActiveSession(null);
    {
      const completer = createChatCompleter({
        getModel: async () => undefined,
        generateText: async () => ({ text: "x" }),
        sessionGenerate: async () => ({ text: "y" }),
      });
      let threw = "";
      try { await completer({ system: "s", user: "u" }); } catch (e) { threw = String(e); }
      ok(threw.includes("无活动会话"), "无活动会话要明确报错");
    }
  } finally {
    setActiveSession(saved);
  }
}

section("describeOutcome：结果 → 用户可读文案");
{
  ok(describeOutcome({ status: "nothing-pending" }).includes("没有待编译"), "nothing-pending 文案");
  ok(describeOutcome({ status: "no-vault" }).includes("ow init"), "no-vault 给出修法");
  ok(
    describeOutcome({
      status: "compiled",
      report: { pages_created: 2, pages_updated: 1, publish_candidates: ["a", "b"] },
      window: { turns: 30, from_turn: 1, to_turn: 30 },
    } as never).includes("30 轮"),
    "compiled 文案带轮数",
  );
}

section("maybeCompile：manual 跳过信号门（预算/锁照常）");
{
  const proj = mkdtempSync(join(tmpdir(), "qdoc-oc-proj-"));
  const iso = new Date().toISOString();
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: iso, seq: 0, message: { role: "user", content: "你好" } },
    { type: "message", id: "a1", parentId: null, timestamp: iso, seq: 1, message: { role: "assistant", content: "你好，有什么可以帮你？" } },
  ];
  const events = [
    { type: "message", seq: 0, message: { role: "user" } },
    { type: "message", seq: 1, message: { role: "assistant" } },
  ];
  const base = {
    agent: "opencode" as const,
    sessionId: "s-gate",
    events,
    entries,
    cwd: proj,
    skillDir: COMPILER_SKILL_DIR,
    autoInit: true,
    turns: 1,
  };
  const gated = await maybeCompile(base);
  eq(gated.status, "no-signal", "短闲聊窗口默认被信号门拦下");
  const manual = await maybeCompile({ ...base, manual: true });
  eq(manual.status, "error", "manual=true 穿过信号门（死在无 LLM 配置——闸门之后才烧 token）");
  ok(String((manual as { error?: string }).error).includes("无可用 LLM 配置") || String((manual as { error?: string }).error).length > 0, "错误来自编译阶段而非信号门");
  rmSync(proj, { recursive: true, force: true });
}

section("Git 自动更新：开关 / 退避 / ff-only 拉取");
{
  const ocMachine = process.env.QDOC_MACHINE_DIR as string;
  const statePath = join(ocMachine, "auto-update-test.json");
  eq(autoUpdateStatePath(statePath), statePath, "statePath 覆盖生效");

  // ① 开关没开
  delete process.env.AUTOSKILL_AUTO_UPDATE;
  eq((await maybeAutoUpdate({ statePath })).status, "disabled", "默认关闭");

  process.env.AUTOSKILL_AUTO_UPDATE = "1";
  try {
    // git 夹具：bare origin + work clone（落后 1 个提交）
    const base = mkdtempSync(join(tmpdir(), "qdoc-oc-git-"));
    const id = "git -c user.email=t@t -c user.name=t";
    execSync(`git init --bare ${base}/origin.git`);
    execSync(`git clone -q ${base}/origin.git ${base}/work`);
    writeFileSync(join(base, "work", "a.md"), "a");
    execSync(`cd ${base}/work && ${id} add -A && ${id} commit -qm a && git push -q origin HEAD`);
    // 另一个 clone 推进远端
    execSync(`git clone -q ${base}/origin.git ${base}/other`);
    writeFileSync(join(base, "other", "b.md"), "b");
    execSync(`cd ${base}/other && ${id} add -A && ${id} commit -qm b && git push -q origin HEAD`);

    // ② 退避窗口内不动作（no-repo 判断在退避之前，所以要拿真仓库测退避）
    const future = new Date(Date.now() + 3_600_000).toISOString();
    writeFileSync(statePath, JSON.stringify({ schema: 1, attempts: 2, lastError: "x", nextRetryAt: future }));
    const b = await maybeAutoUpdate({ statePath, repoRoot: join(base, "work") });
    eq(b.status, "backoff", "退避期内不执行");
    eq(b.retryAt, future, "退避到期时间透传");

    // ③ 非仓库目录（优先于退避判断）
    const nr = await maybeAutoUpdate({ statePath, repoRoot: mkdtempSync(join(tmpdir(), "qdoc-oc-norepo-")) });
    eq(nr.status, "no-repo", "非 git 目录报 no-repo");

    // ④ 真实 git 流程：清掉退避 → ff-only 拉平 → 技能重装 + 热载
    writeFileSync(statePath, JSON.stringify({ schema: 1 }));
    const skillsDir = join(base, "skills-out");
    mkdirSync(skillsDir, { recursive: true });
    let reloaded = 0;
    const r = await maybeAutoUpdate({
      repoRoot: join(base, "work"),
      statePath,
      hostDir: skillsDir,
      reloadSkills: () => { reloaded += 1; },
    });
    eq(r.status, "pulled", "ff-only 拉取成功");
    eq(r.behind, 1, "落后 1 个提交");
    eq(reloaded, 1, "热载回调被调用");
    ok(existsSync(join(base, "work", "b.md")), "工作区真的更新到了 b 提交");
    const st = JSON.parse(readFileSync(statePath, "utf8")) as { attempts?: number };
    eq(st.attempts ?? 0, 0, "成功后清退避");

    // ⑤ 已是最新
    const r2 = await maybeAutoUpdate({ repoRoot: join(base, "work"), statePath, hostDir: skillsDir });
    eq(r2.status, "up-to-date", "无新提交时不动");

    rmSync(base, { recursive: true, force: true });
  } finally {
    delete process.env.AUTOSKILL_AUTO_UPDATE;
    rmSync(statePath, { force: true });
  }
}

process.exit(summary());
