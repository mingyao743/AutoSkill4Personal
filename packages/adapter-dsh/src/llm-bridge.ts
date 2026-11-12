/**
 * dsh 宿主 LLM 桥（bug 6）：把 ctx.llm 接进 core 的 chatComplete。
 *
 * 为什么必须有：dsh 的凭据在宿主自己的 profile/.credentials.yaml 里，不存在 models.json；
 * 而 dsh 适配层 spawn 子进程时带 `--no-home`（宿主独立原则，不读 ~/.pi），于是 standalone
 * 降级链在 dsh 里只剩 OPENAI_API_KEY 一条路。实测 `~/.dsh/data/autoskill/knowledge/errors.log`
 * 里全是 "未找到可用 LLM 配置" —— compaction 抢救一次都没成功过。
 *
 * 做法：不复制凭据、不猜配置路径，直接调宿主服务 `ctx.llm`（provider 无关的流式调用）。
 *   - 路由选择：显式配置 > 从 agent 记住的当前路由（compaction 阶段能拿到）> 宿主首个 provider
 *   - 请求：system + user 各一条消息（dsh-llm 的 GenerateOptions.messages 接受 request-only user）
 *   - 取消：透传 signal；宿主 finish 的 error/aborted 转成 throw，交给 core 记 errors.log
 *   - usage：inputTokens/outputTokens/totalTokens；网关不回 usage 时省略（只影响预算统计）
 *
 * dispatch：spawn CLI 仍然优先（隔离、不占宿主事件循环）；只有 standalone 凭据不可用时，
 * 才退回“进程内管线”（tools.ts runPipelineInProcess），那条路走本桥。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
	clearChatCompleter, extractJsonFromText, setChatCompleter,
	type ChatOptions, type ChatResult, type ChatUsage,
} from "../../core/lib/llm.ts";

/** dsh-llm 的结构子集（不 import 运行时，避免给适配层加硬依赖/类型漂移） */
interface DshStreamChunk {
	type: string;
	text?: string;
	usage?: Record<string, number>;
	reason?: { kind?: string; failure?: { code?: string; message?: string } };
}

export interface DshLlmService {
	listProviders(): Array<{ provider: string }>;
	listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>;
	stream(options: Record<string, unknown>): AsyncIterable<DshStreamChunk>;
}

export interface LlmBridgeConfig {
	/** 显式 provider；默认跟随当前会话路由，再退回宿主首个路由 */
	provider?: string;
	/** 显式 model；`provider/model` 形式也可（只在这个调用里覆盖 provider） */
	model?: string;
	/** 抽取调用的输出上限；不传走适配器默认 */
	maxTokens?: number;
}

export interface LlmTarget {
	provider: string;
	model: string;
}

/** compaction 阶段能拿到 agent 的当前路由，记下来给后续抽取调用复用 */
let remembered: LlmTarget | undefined;

export function rememberLlmTarget(agent: unknown): void {
	try {
		const a = agent as {
			options?: { provider?: string; model?: string };
			session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined };
		} | undefined;
		const header = a?.session?.requestHeader?.();
		const provider = a?.options?.provider ?? header?.config?.provider;
		const model = a?.options?.model ?? header?.config?.model;
		if (typeof provider === "string" && provider && typeof model === "string" && model) {
			remembered = { provider, model };
		}
	} catch {
		// 拿不到路由不致命：resolveTarget 会退回宿主首个 provider
	}
}

/** 仅供测试/诊断：读当前记住的路由 */
export function rememberedTarget(): LlmTarget | undefined {
	return remembered;
}

async function resolveTarget(
	llm: DshLlmService,
	config: LlmBridgeConfig,
	explicitModel?: string,
): Promise<LlmTarget> {
	const routes = (llm.listProviders() ?? []).map((r) => r?.provider).filter((p): p is string => typeof p === "string" && p.length > 0);
	if (routes.length === 0) throw new Error("dsh llm 服务未注册任何 provider 路由");

	// 显式 `provider/model` 只在路由存在时覆盖 provider，避免把整串当模型名发给错路由
	if (explicitModel && explicitModel.includes("/")) {
		const at = explicitModel.indexOf("/");
		const p = explicitModel.slice(0, at);
		const m = explicitModel.slice(at + 1);
		if (p && m && routes.includes(p)) return { provider: p, model: m };
	}

	let provider = config.provider ?? remembered?.provider ?? routes[0];
	if (!routes.includes(provider)) provider = routes[0];

	let model = explicitModel && !explicitModel.includes("/")
		? explicitModel
		: config.model ?? (remembered && remembered.provider === provider ? remembered.model : undefined);
	if (!model) {
		let models: Array<{ id: string }> = [];
		try {
			models = await llm.listModels(provider);
		} catch {
			// 目录不可用不影响核心路由（dsh-llm 允许 unlisted model id），但没名字就没法发请求
		}
		model = models[0]?.id;
	}
	if (!model) throw new Error(`dsh llm provider "${provider}" 没有可用模型（配置 llm.model 可显式指定）`);
	return { provider, model };
}

function mapUsage(raw: Record<string, number> | undefined): ChatUsage | undefined {
	if (!raw) return undefined;
	const n = (k: string): number => (typeof raw[k] === "number" ? raw[k] : 0);
	const promptTokens = n("inputTokens") || n("promptTokens");
	const completionTokens = n("outputTokens") || n("completionTokens");
	return {
		promptTokens,
		completionTokens,
		totalTokens: n("totalTokens") || promptTokens + completionTokens,
	};
}

async function chatViaDsh(llm: DshLlmService, config: LlmBridgeConfig, opts: ChatOptions): Promise<ChatResult> {
	const target = await resolveTarget(llm, config, opts.model);
	const request: Record<string, unknown> = {
		provider: target.provider,
		model: target.model,
		// request-only user 消息是 dsh-llm 明确支持的非会话输入；system 用普通消息形状
		messages: [
			{ role: "system", content: [{ type: "text", text: opts.system }] },
			{ role: "user", content: [{ type: "text", text: opts.user }] },
		],
	};
	const maxTokens = opts.maxTokens ?? config.maxTokens;
	if (maxTokens != null) request.maxTokens = maxTokens;
	if (opts.temperature != null) request.temperature = opts.temperature;
	if (opts.signal) request.signal = opts.signal;

	let text = "";
	let reasoning = "";
	let usage: Record<string, number> | undefined;
	let finish: DshStreamChunk["reason"];

	for await (const chunk of llm.stream(request)) {
		switch (chunk?.type) {
			case "text-delta":
				text += chunk.text ?? "";
				break;
			case "reasoning-delta":
				// 思考型模型：正文为空时从 reasoning 里抢救 JSON（与 core 的 registry 路径一致）
				reasoning += chunk.text ?? "";
				break;
			case "usage":
				usage = chunk.usage;
				break;
			case "finish":
				finish = chunk.reason;
				break;
			default:
				break;
		}
	}

	const kind = finish?.kind;
	if (kind === "error" || kind === "aborted") {
		const failure = finish?.failure;
		throw new Error(
			`dsh llm ${kind}${failure?.code ? ` (${failure.code})` : ""}: ${failure?.message ?? "未知错误"}`,
		);
	}

	const out = text.trim() || extractJsonFromText(reasoning) || reasoning;
	if (!out.trim()) throw new Error("dsh llm 返回空 content");
	return { text: out, model: `${target.provider}/${target.model}`, usage: mapUsage(usage) };
}

/**
 * 注入桥；宿主没有 llm 服务时返回 false（调用方退回 standalone 链）。
 * 卸载时撤掉注入，避免 plugin dispose 后 core 还指着已销毁的服务。
 */
export function installDshLlm(ctx: Context, config: LlmBridgeConfig = {}): boolean {
	const llm = (ctx as unknown as { llm?: DshLlmService }).llm;
	if (!llm || typeof llm.stream !== "function" || typeof llm.listProviders !== "function") return false;
	setChatCompleter((opts) => chatViaDsh(llm, config, opts));
	ctx.effect(() => () => clearChatCompleter());
	return true;
}
