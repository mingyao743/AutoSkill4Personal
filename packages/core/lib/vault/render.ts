/**
 * 发布渲染：本地页面 → 平台正文。
 *
 * 三件事（方案 §9.4 / §10.9）：
 *  1. 剥掉本地字段（`publish_as` / `publish_status` / `source_*` 不该出现在平台正文里）
 *  2. wikilink `[[path|标题]]` → 纯文本「标题」——qdoc 没有 wikilink 语义，留着是噪声
 *  3. 末尾追加 `<!-- ow:meta ... -->` 注释保住 provenance
 *
 * **为什么用 HTML 注释**：qdoc 是 markdown 渲染器，注释在渲染后不可见，但
 * `read_document_content` 拿得到原文，所以「查」的时候还能还原来源。
 */
import { renderFrontmatter, splitFrontmatter, type Frontmatter } from "./frontmatter.ts";

/** 平台正文里不该出现的本地字段 */
const LOCAL_ONLY = new Set([
  "publish_as", "publish_status", "source_agent", "source_session", "source_turns",
]);

export interface RenderOptions {
  /** 页面在 vault 内的相对路径，进 meta 注释 */
  pagePath: string;
  /** 正文哈希，进 meta 注释（跨设备比对用） */
  contentHash?: string;
}

export interface RenderedPage {
  /** 平台正文（含 frontmatter + meta 注释） */
  text: string;
  /** 平台侧标题（frontmatter.title 或文件名） */
  title: string;
  tags: string[];
  /** 供 ledger 比对 */
  contentHash: string;
}

/** 渲染一页 */
export function renderForPublish(markdown: string, opts: RenderOptions): RenderedPage {
  const { meta, body } = splitFrontmatter(markdown);
  const title = typeof meta.title === "string" && meta.title
    ? meta.title
    : opts.pagePath.replace(/\.md$/, "").split("/").pop() ?? opts.pagePath;

  const cleanMeta: Frontmatter = {};
  for (const [k, v] of Object.entries(meta)) {
    if (LOCAL_ONLY.has(k)) continue;
    (cleanMeta as Record<string, unknown>)[k] = v;
  }

  const bodyOut = stripMetaComment(rewriteWikilinks(body)).trimEnd();
  const metaComment = buildMetaComment(meta, opts);

  const text = `${renderFrontmatter(cleanMeta)}${bodyOut}\n\n${metaComment}\n`;
  return {
    text,
    title,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    contentHash: opts.contentHash ?? "",
  };
}

/**
 * wikilink → 纯文本。
 *   `[[path/to/page|显示名]]` → `显示名`
 *   `[[path/to/page]]`        → `page`（取最后一段，去掉 .md）
 */
export function rewriteWikilinks(body: string): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [target, alias] = inner.split("|");
    if (alias && alias.trim()) return alias.trim();
    const t = target.trim().replace(/\.md$/, "");
    return t.split("/").pop() ?? t;
  });
}

/** 剥掉旧的 meta 注释（重发时避免叠加） */
export function stripMetaComment(body: string): string {
  return body.replace(/\n*<!-- ow:meta[\s\S]*?-->\s*$/m, "").trimEnd();
}

function buildMetaComment(meta: Frontmatter, opts: RenderOptions): string {
  const payload = {
    schema: 1,
    page: opts.pagePath,
    provenance: typeof meta.provenance === "string" ? meta.provenance : undefined,
    sources: Array.isArray(meta.sources) ? meta.sources : undefined,
    confidence: typeof meta.base_confidence === "number" ? meta.base_confidence : undefined,
    lifecycle: typeof meta.lifecycle === "string" ? meta.lifecycle : undefined,
    agent: typeof meta.source_agent === "string" ? meta.source_agent : undefined,
    session: typeof meta.source_session === "string" ? meta.source_session : undefined,
    turns: typeof meta.source_turns === "string" ? meta.source_turns : undefined,
    hash: opts.contentHash || undefined,
  };
  // 去掉 undefined，注释尽量短
  const compact = Object.fromEntries(
    Object.entries(payload).filter(([, v]) => v !== undefined && v !== null),
  );
  return `<!-- ow:meta ${JSON.stringify(compact)} -->`;
}

/** 从平台正文里读回 meta 注释（「查」时还原来源） */
export function parseMetaComment(text: string): Record<string, unknown> | null {
  const m = text.match(/<!-- ow:meta\s+(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
