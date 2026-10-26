/**
 * AutoSkill dsh 宿主适配层（bundle 入口）。
 *
 * 职责（v2 宿主独立原则）：
 *  - 注入 HostContext（数据目录 <dshHome>/data/autoskill/knowledge，不读 ~/.pi 下任何路径）
 *  - 注册自定义 skill provider 到 ctx.skills（原生 registry 形态，不落 SKILL.md 文件）
 *  - 抽取五入口的 dsh 映射（M3 起：capture_knowledge / kb_harvest 工具）
 *
 * Cordis 约定（实测参照 dsh-skill-filesystem/lib/index.js）：
 *  - apply(ctx, config = {}) —— config 有默认 {}，逐字段从 row.config 读取
 *  - provider 经工厂注册：ctx.skills.registerProvider((control) => provider)
 *  - ctx.effect(disposer) 自动清理（卸载时 provider 出 registry + 目录缓存失效）
 */
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { setHostContext, hostContext } from "../../core/lib/context.ts";
import { autoskillProvider } from "./skill-provider.ts";

export interface Config {
	/** Harness 配置根；默认 $DSH_HOME 或 ~/.dsh */
	dshHome?: string;
}

export const name = "autoskill";
export const inject = ["skills"];

/** dsh 命名空间内的知识数据目录（绝不指向 ~/.pi） */
function dshDataDir(dshHome: string): string {
	return join(dshHome, "data", "autoskill", "knowledge");
}

export function apply(ctx: Context, config: Partial<Config> = {}) {
	// 1. 注入宿主上下文（adapter-dsh 启动第一步；冲突注入会抛错，早期暴露 bug）
	const home = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? "~", ".dsh");
	setHostContext({ host: "dsh", dataDir: dshDataDir(home) });

	// 2. 注册 skill provider（工厂形态，control 由 registry 注入）
	ctx.skills.registerProvider(() => autoskillProvider(hostContext()!));
}
