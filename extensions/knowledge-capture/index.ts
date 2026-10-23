/**
 * knowledge-capture extension（P0 在线入口，V2 方案）
 *
 * 五入口共用一个抽取引擎（lib/extract-core.ts + lib/llm.ts 独立流式调用，
 * 绝不在主对话轮次内做批量抽取）：
 *   1. capture_knowledge 工具：agent 单条声明，draft，confidence 0.8
 *   2. kb_harvest 工具：收尾终采，detached spawn CLI，draft（0.6 由 CLI 默认值给出）
 *   3. session_before_compact：compaction 抢救（唯一免审入口），published，floor 0.7，
 *      抽完拼自定义 summary 再放行 compaction（核心在 lib/compaction-rescue.ts）
 *   4. session_shutdown(reason=quit)：detached spawn CLI 全量终采
 *   5. 手动回填：直接跑 scripts/extract.ts（不经本 extension）
 *
 * 安装：pi package 机制（仓库根有 package.json manifest，声明 extensions/skills）；
 * 推荐 `pi install ./AutoSkill` 或 git/npm 源。也可手工在 settings.json 的
 * extensions 数组写本文件绝对路径（不要符号链接：jiti 从注册路径解析相对导入）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { atomId, appendAtoms, atomsPath, loadAtoms, logError } from "../../lib/atom-store.ts";
import { rescueAtoms, generateCompactionSummary } from "../../lib/compaction-rescue.ts";
import { setModelRegistry, activeConfigDescription, chatComplete } from "../../lib/llm.ts";
import { applyPatches, intakeDir } from "../../lib/apply-patches.ts";
import { darwinDue, pendingSummary, darwinThreshold } from "../../lib/skill-state.ts";
import { appendUsage } from "../../lib/usage-store.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACT_CLI = join(REPO_ROOT, "scripts", "extract.ts");
const APPLY_CLI = join(REPO_ROOT, "scripts", "apply-patches.ts");
const DARWIN_CLI = join(REPO_ROOT, "scripts", "darwin-check.ts");
const DARWIN_SKILL = join(REPO_ROOT, "skills", "darwin-skill", "SKILL.md");
const INTEGRATE_GUIDE = join(REPO_ROOT, "design", "INTEGRATE_GUIDE.md");

/** detached spawn 抽取 CLI（quit 终采 / kb_harvest 共用）；fire-and-forget */
function spawnExtract(sessionFile: string): void {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", EXTRACT_CLI, sessionFile],
    { detached: true, stdio: "ignore", cwd: REPO_ROOT },
  );
  child.unref();
}

/** 后台收集日志的原子计数（kb status 用） */
function kbStats(): string {
  const atoms = loadAtoms();
  const draft = atoms.filter((a) => a.status === "draft").length;
  const published = atoms.filter((a) => a.status === "published").length;
  const pend = pendingSummary();
  const due = darwinDue().map((d) => `${d.domain}(${d.trigger || d.edits})`).join(", ") || "无";
  return (
    `atoms: ${atoms.length}（draft ${draft} / published ${published}）\n` +
    `待整合: ${pend.total}${pend.total ? `（${Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ")})` : ""}\n` +
    `体检待触发: ${due}\n` +
    `路径: ${atomsPath()}`
  );
}

/** 注入给 agent 的提示（无锁方案 1：原子即待办队列 + darwin 体检触发） */
function pendingNotice(): string | undefined {
  const parts: string[] = [];
  const pend = pendingSummary();
  if (pend.total > 0) {
    const byDomain = Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ");
    if (pend.total > 25) {
      parts.push(`[知识管道] 待整合原子 ${pend.total} 条（${byDomain}），超过增量阈值。` +
        `建议用户空闲时跑批量：node --experimental-strip-types ${REPO_ROOT}/scripts/assemble.ts && node --experimental-strip-types ${REPO_ROOT}/scripts/package-skill.ts --all`);
    } else {
      parts.push(`[知识管道] 有 ${pend.total} 条待整合知识原子（${byDomain}）。` +
        `若本会话任务完成后空闲，可按 ${INTEGRATE_GUIDE} 的流程将它们整合进 skills` +
        `（写提案到 ${intakeDir()} 后跑 ${APPLY_CLI}）。` +
        `不要在用户任务中途做，一次只整合一个域。忽略本提示也不影响正常工作。`);
    }
  }
  // darwin 体检触发：某 skill 增量修改达阈值
  const due = darwinDue();
  if (due.length > 0) {
    const list = due.map((d) => `${d.domain}(${d.edits}次)`).join(", ");
    parts.push(`[skill 体检] ${list} 自上次体检已累计增量修改 ≥ ${darwinThreshold()} 次，建议空闲时按 ${DARWIN_SKILL} ` +
      `的流程做一次体检（高频域可跑完整优化，长尾域先跑 Phase 0.5-1 评估即可）。` +
      `完成后运行 ${DARWIN_CLI} --done <domain> 记账。需要用户确认的检查点按该 skill 的流程走。`);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

export default function (pi: ExtensionAPI) {
  // ---------- 0a. session_start：注入 ModelRegistry + 消费提案队列 ----------
  let noticed = false; // 每会话只注入一次提示
  pi.on("session_start", async (_event, ctx) => {
    // 抽取引擎复用用户环境的 API 配置：凭据解析与主对话同链（auth.json/models.json/env）。
    // 默认模型跟随用户当前会话模型；后端 LLM 调用全部独立 fire-and-forget。
    try {
      await ctx.modelRegistry.refresh();
      const m = ctx.model;
      setModelRegistry(ctx.modelRegistry as never, m ? `${m.provider}/${m.id}` : undefined);
    } catch {
      setModelRegistry(ctx.modelRegistry as never); // refresh 失败不阻塞会话，getAvailable 自会处理
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
  pi.on("before_agent_start", async (event) => {
    if (noticed || event.messageType !== "user") return;
    noticed = true;
    const notice = pendingNotice();
    if (!notice) return;
    return {
      message: {
        customType: "kb_pending_notice",
        content: notice,
        display: "[知识管道] 有待整合知识原子 / skill 体检提示（详见注入内容）",
      },
    };
  });

  // ---------- 0c. tool_call hook：模型读取 SKILL.md → 记 loaded（usage 审计） ----------
  // 模糊匹配 JSON.stringify(input)：内置 read 与 codemode 读文件的参数形状不同，
  // stringify 后统一匹配对两者都成立；嵌套调用也走本 handler。漏记容忍（下界估计）。
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

  // ---------- 1. capture_knowledge：agent 单条声明 ----------
  const CaptureParams = Type.Object({
    category: StringEnum(["01", "02", "03", "04", "05"] as const, {
      description: "知识类别：01业务认知 02操作SOP 03模板骨架 04案例样例 05问题复盘",
    }),
    content: Type.String({ description: "知识内容：简洁、可独立复用、脱离本对话也能看懂" }),
    atom_type: Type.Optional(Type.String({ description: "切片名（如 根因切片）；不填则由内容推断归类" })),
    domain: Type.Optional(Type.String({ description: "业务域 kebab-case（如 gpu-train-ops）" })),
  });

  pi.registerTool({
    name: "capture_knowledge",
    label: "Capture Knowledge",
    description:
      "声明一条可复用知识原子存入本地知识库（draft，待后续组装成卡片）。" +
      "在刚发现有价值结论/踩坑/操作方法时调用；不要在批量罗列信息时调用。",
    promptSnippet: "capture_knowledge: 将刚产生的可复用知识（结论/踩坑/SOP/模板）存入知识库",
    parameters: CaptureParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const now = new Date().toISOString();
      const atom = {
        atom_id: atomId(params.content, []),
        category: params.category,
        atom_type: params.atom_type ?? "通用切片",
        content: params.content,
        domain: params.domain ?? "",
        sources: [],
        confidence: 0.8,
        version: 1,
        superseded_by: null,
        refs: [],
        status: "draft",
        extracted_at: now,
        extracted_by: "agent-tool",
      };
      // 幂等：同 content 已存在则不重复入库
      const dup = loadAtoms().some((a) => a.content === atom.content);
      if (!dup) appendAtoms([atom]);
      return {
        content: [{ type: "text", text: dup ? "已存在，跳过" : `已入库(draft): ${atom.atom_id}` }],
      };
    },
  });

  // ---------- 2. kb_harvest：收尾终采（fire-and-forget） ----------
  pi.registerTool({
    name: "kb_harvest",
    label: "KB Harvest",
    description:
      "后台启动本会话的知识抽取（独立进程，不阻塞对话）。" +
      "在任务收尾、或对话中积累了大量未捕获知识时调用；重复调用幂等（已抽窗口自动跳过）。",
    promptSnippet: "kb_harvest: 后台抽取本会话知识原子（收尾终采）",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      spawnExtract(sessionFile);
      return {
        content: [{ type: "text", text: `已后台启动抽取: ${sessionFile}\n${kbStats()}` }],
      };
    },
  });

  // ---------- 3. session_before_compact：compaction 抢救（唯一免审入口） ----------
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    const { preparation, signal } = event;
    const { firstKeptEntryId, tokensBefore, previousSummary } = preparation;

    // 被压缩区 = firstKeptEntryId 之前的 message entries（带真实 id，溯源用）
    const allEntries = ctx.sessionManager.getEntries() as Array<{ type: string; id?: string; [k: string]: unknown }>;
    const cutIdx = allEntries.findIndex((e) => e.id === firstKeptEntryId);
    const toSummarize = (cutIdx === -1 ? allEntries : allEntries.slice(0, cutIdx))
      .filter((e): e is import("../../lib/types.ts").MessageEntry =>
        e.type === "message" && typeof e.id === "string");

    if (toSummarize.length === 0) return; // 无可抢救，走默认 compaction

    ctx.ui.notify(
      `[knowledge-capture] compaction 抢救：${toSummarize.length} 条消息，抽取中（思考型模型可能需数分钟）…`,
      "info",
    );

    const rescue = await rescueAtoms(toSummarize, ctx.sessionManager.getSessionId(), signal);
    const savedIds = rescue.savedAtoms.map((a) => a.atom_id);

    let summary: string;
    try {
      summary = await generateCompactionSummary(toSummarize, previousSummary, savedIds, signal);
    } catch (err) {
      logError(`compaction summary生成失败: ${String(err).slice(0, 300)}`);
      // summary 失败但原子已救回：放行默认 compaction（不返回 compaction 字段）
      ctx.ui.notify(
        `[knowledge-capture] 已抢救 ${savedIds.length} 原子（summary 生成失败，走默认压缩）`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`[knowledge-capture] 抢救完成：${savedIds.length} 原子已 published`, "info");
    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { atoms: savedIds, sessionFile: ctx.sessionManager.getSessionFile() },
      },
    };
  });

  // ---------- 4. session_shutdown(quit)：终采 ----------
  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
    if (event.reason !== "quit") return; // reload/new/resume/fork 不是会话终点，跳过
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    spawnExtract(sessionFile);
    if (ctx.hasUI) ctx.ui.notify(`[knowledge-capture] 已后台启动终采: ${sessionFile}`, "info");
  });

  // ---------- /kb：知识库状态（最小实现） ----------
  pi.registerCommand("kb", {
    description: "知识库状态（原子计数与路径）",
    handler: async (_args, ctx) => {
      ctx.ui.notify(kbStats(), "info");
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

