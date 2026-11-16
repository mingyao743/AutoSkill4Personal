/**
 * 待办与文档操作的纯辅助：格式化、tag 计算、目标解析。
 * 不碰网络、不碰文件——CLI 命令只是把这些粘到 MCP client 和台账上。
 */
import { readLedger, writeLedger } from "./publish/ledger.ts";
import type { TodoItem } from "./publish/mcp.ts";

/** 平台 doc_id 形状：UUID 字符串（2026-11-16 起；数字 id 是旧版遗留） */
export function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

/** 平台 tag 上限：超长**静默截断**（2026-11-16 实测），所以只发 ≤20 的 */
export const TAG_MAX = 20;

/** due_date → 短显示（`2026-11-20` → `11-20`；空 → ""） */
export function dueShort(due?: string | null): string {
  if (!due) return "";
  const m = due.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}` : due;
}

const PRIORITY_MARK = ["P0", "P1", "P2", "P3"];

/** 待办列表的人类可读输出；排序：有截止在前、近的先，再按优先级 */
export function formatTodoItems(items: TodoItem[]): string {
  if (items.length === 0) return "（无待办）";
  const sorted = [...items].sort((a, b) => {
    const da = a.due_date ?? "9999", db = b.due_date ?? "9999";
    if (da !== db) return da < db ? -1 : 1;
    return (a.priority ?? 1) - (b.priority ?? 1);
  });
  const lines = sorted.map((t) => {
    const mark = t.is_done ? "✓" : "○";
    const pri = PRIORITY_MARK[t.priority ?? 1] ?? `P${t.priority}`;
    const due = dueShort(t.due_date);
    const proj = t.project_name ? `[${t.project_name}] ` : "";
    return `${mark} ${pri} ${due ? `${due} ` : ""}${proj}${t.title}  (id=${t.id})`;
  });
  return lines.join("\n");
}

/** 按 --set/--add/--remove 计算新 tag 集合；>20 字符的给警告（平台会静默截断） */
export function nextTags(
  current: string[],
  o: { set?: string[]; add?: string[]; remove?: string[] },
): { tags: string[]; warnings: string[] } {
  let tags: string[];
  if (o.set) {
    tags = [...new Set(o.set)];
  } else {
    const rm = new Set(o.remove ?? []);
    tags = current.filter((t) => !rm.has(t));
    for (const t of o.add ?? []) if (!tags.includes(t)) tags.push(t);
  }
  const warnings = tags.filter((t) => t.length > TAG_MAX)
    .map((t) => `tag "${t}" 超过平台 ${TAG_MAX} 字符上限，会被静默截断——建议用 p:<短名> 形式`);
  return { tags, warnings };
}

/**
 * 解析 `ow doc rename/tag` 的目标：<page 路径>（查台账）或 <UUID>（直用）。
 * 台账里是旧数字 id 时报可执行的修复指引，而不是让 agent 去猜。
 */
export function resolveDocTarget(
  vaultDir: string,
  arg: string,
): { docId: string; pagePath?: string } {
  const a = arg.trim();
  if (looksLikeUuid(a)) return { docId: a };
  const ledger = readLedger(vaultDir);
  // ① 台账 key 精确匹配（vault 相对路径）
  const direct = ledger.pages[a];
  if (direct?.document_id != null) {
    if (typeof direct.document_id === "number") {
      throw new Error(`台账里 ${a} 的 doc_id 是旧数字 id（平台已改 UUID）。先跑 \`ow publish\` 自愈重建，再改名。`);
    }
    return { docId: direct.document_id, pagePath: a };
  }
  // ② 按台账里记录的 filename 反查
  for (const [p, entry] of Object.entries(ledger.pages)) {
    if (entry.filename === a || entry.filename === `${a}.md`) {
      if (typeof entry.document_id === "number") {
        throw new Error(`台账里 ${p} 的 doc_id 是旧数字 id（平台已改 UUID）。先跑 \`ow publish\` 自愈重建，再改名。`);
      }
      return { docId: entry.document_id, pagePath: p };
    }
  }
  throw new Error(`台账里没找到 "${a}"。用 vault 页相对路径（如 references/foo.md）或平台 UUID。`);
}

/** 改名/改 tag 成功后把台账里的 filename 对齐（doc_id 是认领权威，filename 只是显示） */
export function syncLedgerFilename(vaultDir: string, docId: string, filename: string): boolean {
  const ledger = readLedger(vaultDir);
  let hit = false;
  for (const [p, entry] of Object.entries(ledger.pages)) {
    if (entry.document_id === docId) {
      ledger.pages[p] = { ...entry, filename, updated_at: new Date().toISOString() };
      hit = true;
    }
  }
  if (hit) writeLedger(vaultDir, ledger);
  return hit;
}
