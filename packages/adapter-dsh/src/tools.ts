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
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { setHostContext, hostContext } from "../../core/lib/context.ts";
import { atomId, appendAtoms, loadAtoms, type KnowledgeAtom } from "../../core/lib/atom-store.ts";
import {
  admissionGate, categoryForType, declaredSource, defaultAtomType, ensureTypeFields, isDocType, keepAsForType, labelForType,
} from "../../core/lib/admission.ts";
import { validateAtom } from "../../core/lib/validate.ts";
import { resolveStandaloneConfig } from "../../core/lib/llm.ts";
import { pendingSummary } from "../../core/lib/skill-state.ts";

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

// 当前会话文件：定时器与工具共用（拿不到 agent 句柄时用"最新会话文件"兜底）
let currentSessionFile: string | undefined;

export function rememberAgent(agent: unknown): void {
	const f = dshSessionFile(agent);
	if (f) currentSessionFile = f;
}

export function getCurrentSessionFile(): string | undefined {
	return currentSessionFile;
}

/** 兜底：扫描 cwd 对应的 sessions 目录，取 mtime 最新的会话文件 */
export function latestSessionFile(): string | undefined {
	try {
		const slug = `--${process.cwd().replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}--`;
		const base = join(homedir(), ".dsh", "sessions", slug);
		if (!existsSync(base)) return undefined;
		let best: string | undefined;
		let bestM = 0;
		for (const d of readdirSync(base)) {
			const dir = join(base, d);
			try {
				if (!statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			for (const f of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
				const p = join(dir, f);
				if (!existsSync(p)) continue;
				const m = statSync(p).mtimeMs;
				if (m > bestM) {
					bestM = m;
					best = p;
				}
			}
		}
		return best;
	} catch {
		return undefined;
	}
}

/** 后台收集日志的知识卡片计数（对齐 pi 侧 kbStats） */
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
				const a = args as {
					doc_type: string; content: string; why: string; domain?: string; atom_type?: string; expires_when?: string; keep_as?: string;
				};
				if (!isDocType(a.doc_type)) {
					return `未入库：doc_type "${a.doc_type}" 非法。只允许 sop/spec/template/case/postmortem/convention/index/rubric。`;
				}
				const sessionId =
					(exec.agent as { session?: { id?: string } } | undefined)?.session?.id ?? "unknown-session";
				const source = declaredSource(sessionId);
				const atom: KnowledgeAtom = {
					atom_id: atomId(a.content, [source]),
					category: categoryForType(a.doc_type),
					atom_type: a.atom_type ?? defaultAtomType(a.doc_type),
					content: a.content,
					domain: (a.domain ?? "").trim() || "general",
					sources: [source],
					confidence: 0.8,
					version: 1,
					superseded_by: null,
					refs: [],
					status: "draft",
					extracted_at: new Date().toISOString(),
					extracted_by: "agent-tool-dsh",
					doc_type: a.doc_type,
					keep_as: a.doc_type === "case" && a.keep_as === "data" ? "data" : keepAsForType(a.doc_type),
					why: a.why,
					expires_when: a.expires_when ? a.expires_when.trim() : null,
				};
				// 结构化字段用 content 兜底（工具入参没有 step/concept_name 等字段）
				ensureTypeFields(atom);
				// 与 pi 侧同一条准入规则：声明型入口不再免检
				const gate = admissionGate(atom, { requireWhy: true });
				if (!gate.ok) return `未入库：${gate.reasons.join("；")}`;
				const v = validateAtom(atom, []);
				if (!v.ok) return `未入库：${v.errors.join("；")}`;
				const dup = loadAtoms().some((x) => x.content === atom.content);
				if (!dup) appendAtoms([atom]);
				return dup
					? `已存在，跳过（${labelForType(a.doc_type)}）`
					: `已记录 1 条「${labelForType(a.doc_type)}」→ ${atom.domain || "未标主题"}（草稿，待整合）${atom.keep_as === "data" ? "｜资料层，不进技能正文" : ""}`;
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
				const sessionFile = dshSessionFile(exec.agent) ?? latestSessionFile();
				if (sessionFile) spawnPipelineDsh(sessionFile, { maxBatches: 2, budgetTokens: 40_000 });
				// 凭据可用性预检（对齐 pi 侧失败尽早暴露：CLI 报错入 errors.log，这里只提示）
				const { config, reason } = resolveStandaloneConfig();
				const note = config ? "" : `\n[抽取凭据预检] 当前环境无可用 LLM 配置，后台抽取将失败：\n${reason}`;
				const project = process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? "当前项目";
				const located = sessionFile ? "" : "\n未定位到会话文件，抽取器需手动指定。";
				return Promise.resolve(`已开始发现并抽取「${project}」会话的知识（后台运行，只处理未审消息）。${located}\n${kbStats()}${note}`);
			},
		}),
	);
}
