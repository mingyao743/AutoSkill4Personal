/**
 * AutoSkill dsh 宿主适配层（bundle 入口）。
 *
 * 职责（v2 宿主独立原则）：
 *  - 注入 HostContext（数据目录 <dshHome>/data/autoskill/knowledge，不读 ~/.pi 下任何路径）
 *  - 注册自定义 skill provider 到 ctx.skills（原生 registry 形态，不落 SKILL.md 文件）
 *  - 抽取入口的 dsh 映射（M3 起：kb_harvest 工具）
 *
 * Cordis 约定（实测参照 dsh-skill-filesystem/lib/index.js）：
 *  - apply(ctx, config = {}) —— config 有默认 {}，逐字段从 row.config 读取
 *  - provider 经工厂注册：ctx.skills.registerProvider((control) => provider)
 *  - ctx.effect(disposer) 自动清理（卸载时 provider 出 registry + 目录缓存失效）
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { setHostContext, hostContext } from "../../core/lib/context.ts";
import { logError } from "../../core/lib/atom-store.ts";
import { autoskillProvider } from "./skill-provider.ts";
import { installDshLlm, type LlmBridgeConfig } from "./llm-bridge.ts";
import {
	registerTools, setDshHome, getCurrentSessionFile, latestSessionFile, dispatchPipeline,
} from "./tools.ts";

export interface Config {
	/** Harness 配置根；默认 $DSH_HOME 或 ~/.dsh */
	dshHome?: string;
	/** 抽取用 LLM 路由；不配则跟随当前会话，再退回宿主首个 provider */
	llm?: LlmBridgeConfig;
	/** 知识管线定时触发（dsh 没有逐轮钩子，只能定时扫） */
	pipeline?: {
		enabled?: boolean;
		/** 检查间隔秒数（默认 600） */
		intervalSeconds?: number;
		/** 单次最多几批（默认 2） */
		maxBatches?: number;
		/** 单次 token 预算（默认 40000） */
		budgetTokens?: number;
	};
}

export const name = "autoskill";
export const inject = ["skills", "tools", "llm"];

/** dsh 命名空间内的知识数据目录（绝不指向 ~/.pi） */
function dshDataDir(dshHome: string): string {
	return join(dshHome, "data", "autoskill", "knowledge");
}

export function apply(ctx: Context, config: Partial<Config> = {}) {
	// 1. 注入宿主上下文（adapter-dsh 启动第一步；冲突注入会抛错，早期暴露 bug）
	const home = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? "~", ".dsh");
	setHostContext({ host: "dsh", dataDir: dshDataDir(home) });
	setDshHome(home); // 会话文件扫描也用同一个根（自定义 DSH_HOME 时不再硬编码 ~/.dsh）

	// 2. LLM 桥：抽取/抢救走宿主 ctx.llm，凭据留在宿主内（不再依赖 ~/.pi 的 models.json）
	//    注入失败（宿主未挂 llm）时退回 standalone 链，由 errors.log 暴露原因
	if (!installDshLlm(ctx, config.llm ?? {})) {
		logError("[autoskill] 宿主没有 ctx.llm，抽取只能退回 standalone 链（需 OPENAI_API_KEY）");
	}

	// 3. 注册 skill provider（工厂形态，control 由 registry 注入）
	ctx.skills.registerProvider(() => autoskillProvider(hostContext()!));

	// 4. M3：kb_harvest 工具
	registerTools(ctx);

	// 5. 知识管线定时触发：会话文件有新内容才跑（覆盖派生保证不重复消耗）
	startPipelineTimer(ctx, config);
}

/**
 * dsh 没有逐轮钩子：用定时器 + 会话文件 mtime 变化作为触发。
 * 优先用工具/压缩阶段抓到的会话文件；拿不到就扫 cwd 对应的 sessions 目录取最新。
 */
function startPipelineTimer(ctx: Context, config: Partial<Config>): void {
	const p = config.pipeline ?? {};
	if (p.enabled === false) return;
	const intervalMs = Math.max(60, p.intervalSeconds ?? 600) * 1000;
	let lastFile: string | undefined;
	let lastMtime = 0;

	const tick = (): void => {
		try {
			const f = getCurrentSessionFile() ?? latestSessionFile();
			if (!f || !existsSync(f)) return;
			const mtime = statSync(f).mtimeMs;
			if (f === lastFile && mtime === lastMtime) return; // 没有新消息，不重复烧 token
			lastFile = f;
			lastMtime = mtime;
			dispatchPipeline(f, {
				maxBatches: p.maxBatches ?? 2,
				budgetTokens: p.budgetTokens ?? 40_000,
			});
		} catch {
			// 定时器异常不影响宿主
		}
	};

	const timer = setInterval(tick, intervalMs);
	const first = setTimeout(tick, 60_000);
	ctx.effect(() => () => {
		clearInterval(timer);
		clearTimeout(first);
	});
}
