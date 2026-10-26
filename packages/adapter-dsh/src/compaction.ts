/**
 * AutoSkill dsh compaction 抢救引擎（M4 实现）。
 *
 * 与 pi 侧 session_before_compact 语义对齐（knowledge-capture.ts 单一事实源）：
 *   被压缩区 → rescueAtoms(published, confidence floor 0.7，唯一免审入口) → summary 照常生成。
 *   失败降级：原子抽取失败不阻塞 compaction（日志入 errors.log，走默认 LLM summary）。
 *
 * dsh 宿主差异（bisect 定位，dsh-compaction-basic 899 行 summarize sole hook）：
 *   CompactionEngine 是 Service subclass 挂载机制（无 before/after hook 语义）；
 *   regionDependencies().summarize 每次压缩调用 this.summarize(input, agent, signal)，
 *   input.messages 为被压缩区 conversation span。
 *   替换策略 = function apply 形状 + apply 内 class extends BasicCompactionEngine + ctx.plugin 注册。
 *   【形状约束×3】（bisect 定位结论）：
 *     × service-class default export + .ts heritage 表达式 → dsh thread 静默 "failed to import"
 *     × ctx.plugin(Class, config) 二参形态 → fiber 创建失败（无 static Config 校验链）
 *     ✓ function apply + 一参 ctx.plugin(Class) + rescueEnabled 读 entry config 闭包
 *
 * 挂载方式（profile patch 层）：disable compaction-basic 行 + enable autoskill-compaction 行。
 */
import type { Context } from "@deepseek-ai/cordis";
// @ts-expect-error dsh-compaction-basic 编译产物无类型声明
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { rescueAtoms, type RescueResult } from "../../core/lib/compaction-rescue.ts";
import { logError } from "../../core/lib/atom-store.ts";
import type { MessageEntry } from "../../core/lib/types.ts";

export interface CompactionConfig {
	/** 是否启用知识抢救（默认 true；false 时退化为纯 basic 引擎） */
	rescueEnabled?: boolean;
	[key: string]: unknown;
}

/** dsh messages → core MessageEntry 归一（消费端为内存 messages 数组非 jsonl 行流） */
function messagesToEntries(messages: readonly unknown[]): MessageEntry[] {
	const out: MessageEntry[] = [];
	let seq = 0;
	for (const m of messages) {
		const msg = m as { role?: string; content?: unknown; id?: string };
		const role = msg?.role;
		if (role !== "user" && role !== "assistant") continue;
		out.push({
			type: "message",
			id: msg.id ?? `dsh-msg-${seq}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role, content: msg.content } as MessageEntry["message"],
		});
		seq += 1;
	}
	return out;
}

type BasicCtor = new (ctx: never, config: unknown) => {
	summarize(input: unknown, agent: never, signal: AbortSignal | undefined): Promise<unknown>;
};

export const inject: string[] = ["llm", "tokenMeter", "sessions"];

export function apply(ctx: Context, config: CompactionConfig = {}) {
	const rescueEnabled = config?.rescueEnabled !== false;
	const Basic = BasicCompactionEngine as unknown as BasicCtor;

	class AutoSkillCompactionEngine extends Basic {
		/** dsh summarize sole hook：先抢救后 summary（失败放行默认压缩） */
		async summarize(input: unknown, agent: never, signal: AbortSignal | undefined): Promise<unknown> {
			await this.rescueKnowledge(input, signal);
			return super.summarize(input, agent, signal);
		}

		/** 被压缩区知识抢救（fire-and-fail，绝不阻塞 compaction；rescueEnabled 来自 entry config 闭包） */
		private async rescueKnowledge(input: unknown, signal: AbortSignal | undefined): Promise<void> {
			if (!rescueEnabled) return;
			try {
				const messages = (input as { messages?: readonly unknown[] })?.messages ?? [];
				const entries = messagesToEntries(messages);
				if (entries.length === 0) return;
				const rescue: RescueResult = await rescueAtoms(entries, "autoskill", signal);
				if (rescue.savedAtoms.length > 0) {
					logError(`[autoskill] compaction 抢救完成：${entries.length} 条消息 → ${rescue.savedAtoms.length} 原子 (${rescue.savedAtoms.map((a) => a.atom_id).join(", ").slice(0, 80)})`);
				}
			} catch (e) {
				// 抢救失败绝不阻塞 compaction（对齐 pi 侧 "summary 失败放行默认压缩" 的更早一步）
				logError(`[autoskill] compaction 抢救失败（放行默认压缩）: ${String(e).slice(0, 300)}`);
			}
		}
	}

	ctx.plugin(AutoSkillCompactionEngine);
}
