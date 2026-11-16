/**
 * 平台文件名规则（2026-11-16 起去掉前缀，方案 §9.2 修订）。
 *
 * 旧规则 `qdoc-<项目短名>-<页面名>.md` 的三个前提都已失效：
 *   - `search_documents` 现在匹配**文件名和正文**，还支持 tag 过滤（实测 schema）
 *   - `update_document` 现在能单独改 filename / tags（乐观锁）
 *   - 平台新增 `list_document_tags`，标签成了可汇总的一等元数据
 *
 * 所以分组改用 tag（`project:<短名>`），文件名只承担「可读」这一个职责：
 *   `skills/mcp-streamable-http-probe.md` → `skills-mcp-streamable-http-probe.md`
 *
 * 台账（.publish/ledger.json）仍然是「哪些文档是我们的」的权威来源，
 * 文件名不再承担认领职责。
 */
import { createHash } from "node:crypto";

/** 页面相对路径 → 平台 filename：扁平化、保留中英文、无前缀 */
export function toPlatformFilename(pagePath: string): string {
  return pagePath
    .replace(/\.md$/, "")
    .replace(/\//g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") + ".md";
}

/** 项目短名：取项目目录名，转小写、非字母数字换 `-`，截断 24 字符 */
export function projectSlug(projectRoot: string): string {
  const name = (projectRoot.split("/").pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name) return name.slice(0, 24);
  // 目录名全是中文等非 ASCII：退化用路径哈希前 8 位
  return `p${createHash("sha1").update(projectRoot).digest("hex").slice(0, 8)}`;
}

/**
 * 项目标签：create 时打上，search/list 都能按它过滤。
 *
 * 平台 tag **上限 20 字符**（超长静默截断，2026-11-16 实测：
 * "project:autoskill4personal" 被截成 "project:autoskill4pe"，按全名过滤就
 * 永远命中 0）。所以用短前缀 `p:` + 短名截到 18 位，总计恰好 ≤20。
 */
export function projectTag(projectRoot: string): string {
  return `p:${projectSlug(projectRoot).slice(0, 18)}`;
}

/** 旧规则文件名（2026-11-13 发布的两篇就是这个形式）；对账时还要认得它 */
export function legacyFilename(pagePath: string, projectRoot: string): string {
  const flat = toPlatformFilename(pagePath).replace(/\.md$/, "");
  return `qdoc-${projectSlug(projectRoot)}-${flat}.md`;
}

/**
 * 反解：从平台 filename 猜回 vault 相对路径（对账兜底用）。
 *
 * 只认得旧前缀形式——新规则是**有损压缩**（`-` 既是路径分隔又是连字符），
 * 反解不回去，对账以台账 doc_id 为准。
 */
export function guessPagePath(filename: string, projectRoot: string): string | null {
  const prefix = `qdoc-${projectSlug(projectRoot)}-`;
  if (!filename.startsWith(prefix)) return null;
  const rest = filename.slice(prefix.length).replace(/\.md$/, "");
  return rest ? `${rest}.md` : null;
}
