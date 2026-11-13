/**
 * AutoSkill dsh 抽取调度层：轮询会话文件 → 满窗口就编译（进程内，走 ctx.llm）。
 *
 * dsh 无 per-turn 钩子（cordis 只暴露 tools/skills/llm/effect），所以触发靠
 * index.ts 的定时器轮询会话文件 mtime，变了就调本模块的 `runCycle`。
 * 30 轮闸、信号门、两级锁、编译全在 `core/trigger/cycle.ts` 里——与 pi 侧
 * `before_agent_start` 调的是**同一份**编排，两边行为不会分叉。
 *
 * 旧的 `dispatchPipeline` / `spawnPipelineDsh`（spawn 子进程抽取到 atoms）已随
 * 旧 autoskill 架构删除：那条路把产物落到 atoms.jsonl，而新方案产出的是
 * `.qdoc/` 知识页。留着只会产生两条互不相认的产物线。
 *
 * dsh 宿主差异（v2 宿主独立原则，不读 ~/.pi 下任何路径）：
 *   会话文件是 zstd v4 格式（<dshHome>/sessions/<cwd-slug>/<id>/session.v4.jsonl[.zstd]）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostContext } from "../../core/lib/base/context.ts";
import { parseSession } from "../../core/lib/extract/window.ts";
import { sessionFileFor, latestSessionFileIn, sessionIdFromFile } from "./session-path.ts";
import { maybeCompile } from "../../core/lib/trigger/cycle.ts";
import { readSessionLines, sessionIdFromPath, isSubagentSession } from "../../core/lib/trigger/session-file.ts";



/** 原始事件数组（未归一，给 indexTurns 数 turn/end 用） */
function parseRawEvents(lines: string[]): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			/* 损坏行跳过 */
		}
	}
	return out;
}

/**
 * **新主路径**：走 `trigger/cycle.ts` 的统一编排（方案 §5.5）。
 *
 * 与旧的 `dispatchPipeline` 的区别：
 *  - 轮次判定改用 `indexTurns`（剔注入消息 + 剔空轮），不再用 `unreviewedUserTurns`
 *  - 水位线存 vault（`.ow/state.json`），不靠 atom sources 覆盖判定
 *  - 编译走 `compiler/run.ts` 进程内调 `ctx.llm`，产出落到 `.qdoc/` 知识页
 *  - 有 vault 锁 + 机器锁两级仲裁
 *
 * 旧的 `dispatchPipeline` 仍保留（抽取到 atoms 的旧管线），但定时器已改调本函数。
 */
export async function runCycle(sessionFile: string): Promise<string> {
	const h = hostContext();
	if (!h?.dataDir || !sessionFile) return "none";

	// 子代理会话不参与知识编译（它们是被派去做单件事的，产出没有独立价值）
	if (isSubagentSession(sessionFile)) return "subagent-skip";

	const lines = readSessionLines(sessionFile);
	const events = parseRawEvents(lines);
	if (events.length === 0) return "skip";

	const sessionId = sessionIdFromLines(lines, sessionFile);
	const cwd = cwdFromEvents(events) ?? process.cwd();
	// 归一后的消息：复用 core 的 parseSession（它已处理 dsh 三事件形状），
	// 再按「产生消息的事件 seq」逐条对齐——窗口切分与水位都靠 seq 定位，不能拿序号顶替。
	const entries = attachSeqs(parseSession(lines), events);

	const outcome = await maybeCompile({
		agent: "dsh",
		sessionId,
		events,
		entries,
		cwd,
		skillDir: COMPILER_SKILL_DIR,
		autoInit: autoInitVault || process.env.OW_AUTO_INIT === "1",
	});
	return outcome.status;
}

/** 仓库根：packages/adapter-dsh/src/tools.ts → 上三级 */
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 编译内核技能目录（仓库内 agent-skills/ow-compiler） */
const COMPILER_SKILL_DIR = join(MONOREPO_ROOT, "agent-skills", "ow-compiler");

/** 从 session 头取 cwd（决定 vault 位置） */
function cwdFromEvents(events: Array<Record<string, unknown>>): string | undefined {
	for (const e of events) {
		if (e.type === "session" && typeof e.cwd === "string") return e.cwd;
	}
	return undefined;
}

/**
 * 给归一后的 entry 补 seq。
 *
 * parseSession 按事件顺序产出，而 dsh 的 seq 只出现在原始事件里。两条路：
 *  1. entry.id 能对上事件（user/assistant 的 message.id、tool/result 的 callId）
 *  2. 对不上时按「同类事件的出现顺序」对齐（顺序一致，只是不认 id）
 */
function attachSeqs(
	entries: Array<{ id: string }>,
	events: Array<Record<string, unknown>>,
): Array<{ id: string; seq: number } & Record<string, unknown>> {
	// 建 id → seq 索引
	const byId = new Map<string, number>();
	const seqs: number[] = [];
	for (const e of events) {
		const seq = typeof e.seq === "number" ? e.seq : undefined;
		if (seq === undefined) continue;
		if (!MESSAGE_EVENT_TYPES.has(String(e.type))) continue;
		seqs.push(seq);
		const id = messageIdOf(e);
		if (id) byId.set(id, seq);
	}
	let cursor = 0;
	return entries.map((entry) => {
		const hit = byId.get(entry.id);
		if (hit !== undefined) return { ...entry, seq: hit };
		// 退化：按顺序取下一个消息事件的 seq
		const seq = seqs[cursor] ?? seqs[seqs.length - 1] ?? 0;
		cursor += 1;
		return { ...entry, seq };
	});
}

/** 会产生 MessageEntry 的事件类型 */
const MESSAGE_EVENT_TYPES = new Set(["message", "user/message", "assistant/message", "tool/result"]);

/** 从事件里取消息 id（dsh 的三种形状） */
function messageIdOf(e: Record<string, unknown>): string | undefined {
	const data = e.data as Record<string, unknown> | undefined;
	if (!data) return undefined;
	const direct = data.id;
	if (typeof direct === "string") return direct;
	const msg = data.message as Record<string, unknown> | undefined;
	if (typeof msg?.id === "string") return msg.id;
	const callId = data.callId ?? msg?.toolCallId;
	if (typeof callId === "string") return callId;
	return undefined;
}



/** 会话 id：优先 session 事件里的真实 id，退化为文件名（与 core CLI 一致） */
function sessionIdFromLines(lines: string[], sessionFile: string): string {
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as { type?: string; id?: string };
			if (e.type === "session" && typeof e.id === "string") return e.id;
		} catch {
			// 损坏行跳过
		}
	}
	return sessionIdFromFile(sessionFile);
}

let currentSessionFile: string | undefined;

/** dsh 配置根：index.ts apply 时注入（config.dshHome），没注入则按 $DSH_HOME / ~/.dsh */
let configuredDshHome: string | undefined;

export function setDshHome(home: string): void {
	configuredDshHome = home;
}

/** 自动初始化 `.qdoc/`（由 index.ts 的 config.pipeline.autoInit 注入） */
let autoInitVault = false;
export function setAutoInit(on: boolean): void {
	autoInitVault = on;
}

export function rememberAgent(agent: unknown): void {
	const f = dshSessionFile(agent);
	if (f) currentSessionFile = f;
}

export function getCurrentSessionFile(): string | undefined {
	return currentSessionFile;
}

/** 兜底：扫描 cwd 对应的 sessions 目录，取 mtime 最新的会话文件 */
export function latestSessionFile(): string | undefined {
	return latestSessionFileIn(configuredDshHome);
}

/** 从 agent 会话句柄派生 dsh 会话文件路径（<dshHome>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl[.zstd]） */
function dshSessionFile(agent: unknown): string | undefined {
	try {
		const id = (agent as { session?: { id?: string } } | undefined)?.session?.id;
		if (!id) return undefined;
		return sessionFileFor(configuredDshHome, process.cwd(), id);
	} catch {
		return undefined;
	}
}

