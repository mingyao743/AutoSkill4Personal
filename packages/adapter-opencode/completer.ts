/**
 * LLM 调用直连：把 core 的 ChatCompleter 注入点接到 OpenCode 会话模型（设计文档 §3.4）。
 *
 * 为什么不走 core 的 standalone 降级链：OpenCode 的凭据（auth.json / provider 配置）
 * 在宿主手里，core 读不到；宿主的 generate API 恰好是「不进历史、不起工具、
 * 用会话当前模型」的瞬态调用——正是编译内核想要的形态。
 *
 * 链路（设计文档 §3.4）：
 *   1. ctx.experimental.generate.text({ model: 会话当前模型, prompt })   ← 首选
 *   2. ctx.session.generate({ sessionID, prompt })                       ← 回退（experimental 不稳定）
 *
 * 会话 ID 从哪来：编译都发生在某个会话的钩子里，triggers 在钩子入口调
 * setActiveSession；completer 调用时读取。ChatOptions 没有 session 字段，
 * 这是与 ChatCompleter 抽象对齐的最小侵入做法。
 */
import type { ChatCompleter } from "../../packages/core/lib/base/llm.ts";
import type { OcModelRef, OcSessionInfo } from "./types.ts";

let activeSessionID: string | null = null;

/** 触发层在每次会话钩子入口更新（prompt / idle / compaction / qdoc_capture） */
export function setActiveSession(sessionID: string | null): void {
  activeSessionID = sessionID;
}

export function getActiveSession(): string | null {
  return activeSessionID;
}

export interface CompleterDeps {
  /** 读会话当前模型；缺模型时直接走回退（generate.text 必须给 model） */
  getModel: (sessionID: string) => Promise<OcModelRef | undefined>;
  /** ctx.experimental.generate.text 包装 */
  generateText: (opts: { model?: OcModelRef; prompt: string }) => Promise<{ text?: string }>;
  /** ctx.session.generate 包装 */
  sessionGenerate: (opts: { sessionID: string; prompt: string }) => Promise<{ text?: string }>;
}

function modelLabel(model?: OcModelRef): string {
  return model?.providerID && model?.id ? `${model.providerID}/${model.id}` : "opencode";
}

/** 组装 core 需要的 ChatCompleter（依赖注入，测试可用假 deps） */
export function createChatCompleter(deps: CompleterDeps): ChatCompleter {
  return async (opts) => {
    const sessionID = activeSessionID;
    if (!sessionID) {
      throw new Error("opencode completer: 无活动会话（setActiveSession 未设置）");
    }
    const prompt = `${opts.system}\n\n${opts.user}`;

    // 1) experimental.generate.text：不进历史、不起工具、会话当前模型
    if (deps.getModel && deps.generateText) {
      try {
        const model = (await deps.getModel(sessionID)) ?? undefined;
        if (model?.providerID && model?.id) {
          const r = await deps.generateText({ model, prompt });
          const text = (r?.text ?? "").trim();
          if (text) return { text, model: modelLabel(model) };
        }
      } catch {
        // experimental 不稳定是设计文档明示的风险——静默落到回退，不上抛
      }
    }

    // 2) 回退：会话内瞬态生成（同样不进历史）
    const r2 = await deps.sessionGenerate({ sessionID, prompt });
    const text2 = (r2?.text ?? "").trim();
    if (!text2) throw new Error("opencode completer: 两种生成通道都返回空");
    return { text: text2, model: "session.generate" };
  };
}

/** 从会话信息里安全取模型（session.get 失败/缺字段都不抛） */
export async function sessionModel(
  get: (input: { sessionID: string }) => Promise<OcSessionInfo>,
  sessionID: string,
): Promise<OcModelRef | undefined> {
  try {
    const m = (await get({ sessionID }))?.model;
    return m && typeof m.providerID === "string" && typeof m.id === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}
