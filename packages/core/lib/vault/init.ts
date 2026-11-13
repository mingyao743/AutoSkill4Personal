/**
 * vault 发现与初始化。
 *
 * 发现规则（方案 §2.1）：从 cwd 向上找最近的 `.qdoc/`；没有则用 git 根；仍没有按
 * `auto_init` 决定是否初始化，否则跳过。
 *
 * 一个**项目**一个 vault（`<project>/.qdoc/`）。同一台机器上 N 个项目就有 N 个 vault，
 * 但**同一项目的多个 agent 共用一个**——这正是要 vault 锁的原因（§5.6）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VAULT_DIR_NAME = ".qdoc";

export interface VaultInfo {
  /** `.qdoc/` 绝对路径 */
  dir: string;
  /** 项目根（`.qdoc/` 的父目录） */
  projectRoot: string;
  /** 已初始化（有 index.md） */
  initialized: boolean;
}

/** 从某个目录向上找 `.qdoc/`；找不到返回 null */
export function findVault(startDir = process.cwd()): VaultInfo | null {
  let cur = resolve(startDir);
  for (;;) {
    const candidate = join(cur, VAULT_DIR_NAME);
    if (existsSync(candidate) && isDir(candidate)) {
      return { dir: candidate, projectRoot: cur, initialized: existsSync(join(candidate, "index.md")) };
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 找 git 根（`git rev-parse --show-toplevel` 的纯文件版，避免起子进程） */
export function findGitRoot(startDir = process.cwd()): string | null {
  let cur = resolve(startDir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 解析当前 cwd 对应的 vault。
 * 找到就返回；找不到且 `autoInit` 为 true 就在 git 根（或 cwd）初始化。
 */
export function resolveVault(
  opts: { cwd?: string; autoInit?: boolean } = {},
): VaultInfo | null {
  const cwd = opts.cwd ?? process.cwd();
  const found = findVault(cwd);
  if (found) return found;
  if (!opts.autoInit) return null;
  const root = findGitRoot(cwd) ?? resolve(cwd);
  return initVault(root);
}

const SUBDIRS = [
  "concepts", "entities", "skills", "references", "synthesis", "journal",
  "projects", "_raw", "_raw/_archived", "_staging",
  ".ow", ".ow/pending", ".ow/logs",
  ".publish", ".publish/base", ".publish/conflicts",
];

/** 建 vault 骨架（幂等：已存在不覆盖已有内容） */
export function initVault(projectRoot: string): VaultInfo {
  const dir = join(projectRoot, VAULT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });

  const tpl = templateDir();
  const vars = { PROJECT_ROOT: projectRoot };
  writeIfMissing(join(dir, "index.md"), readTemplate(tpl, "index.md", defaultIndex(projectRoot), vars));
  writeIfMissing(join(dir, "log.md"), readTemplate(tpl, "log.md", defaultLog(), vars));
  writeIfMissing(join(dir, "hot.md"), readTemplate(tpl, "hot.md", defaultHot(), vars));
  writeIfMissing(join(dir, "AGENTS.md"), readTemplate(tpl, "AGENTS.md", defaultAgents(), vars));
  writeIfMissing(join(dir, ".manifest.json"), JSON.stringify({ schema: 1, pages: {} }, null, 2));

  ensureGitignore(projectRoot);
  return { dir, projectRoot, initialized: true };
}

function templateDir(): string {
  // packages/core/lib/vault/init.ts → 仓库根/templates/vault
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "templates", "vault");
}

/**
 * 读模板并替换占位符。
 *
 * 占位符而不是硬编码日期：模板文件要能进 git，写死日期会导致每次 `ow init`
 * 都产生一个「改过的模板」。
 */
function readTemplate(dir: string, name: string, fallback: string, vars: Record<string, string> = {}): string {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    text = fallback;
  }
  const all = { UPDATED_AT: new Date().toISOString().slice(0, 10), ...vars };
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => all[k] ?? m);
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, content, "utf8");
}

/** 追加 .gitignore 条目（幂等） */
export function ensureGitignore(projectRoot: string): void {
  const p = join(projectRoot, ".gitignore");
  const wanted = [
    `${VAULT_DIR_NAME}/.ow/`,
    `${VAULT_DIR_NAME}/_raw/`,
    `${VAULT_DIR_NAME}/_staging/`,
    `${VAULT_DIR_NAME}/.publish/`,
  ];
  let cur = "";
  try {
    cur = readFileSync(p, "utf8");
  } catch {
    /* 没有就建 */
  }
  const missing = wanted.filter((w) => !cur.split(/\r?\n/).some((l) => l.trim() === w));
  if (missing.length === 0) return;
  const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
  appendFileSync(p, `${prefix}\n# qdoc vault 运行态与原始快照\n${missing.join("\n")}\n`, "utf8");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------- 默认模板（templates/ 缺失时的兜底） ----------------

function defaultIndex(projectRoot: string): string {
  return `---
title: 知识索引
summary: 本项目所有知识页的入口
tags: [index]
timezone: Asia/Shanghai
---

# 知识索引

> 由 qdoc 自动维护。最后更新：${new Date().toISOString().slice(0, 10)}

项目：\`${projectRoot}\`

## 页面

<!-- 自动生成，勿手改 -->
`;
}

function defaultLog(): string {
  return `---
title: 变更日志
tags: [log]
---

# 变更日志

<!-- 自动生成，勿手改 -->
`;
}

function defaultHot(): string {
  return `---
title: 热缓存
tags: [hot]
---

# 热缓存

最近被引用的页面（编译时作为上下文的一部分）。

<!-- 自动生成，勿手改 -->
`;
}

function defaultAgents(): string {
  return `# 项目写作约定

本文件给编译器读，描述这个项目的知识该怎么写。

- 语言：中文
- 页面标题用名词短语，不用问句
- 代码片段必须带语言标记
`;
}
