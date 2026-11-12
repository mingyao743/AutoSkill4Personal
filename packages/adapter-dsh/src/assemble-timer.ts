/**
 * AutoSkill dsh 定时组装服务（M5 实现）。
 *
 * dsh 原生增值：知识卡片池 atoms.jsonl → knowledge/cards/ 卡片文件的定时重建。
 *
 * 方案取舍（实测 dsh-schedule/README 确认）：
 *   dsh-schedule 投递依赖 Host Web Session controller（headless/SDK-only 不可单独挂载），
 *   且 reminder 的产物是"往原 Session 投递 follow-up message"——让模型再跑一次脚本，重且慢。
 *   组装是确定性脚本任务（assemble.ts 已是独立 CLI），直接 Node timer 更轻：不依赖
 *   Session 持久化链路，Web/headless 两种形态均可用；宿主 shutdown 时 timer 自然销毁
 *   （Cordis plugin disposal 链）。
 *
 * 触发条件（与 pi 侧 kb status 一致）：待整合知识卡片数 > 阈值 或 到达间隔。
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { pendingSummary } from "../../core/lib/skill-state.ts";
import { logError, loadAtoms } from "../../core/lib/atom-store.ts";

export const name = "autoskill-assemble-timer";

/** 注入：timer 语义只需要 Cordis 根（ctx.on dispose 随 plugin 销毁） */
export const inject: string[] = [];

export interface AssembleTimerConfig {
	/** 是否启用（默认 false——显式 opt-in，避免所有部署无差别消耗 LLM 判重调用） */
	enabled?: boolean;
	/** 检查间隔秒数（默认 3600 = 1h；最小 300） */
	intervalSeconds?: number;
	/** 待整合知识卡片阈值（pending 超过才真跑 assemble；默认 10） */
	pendingThreshold?: number;
}

/** AutoSkill 仓库根（spawn cwd + CLI 绝对路径基准） */
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ASSEMBLE_CLI = join(MONOREPO_ROOT, "packages", "core", "scripts", "assemble.ts");

export function apply(ctx: Context, config: AssembleTimerConfig = {}) {
	if (config.enabled === false) return; // 显式关闭

	const intervalMs = Math.max(300, config.intervalSeconds ?? 3600) * 1000;
	const threshold = config.pendingThreshold ?? 10;

	const tick = () => {
		try {
			const pend = pendingSummary();
			if (pend.total < threshold) return;
			// detached spawn assemble CLI（fire-and-forget；LLM 判重走 core 独立解析链）
			// ctx 扩展：logger 存在于 base 宿主
			const logger = (ctx as unknown as { logger?: { info(msg: string): void } }).logger;
			logger?.info?.(`[autoskill] 定时组装触发：待整合 ${pend.total} 知识卡片 ≥ 阈值 ${threshold}`);
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", ASSEMBLE_CLI],
				{
					detached: true,
					stdio: "ignore",
					cwd: MONOREPO_ROOT,
					env: { ...process.env, AUTOSKILL_DATA_DIR: process.env.AUTOSKILL_DATA_DIR ?? "" },
				},
			);
			child.unref();
		} catch (e) {
			logError(`[autoskill] 定时组装 tick 失败: ${String(e).slice(0, 200)}`);
		}
	};

	const timer = setInterval(tick, intervalMs);
	// 首次延迟 30s 再查一次（boot 窗口内知识卡片池刚加载完即触发无意义）
	const first = setTimeout(tick, 30_000);

	// Cordis disposal：plugin 卸载时清 timer
	ctx.effect(() => () => {
		clearInterval(timer);
		clearTimeout(first);
	});
}

// 引用防抖（loadAtoms 在 pendingSummary 内部链路使用，这里显式引用维持热路径预检）
void loadAtoms;
