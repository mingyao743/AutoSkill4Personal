/**
 * 宿主上下文注入：opencode 命名空间的路径规则（设计文档 §3.1）。
 *
 * 数据隔离是硬要求：
 *  - 知识数据 ~/.config/qdoc/knowledge/opencode（与 pi/dsh 互不沾染）
 *  - 技能落盘 ~/.config/opencode/skills（OpenCode 官方 skills 目录，
 *    与 HOST_DIRS.opencode 同一口径，install-skill / 自动同步共用）
 *  - 编译产物热载：ctx.skill.reload() 由 triggers 注册后调用
 *
 * core 不认识这些路径——全部经 setHostContext 注入（幂等）。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setHostContext, type HostContext } from "../../packages/core/lib/base/context.ts";
import { HOST_DIRS } from "../../packages/core/lib/sync/install.ts";

/** 知识数据根目录（KB_DIR 可覆盖，与 pi 的 KB_DIR 同名约定） */
export function opencodeDataDir(): string {
  return process.env.KB_DIR ?? join(homedir(), ".config", "qdoc", "knowledge", "opencode");
}

/** 技能落盘目录（与 install-skill / 自动同步共用 HOST_DIRS） */
export function opencodeSkillsDir(): string {
  return process.env.OW_SKILLS_DIR ?? HOST_DIRS.opencode;
}

/** 组装宿主上下文（纯函数，测试可直接断言字段） */
export function buildHostContext(): HostContext {
  return {
    host: "opencode",
    dataDir: opencodeDataDir(),
    skillsDir: opencodeSkillsDir(),
  };
}

/** 注入（幂等；冲突注入会被 core 拒绝并抛错——那是 bug，要早暴露） */
export function initHostContext(): void {
  setHostContext(buildHostContext());
}

/** 编译内核技能目录（仓库内 agent-skills/ow-compiler，与 adapter-pi 同一相对定位） */
export const COMPILER_SKILL_DIR = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "agent-skills", "ow-compiler",
);
