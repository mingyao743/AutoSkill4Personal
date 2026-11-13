/**
 * AutoSkill dsh 工具层（M3 实现）：capture_knowledge + kb_harvest。
 *
 * 注册形态（实测参照 dsh-tool-goal / dsh-tool-bash 编译产物）：
 *   inject: ["tools"]；ctx.tools.register(defineTool({ name, description, parameters, output, execute }))
 *   defineTool 来自 @deepseek-ai/dsh-tools；parameters 是 property-map 形状
 *   （顶层参数名 → {type, required?, description}，与 dsh-tool-goal 同构）；output 是 {schema, render}。
 *
 * 与 pi 侧对齐的行为（knowledge-capture.ts 单一事实源）：
 *   capture_knowledge —— 单条声明，draft，confidence 0.8，幂等（同 content 跳过）；
 *   kb_harvest        —— detached spawn 抽取 CLI（fire-and-forget），会话文件从 agent.session.id 派生。
 *
 * dsh 宿主差异（v2 宿主独立原则，不读 ~/.pi 下任何路径）：
 *   凭据：进程内调用走 ctx.llm 桥（llm-bridge.ts），凭据在宿主内闭环；
 *   spawn 子进程时才退回环境变量链（OPENAI_API_KEY / AUTOSKILL_*），无凭据时自动改用进程内。
 *   会话文件是 zstd v4 格式（<dshHome>/sessions/<cwd-slug>/<id>/session.v4.jsonl[.zstd]）。
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { hostContext } from "../../core/lib/context.ts";
import { loadAtoms, logError } from "../../core/lib/atom-store.ts";
import { parseSession } from "../../core/lib/window.ts";
import { runPipeline } from "../../core/lib/pipeline.ts";
import { sessionFileFor, latestSessionFileIn, sessionIdFromFile } from "./session-path.ts";
import { rememberLlmTarget } from "./llm-bridge.ts";
import { resolveStandaloneConfig } from "../../core/lib/llm.ts";
import { captureDeclaredAtom, kbStatusText, type CaptureDeclaration } from "../../core/lib/capture-orchestration.ts";

/** AutoSkill 仓库根（spawn cwd + CLI 绝对路径基准）：packages/adapter-dsh/src/tools.ts → 上三级到根 */
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const EXTRACT_CLI = join(MONOREPO_ROOT, "packages", "core", "scripts", "extract.ts"); // 手动回填用
const PIPELINE_CLI = join(MONOREPO_ROOT, "packages", "core", "scripts", "pipeline.ts");

/**
 * detached spawn 知识管线 CLI（覆盖派生 → 抽取触发机制 → 知识抽取）。
 * 与 pi 侧 spawnPipeline 同构；--no-home 保证绝不读 ~/.pi 的模型配置。
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
 * 选路：standalone 凭据可用 → detached spawn（隔离、不占宿主事件循环）；
 * 否则 → 进程内管线（走 ctx.llm 桥）。返回实际走的路由，便于测试与诊断。
 */
export function dispatchPipeline(
	sessionFile: string,
	opts: { maxBatches?: number; budgetTokens?: number } = {},
): "spawn" | "in-process" | "none" {
	const h = hostContext();
	if (!h?.dataDir || !sessionFile) return "none";
	if (resolveStandaloneConfig().config) {
		spawnPipelineDsh(sessionFile, opts);
		return "spawn";
	}
	void runPipelineInProcess(sessionFile, opts).catch((e) => {
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

// ---------------- M3 两工具 ----------------

export function registerTools(ctx: Context): void {
	ctx.tools.register(
		defineTool({
			name: "capture_knowledge",
			description:
				"声明一条可复用知识卡片存入本地知识库（带类型与价值理由，待后续组装）。" +
				"在刚发现有价值结论/踩坑/操作方法/模板/资料时调用；不要在批量罗列信息时调用。",
			parameters: {
				doc_type: {
					type: "string",
					required: true,
					description:
						"文档类型（8 选 1）：sop操作SOP / spec口径契约 / template模板骨架 / case案例资料 / postmortem问题复盘 / convention环境约定 / index索引线索 / rubric判据标准",
				},
				content: { type: "string", required: true, description: "知识内容：简洁、可独立复用、脱离本对话也能看懂" },
				why: { type: "string", required: true, description: "价值理由：不存会损失什么（具体后果，≥8 字）" },
				domain: { type: "string", description: "业务主题 kebab-case（如 gpu-train-ops）；不填记为 general" },
				atom_type: { type: "string", description: "可选细标签（如 根因切片）" },
				expires_when: { type: "string", description: "失效条件（convention / index 必填）" },
				keep_as: { type: "string", description: "case 专用：reference（参考案例）或 data（客户资料/真实事实，需脱敏）" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args, exec) {
				rememberLlmTarget(exec.agent);
				const sessionId =
					(exec.agent as { session?: { id?: string } } | undefined)?.session?.id ?? "unknown-session";
				// 入卡逻辑（建 atom + 准入 + 校验 + 幂等去重）在 core.captureDeclaredAtom
				return captureDeclaredAtom(args as CaptureDeclaration, {
					sessionId,
					extractedBy: "agent-tool-dsh",
				}).message;
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "kb_harvest",
			description:
				"后台启动本会话的知识抽取（独立进程，不阻塞对话）。" +
				"在任务收尾、或对话中积累了大量未捕获知识时调用；重复调用幂等（已抽窗口自动跳过）。",
			parameters: {},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			execute(args, exec) {
				rememberAgent(exec.agent);
				rememberLlmTarget(exec.agent);
				const sessionFile = dshSessionFile(exec.agent) ?? latestSessionFile();
				// 凭据可用 → 独立进程；否则 → 宿主进程内（走 ctx.llm 桥，凭据在宿主内闭环）
				const route = sessionFile ? dispatchPipeline(sessionFile, { maxBatches: 2, budgetTokens: 40_000 }) : "none";
				// 凭据可用性预检（对齐 pi 侧失败尽早暴露；进程内路径由桥负责，不再报 standalone 缺配置）
				const { config, reason } = resolveStandaloneConfig();
				const note = route === "spawn" && !config
					? `\n[抽取凭据预检] 当前环境无可用 LLM 配置，后台抽取将失败：\n${reason}`
					: "";
				const project = process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? "当前项目";
				const located = sessionFile ? "" : "\n未定位到会话文件，抽取器需手动指定。";
				const via = route === "in-process" ? "宿主进程内，走 ctx.llm" : "后台独立进程";
				return Promise.resolve(`已开始发现并抽取「${project}」会话的知识（${via}，只处理未审消息）。${located}\n${kbStatusText()}${note}`);
			},
		}),
	);
}
