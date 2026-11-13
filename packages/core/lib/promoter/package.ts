/**
 * 技能打包：把候选知识页转成可推送的技能包。
 *
 * **转换时必须做三件事**，否则技能在别的机器上不能用：
 *  1. **去路径**：`/Users/me/proj/x.ts` → `x.ts`（别处的绝对路径无意义）
 *  2. **去 wikilink**：`[[页面名]]` → `页面名`（技能包里没有 vault，链接会断）
 *  3. **补 frontmatter**：平台 `import_skill_from_files` 强制要求根 `SKILL.md`
 *     且 `name` + `description` 必填
 *
 * **不做的事**：不自动改写正文语义、不删内容。技能就是知识页的可执行版本，
 * 内容由人审（`ow promote --dry-run` 先看）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillFile } from "../publish/mcp.ts";
import { readBody } from "./scan.ts";
import type { SkillCandidate } from "./scan.ts";

export interface SkillPackage {
  /** 技能名（平台唯一标识，用小写连字符） */
  name: string;
  /** 平台必填 */
  description: string;
  /** 文件列表，第一个必是 SKILL.md */
  files: SkillFile[];
  /** 源页面 */
  sourcePage: string;
  /** 打包时做的转换，供人核对 */
  transforms: string[];
}

export interface PackageOptions {
  /** 技能名；不传则从页面标题推 */
  name?: string;
  /** 覆盖 description */
  description?: string;
  /** 附加的 references（页面标题 → 内容） */
  references?: Array<{ title: string; pagePath: string }>;
  /** 只生成不写盘 */
  dryRun?: boolean;
}

/**
 * 标题 → 技能名。
 *
 * 保留中文：平台技能名允许 Unicode，而把「多帧解压」变成 `skill-bn14b9`
 * 对人毫无意义（`ow sync` 列表里认不出是哪个）。
 * 只做三件事：小写、非字母数字/中文换成连字符、压掉重复连字符。
 */
export function toSkillName(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) {
    let h = 0;
    for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
    return `skill-${(h >>> 0).toString(36)}`;
  }
  return base.slice(0, 64);
}

/** 技能名是否合法（平台侧要求：非空、无空格、无路径分隔符） */
export function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false;
  return /^[a-z0-9\u4e00-\u9fa5][a-z0-9\u4e00-\u9fa5-]*$/.test(name);
}

/**
 * 去掉绝对路径。
 *
 * 只处理看起来像路径的（含 `/` 且长度合理），避免误伤普通的斜杠用法。
 * 保留文件名和相对路径的最后两段，足够定位。
 */
export function stripAbsolutePaths(text: string): { text: string; count: number } {
  let count = 0;
  // Unix 绝对路径：至少两级，末段像文件名或目录名
  const unixRe = /(?:^|[\s(`"'])(\/(?:[\w.@+-]+\/){2,}[\w.@+-]+)/g;
  let out = text.replace(unixRe, (m, p: string) => {
    count++;
    const parts = p.split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return m.replace(p, tail);
  });
  // Windows 盘符路径
  const winRe = /(?:^|[\s(`"'])([A-Za-z]:\\[\w.@+\-\\ ]+)/g;
  out = out.replace(winRe, (m, p: string) => {
    count++;
    const parts = p.split("\\").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return m.replace(p, tail);
  });
  // 家目录缩写
  out = out.replace(/~\/[\w.@+-]+(?:\/[\w.@+-]+)*/g, (m) => {
    count++;
    const parts = m.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  });
  return { text: out, count };
}

/**
 * 去 wikilink。
 *
 * `[[页面名]]` → `页面名`
 * `[[页面名|显示文本]]` → `显示文本`
 * `[[页面名#小节]]` → `页面名 · 小节`
 */
export function stripWikilinks(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, page: string, section?: string, label?: string) => {
    count++;
    if (label) return label.trim();
    const p = page.trim();
    return section ? `${p} · ${section.trim()}` : p;
  });
  return { text: out, count };
}

/**
 * 从知识页生成技能包。
 *
 * 结构：
 * ```
 * SKILL.md               ← 知识页正文（转换后）+ 技能头
 * references/<name>.md   ← 附加的参考页
 * ```
 */
export function packageSkill(
  vaultDir: string,
  candidate: SkillCandidate,
  opts: PackageOptions = {},
): SkillPackage {
  const name = opts.name ?? toSkillName(candidate.title);
  const body = readBody(vaultDir, candidate.pagePath);
  const transforms: string[] = [];

  let main = body;
  const w = stripWikilinks(main);
  if (w.count > 0) transforms.push(`去掉 ${w.count} 处 wikilink`);
  main = w.text;

  const p = stripAbsolutePaths(main);
  if (p.count > 0) transforms.push(`去掉 ${p.count} 处绝对路径`);
  main = p.text;

  // 技能头：平台强制要求 name + description
  const description = (opts.description ?? candidate.summary ?? candidate.title).slice(0, 500);
  const header = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
  ].join("\n");

  // 正文里已经有 `# 标题` 就不再重复
  const hasH1 = /^\s*#\s+\S/m.test(main);
  const titleBlock = hasH1 ? "" : `# ${candidate.title}\n\n`;

  const files: SkillFile[] = [
    { path: "SKILL.md", content: `${header}${titleBlock}${main.trim()}\n` },
  ];

  for (const ref of opts.references ?? []) {
    const refBody = readBody(vaultDir, ref.pagePath);
    if (!refBody) continue;
    let content = stripWikilinks(refBody).text;
    content = stripAbsolutePaths(content).text;
    const refName = toSkillName(ref.title);
    files.push({ path: `references/${refName}.md`, content: `# ${ref.title}\n\n${content.trim()}\n` });
  }

  return { name, description, files, sourcePage: candidate.pagePath, transforms };
}

/** 写到目录（`ow promote --write`） */
export function writePackage(dir: string, pkg: SkillPackage): string[] {
  const written: string[] = [];
  for (const f of pkg.files) {
    const abs = join(dir, f.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
    written.push(abs);
  }
  return written;
}

/** 包摘要（人看的一行） */
export function describePackage(pkg: SkillPackage): string {
  const kb = (pkg.files.reduce((n, f) => n + f.content.length, 0) / 1024).toFixed(1);
  const tr = pkg.transforms.length > 0 ? `，${pkg.transforms.join("、")}` : "";
  return `${pkg.name}：${pkg.files.length} 文件 / ${kb}KB${tr}`;
}

/** 打包前检查：能不能推（平台限制） */
export function checkPackage(pkg: SkillPackage): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (pkg.files.length === 0) reasons.push("没有文件");
  if (!pkg.files.some((f) => f.path === "SKILL.md")) reasons.push("缺根 SKILL.md（平台强制要求）");
  if (pkg.files.length > 50) reasons.push(`文件数 ${pkg.files.length} > 50（平台上限）`);

  const total = pkg.files.reduce((n, f) => n + f.content.length, 0);
  if (total > 2 * 1024 * 1024) reasons.push(`总大小 ${(total / 1024 / 1024).toFixed(1)}MB > 2MB（平台上限）`);

  for (const f of pkg.files) {
    if (f.content.length > 1024 * 1024) reasons.push(`${f.path} 超过 1MB`);
  }
  if (!isValidSkillName(pkg.name)) reasons.push(`技能名不合法：${pkg.name}`);
  if (!pkg.description) reasons.push("缺 description（平台必填）");

  return { ok: reasons.length === 0, reasons };
}
