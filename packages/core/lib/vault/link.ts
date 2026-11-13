/**
 * `ow link`：生成 `wiki -> .qdoc` 软链，让 Obsidian 能直接打开 vault。
 *
 * `.qdoc` 是隐藏目录，Obsidian 默认不展示隐藏目录，所以建一个非隐藏名的软链指过去。
 * 幂等：已有正确链接不动；已有错误链接先删再建（只在它确实是软链时才删，不误删真目录）。
 */
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR_NAME } from "./init.ts";

export interface LinkResult {
  action: "created" | "exists" | "replaced" | "skipped";
  path: string;
  target: string;
  reason?: string;
}

export function linkVault(projectRoot: string, linkName = "wiki"): LinkResult {
  const target = VAULT_DIR_NAME;
  const path = join(projectRoot, linkName);

  if (existsSync(path)) {
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      /* 读不到当非软链 */
    }
    if (!isLink) {
      return { action: "skipped", path, target, reason: "目标已存在且不是软链，不覆盖" };
    }
    const cur = readlinkSync(path);
    if (cur === target) return { action: "exists", path, target };
    rmSync(path, { force: true });
    symlinkSync(target, path);
    return { action: "replaced", path, target };
  }

  symlinkSync(target, path);
  return { action: "created", path, target };
}

/** 拆链（`ow link --remove`） */
export function unlinkVault(projectRoot: string, linkName = "wiki"): boolean {
  const path = join(projectRoot, linkName);
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
