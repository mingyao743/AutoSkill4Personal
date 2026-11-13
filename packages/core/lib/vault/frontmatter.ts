/**
 * YAML frontmatter 解析 / 序列化。
 *
 * 只支持本项目用到的子集：标量、字符串数组、布尔、数字。**不引入 YAML 库**——
 * 页面 frontmatter 是我们自己写的，格式受控；引库反而会把 `sources: [a, b]`
 * 这类单行数组解析成别的东西，和 obsidian-wiki 上游产物不一致。
 *
 * 发布相关的三个字段（方案 §4）：
 *   publish_as: document | skill | local
 *   publish_status: pending | published | tombstone
 *   source_agent / source_session / source_turns
 */
import { createHash } from "node:crypto";

export type PublishAs = "document" | "skill" | "local";
export type PublishStatus = "pending" | "published" | "tombstone";

export interface Frontmatter {
  title?: string;
  summary?: string;
  tags?: string[];
  sources?: string[];
  provenance?: string;
  base_confidence?: number;
  lifecycle?: string;
  publish_as?: PublishAs;
  publish_status?: PublishStatus;
  source_agent?: string;
  source_session?: string;
  source_turns?: string;
  [k: string]: unknown;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 拆成 frontmatter 对象 + 正文 */
export function splitFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const m = text.match(FM_RE);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYaml(m[1]), body: text.slice(m[0].length) };
}

/**
 * 解析 frontmatter 的 YAML 子集。
 *
 * 支持两种列表写法（**两种都要**，因为人写的时候不会统一）：
 * ```
 * sources: [a, b]        ← 行内
 * sources:               ← 多行
 *   - a
 *   - b
 * ```
 * 之前只支持行内，多行写法被解析成空字符串——`sources` 一空，
 * 技能晋升的 lineage 就永远是 0，等于该功能完全不工作且不报错。
 */
function parseYaml(src: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = src.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");
    i++;
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();

    if (val !== "") {
      (out as Record<string, unknown>)[key] = parseScalarOrList(val);
      continue;
    }

    const items: string[] = [];
    while (i < lines.length) {
      const item = lines[i].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      items.push(unquote(item[1].trim()));
      i++;
    }
    (out as Record<string, unknown>)[key] = items.length > 0 ? items : "";
  }
  return out;
}

function parseScalarOrList(val: string): unknown {
  if (val === "") return "";
  // [a, b, c]
  if (val.startsWith("[") && val.endsWith("]")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => unquote(x.trim())).filter((x) => x.length > 0);
  }
  // 数字
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  // 布尔
  if (val === "true") return true;
  if (val === "false") return false;
  return unquote(val);
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** 序列化回 `---\n...\n---\n\n` 形态；字段顺序固定，便于 git diff */
export function renderFrontmatter(meta: Frontmatter): string {
  const order: Array<keyof Frontmatter> = [
    "title", "summary", "tags", "sources", "provenance",
    "base_confidence", "lifecycle",
    "publish_as", "publish_status",
    "source_agent", "source_session", "source_turns",
  ];
  const seen = new Set<string>();
  const lines: string[] = ["---"];

  const emit = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      lines.push(`${k}: [${v.map((x) => quoteIfNeeded(String(x))).join(", ")}]`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      const s = String(v);
      if (s === "") return;
      lines.push(`${k}: ${quoteIfNeeded(s)}`);
    }
  };

  for (const k of order) {
    if (k in meta) {
      emit(String(k), meta[k]);
      seen.add(String(k));
    }
  }
  // 未知字段按原序附在后面（不丢上游自定义字段）
  for (const [k, v] of Object.entries(meta)) {
    if (seen.has(k)) continue;
    emit(k, v);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** 含特殊字符时加引号；冒号、井号、方括号、引号都算 */
function quoteIfNeeded(s: string): string {
  if (/^[\[\]{}#&*!|>'"%@`,]/.test(s) || /: | #|^\s|\s$/.test(s) || s.includes("\n")) {
    return JSON.stringify(s);
  }
  return s;
}

/** 正文哈希（发布账本用；不含 frontmatter，避免元数据变动触发重推） */
export function bodyHash(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** 整页哈希（含 frontmatter，用于「页面是否变过」判定） */
export function pageHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
