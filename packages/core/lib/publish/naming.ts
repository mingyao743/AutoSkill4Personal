/**
 * 文件名前缀：平台没有 namespace，只能靠 filename 做逻辑分组。
 *
 * 规则（方案 §9.2）：`qdoc-<项目短名>-<页面名>.md`
 *
 * 为什么用前缀而不是 tag：`search_documents` / `list_documents` 都返回 filename，
 * 前缀能在**不读正文**的情况下过滤出本项目的文档；tag 在 `update_document` 时
 * 还改不了（平台只接受 create 时给 tags），靠 tag 分组会随时间漂移。
 */
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

export const FILENAME_PREFIX = "qdoc";

/** 项目短名：取项目目录名，转小写、非字母数字换 `-`，截断 24 字符 */
export function projectSlug(projectRoot: string): string {
  const name = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name) return name.slice(0, 24);
  // 目录名全是中文等非 ASCII：退化用路径哈希前 8 位
  return `p${createHash("sha1").update(projectRoot).digest("hex").slice(0, 8)}`;
}

/** vault 内相对路径 → 平台 filename */
export function toPlatformFilename(pagePath: string, projectRoot: string): string {
  const slug = projectSlug(projectRoot);
  const flat = pagePath
    .replace(/\.md$/, "")
    .replace(/\//g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${FILENAME_PREFIX}-${slug}-${flat}.md`;
}

/** 平台 filename → 是否属于本项目 */
export function belongsToProject(filename: string, projectRoot: string): boolean {
  return filename.startsWith(`${FILENAME_PREFIX}-${projectSlug(projectRoot)}-`);
}

/**
 * 反解：从 filename 猜回 vault 相对路径（只用于对账，不保证精确——
 * 分隔符 `-` 与路径里的 `-` 不可区分，所以对账以账本为准，这个只做兜底提示）。
 */
export function guessPagePath(filename: string, projectRoot: string): string | null {
  const prefix = `${FILENAME_PREFIX}-${projectSlug(projectRoot)}-`;
  if (!filename.startsWith(prefix)) return null;
  const rest = filename.slice(prefix.length).replace(/\.md$/, "");
  return rest ? `${rest}.md` : null;
}

/** 目录名（诊断用：告诉我们一页本来在哪个分类下） */
export function categoryOf(pagePath: string): string {
  return dirname(pagePath).split("/")[0] ?? "";
}
