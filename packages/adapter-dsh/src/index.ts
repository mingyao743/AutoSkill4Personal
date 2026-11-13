/**
 * AutoSkill dsh 宿主适配层（bundle 入口）。
 *
 * 职责（v2 宿主独立原则）：
 *  - 注入 HostContext（数据目录 <dshHome>/data/autoskill/knowledge，不读 ~/.pi 下任何路径）
 *  - 注册自定义 skill provider 到 ctx.skills（原生 registry 形态，不落 SKILL.md 文件）
 *  - 抽取触发：定时器轮询会话文件 mtime → dispatchPipeline（每 N 轮闸在 core，与 pi 同一份逻辑；dsh 无 per-turn 钩子）
 *
 * Cordis 约定（实测参照 dsh-skill-filesystem/lib/index.js）：
 *  - apply(ctx, config = {}) —— config 有默认 {}，逐字段从 row.config 读取
 *  - provider 经工厂注册：ctx.skills.registerProvider((control) => provider)
 *  - ctx.effect(disposer) 自动清理（卸载时 provider 出 registry + 目录缓存失效）
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { setHostContext, hostContext } from "../../core/lib/base/context.ts";
import { logError } from "../../core/lib/base/atom-store.ts";
import { installDshLlm, type LlmBridgeConfig } from "./llm-bridge.ts";
import {
	setDshHome, setAutoInit, getCurrentSessionFile, latestSessionFile, runCycle,
} from "./tools.ts";

export interface Config {
	/** Harness 配置根；默认 $DSH_HOME 或 ~/.dsh */
	dshHome?: string;
	/** 抽取用 LLM 路由；不配则跟随当前会话，再退回宿主首个 provider */
	llm?: LlmBridgeConfig;
	/** 知识管线定时触发（dsh 无 per-turn 钩子，定时轮询会话文件 mtime；30 轮闸在 core/trigger） */
	pipeline?: {
		enabled?: boolean;
		/** 检查间隔秒数（默认 120；turn-count 检查不烧 token，命中 N 轮阈值才花） */
		intervalSeconds?: number;
		/** 自动初始化 `.qdoc/`（默认 false：只往已有 vault 写） */
		autoInit?: boolean;
	};
}

export const name = "autoskill";
export const inject = ["llm"];

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

	// 3. 知识管线定时触发：会话文件有新内容才跑（30 轮闸 + 编译在 core/trigger/cycle）
	//
	// 这里**不再注册 skill provider**。旧实现从 atoms.jsonl 派生「知识主题技能」，
	// 那是旧 autoskill 架构；新方案的技能来源是 `agent-skills/` 目录（装到
	// ~/.dsh/skills）与平台同步（`ow sync`），两条路都不需要进程内 provider。
	// 留着它只会往技能列表里塞一批旧主题，与 qdoc / ow-compiler 混淆。
	setAutoInit(config.pipeline?.autoInit === true);
	startPipelineTimer(ctx, config);
}

/**
 * dsh 无 per-turn 钩子：定时器（默认 120s）轮询会话文件 mtime，变了就调 `runCycle`。
 *
 * `runCycle` 走 `core/trigger/cycle.ts` 的统一编排（与 pi 侧 `before_agent_start`
 * 调同一个函数），内部依次过：30 轮闸 → 信号门 → 机器锁 → vault 锁 → 编译。
 * mtime 没变 / 未到 30 轮都不烧 token。
 *
 * 会话文件优先用工具阶段抓到的；拿不到就扫 cwd 对应的 sessions 目录取最新。
 */
function startPipelineTimer(ctx: Context, config: Partial<Config>): void {
	const p = config.pipeline ?? {};
	if (p.enabled === false) return;
	const intervalMs = Math.max(60, p.intervalSeconds ?? 120) * 1000;
	let lastFile: string | undefined;
	let lastMtime = 0;

	const tick = (): void => {
		try {
			const f = getCurrentSessionFile() ?? latestSessionFile();
			if (!f || !existsSync(f)) return;
			const mtime = statSync(f).mtimeMs;
			if (f === lastFile && mtime === lastMtime) return; // 没有新消息，跳过
			lastFile = f;
			lastMtime = mtime;
			// 30 轮闸、信号门、两级锁、编译全在 runCycle 里；这里只负责「文件变了就试一次」
			void runCycle(f).catch((e) => {
				logError(`[autoskill] runCycle 失败: ${String(e).slice(0, 300)}`);
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
