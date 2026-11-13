/**
 * knowledge-capture extension（P0 在线入口，V2 方案）—— 纯宿主对接层。
 *
 * 抽取/编排逻辑全在 core/lib/capture-orchestration.ts；本文件只做 pi 对接：
 *   - setHostContext（pi 路径注入）
 *   - 注册 pi 钩子/命令（session_start / before_agent_start / tool_call / kb / kb_doctor）
 *   - 从 ctx 取 entries/sessionId（宿主形状）
 *   - detached spawn（进程管理）
 *   - 工具响应格式化
 *
 * 统一触发（全 agent 一份逻辑，core 定义）：
 *   + before_agent_start（user 轮）→ core/trigger/cycle.ts 的 maybeCompile
 *     （30 轮闸 → 信号门 → 两级锁 → 进程内编译）
 *
 * 旧的 atoms 抽取管线（shouldExtractOnTurn / runScheduledExtraction）已随旧
 * autoskill 架构删除，与 dsh 侧保持一致——两边只产出 `.qdoc/` 知识页这一种产物。
 * 手动入口是 `qdoc` 前门技能（唤醒词），不是工具。
 *
 * 安装：pi package 机制（仓库根 package.json manifest）；推荐 `pi install ./AutoSkill` 或 git/npm 源。
 * 也可手工在 settings.json 的 extensions 数组写本文件绝对路径（不要符号链接：jiti 从注册路径解析相对导入）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setHostContext } from "../../packages/core/lib/base/context.ts";
import { setModelRegistry, activeConfigDescription, chatComplete } from "../../packages/core/lib/base/llm.ts";
import { appendUsage } from "../../packages/core/lib/skill/usage-store.ts";
import { coverageReport } from "../../packages/core/lib/extract/coverage.ts";
import type { MessageEntry } from "../../packages/core/lib/base/types.ts";
import { maybeCompile } from "../../packages/core/lib/trigger/cycle.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  kbStatusText, pendingNoticeText,
  applyPatches,
} from "../../packages/core/lib/capture-orchestration.ts";

// adapter-pi 宿主上下文注入（v2：数据目录/凭据基准/skills 输出全部住在 pi 命名空间内）。
// extension 进程内首次调用时注入；spawn CLI 各自进程靠 AUTOSKILL_DATA_DIR/AUTOSKILL_HOME 环境传递。
setHostContext({
  host: "pi",
  dataDir: process.env.KB_DIR ?? join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge"),
  homeDir: join(homedir(), ".pi", "agent"),
  modelsPath: process.env.PI_MODELS_PATH,
  settingsPath: join(homedir(), ".pi", "agent", "settings.json"),
});

/** 编译内核技能目录（仓库内 agent-skills/ow-compiler） */
const COMPILER_SKILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "agent-skills", "ow-compiler",
);

/**
 * 走 `core/trigger/cycle.ts` 的统一编排（与 dsh 侧 `runCycle` 同一个函数）。
 *
 * pi 有 `before_agent_start` 逐轮钩子，所以轮次判定是**精确的**——不像 dsh 要等定时器。
 * 但闸门逻辑完全一致：30 轮 → 信号门 → 机器锁 → vault 锁 → 编译。
 *
 * 会话事件的 seq：pi 的 entry 没有 seq，用「消息在活跃分支里的序号」充当（单调即可，
 * 窗口切分与水位只要求单调，不要求等于宿主内部编号）。
 */
async function maybeRunCycle(ctx: unknown, reason: string): Promise<void> {
  const sm = (ctx as {
    sessionManager?: {
      getSessionId?: () => string;
      getEntries?: () => Array<{ type?: string; id?: string; message?: { role?: string } }>;
      getCwd?: () => string;
    };
  })?.sessionManager;
  const sessionId = sm?.getSessionId?.();
  const all = sm?.getEntries?.() ?? [];
  if (!sessionId || all.length === 0) return;

  const entries = all.filter((e) => e?.type === "message" && typeof e?.id === "string");
  if (entries.length === 0) return;

  const withSeq = entries.map((e, i) => ({ ...e, seq: i }));
  const events = withSeq.map((e) => ({
    type: "message",
    seq: e.seq,
    message: e.message,
    id: e.id,
  }));

  const outcome = await maybeCompile({
    agent: "pi",
    sessionId,
    events,
    entries: withSeq as unknown as Array<MessageEntry & { seq: number }>,
    cwd: sm?.getCwd?.() ?? process.cwd(),
    skillDir: COMPILER_SKILL_DIR,
    autoInit: process.env.OW_AUTO_INIT === "1",
  });

  const ui = (ctx as { ui?: { notify?: (m: string, type?: string) => void } }).ui;
  if (outcome.status === "compiled") {
    ui?.notify?.(
      `[知识库] 编译完成：新增 ${outcome.report.pages_created}、更新 ${outcome.report.pages_updated}（${reason}）`,
      "info",
    );
  }
}

export default function (pi: ExtensionAPI) {
  // ---------- 0a. session_start：注入 ModelRegistry + 消费提案队列 ----------
  let noticed = false; // 每会话只注入一次提示
  pi.on("session_start", async (_event, ctx) => {
    // 抽取引擎复用用户环境的 API 配置：凭据解析与主对话同链（auth.json/models.json/env）。
    try {
      await ctx.modelRegistry.refresh();
      const m = ctx.model;
      setModelRegistry(ctx.modelRegistry as never, m ? `${m.provider}/${m.id}` : undefined);
    } catch {
      setModelRegistry(ctx.modelRegistry as never); // refresh 失败不阻塞会话
    }
    try {
      const r = applyPatches();
      if (r.applied.length + r.discarded.length > 0) {
        ctx.ui.notify(`[知识管道] 提案队列：应用 ${r.applied.length} / 自愈重做 ${r.discarded.length}`, "info");
      }
    } catch (e) {
      logError(`session_start 应用提案失败: ${String(e).slice(0, 200)}`);
    }
  });

  // ---------- 0b. before_agent_start：首个用户轮注入提示（pending + darwin 体检） ----------
  pi.on("before_agent_start", async (event, ctx) => {
    // 用户轮开始前推进知识编译（30 轮闸 → 信号门 → 两级锁 → 进程内编译）。
    // 旧的 atoms 抽取管线已随旧 autoskill 架构移除，与 dsh 侧保持一致。
    if (event.messageType === "user") {
      void maybeRunCycle(ctx, "turn").catch((e) => {
        logError(`cycle(turn) 失败: ${String(e).slice(0, 200)}`);
      });
    }
    if (noticed || event.messageType !== "user") return;
    noticed = true;
    const notice = pendingNoticeText();
    if (!notice) return;
    return {
      message: {
        customType: "kb_pending_notice",
        content: notice,
        display: "[知识管道] 有待整合知识卡片 / skill 体检提示（详见注入内容）",
      },
    };
  });

  // ---------- 0c. tool_call hook：模型读取 SKILL.md → 记 loaded（usage 审计） ----------
  pi.on("tool_call", async (event) => {
    try {
      const input = JSON.stringify((event as { input?: unknown }).input ?? {});
      if (!input.includes(".pi/agent/skills/") || !input.includes("SKILL.md")) return undefined;
      const m = input.match(/skills\/([\w.-]+)\/SKILL\.md/);
      if (!m) return undefined;
      appendUsage([{
        ts: new Date().toISOString(),
        session: "live",
        skill: m[1],
        event: "loaded",
        evidence: event.toolName,
      }]);
    } catch {
      // 审计失败绝不阻塞工具调用
    }
    return undefined; // 放行，不修改不拦截
  });

  // ---------- /kb：知识库状态（最小实现） ----------
  pi.registerCommand("kb", {
    description: "知识库状态（知识卡片计数与路径）",
    handler: async (_args, ctx) => {
      let extra = "";
      try {
        const id = ctx.sessionManager.getSessionId();
        const all = ctx.sessionManager.getEntries() as Array<{ type?: string; id?: string }>;
        const entries = all.filter((e) => e?.type === "message" && typeof e?.id === "string") as unknown as MessageEntry[];
        if (id && entries.length > 0) {
          const cov = coverageReport(entries, id);
          extra = `\n本条会话：已覆盖 ${cov.covered}/${cov.total}，待审 ${cov.unreviewed}`;
        }
      } catch {
        // 状态展示失败不影响命令
      }
      ctx.ui.notify(kbStatusText() + extra, "info");
    },
  });

  // ---------- kb_doctor：LLM 链路诊断（分发后用户自检配置） ----------
  const DoctorParams = Type.Object({
    fire_real_call: Type.Optional(Type.Boolean({ description: "是否发一次真实测试调用（默认 false，只查配置解析）" })),
  });
  pi.registerTool({
    name: "kb_doctor",
    label: "KB Doctor",
    description: "知识管道 LLM 链路诊断：报告当前抽取引擎的模型配置来源；可选发一次真实测试调用验证凭据可用。",
    promptSnippet: "kb_doctor: 自检知识管道的 LLM 配置链路",
    parameters: DoctorParams,
    async execute(_toolCallId, params) {
      const lines = [`模式: ${activeConfigDescription()}`];
      if (params.fire_real_call) {
        try {
          const t0 = Date.now();
          const r = await chatComplete({ system: "你是诊断助手", user: "只回复两个字：正常", timeoutMs: 60_000 });
          lines.push(`真实调用: ✅ ${r.model}（${Date.now() - t0}ms）`);
        } catch (e) {
          lines.push(`真实调用: ❌ ${String(e).slice(0, 300)}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
