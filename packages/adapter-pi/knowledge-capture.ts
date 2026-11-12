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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { setHostContext } from "../../packages/core/lib/context.ts";
import {
  atomId, appendAtoms, atomsPath, loadAtoms, logError, type KnowledgeAtom,
} from "../../packages/core/lib/atom-store.ts";
import {
  admissionGate, categoryForType, declaredSource, defaultAtomType, ensureTypeFields, isDocType, keepAsForType, labelForType,
} from "../../packages/core/lib/admission.ts";
import { validateAtom } from "../../packages/core/lib/validate.ts";
import { rescueAtoms, generateCompactionSummary } from "../../packages/core/lib/compaction-rescue.ts";
import { setModelRegistry, activeConfigDescription, chatComplete } from "../../packages/core/lib/llm.ts";
import { applyPatches, intakeDir } from "../../packages/core/lib/apply-patches.ts";
import { darwinDue, pendingSummary, darwinThreshold } from "../../packages/core/lib/skill-state.ts";
import { compileDue } from "../../packages/core/lib/compile-skill.ts";
import { lastCompileHashes } from "../../packages/core/lib/compile-state.ts";
import { appendUsage } from "../../packages/core/lib/usage-store.ts";
import { coverageReport } from "../../packages/core/lib/coverage.ts";
import { runPipeline } from "../../packages/core/lib/pipeline.ts";
import type { MessageEntry } from "../../packages/core/lib/types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PIPELINE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "pipeline.ts");
const EXTRACT_CLI = join(REPO_ROOT, "packages", "core", "scripts", "extract.ts"); // 仅手动回填用
const APPLY_CLI = join(REPO_ROOT, "packages", "core", "scripts", "apply-patches.ts");
const DARWIN_CLI = join(REPO_ROOT, "packages", "core", "scripts", "darwin-check.ts");
const DARWIN_SKILL = join(REPO_ROOT, "skills", "darwin-skill", "SKILL.md");
const INTEGRATE_GUIDE = join(REPO_ROOT, "design", "INTEGRATE_GUIDE.md");
const COMPILE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "compile-skills.ts");
const COMPILE_DESIGN = join(REPO_ROOT, "design", "SKILL_COMPILER.md");

// adapter-pi 宿主上下文注入（v2：数据目录/凭据基准/skills 输出全部住在 pi 命名空间内）。
// extension 进程内首次调用时注入；spawn CLI 各自进程靠 AUTOSKILL_DATA_DIR/AUTOSKILL_HOME 环境传递。
setHostContext({
  host: "pi",
  dataDir: process.env.KB_DIR ?? join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge"),
  homeDir: join(homedir(), ".pi", "agent"),
  modelsPath: process.env.PI_MODELS_PATH,
  settingsPath: join(homedir(), ".pi", "agent", "settings.json"),
});

/**
 * detached spawn 知识管线 CLI（quit / kb_harvest 共用）；fire-and-forget。
 * 管线自带覆盖派生：只处理未审消息，重复调用不会重复消耗。
 */
function spawnPipeline(sessionFile: string, opts: { maxBatches?: number; budget?: number } = {}): void {
  const dataDir = process.env.KB_DIR ?? join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge");
  const home = join(homedir(), ".pi", "agent");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types", PIPELINE_CLI, sessionFile,
      "--data-dir", dataDir, "--home", home,
      "--mode", "incremental",
      "--max-batches", String(opts.maxBatches ?? 3),
      "--budget", String(opts.budget ?? 60_000),
    ],
    {
      detached: true, stdio: "ignore", cwd: REPO_ROOT,
      env: {
        ...process.env,
        AUTOSKILL_DATA_DIR: dataDir,
        AUTOSKILL_HOME: home,
        PI_MODELS_PATH: process.env.PI_MODELS_PATH ?? "",
      },
    },
  );
  child.unref();
}

// ---------- 进程内管线（每轮异步推进，不阻塞对话） ----------
let pipelineRunning = false;
const PIPELINE_MIN_PENDING = 30; // 待审消息少于 30 条不跑（唯一节流条件，不设时间下限）

/**
 * 每轮之后异步推进知识管线（覆盖派生 → 抽取触发机制 → 知识抽取）。
 * 触发只看"待审 ≥30 条"：跑完覆盖水位前移、待审归零，天然防抖，不需要时间下限；
 * 不并发由 pipelineRunning 保证。一次最多 1 批、预算 40k；失败只记日志，绝不打断对话。
 */
async function maybeRunPipeline(ctx: unknown, reason: string): Promise<void> {
  if (pipelineRunning) return;
  const sm = (ctx as {
    sessionManager?: {
      getSessionId?: () => string;
      getEntries?: () => Array<{ type?: string; id?: string }>;
    };
  })?.sessionManager;
  const id = sm?.getSessionId?.();
  const all = sm?.getEntries?.() ?? [];
  const entries = all.filter((e) => e?.type === "message" && typeof e?.id === "string") as unknown as MessageEntry[];
  if (!id || entries.length === 0) return;
  const cov = coverageReport(entries, id);
  if (cov.unreviewed < PIPELINE_MIN_PENDING) return;

  pipelineRunning = true;
  try {
    const report = await runPipeline({
      sessionId: id,
      entries,
      harness: "pi",
      maxBatches: 1,
      budgetTokens: 40_000,
    });
    const ui = (ctx as { ui?: { notify?: (m: string, type?: string) => void } }).ui;
    if (report.atoms > 0) ui?.notify?.(`[知识管道] 知识抽取 ${report.atoms} 条知识（${reason}）`, "info");
  } catch (e) {
    logError(`pipeline(${reason}) 失败: ${String(e).slice(0, 200)}`);
  } finally {
    pipelineRunning = false;
  }
}

/** 后台收集日志的知识卡片计数（kb status 用） */
function kbStats(): string {
  const atoms = loadAtoms();
  const draft = atoms.filter((a) => a.status === "draft").length;
  const published = atoms.filter((a) => a.status === "published").length;
  const pend = pendingSummary();
  const due = darwinDue().map((d) => `${d.domain}(${d.trigger || d.edits})`).join(", ") || "无";
  const compile = compileDue(atoms, lastCompileHashes(), { limit: 10_000 }).map((d) => d.skillName).join(", ") || "无";
  return (
    `atoms: ${atoms.length}（draft ${draft} / published ${published}）\n` +
    `待整合: ${pend.total}${pend.total ? `（${Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ")})` : ""}\n` +
    `体检待触发: ${due}\n` +
    `可编译: ${compile}\n` +
    `路径: ${atomsPath()}`
  );
}

/** 当前会话 id（拿不到时用固定占位：来源仍可追溯，且不会伪造真实窗口） */
function safeSessionId(ctx: unknown): string {
  try {
    const id = (ctx as { sessionManager?: { getSessionId?: () => string } })?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? id : "unknown-session";
  } catch {
    return "unknown-session";
  }
}

/** 会话里最后一条 message 的 id（声明型来源的溯源锚点） */
function lastMessageId(ctx: unknown): string | undefined {
  try {
    const entries = (ctx as { sessionManager?: { getEntries?: () => Array<{ type?: string; id?: string }> } })
      ?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "message" && typeof e.id === "string") return e.id;
    }
  } catch {
    // 取不到就不带锚点，来源降级到 session 级
  }
  return undefined;
}

/** 项目名（消息可读性用）：当前工作目录名 */
function projectName(): string {
  return process.cwd().split("/").filter(Boolean).pop() ?? "当前项目";
}

/** 注入给 agent 的提示（无锁方案 1：知识卡片即待办队列 + darwin 体检触发） */
function pendingNotice(): string | undefined {
  const parts: string[] = [];
  const pend = pendingSummary();
  if (pend.total > 0) {
    const byDomain = Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ");
    if (pend.total > 25) {
      parts.push(`[知识管道] 待整合知识卡片 ${pend.total} 条（${byDomain}），超过增量阈值。` +
        `建议用户空闲时跑批量：node --experimental-strip-types ${REPO_ROOT}/packages/core/scripts/assemble.ts && node --experimental-strip-types ${REPO_ROOT}/packages/core/scripts/package-skill.ts --all`);
    } else {
      parts.push(`[知识管道] 有 ${pend.total} 条待整合知识卡片（${byDomain}）。` +
        `若本会话任务完成后空闲，可按 ${INTEGRATE_GUIDE} 的流程将它们整合进 skills` +
        `（写提案到 ${intakeDir()} 后跑 ${APPLY_CLI}）。` +
        `不要在用户任务中途做，一次只整合一个主题。忽略本提示也不影响正常工作。`);
    }
  }
  // darwin 体检触发：某 skill 增量修改达阈值
  const due = darwinDue();
  if (due.length > 0) {
    const list = due.map((d) => `${d.domain}(${d.edits}次)`).join(", ");
    parts.push(`[skill 体检] ${list} 自上次体检已累计增量修改 ≥ ${darwinThreshold()} 次，建议空闲时按 ${DARWIN_SKILL} ` +
      `的流程做一次体检（高频主题可跑完整优化，长尾主题先跑 Phase 0.5-1 评估即可）。` +
      `完成后运行 ${DARWIN_CLI} --done <domain> 记账。需要用户确认的检查点按该 skill 的流程走。`);
  }
  // 技能编译：已过就绪门且内容有变化的主题（确定性检查，不调 LLM）
  try {
    const compile = compileDue(loadAtoms(), lastCompileHashes(), { limit: 5 });
    if (compile.length > 0) {
      const list = compile.map((d) => `${d.skillName}(${d.atoms}张/${d.sessions}会话)`).join(", ");
      parts.push(`[技能编译] ${list} 已过就绪门且内容有变化。空闲时按 ${COMPILE_DESIGN} 的流程：` +
        `跑 ${COMPILE_CLI} --domain <主题> 生成编译简报 → 交给 create-skill 产出 SKILL.md → ` +
        `用 --validate 过确定性关卡 → --apply 写 intake 提案。不要在用户任务中途做。`);
    }
  } catch {
    // 提示失败不影响会话
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
  pi.on("before_agent_start", async (event, ctx) => {
    // 用户轮开始前异步推进管线（内部有 10 分钟 + 30 条待审的双重节流）
    if (event.messageType === "user") void maybeRunPipeline(ctx, "turn");
    if (noticed || event.messageType !== "user") return;
    noticed = true;
    const notice = pendingNotice();
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

  // ---------- 1. capture_knowledge：agent 单条声明（过准入规则 + 校验，不再免检） ----------
  const CaptureParams = Type.Object({
    doc_type: StringEnum(["sop", "spec", "template", "case", "postmortem", "convention", "index", "rubric"] as const, {
      description:
        "文档类型：sop操作SOP / spec口径契约 / template模板骨架 / case案例资料 / postmortem问题复盘 / convention环境约定 / index索引线索 / rubric判据标准",
    }),
    content: Type.String({ description: "知识内容：简洁、可独立复用、脱离本对话也能看懂" }),
    why: Type.String({ description: "价值理由：不存会损失什么（具体后果，≥8 字）" }),
    domain: Type.Optional(Type.String({ description: "业务主题 kebab-case（如 gpu-train-ops）；不填记为 general" })),
    atom_type: Type.Optional(Type.String({ description: "可选细标签（如 根因切片）" })),
    expires_when: Type.Optional(Type.String({ description: "失效条件（convention / index 必填，如：目录重构后失效）" })),
    keep_as: Type.Optional(Type.String({ description: "case 专用：reference（参考案例）或 data（客户资料/真实事实，需脱敏）" })),
  });

  pi.registerTool({
    name: "capture_knowledge",
    label: "Capture Knowledge",
    description:
      "声明一条可复用知识卡片存入本地知识库（带类型与价值理由，待后续组装）。" +
      "在刚发现有价值结论/踩坑/操作方法/模板/资料时调用；不要在批量罗列信息时调用。",
    promptSnippet: "capture_knowledge: 将刚产生的可复用知识（结论/踩坑/SOP/模板/资料）存入知识库",
    parameters: CaptureParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        doc_type: string; content: string; why: string; domain?: string; atom_type?: string; expires_when?: string; keep_as?: string;
      };
      if (!isDocType(p.doc_type)) {
        return {
          content: [{
            type: "text",
            text: `未入库：doc_type "${p.doc_type}" 非法。只允许 sop/spec/template/case/postmortem/convention/index/rubric。`,
          }],
        };
      }
      const sessionId = safeSessionId(ctx);
      const source = declaredSource(sessionId, lastMessageId(ctx));
      const atom: KnowledgeAtom = {
        atom_id: atomId(p.content, [source]),
        category: categoryForType(p.doc_type),
        atom_type: p.atom_type ?? defaultAtomType(p.doc_type),
        content: p.content,
        domain: (p.domain ?? "").trim() || "general",
        sources: [source],
        confidence: 0.8,
        version: 1,
        superseded_by: null,
        refs: [],
        status: "draft",
        extracted_at: new Date().toISOString(),
        extracted_by: "agent-tool",
        doc_type: p.doc_type,
        keep_as: p.doc_type === "case" && p.keep_as === "data" ? "data" : keepAsForType(p.doc_type),
        why: p.why,
        expires_when: p.expires_when ? p.expires_when.trim() : null,
      };
      // 结构化字段用 content 兜底（工具入参没有 step/concept_name 等字段）
      ensureTypeFields(atom);
      // 准入规则（无来源/敏感信息/价值理由）+ 结构校验：声明型入口不再免检
      const gate = admissionGate(atom, { requireWhy: true });
      if (!gate.ok) {
        return { content: [{ type: "text", text: `未入库：${gate.reasons.join("；")}` }] };
      }
      const v = validateAtom(atom, []);
      if (!v.ok) {
        return { content: [{ type: "text", text: `未入库：${v.errors.join("；")}` }] };
      }
      // 幂等：同 content 已存在则不重复入库
      const dup = loadAtoms().some((a) => a.content === atom.content);
      if (!dup) appendAtoms([atom]);
      return {
        content: [{
          type: "text",
          text: dup
            ? `已存在，跳过（${labelForType(p.doc_type)}）`
            : `已记录 1 条「${labelForType(p.doc_type)}」→ ${atom.domain || "未标主题"}（草稿，待整合）${atom.keep_as === "data" ? "｜资料层，不进技能正文" : ""}`,
        }],
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
    promptSnippet: "kb_harvest: 后台抽取本会话知识卡片（收尾终采）",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      spawnPipeline(sessionFile, { maxBatches: 2, budget: 40_000 });
      return {
        content: [{
          type: "text",
          text: `已开始发现并抽取「${projectName()}」会话的知识（后台运行，只处理未审消息）。\n${kbStats()}`,
        }],
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
      .filter((e): e is MessageEntry => e.type === "message" && typeof e.id === "string");

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
      // summary 失败但知识卡片已救回：放行默认 compaction（不返回 compaction 字段）
      ctx.ui.notify(
        `[knowledge-capture] 已抢救 ${savedIds.length} 知识卡片（summary 生成失败，走默认压缩）`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`[knowledge-capture] 抢救完成：${savedIds.length} 知识卡片已 published`, "info");
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
    spawnPipeline(sessionFile, { maxBatches: 3, budget: 60_000 });
    if (ctx.hasUI) ctx.ui.notify(`[知识管道] 已开始整理「${projectName()}」会话的知识（后台）`, "info");
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
      ctx.ui.notify(kbStats() + extra, "info");
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

