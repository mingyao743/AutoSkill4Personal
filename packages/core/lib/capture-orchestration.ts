/**
 * 捕获编排：把"何时抽取 / 单条声明如何入卡 / 状态与提示如何生成 / 后台管线如何 spawn"
 * 这类 host 无关的编排逻辑从 adapter 抽到 core。adapter 只剩宿主对接
 * （注册钩子、从 ctx 取 entries/sessionId、spawn 进程、格式化工具响应）。
 *
 * 设计原则（见 PLATFORM_INTEGRATION_REVIEW §分层）：
 *  - adapter 只对接各 agent 运行时；具体如何抽取/编排，全在 core。
 *  - 本模块函数纯数据进出（entries/sessionId/params），不触碰任何宿主 ctx。
 *  - 行为与原 adapter-pi/knowledge-capture.ts 逐一致（行为保持重构）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  atomId, appendAtoms, atomsPath, loadAtoms, logError, type KnowledgeAtom,
} from "./atom-store.ts";
import {
  admissionGate, categoryForType, declaredSource, defaultAtomType, ensureTypeFields,
  isDocType, keepAsForType, labelForType,
} from "./admission.ts";
import { validateAtom } from "./validate.ts";

import { applyPatches, intakeDir } from "./apply-patches.ts";
import { darwinDue, pendingSummary, darwinThreshold } from "./skill-state.ts";
import { compileDue } from "./compile-skill.ts";
import { lastCompileHashes } from "./compile-state.ts";
import { runPipeline, type PipelineReport } from "./pipeline.ts";
import { coverageReport } from "./coverage.ts";
import type { MessageEntry } from "./types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PIPELINE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "pipeline.ts");
export const ASSEMBLE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "assemble.ts");
export const PACKAGE_SKILL_CLI = join(REPO_ROOT, "packages", "core", "scripts", "package-skill.ts");
export const APPLY_CLI = join(REPO_ROOT, "packages", "core", "scripts", "apply-patches.ts");
export const DARWIN_CLI = join(REPO_ROOT, "packages", "core", "scripts", "darwin-check.ts");
export const DARWIN_SKILL = join(REPO_ROOT, "skills", "darwin-skill", "SKILL.md");
export const INTEGRATE_GUIDE = join(REPO_ROOT, "design", "INTEGRATE_GUIDE.md");
export const COMPILE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "compile-skills.ts");
export const COMPILE_DESIGN = join(REPO_ROOT, "design", "SKILL_COMPILER.md");

/** 增量管线节流：待审消息少于本数不跑。
 *  原 30（compaction 抢救兜底时的节流）；抢救通道去掉后降到 5，让管线及时覆盖，
 *  避免消息在被压缩丢弃前未被处理（每轮仍只 1 批/40k，成本可控）。 */
export const PIPELINE_MIN_PENDING = 5;

/** capture_knowledge 工具入参的 host 无关形状（adapter 用 TypeBox 包一层给宿主） */
export interface CaptureDeclaration {
  doc_type: string;
  content: string;
  why: string;
  domain?: string;
  atom_type?: string;
  expires_when?: string;
  keep_as?: string;
}

export interface CaptureContext {
  sessionId: string;
  lastMsgId?: string;
  /** 入卡来源标记：pi="agent-tool"（默认）、dsh="agent-tool-dsh" */
  extractedBy?: string;
}

export interface CaptureResult {
  ok: boolean;
  duplicate: boolean;
  message: string;
  label?: string;
  domain?: string;
  keep_as?: string;
}

/**
 * 单条声明入卡（原 capture_knowledge execute 主体）。
 * 建 atom → ensureTypeFields → 准入 → 校验 → 幂等去重 → 落库。
 */
export function captureDeclaredAtom(decl: CaptureDeclaration, ctx: CaptureContext): CaptureResult {
  if (!isDocType(decl.doc_type)) {
    return {
      ok: false, duplicate: false,
      message: `未入库：doc_type "${decl.doc_type}" 非法。只允许 sop/spec/template/case/postmortem/convention/index/rubric。`,
    };
  }
  const source = declaredSource(ctx.sessionId, ctx.lastMsgId);
  const atom: KnowledgeAtom = {
    atom_id: atomId(decl.content, [source]),
    category: categoryForType(decl.doc_type),
    atom_type: decl.atom_type ?? defaultAtomType(decl.doc_type),
    content: decl.content,
    domain: (decl.domain ?? "").trim() || "general",
    sources: [source],
    confidence: 0.8,
    version: 1,
    superseded_by: null,
    refs: [],
    status: "draft",
    extracted_at: new Date().toISOString(),
    extracted_by: ctx.extractedBy ?? "agent-tool",
    doc_type: decl.doc_type,
    keep_as: decl.doc_type === "case" && decl.keep_as === "data" ? "data" : keepAsForType(decl.doc_type),
    why: decl.why,
    expires_when: decl.expires_when ? decl.expires_when.trim() : null,
  };
  ensureTypeFields(atom);
  const gate = admissionGate(atom, { requireWhy: true });
  if (!gate.ok) {
    return { ok: false, duplicate: false, message: `未入库：${gate.reasons.join("；")}` };
  }
  const v = validateAtom(atom, []);
  if (!v.ok) {
    return { ok: false, duplicate: false, message: `未入库：${v.errors.join("；")}` };
  }
  const dup = loadAtoms().some((a) => a.content === atom.content);
  if (!dup) appendAtoms([atom]);
  const label = labelForType(decl.doc_type);
  return {
    ok: true, duplicate: dup,
    message: dup
      ? `已存在，跳过（${label}）`
      : `已记录 1 条「${label}」→ ${atom.domain || "未标主题"}（草稿，待整合）${atom.keep_as === "data" ? "｜资料层，不进技能正文" : ""}`,
    label, domain: atom.domain, keep_as: atom.keep_as,
  };
}

/** 知识库状态文本（原 kbStats）：atoms 计数 / 待整合 / 体检待触发 / 可编译 / 路径 */
export function kbStatusText(): string {
  const atoms = loadAtoms();
  const draft = atoms.filter((a) => a.status === "draft").length;
  const published = atoms.filter((a) => a.status === "published").length;
  const pend = pendingSummary();
  const due = darwinDue().map((d) => `${d.domain}(${d.trigger || d.edits})`).join(", ") || "无";
  const compile = compileDue(atoms, lastCompileHashes(), { limit: 10_000 }).map((d) => d.skillName).join(", ") || "无";
  return (
    `atoms: ${atoms.length}（draft ${draft} / published ${published}）\n` +
    `待整合: ${pend.total}${pend.total ? `（${Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ")})` : ""}\n` +
    `体检待触发: ${due}\n` +
    `可编译: ${compile}\n` +
    `路径: ${atomsPath()}`
  );
}

/** 注入给 agent 的提示（原 pendingNotice）：待整合超阈值/体检/编译三段，无则 undefined */
export function pendingNoticeText(): string | undefined {
  const parts: string[] = [];
  const pend = pendingSummary();
  if (pend.total > 0) {
    const byDomain = Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ");
    if (pend.total > 25) {
      parts.push(`[知识管道] 待整合知识卡片 ${pend.total} 条（${byDomain}），超过增量阈值。` +
        `建议用户空闲时跑批量：node --experimental-strip-types ${ASSEMBLE_CLI} && node --experimental-strip-types ${PACKAGE_SKILL_CLI} --all`);
    } else {
      parts.push(`[知识管道] 有 ${pend.total} 条待整合知识卡片（${byDomain}）。` +
        `若本会话任务完成后空闲，可按 ${INTEGRATE_GUIDE} 的流程将它们整合进 skills` +
        `（写提案到 ${intakeDir()} 后跑 ${APPLY_CLI}）。` +
        `不要在用户任务中途做，一次只整合一个主题。忽略本提示也不影响正常工作。`);
    }
  }
  const due = darwinDue();
  if (due.length > 0) {
    const list = due.map((d) => `${d.domain}(${d.edits}次)`).join(", ");
    parts.push(`[skill 体检] ${list} 自上次体检已累计增量修改 ≥ ${darwinThreshold()} 次，建议空闲时按 ${DARWIN_SKILL} ` +
      `的流程做一次体检（高频主题可跑完整优化，长尾主题先跑 Phase 0.5-1 评估即可）。` +
      `完成后运行 ${DARWIN_CLI} --done <domain> 记账。需要用户确认的检查点按该 skill 的流程走。`);
  }
  try {
    const compile = compileDue(loadAtoms(), lastCompileHashes(), { limit: 5 });
    if (compile.length > 0) {
      const list = compile.map((d) => `${d.skillName}(${d.atoms}张/${d.sessions}会话)`).join(", ");
      parts.push(`[技能编译] ${list} 已过就绪门且内容有变化。空闲时按 ${COMPILE_DESIGN} 的流程：` +
        `跑 ${COMPILE_CLI} --domain <主题> 生成编译简报 → 交给 create-skill 产出 SKILL.md → ` +
        `用 --validate 过确定性关卡 → --apply 写 intake 提案。不要在用户任务中途做。`);
    }
  } catch {
    // 提示失败不影响会话
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** 增量管线是否该跑（原 maybeRunPipeline 的阈值判断） */
export function shouldRunIncremental(entries: MessageEntry[], sessionId: string): { run: boolean; unreviewed: number } {
  if (entries.length === 0) return { run: false, unreviewed: 0 };
  const cov = coverageReport(entries, sessionId);
  return { run: cov.unreviewed >= PIPELINE_MIN_PENDING, unreviewed: cov.unreviewed };
}

/** 跑一轮增量管线（1 批 / 40k 预算，原 maybeRunPipeline 的 runPipeline 调用） */
export async function runIncrementalPipeline(
  sessionId: string, entries: MessageEntry[], harness: "pi" | "dsh" = "pi",
): Promise<PipelineReport> {
  return runPipeline({ sessionId, entries, harness, maxBatches: 1, budgetTokens: 40_000 });
}

/** detached spawn 知识管线 CLI 的参数（原 spawnPipeline 的 spawn 配置）；进程 spawn 本身仍由 adapter 做 */
export function pipelineSpawnArgs(sessionFile: string, opts: { maxBatches?: number; budget?: number } = {}): {
  args: string[]; env: Record<string, string>; cwd: string;
} {
  const dataDir = process.env.KB_DIR ?? join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge");
  const home = join(homedir(), ".pi", "agent");
  return {
    args: [
      "--experimental-strip-types", PIPELINE_CLI, sessionFile,
      "--data-dir", dataDir, "--home", home,
      "--mode", "incremental",
      "--max-batches", String(opts.maxBatches ?? 3),
      "--budget", String(opts.budget ?? 60_000),
    ],
    env: {
      ...process.env,
      AUTOSKILL_DATA_DIR: dataDir,
      AUTOSKILL_HOME: home,
      PI_MODELS_PATH: process.env.PI_MODELS_PATH ?? "",
    },
    cwd: REPO_ROOT,
  };
}

/** detached spawn（adapter 便利封装：直接 spawn + unref；仍属 host 进程管理，留本模块供 adapter 调） */
export function spawnPipeline(sessionFile: string, opts: { maxBatches?: number; budget?: number } = {}): void {
  const { args, env, cwd } = pipelineSpawnArgs(sessionFile, opts);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd, env });
  child.unref();
}

export { applyPatches, logError };
