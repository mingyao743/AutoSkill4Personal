/**
 * 技能候选扫描：从知识页里找出「够格升级成技能」的。
 *
 * **为什么要这个**：知识页是给人读的，技能是给 agent 执行时读的。同一份知识
 * 攒够了一定证据（多次独立验证、被反复引用、有可执行步骤），就值得变成技能，
 * 让 agent 下次直接照着做，而不是重新推导。
 *
 * 三道门槛（方案 §3.10）：
 *  1. **≥2 lineage**：至少两个不同会话独立得出过同一结论（不是一次性的）
 *  2. **≥3 引用**：被其他页面 wikilink 引用至少 3 次（说明是枢纽知识）
 *  3. **有验证段**：正文里有「怎么做」「验证」「检查」这类可执行结构
 *
 * 三条都满足才进候选。**宁缺毋滥**——自动生成的技能如果质量低，会污染 agent
 * 的行为，比没有更糟。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanPages, type PageInfo } from "../vault/index.ts";
import { splitFrontmatter } from "../vault/frontmatter.ts";

export interface SkillCandidate {
  /** 源页面路径 */
  pagePath: string;
  title: string;
  summary: string;
  tags: string[];
  /** 不同会话来源数量 */
  lineage: number;
  /** 被引用次数 */
  refs: number;
  /** 是否有可执行结构 */
  hasProcedure: boolean;
  /** 综合得分 0-1，用于排序 */
  score: number;
  /** 为什么够格 / 为什么不够 */
  reasons: string[];
  /** 不够格时缺什么 */
  missing: string[];
}

export interface ScanOptions {
  /** 最少 lineage 数，默认 2 */
  minLineage?: number;
  /** 最少引用数，默认 3 */
  minRefs?: number;
  /** 是否要求有验证段，默认 true */
  requireProcedure?: boolean;
  /** 只看这些标签的页面 */
  tags?: string[];
  /** 最多返回多少条，默认 20 */
  limit?: number;
}

export const MIN_LINEAGE = 2;
export const MIN_REFS = 3;

/** 可执行结构的标志词（标题或正文里出现即算） */
const PROCEDURE_MARKERS = [
  /^#{2,4}\s*(?:怎么做|如何做|步骤|流程|操作|用法|验证|检查|排查|修复|实现)/m,
  /^#{2,4}\s*(?:how to|steps?|procedure|usage|verify|check|fix|implement)/im,
  /^\s*\d+\.\s+\S/m, // 有序列表至少一项
];

/** 从正文提取 wikilink 目标 */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(body)) !== null && guard++ < 1000) {
    out.push(m[1].trim());
  }
  return out;
}

/** 归一化标题用于比对（去空格、标点、大小写） */
export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[\s\-_·。，,、：:（）()【】\[\]]/g, "");
}

/**
 * 算 lineage：`sources` 里不同会话的数量。
 *
 * 为什么不用 `sources.length`：同一会话编译两次会产生两条来源记录，
 * 但那是同一次经验，不算独立验证。
 */
export function computeLineage(meta: Record<string, unknown>): number {
  const raw = meta.sources;
  if (!Array.isArray(raw)) return 0;

  const seen = new Set<string>();
  for (const s of raw) {
    const str = typeof s === "string" ? s : JSON.stringify(s);
    // 来源形如 "dsh/session-abc/第 1-30 轮" → 取会话 id 部分
    const m = str.match(/(?:^|\/)(session[-_][\w-]+|[0-9a-f]{8}-[0-9a-f-]{27,})/i);
    seen.add(m ? m[1].toLowerCase() : str);
  }
  return seen.size;
}

/** 判断正文有没有可执行结构 */
export function hasProcedure(body: string): boolean {
  return PROCEDURE_MARKERS.some((re) => re.test(body));
}

/** 读页面正文（不含 frontmatter） */
export function readBody(vaultDir: string, pagePath: string): string {
  const abs = join(vaultDir, pagePath);
  if (!existsSync(abs)) return "";
  try {
    return splitFrontmatter(readFileSync(abs, "utf8")).body;
  } catch {
    return "";
  }
}

/**
 * 扫描候选。
 *
 * 引用计数：先建全库的「标题 → 被引用次数」表，再对每个页面查。
 * 这样 O(n) 而不是每页都遍历全库。
 */
export function scanCandidates(vaultDir: string, opts: ScanOptions = {}): SkillCandidate[] {
  const minLineage = opts.minLineage ?? MIN_LINEAGE;
  const minRefs = opts.minRefs ?? MIN_REFS;
  const requireProcedure = opts.requireProcedure ?? true;

  const pages = scanPages(vaultDir);
  if (pages.length === 0) return [];

  // 建引用计数表
  const refCount = new Map<string, number>();
  const bodies = new Map<string, string>();
  for (const p of pages) {
    const body = readBody(vaultDir, p.path);
    bodies.set(p.path, body);
    for (const link of extractWikilinks(body)) {
      const key = normalizeTitle(link);
      refCount.set(key, (refCount.get(key) ?? 0) + 1);
    }
  }

  const out: SkillCandidate[] = [];
  for (const p of pages) {
    if (opts.tags && opts.tags.length > 0) {
      const has = p.tags.some((t) => opts.tags!.includes(t));
      if (!has) continue;
    }
    // 已归档/存疑的不升级
    const status = String(p.meta.status ?? "active");
    if (status === "archived" || status === "disputed") continue;

    const body = bodies.get(p.path) ?? "";
    const lineage = computeLineage(p.meta as Record<string, unknown>);
    const refs = refCount.get(normalizeTitle(p.title)) ?? 0;
    const proc = hasProcedure(body);

    const reasons: string[] = [];
    const missing: string[] = [];

    if (lineage >= minLineage) reasons.push(`${lineage} 个独立会话验证`);
    else missing.push(`只有 ${lineage} 个会话（需 ≥${minLineage}）`);

    if (refs >= minRefs) reasons.push(`被引用 ${refs} 次`);
    else missing.push(`被引用 ${refs} 次（需 ≥${minRefs}）`);

    if (proc) reasons.push("有可执行步骤");
    else if (requireProcedure) missing.push("缺少可执行步骤");

    if (missing.length > 0) continue;

    // 得分：lineage 与 refs 归一化后加权，正文长度作微调
    const score =
      Math.min(1, lineage / (minLineage * 2)) * 0.4 +
      Math.min(1, refs / (minRefs * 2)) * 0.4 +
      Math.min(1, body.length / 4000) * 0.2;

    out.push({
      pagePath: p.path,
      title: p.title,
      summary: p.summary,
      tags: p.tags,
      lineage,
      refs,
      hasProcedure: proc,
      score: Math.round(score * 100) / 100,
      reasons,
      missing,
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
}

/** 诊断：为什么某个页面不够格（`ow promote --explain <page>`） */
export function explainPage(vaultDir: string, pagePath: string, opts: ScanOptions = {}): {
  page: PageInfo | null;
  lineage: number;
  refs: number;
  hasProcedure: boolean;
  missing: string[];
} {
  const pages = scanPages(vaultDir);
  const page = pages.find((p) => p.path === pagePath) ?? null;
  if (!page) return { page: null, lineage: 0, refs: 0, hasProcedure: false, missing: ["页面不存在"] };

  let refs = 0;
  const key = normalizeTitle(page.title);
  for (const p of pages) {
    if (p.path === pagePath) continue;
    const body = readBody(vaultDir, p.path);
    if (extractWikilinks(body).some((l) => normalizeTitle(l) === key)) refs++;
  }

  const lineage = computeLineage(page.meta as Record<string, unknown>);
  const proc = hasProcedure(readBody(vaultDir, pagePath));
  const minLineage = opts.minLineage ?? MIN_LINEAGE;
  const minRefs = opts.minRefs ?? MIN_REFS;

  const missing: string[] = [];
  if (lineage < minLineage) missing.push(`lineage ${lineage} < ${minLineage}`);
  if (refs < minRefs) missing.push(`引用 ${refs} < ${minRefs}`);
  if (!proc) missing.push("缺少可执行步骤");

  return { page, lineage, refs, hasProcedure: proc, missing };
}
