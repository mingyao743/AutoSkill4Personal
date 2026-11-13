/**
 * AutoSkill dsh 抽取调度层：dispatchPipeline（每 N 轮闸 + 选路 spawn/in-process）。
 *
 * dsh 无 per-turn 钩子（cordis 只暴露 tools/skills/llm/effect），抽取触发靠
 * index.ts 定时器轮询会话文件 mtime → 调本模块 dispatchPipeline。
 * dispatchPipeline 内部走 core.shouldExtractOnTurn（未审 user 轮≥N=30 才抽），
 * 与 pi 侧 before_agent_start 调的是同一份 core 逻辑。
 *
 * 选路（凭据闭环）：
 *   standalone 凭据可用 → detached spawn CLI（隔离、不占宿主事件循环）；
 *   否则 → 进程内管线（走 ctx.llm 桥，凭据在宿主内闭环，无 standalone 配置也能跑）。
 *
 * dsh 宿主差异（v2 宿主独立原则，不读 ~/.pi 下任何路径）：
 *   会话文件是 zstd v4 格式（<dshHome>/sessions/<cwd-slug>/<id>/session.v4.jsonl[.zstd]）。
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostContext } from "../../core/lib/context.ts";
import { loadAtoms, logError } from "../../core/lib/atom-store.ts";
import { parseSession } from "../../core/lib/window.ts";
import { runPipeline } from "../../core/lib/pipeline.ts";
import { sessionFileFor, latestSessionFileIn, sessionIdFromFile } from "./session-path.ts";
import { resolveStandaloneConfig } from "../../core/lib/llm.ts";
import { shouldExtractOnTurn, EXTRACT_EVERY_N_TURNS } from "../../core/lib/capture-orchestration.ts";

/** AutoSkill 仓库根（spawn cwd + CLI 绝对路径基准）：packages/adapter-dsh/src/tools.ts → 上三级到根 */
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PIPELINE_CLI = join(MONOREPO_ROOT, "packages", "core", "scripts", "pipeline.ts");

/**
 * detached spawn 知识管线 CLI（standalone 凭据可用时的选路）。
 * --no-home 保证绝不读 ~/.pi 的模型配置；凭据走环境变量链。
 */
export function spawnPipelineDsh(sessionFile: string, opts: { maxBatches?: number; budgetTokens?: number } = {}): void {
	const h = hostContext();
	if (!h?.dataDir || !sessionFile) return;
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types", PIPELINE_CLI, sessionFile,
			"--data-dir", h.dataDir,
			"--no-home",
			"--mode", "incremental",
			"--max-batches", String(opts.maxBatches ?? 2),
			"--budget", String(opts.budgetTokens ?? 40_000),
		],
		{
			detached: true,
			stdio: "ignore",
			cwd: MONOREPO_ROOT,
			env: {
				...process.env,
				AUTOSKILL_DATA_DIR: h.dataDir,
				OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
				OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "",
				AUTOSKILL_PROVIDER: process.env.AUTOSKILL_PROVIDER ?? "",
				AUTOSKILL_MODEL: process.env.AUTOSKILL_MODEL ?? "",
			},
		},
	);
	child.unref();
}

/**
 * 进程内管线（凭据在宿主里的唯一可行路径）。
 *
 * 为什么需要：spawn 出来的 CLI 是独立进程，看不到宿主 ctx.llm，只能走 standalone 链
 * （dsh → 只剩 OPENAI_API_KEY）。没配环境变量时 spawn 会静默失败，知识永远抽不出来。
 * 这条路径在宿主进程里跑，chatComplete 走注入的 ctx.llm 桥；异步 fire-and-forget，
 * 不阻塞工具调用（代价是宿主退出时可能截断，覆盖水位保证下次接着抽）。
 */
export async function runPipelineInProcess(
	sessionFile: string,
	opts: { maxBatches?: number; budgetTokens?: number } = {},
): Promise<void> {
	const h = hostContext();
	if (!h?.dataDir || !sessionFile) return;
	const lines = readSessionLines(sessionFile);
	const entries = parseSession(lines);
	if (entries.length === 0) return;
	const sessionId = sessionIdFromLines(lines, sessionFile);

	// 主题清单：知识卡片池高频主题，防模型自造主题（与 pipeline CLI 同口径）
	const counts = new Map<string, number>();
	for (const a of loadAtoms()) {
		const d = (a.domain || "").trim();
		if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	const domainOptions = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([d]) => d);

	await runPipeline({
		sessionId,
		entries,
		harness: "dsh",
		maxBatches: opts.maxBatches ?? 2,
		budgetTokens: opts.budgetTokens ?? 40_000,
		domainOptions,
	});
}

/**
 * 选路 + 每 N 轮闸：读会话文件 → shouldExtractOnTurn（未审 user 轮≥N 才抽）→
 * standalone 凭据可用 → detached spawn；否则 → 进程内管线（走 ctx.llm 桥）。
 * 不到 N 轮返回 "skip"（不烧 token）。返回实际路由，便于诊断。
 *
 * 这是 dsh 侧唯一的抽取触发入口（无 per-turn 钩子，由 index.ts 定时器轮询调本函数）。
 */
export function dispatchPipeline(
	sessionFile: string,
	opts: { maxBatches?: number; budgetTokens?: number } = {},
): "spawn" | "in-process" | "skip" | "none" {
	const h = hostContext();
	if (!h?.dataDir || !sessionFile) return "none";
	// 每 N 轮闸：读会话 → 数未审 user 轮 → 不到 N 不抽（core 统一逻辑，与 pi 同一份）
	const lines = readSessionLines(sessionFile);
	const entries = parseSession(lines);
	if (entries.length === 0) return "skip";
	const sessionId = sessionIdFromLines(lines, sessionFile);
	if (!shouldExtractOnTurn(entries, sessionId).extract) return "skip";
	// 命中：N-scaled 批次（N=30 → 3 批/120k；与 pi runScheduledExtraction 同口径）
	const maxBatches = opts.maxBatches ?? Math.min(8, Math.ceil(Math.max(1, EXTRACT_EVERY_N_TURNS) / 10));
	const budgetTokens = opts.budgetTokens ?? Math.min(240_000, maxBatches * 40_000);
	if (resolveStandaloneConfig().config) {
		spawnPipelineDsh(sessionFile, { maxBatches, budgetTokens });
		return "spawn";
	}
	void runPipelineInProcess(sessionFile, { maxBatches, budgetTokens }).catch((e) => {
		logError(`[autoskill] 进程内管线失败: ${String(e).slice(0, 300)}`);
	});
	return "in-process";
}

/** 会话文件行流：dsh v4 是 zstd 压缩的 jsonl（与 core CLI 同一解压口径） */
function readSessionLines(p: string): string[] {
	if (p.endsWith(".zstd")) {
		return execFileSync("zstd", ["-d", "-c", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n");
	}
	return readFileSync(p, "utf8").split("\n");
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

