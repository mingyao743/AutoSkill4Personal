/**
 * 「一源一主页」守卫（上游 obsidian-wiki 的 `ingest_guard` 逻辑重写为 TS）。
 *
 * 为什么需要：同一段对话被两个窗口覆盖时，编译器可能造出两页讲同一件事的知识。
 * 上游的做法是先把「源」列出来，判断哪些已有主页、哪些是新的。
 *
 * 与上游的差别：上游按**源文件**判（一个 obsidian 笔记一页），我们按
 * **来源会话 + 主题**判（一段会话可能产出多页，一页也可能引多段会话）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter } from "./frontmatter.ts";

export type GuardDecision = "create" | "update" | "blocked";

export interface GuardInput {
  vaultDir: string;
  /** 候选页的相对路径（如 `concepts/foo.md`） */
  candidatePath: string;
  /** 候选页引用的来源（session id 或文件路径） */
  sources: string[];
  /** 候选页标题，用于近似判重 */
  title: string;
}

export interface GuardResult {
  decision: GuardDecision;
  /** 撞上的已有页（update/blocked 时给出） */
  existingPath?: string;
  reason: string;
}

/** 标题归一：去标点空格、转小写，用于近似判重 */
function normTitle(t: string): string {
  return t.toLowerCase().replace(/[\s\-_/\\.,:;!?'"()[\]{}]+/g, "");
}

/** 读一个页面已有的 sources 与 title */
function readPageMeta(path: string): { title: string; sources: string[] } | null {
  try {
    const { meta } = splitFrontmatter(readFileSync(path, "utf8"));
    return {
      title: typeof meta.title === "string" ? meta.title : "",
      sources: Array.isArray(meta.sources) ? meta.sources.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * 判定：create / update / blocked。
 *
 * 规则（从严到宽）：
 *  1. 路径已存在 → update（同一页重写）
 *  2. 标题完全相同 → blocked（疑似重复造页，交人工或 dedup 处理）
 *  3. 来源有重叠且标题近似 → update（同源同题，合并到已有页）
 *  4. 其余 → create
 */
export function guardPage(input: GuardInput): GuardResult {
  const abs = join(input.vaultDir, input.candidatePath);
  if (existsSync(abs)) {
    return { decision: "update", existingPath: input.candidatePath, reason: "path-exists" };
  }

  const existing = scanMeta(input.vaultDir);
  const target = normTitle(input.title);

  for (const [path, meta] of existing) {
    if (target && normTitle(meta.title) === target) {
      return { decision: "blocked", existingPath: path, reason: "duplicate-title" };
    }
  }

  const srcSet = new Set(input.sources);
  for (const [path, meta] of existing) {
    const overlap = meta.sources.some((s) => srcSet.has(s));
    if (!overlap) continue;
    if (target && isSimilar(target, normTitle(meta.title))) {
      return { decision: "update", existingPath: path, reason: "same-source-similar-title" };
    }
  }

  return { decision: "create", reason: "new-page" };
}

function scanMeta(vaultDir: string): Map<string, { title: string; sources: string[] }> {
  const out = new Map<string, { title: string; sources: string[] }>();
  for (const sub of ["concepts", "entities", "skills", "references", "synthesis", "journal"]) {
    const base = join(vaultDir, sub);
    if (!existsSync(base)) continue;
    // 相对路径必须带分类目录前缀（`concepts/a.md`），否则报给调用方的路径指不到文件
    walkMd(base, (full, rel) => {
      const meta = readPageMeta(full);
      if (meta) out.set(`${sub}/${rel}`, meta);
    });
  }
  return out;
}

function walkMd(dir: string, visit: (full: string, rel: string) => void, prefix = ""): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${n}` : n;
    const full = join(dir, n);
    if (n.endsWith(".md")) visit(full, rel);
    else walkMd(full, visit, rel);
  }
}

/** 近似判重：一个是另一个的子串，或编辑距离足够小 */
function isSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  if (Math.abs(a.length - b.length) > 4) return false;
  return levenshtein(a, b) <= 2;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
