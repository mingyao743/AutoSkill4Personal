/**
 * 捕获编排：把"何时抽取 / 状态与提示如何生成 / 后台管线如何 spawn"
 * 这类 host 无关的编排逻辑从 adapter 抽到 core。adapter 只剩宿主对接
 * （注册钩子、从 ctx 取 entries/sessionId、spawn 进程、格式化工具响应）。
 *
 * 统一触发（全 agent 一份逻辑）：每 N 个未审 user 轮抽一次。
 *  - shouldExtractOnTurn：stateless 数未审 user 轮，>= N 才抽。
 *  - runScheduledExtraction：多批把累积 N 轮一次抽完。
 *  - adapter 只 hook 宿主的"轮次推进"事件（pi=before_agent_start；dsh=定时器轮询）→ 调本模块。
 *
 * 设计原则（见 PLATFORM_INTEGRATION_REVIEW §分层）：
 *  - adapter 只对接各 agent 运行时；具体如何抽取/编排，全在 core。
 *  - 本模块函数纯数据进出（entries/sessionId/params），不触碰任何宿主 ctx。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  atomsPath, loadAtoms, logError,
} from "./atom-store.ts";

import { applyPatches, intakeDir } from "./apply-patches.ts";
import { darwinDue, pendingSummary, darwinThreshold } from "./skill-state.ts";
import { compileDue } from "./compile-skill.ts";
import { lastCompileHashes } from "./compile-state.ts";
import { runPipeline, type PipelineReport } from "./pipeline.ts";
import { coveredIds } from "./coverage.ts";
import type { MessageEntry } from "./types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ASSEMBLE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "assemble.ts");
export const PACKAGE_SKILL_CLI = join(REPO_ROOT, "packages", "core", "scripts", "package-skill.ts");
export const APPLY_CLI = join(REPO_ROOT, "packages", "core", "scripts", "apply-patches.ts");
export const DARWIN_CLI = join(REPO_ROOT, "packages", "core", "scripts", "darwin-check.ts");
export const DARWIN_SKILL = join(REPO_ROOT, "skills", "darwin-skill", "SKILL.md");
export const INTEGRATE_GUIDE = join(REPO_ROOT, "design", "INTEGRATE_GUIDE.md");
export const COMPILE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "compile-skills.ts");
export const COMPILE_DESIGN = join(REPO_ROOT, "design", "SKILL_COMPILER.md");

/** 统一触发：每 N 个未审 user 轮抽一次（全 agent 共用一份逻辑）。
 *  - turn = 一条 user 消息；未审 = 该 msg id 未被任何 atom 的 sources 覆盖。
 *  - stateless：从 entries + coverage 派生，不依赖计数器文件，adapter/进程重启不丢。
 *  - 可配：env AUTOSKILL_EXTRACT_EVERY_N_TURNS 覆盖。
 *  - 命中后 runScheduledExtraction 多批把累积 N 轮一次抽完（不是 1 批）。 */
export const EXTRACT_EVERY_N_TURNS = Number(process.env.AUTOSKILL_EXTRACT_EVERY_N_TURNS ?? 30);

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

/** 数本会话未审的 user 消息（=未抽取的轮数）。stateless：entries + coverage 派生。 */
export function unreviewedUserTurns(entries: MessageEntry[], sessionId: string): number {
  if (entries.length === 0) return 0;
  const covered = coveredIds(entries, sessionId);
  return entries.filter((e) => e.message?.role === "user" && e.id && !covered.has(e.id)).length;
}

/** 每 N 轮闸：未审 user 轮 >= N 才抽。返回 {extract, pending, threshold} 供 adapter 决策/日志。 */
export function shouldExtractOnTurn(
  entries: MessageEntry[], sessionId: string, n: number = EXTRACT_EVERY_N_TURNS,
): { extract: boolean; pending: number; threshold: number } {
  const pending = unreviewedUserTurns(entries, sessionId);
  return { extract: pending >= n && n > 0, pending, threshold: n };
}

/** 命中后：多批把累积的 N 轮一次抽完（批次随 N 缩放，不是 1 批）。
 *  N=30 → 3 批 / 120k；上限 8 批 / 240k 防失控。 */
export async function runScheduledExtraction(
  sessionId: string, entries: MessageEntry[], harness: "pi" | "dsh" = "pi",
  n: number = EXTRACT_EVERY_N_TURNS,
): Promise<PipelineReport> {
  const maxBatches = Math.min(8, Math.ceil(Math.max(1, n) / 10));
  const budgetTokens = Math.min(240_000, maxBatches * 40_000);
  return runPipeline({ sessionId, entries, harness, maxBatches, budgetTokens });
}

export { applyPatches, logError };
