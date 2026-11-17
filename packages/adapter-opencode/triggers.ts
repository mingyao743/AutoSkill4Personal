/**
 * 触发层：把 core 的编译编排接到 OpenCode 的四个入口（设计文档 §3.5）。
 *
 *   1. session.hook("prompt")     每条用户 prompt 入队时：推进 30 轮闸编译 + 每日技能检查
 *   2. ctx.event.subscribe(session.idle)  会话空闲：补跑尾窗（≥5 轮才值得编）
 *   3. session.hook("compaction") 压缩前抢救：把即将被抹掉的 transcript 编译掉
 *   4. qdoc_capture 工具          手动沉淀：跳过信号门，把剩余轮次一次编完
 *
 * 硬规则（与 adapter-pi 一致）：
 *  - 所有触发 fire-and-forget：编译失败绝不影响主对话（void + logError）
 *  - 编译走 core/trigger/cycle.ts 的 maybeCompile——30 轮闸、预算闸、两级锁不绕行
 *  - 手动（qdoc_capture）是唯一跳过信号门的路径（方案 §6.5），同样不绕锁与预算
 */
import { logError } from "../../packages/core/lib/base/atom-store.ts";
import { maybeCompile, EXTRACT_EVERY_N_TURNS, type CycleOutcome } from "../../packages/core/lib/trigger/cycle.ts";
import { indexTurns, remainingTurns } from "../../packages/core/lib/trigger/turns.ts";
import { getSessionState, sessionKey } from "../../packages/core/lib/trigger/state.ts";
import { resolveVault } from "../../packages/core/lib/vault/init.ts";
import { maybeAutoSync } from "../../packages/core/lib/sync/auto-check.ts";
import { findRepoRoot } from "../../packages/core/lib/sync/drift.ts";
import type { MessageEntry } from "../../packages/core/lib/base/types.ts";
import { mapSessionMessages, type MappedSession } from "./messages.ts";
import { setActiveSession, getActiveSession } from "./completer.ts";
import { COMPILER_SKILL_DIR } from "./host.ts";
import { maybeAutoUpdate } from "./auto-update.ts";
import type { OcCompactionEvent, OcPluginContext, OcSessionInfo } from "./types.ts";

function fmt(e: unknown): string {
  return String(e).slice(0, 200);
}

function log(msg: string): void {
  // 服务进程没有 ui.notify 可用：进 stderr（opencode 服务日志可见）
  console.error(`[autoskill] ${msg}`);
}

/** 提示：自动同步/自动更新只在有话要说时调用 */
function notify(msg: string, level: "info" | "warning"): void {
  log(`${level === "warning" ? "⚠️" : "ℹ️"} ${msg}`);
}

// ---------------- 会话快照 ----------------

export interface SessionSnapshot {
  session?: OcSessionInfo;
  mapped: MappedSession;
  /** 会话 cwd（决定 vault）；session.directory 优先，退到插件位置，再退到进程 cwd */
  cwd: string;
  model?: { providerID: string; id: string };
}

export async function sessionSnapshot(ctx: OcPluginContext, sessionID: string): Promise<SessionSnapshot> {
  let session: OcSessionInfo | undefined;
  try {
    session = await ctx.session.get({ sessionID });
  } catch {
    // 会话可能已关闭；context 仍可能可读
  }
  const raw = await ctx.session.context({ sessionID });
  const mapped = mapSessionMessages(raw);
  const cwd = session?.directory ?? ctx.location?.directory ?? process.cwd();
  const model = session?.model;
  return { session, mapped, cwd, model };
}

// ---------------- 编译入口 ----------------

export interface CycleOptions {
  manual?: boolean;
  /** 覆盖轮次阈值；手动路径传「剩余全部」 */
  turns?: number;
}

/** 用现成快照跑一轮编译（prompt / idle / compaction / 手动四个入口共用） */
export async function runCycleFromSnapshot(
  snap: SessionSnapshot,
  sessionID: string,
  reason: string,
  opts: CycleOptions = {},
): Promise<CycleOutcome | null> {
  if (snap.mapped.entries.length === 0) return null;
  const outcome = await maybeCompile({
    agent: "opencode",
    sessionId: sessionID,
    events: snap.mapped.events,
    entries: snap.mapped.entries as unknown as Array<MessageEntry & { seq: number }>,
    cwd: snap.cwd,
    skillDir: COMPILER_SKILL_DIR,
    autoInit: process.env.OW_AUTO_INIT === "1",
    manual: opts.manual,
    turns: opts.turns,
  });
  // 静默原则：只有真的编译了或有异常才留痕；not-enough-turns 这类常态不出声
  if (outcome.status === "compiled" || outcome.status === "already-compiled") {
    log(`cycle(${reason}) ${outcome.status}：${outcome.window.turns} 轮 → ${outcome.report.pages_created} 新页 / ${outcome.report.pages_updated} 更新`);
  } else if (outcome.status === "error") {
    logError(`[autoskill] cycle(${reason}) 失败: ${outcome.error.slice(0, 200)}`);
  } else if (outcome.status !== "not-enough-turns" && outcome.status !== "no-signal") {
    log(`cycle(${reason}) → ${outcome.status}`);
  }
  return outcome;
}

/** 快照 + 编译一步到位（idle / compaction 用） */
export async function maybeRunCycle(
  ctx: OcPluginContext,
  sessionID: string,
  reason: string,
  opts: CycleOptions = {},
): Promise<CycleOutcome | null> {
  try {
    const snap = await sessionSnapshot(ctx, sessionID);
    return await runCycleFromSnapshot(snap, sessionID, reason, opts);
  } catch (e) {
    logError(`[autoskill] cycle(${reason}) 失败: ${fmt(e)}`);
    return null;
  }
}

// ---------------- 每日技能检查 + 仓库自动更新（prompt 入口顺带） ----------------

async function dailyChecks(cwd: string): Promise<void> {
  if (process.env.OW_AUTO_CHECK === "0") return;
  const vaultDir = resolveVault({ cwd, autoInit: false })?.dir;
  try {
    await maybeAutoSync({ host: "opencode", vaultDir, notify });
  } catch (e) {
    logError(`[autoskill] autoSync(opencode) 失败: ${fmt(e)}`);
  }
  if (process.env.AUTOSKILL_AUTO_UPDATE === "1") {
    try {
      await maybeAutoUpdate({ repoRoot: findRepoRoot(), reloadSkills: () => currentCtx?.skill?.reload?.() });
    } catch (e) {
      logError(`[autoskill] autoUpdate 失败: ${fmt(e)}`);
    }
  }
}

// ---------------- 压缩前抢救 ----------------

/** compaction 钩子：把即将被压缩的 transcript 编译掉（绝不写 event.result，不抢宿主的总结） */
async function rescueBeforeCompaction(ctx: OcPluginContext, event: OcCompactionEvent): Promise<void> {
  try {
    const sessionID = event?.sessionID ?? getActiveSession();
    if (!sessionID || !Array.isArray(event?.messages) || event.messages.length === 0) return;
    const mapped = mapSessionMessages(event.messages);
    if (mapped.entries.length === 0) return;
    const snap = await sessionSnapshot(ctx, sessionID);
    await runCycleFromSnapshot(
      { ...snap, mapped },
      sessionID,
      "compaction",
    );
  } catch (e) {
    logError(`[autoskill] compaction 抢救失败: ${fmt(e)}`);
  }
}

// ---------------- 手动沉淀（qdoc_capture 工具） ----------------

export type ManualOutcome = { status: "no-session" | "no-snapshot" | "no-vault" | "nothing-pending" } | CycleOutcome;

/**
 * 手动沉淀：把当前会话剩余未编译的轮次一次编完（跳过信号门与尾窗门槛，
 * 30 轮闸以 turns=remaining 覆盖；预算闸与两级锁照常）。
 */
export async function manualCapture(ctx: OcPluginContext, sessionID: string | null | undefined): Promise<ManualOutcome> {
  if (!sessionID) return { status: "no-session" };
  setActiveSession(sessionID);
  let snap: SessionSnapshot;
  try {
    snap = await sessionSnapshot(ctx, sessionID);
  } catch (e) {
    logError(`[autoskill] qdoc_capture 读取会话失败: ${fmt(e)}`);
    return { status: "no-snapshot" };
  }
  if (snap.mapped.entries.length === 0) return { status: "nothing-pending" };
  const vault = resolveVault({ cwd: snap.cwd, autoInit: process.env.OW_AUTO_INIT === "1" });
  if (!vault) return { status: "no-vault" };
  const index = indexTurns(snap.mapped.events, sessionID, "opencode");
  const key = sessionKey("opencode", sessionID);
  const remaining = remainingTurns(index, getSessionState(vault.dir, key).compiled_to_turn);
  if (remaining === 0) return { status: "nothing-pending" };
  return (await runCycleFromSnapshot(snap, sessionID, "manual", { manual: true, turns: remaining })) ?? { status: "nothing-pending" };
}

/** CycleOutcome → 给模型/用户看的中文说明（qdoc_capture 的工具返回） */
export function describeOutcome(outcome: ManualOutcome): string {
  if (outcome.status === "no-session") return "无法确定会话 ID（当前没有活动会话）";
  if (outcome.status === "no-snapshot") return "读取会话内容失败";
  if (outcome.status === "no-vault") return "当前目录没有知识库（在项目里跑 `ow init` 可初始化）";
  if (outcome.status === "nothing-pending") return "没有待编译的新轮次";
  switch (outcome.status) {
    case "compiled":
      return `✅ 已编译 ${outcome.window.turns} 轮（第 ${outcome.window.from_turn}–${outcome.window.to_turn} 轮）：新建 ${outcome.report.pages_created} 页、更新 ${outcome.report.pages_updated} 页${outcome.report.publish_candidates.length > 0 ? `，${outcome.report.publish_candidates.length} 页待发布（小q 发布）` : ""}`;
    case "already-compiled":
      return "这一段之前已经编译过，水位已推进";
    case "not-enough-turns":
      return `还不够一窗（已有 ${outcome.pending} 轮，满 ${outcome.need} 轮自动编译）`;
    case "no-signal":
      return "这段对话信号不足（纯检索/闲聊），已跳过；可稍后再试";
    case "self-trigger":
      return "当前会话在知识库内部，跳过（防自触发）";
    case "machine-busy":
    case "vault-busy":
      return "另一个会话正在编译，稍后再试";
    case "budget-exhausted":
      return `编译预算已用尽：${outcome.reason}`;
    case "no-vault":
      return "当前目录没有知识库（在项目里跑 `ow init` 可初始化）";
    case "error":
      return `编译失败：${outcome.error.slice(0, 200)}`;
    default:
      return `未预期的结果：${JSON.stringify(outcome).slice(0, 200)}`;
  }
}

// ---------------- 注册 ----------------

export interface Registration {
  dispose: () => void;
}

/** registerTriggers 期间收下 ctx，供 dailyChecks 的热载回调使用 */
let currentCtx: OcPluginContext | null = null;

/**
 * 注册全部触发点。setup 里 await 一次即可；返回的 dispose 在插件卸载时调用。
 * 每个注册点独立 try/catch——OpenCode 某个 API 缺席时只损失该入口，不炸整个插件。
 */
export async function registerTriggers(ctx: OcPluginContext): Promise<Registration> {
  currentCtx = ctx;

  // 1) prompt：每条用户 prompt 入队 → 推进编译 + 每日检查（fire-and-forget，不阻塞回答）
  try {
    ctx.session.hook("prompt", (event) => {
      const sessionID = event?.sessionID ?? null;
      if (!sessionID) return;
      setActiveSession(sessionID);
      void (async () => {
        try {
          const snap = await sessionSnapshot(ctx, sessionID);
          await runCycleFromSnapshot(snap, sessionID, "turn");
          await dailyChecks(snap.cwd);
        } catch (e) {
          logError(`[autoskill] prompt 触发失败: ${fmt(e)}`);
        }
      })();
    });
  } catch (e) {
    logError(`[autoskill] 注册 prompt 钩子失败: ${fmt(e)}`);
  }

  // 2) session.idle：空闲补跑尾窗（maybeCompile 内部自带 ≥5 轮门槛）
  let closed = false;
  const idleLoop = (async () => {
    try {
      const stream = ctx.event.subscribe({ types: ["session.idle"] });
      for await (const evt of stream) {
        if (closed) break;
        const sessionID = evt?.properties?.sessionID;
        if (!sessionID) continue;
        setActiveSession(sessionID);
        void maybeRunCycle(ctx, sessionID, "idle");
      }
    } catch (e) {
      if (!closed) logError(`[autoskill] idle 订阅中断: ${fmt(e)}`);
    }
  })();
  void idleLoop;

  // 3) compaction：压缩前抢救（只读 messages，绝不写 event.result）
  try {
    ctx.session.hook("compaction", (event) => {
      void rescueBeforeCompaction(ctx, event ?? {});
    });
  } catch (e) {
    logError(`[autoskill] 注册 compaction 钩子失败: ${fmt(e)}`);
  }

  // 4) qdoc_capture 工具：模型可主动调用，用户说「小q 沉淀」时模型走这里
  try {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "qdoc_capture",
        description:
          "把当前会话沉淀成 qdoc 知识页：立即编译剩余未编译的轮次（跳过降噪信号门，预算与锁照常）。用户说「小q 沉淀/记一下」或要求保存会话知识时调用。",
        input: { type: "object", properties: {}, required: [], additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, context) => {
          const sessionID = context?.sessionID ?? getActiveSession();
          const outcome = await manualCapture(ctx, sessionID);
          return { content: describeOutcome(outcome) };
        },
      });
    });
  } catch (e) {
    logError(`[autoskill] 注册 qdoc_capture 工具失败: ${fmt(e)}`);
  }

  return {
    dispose: () => {
      closed = true;
      currentCtx = null;
    },
  };
}

/** 供测试/诊断：确认触发层已装载时能看到的常量 */
export const TRIGGER_TURNS = EXTRACT_EVERY_N_TURNS;
