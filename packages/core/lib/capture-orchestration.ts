/**
 * 捕获编排：知识库状态与提示生成（host 无关）。
 *
 * 旧的 atoms 抽取管线（shouldExtractOnTurn / runScheduledExtraction）已彻底删除，
 * 自动编译走 core/trigger/cycle.ts 的 maybeCompile（30 轮闸 → 信号门 → 两级锁 → 进程内编译）。
 * 本模块只保留：kbStatusText（状态）、pendingNoticeText（注入提示）、applyPatches（提案队列）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  atomsPath, loadAtoms, logError,
} from "./base/atom-store.ts";

import { applyPatches, intakeDir } from "./skill/apply-patches.ts";
import { darwinDue, pendingSummary, darwinThreshold } from "./skill/skill-state.ts";
import { compileDue } from "./skill/compile-skill.ts";
import { lastCompileHashes } from "./skill/compile-state.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ASSEMBLE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "assemble.ts");
export const PACKAGE_SKILL_CLI = join(REPO_ROOT, "packages", "core", "scripts", "package-skill.ts");
export const APPLY_CLI = join(REPO_ROOT, "packages", "core", "scripts", "apply-patches.ts");
export const DARWIN_CLI = join(REPO_ROOT, "packages", "core", "scripts", "darwin-check.ts");
export const DARWIN_SKILL = join(REPO_ROOT, "packages", "core", "skills", "darwin-skill", "SKILL.md");
export const INTEGRATE_GUIDE = join(REPO_ROOT, "design", "INTEGRATE_GUIDE.md");
export const COMPILE_CLI = join(REPO_ROOT, "packages", "core", "scripts", "compile-skills.ts");
export const COMPILE_DESIGN = join(REPO_ROOT, "design", "SKILL_COMPILER.md");

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

export { applyPatches, logError };
