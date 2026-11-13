/**
 * 编译指纹状态：`knowledge/compile-state.json`（内容有变化才重编）。
 *
 * 与 skill-state.json 分开：那个是"整合事务"的账本（apply-patches 单写入者），
 * 这个是"编译输入指纹"，只影响要不要重新生成简报，写坏了最坏是重编一次。
 * CLI 与宿主提示共用本模块，避免两边各写一套格式。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbDir } from "../base/atom-store.ts";

export interface CompileState {
  version: 1;
  /** skill 名（kebab-case） → 上次编译的输入指纹 */
  domains: Record<string, { inputHash: string; briefAt: string }>;
}

export function compileStatePath(): string {
  return join(kbDir(), "compile-state.json");
}

export function loadCompileState(): CompileState {
  if (!existsSync(compileStatePath())) return { version: 1, domains: {} };
  try {
    const raw = JSON.parse(readFileSync(compileStatePath(), "utf8")) as Partial<CompileState>;
    return {
      version: 1,
      domains: raw.domains && typeof raw.domains === "object" && !Array.isArray(raw.domains) ? raw.domains : {},
    };
  } catch {
    return { version: 1, domains: {} }; // 损坏视为空 → 全部重编（安全方向）
  }
}

/** tmp + rename：读方永远看到完整文件 */
export function saveCompileState(state: CompileState): void {
  mkdirSync(kbDir(), { recursive: true });
  const tmp = compileStatePath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, compileStatePath());
}

/** 宿主提示用：skill 名 → 上次指纹 */
export function lastCompileHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [domain, rec] of Object.entries(loadCompileState().domains)) {
    if (rec?.inputHash) out[domain] = rec.inputHash;
  }
  return out;
}
