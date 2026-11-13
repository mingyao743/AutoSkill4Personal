/**
 * 页面索引与维护：扫描 vault、重建 index.md / log.md / hot.md。
 *
 * **手动入口和自动编译都会写这三个文件**，所以调用方必须先拿 vault 锁（§6.7 第 2 条）。
 * 本模块自己不加锁——加锁是编排层（trigger/cycle.ts）的事，避免嵌套加锁死锁。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { splitFrontmatter, type Frontmatter } from "./frontmatter.ts";

/** 被视为知识页的目录（其余目录不参与索引） */
const PAGE_DIRS = ["concepts", "entities", "skills", "references", "synthesis", "journal"];

export interface PageInfo {
  /** 相对 vault 的路径，用 `/` 分隔（跨平台一致） */
  path: string;
  title: string;
  summary: string;
  tags: string[];
  meta: Frontmatter;
  /** 文件 mtime（ms） */
  mtime: number;
}

/** 扫描 vault 下所有知识页 */
export function scanPages(vaultDir: string): PageInfo[] {
  const out: PageInfo[] = [];
  for (const sub of PAGE_DIRS) {
    const base = join(vaultDir, sub);
    if (!existsSync(base)) continue;
    walk(base, (file) => {
      if (!file.endsWith(".md")) return;
      const info = readPage(vaultDir, file);
      if (info) out.push(info);
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function walk(dir: string, visit: (file: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function readPage(vaultDir: string, file: string): PageInfo | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta } = splitFrontmatter(text);
  const rel = relative(vaultDir, file).split(sep).join("/");
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    /* 保持 0 */
  }
  return {
    path: rel,
    title: typeof meta.title === "string" && meta.title ? meta.title : rel.replace(/\.md$/, ""),
    summary: typeof meta.summary === "string" ? meta.summary : "",
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    meta,
    mtime,
  };
}

/** 重建 index.md（保留手写前言，只替换 `## 页面` 之后的自动区） */
export function rebuildIndex(vaultDir: string): { pages: number } {
  const pages = scanPages(vaultDir);
  const path = join(vaultDir, "index.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";

  const groups = new Map<string, PageInfo[]>();
  for (const p of pages) {
    const top = p.path.split("/")[0] ?? "other";
    const list = groups.get(top) ?? [];
    list.push(p);
    groups.set(top, list);
  }

  const lines: string[] = [];
  for (const [group, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${group}`, "");
    for (const p of list.sort((a, b) => a.title.localeCompare(b.title))) {
      const link = `[[${p.path.replace(/\.md$/, "")}|${p.title}]]`;
      lines.push(p.summary ? `- ${link} — ${p.summary}` : `- ${link}`);
    }
    lines.push("");
  }
  lines.push(`> 共 ${pages.length} 页，更新于 ${new Date().toISOString()}`);

  const head = stripAutoSection(existing, "## 页面");
  const body = head.trimEnd();
  const next = `${body}\n\n## 页面\n\n${lines.join("\n")}\n`;
  writeFileSync(path, next, "utf8");
  return { pages: pages.length };
}

/** 砍掉 `## 页面` 之后的内容（保留之前的 frontmatter 与手写部分） */
function stripAutoSection(text: string, marker: string): string {
  if (!text) return defaultHead();
  const i = text.indexOf(marker);
  if (i < 0) return text;
  return text.slice(0, i);
}

function defaultHead(): string {
  return `---\ntitle: 知识索引\ntags: [index]\n---\n\n# 知识索引\n`;
}

/** 追加一行到 log.md 的自动区 */
export function appendLog(vaultDir: string, line: string): void {
  const path = join(vaultDir, "log.md");
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const entry = `- ${ts} ${line}\n`;
  let cur = "";
  try {
    cur = readFileSync(path, "utf8");
  } catch {
    cur = `---\ntitle: 变更日志\ntags: [log]\n---\n\n# 变更日志\n\n`;
  }
  writeFileSync(path, cur.endsWith("\n") ? cur + entry : `${cur}\n${entry}`, "utf8");
}

/** 重建 hot.md：最近 7 天改动过的页（编译时当上下文用） */
export function rebuildHot(vaultDir: string, days = 7): { pages: number } {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = scanPages(vaultDir)
    .filter((p) => p.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30);

  const path = join(vaultDir, "hot.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const head = stripAutoSection(existing, "## 最近改动");
  const lines = recent.map((p) => {
    const when = new Date(p.mtime).toISOString().slice(0, 16).replace("T", " ");
    return `- [[${p.path.replace(/\.md$/, "")}|${p.title}]] — ${when}`;
  });
  const next = `${head.trimEnd()}\n\n## 最近改动\n\n${lines.join("\n") || "_（无）_"}\n`;
  writeFileSync(path, next, "utf8");
  return { pages: recent.length };
}

/** 摘要：给编译器当上下文的 index 精简版 */
export function indexSummary(vaultDir: string, limit = 60): string {
  const pages = scanPages(vaultDir).slice(0, limit);
  return pages.map((p) => `- ${p.path} | ${p.title} | ${p.tags.join(",")}`).join("\n");
}
