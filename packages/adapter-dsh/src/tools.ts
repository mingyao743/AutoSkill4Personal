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
 *   凭据解析链 host=dsh 时不注 homeDir → 环境变量直连④（OPENAI_API_KEY/OPENAI_BASE_URL）
 *   或 AUTOSKILL_PROVIDER/AUTOSKILL_MODEL 显式指定——抽取 LLM 配置经环境变量传给子进程。
 *   会话文件是 zstd v4 格式（session.v4.jsonl.zstd），extract.ts 已原生支持。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { setHostContext, hostContext } from "../../core/lib/context.ts";
import { atomId, appendAtoms, loadAtoms } from "../../core/lib/atom-store.ts";
import { resolveStandaloneConfig } from "../../core/lib/llm.ts";
import { pendingSummary } from "../../core/lib/skill-state.ts";

/** AutoSkill 仓库根（spawn cwd + CLI 绝对路径基准）：packages/adapter-dsh/src/tools.ts → 上三级到根 */
const MONOREPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const EXTRACT_CLI = join(MONOREPO_ROOT, "packages", "core", "scripts", "extract.ts");

/** detached spawn 抽取 CLI（与 pi 侧 spawnExtract 同构：fire-and-forget，子进程经环境变量接收凭据与数据目录） */
function spawnExtractDsh(sessionFile: string | undefined): void {
	const h = hostContext();
	// 抽取 LLM 凭据：dsh 宿主下主对话凭据经 ctx.llm 内部服务持有，不进入环境变量；
	// 子进程 CLI 走独立解析链（④ 环境变量直连 / AUTOSKILL_* 显式指定）。未配置时 CLI 自行报错入 errors.log。
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", EXTRACT_CLI, ...(sessionFile ? [sessionFile] : [])],
		{
			detached: true,
			stdio: "ignore",
			cwd: MONOREPO_ROOT,
			env: {
				...process.env,
				AUTOSKILL_DATA_DIR: h?.dataDir ?? "",
				OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
				OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "",
				AUTOSKILL_PROVIDER: process.env.AUTOSKILL_PROVIDER ?? "",
				AUTOSKILL_MODEL: process.env.AUTOSKILL_MODEL ?? "",
			},
		},
	);
	child.unref();
}

/** 后台收集日志的原子计数（对齐 pi 侧 kbStats） */
function kbStats(): string {
	const h = hostContext();
	const atoms = loadAtoms();
	const draft = atoms.filter((a) => a.status === "draft").length;
	const published = atoms.filter((a) => a.status === "published").length;
	const pend = pendingSummary();
	return (
		`atoms: ${atoms.length}（draft ${draft} / published ${published}）\n` +
		`待整合: ${pend.total}` +
		(pend.total > 0 ? `（${Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ")}）` : "") +
		`\n路径: ${h?.dataDir ? join(h.dataDir, "atoms.jsonl") : "未注入"}`
	);
}

/** 从 agent 会话句柄派生 dsh 会话文件路径（~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd） */
function dshSessionFile(agent: unknown): string | undefined {
	try {
		const a = agent as { session?: { id?: string } } | undefined;
		const id = a?.session?.id;
		if (!id) return undefined;
		// cwd-slug：路径分隔符与非字母字符 → --；与实测目录名一致（如 --Users-chenmingyao-Documents-cmy-only-AutoSkill--）
		const slug = `--${process.cwd().replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}--`;
		const base = join(homedir(), ".dsh", "sessions", slug, id);
		for (const f of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
			if (existsSync(join(base, f))) return join(base, f);
		}
		return undefined;
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
				"声明一条可复用知识原子存入本地知识库（draft，待后续组装成卡片）。" +
				"在刚发现有价值结论/踩坑/操作方法时调用；不要在批量罗列信息时调用。",
			parameters: {
				category: {
					type: "string",
					required: true,
					description: "知识类别：01业务认知 02操作SOP 03模板骨架 04案例样例 05问题复盘",
				},
				content: { type: "string", required: true, description: "知识内容：简洁、可独立复用、脱离本对话也能看懂" },
				atom_type: { type: "string", description: "切片名（如 根因切片）；不填则由内容推断归类" },
				domain: { type: "string", description: "业务域 kebab-case（如 gpu-train-ops）" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: String(value) }],
			},
			async execute(args) {
				const a = args as { category: string; content: string; atom_type?: string; domain?: string };
				const now = new Date().toISOString();
				const atom = {
					atom_id: atomId(a.content, []),
					category: a.category,
					atom_type: a.atom_type ?? "通用切片",
					content: a.content,
					domain: a.domain ?? "",
					sources: [],
					confidence: 0.8,
					version: 1,
					superseded_by: null,
					refs: [],
					status: "draft",
					extracted_at: now,
					extracted_by: "agent-tool-dsh",
				};
				const dup = loadAtoms().some((x) => x.content === atom.content);
				if (!dup) appendAtoms([atom]);
				return dup ? "已存在，跳过" : `已入库(draft): ${atom.atom_id}`;
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
				const sessionFile = dshSessionFile(exec.agent);
				spawnExtractDsh(sessionFile);
				// 凭据可用性预检（对齐 pi 侧失败尽早暴露：CLI 报错入 errors.log，这里只提示）
				const { config, reason } = resolveStandaloneConfig();
				const note = config ? "" : `\n[抽取凭据预检] 当前环境无可用 LLM 配置，后台抽取将失败：\n${reason}`;
				return Promise.resolve(`已后台启动抽取${sessionFile ? `: ${sessionFile}` : "（未定位会话文件，抽取器将等待 stdin/手动指定）"}\n${kbStats()}${note}`);
			},
		}),
	);
}
