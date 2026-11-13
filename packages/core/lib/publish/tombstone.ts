/**
 * 墓碑：平台没有 delete 接口，只能「软删」。
 *
 * 做法（方案 §9.5）：把正文换成墓碑说明 + 保留 meta 注释，让搜索命中时人一眼看出
 * 「这页已经废弃」，而不是直接消失（消失会让人以为从没写过）。
 *
 * 为什么不干脆不管：平台文档会进向量库，被检索到、被引用。留一个明确的墓碑比留一堆
 * 过时内容安全。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLedger, markTombstone } from "./ledger.ts";
import { renderForPublish } from "../vault/render.ts";
import type { QdocMcpClient } from "./mcp.ts";

export interface TombstoneOptions {
  client: QdocMcpClient;
  vaultDir: string;
  pagePath: string;
  /** 废弃原因（写进墓碑正文，给检索者看） */
  reason?: string;
  dryRun?: boolean;
}

export interface TombstoneResult {
  pagePath: string;
  action: "tombstoned" | "skipped" | "failed";
  message?: string;
}

/** 墓碑正文 */
export function renderTombstone(input: {
  pagePath: string;
  title: string;
  reason?: string;
  replacedBy?: string;
}): string {
  const when = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    `title: [已废弃] ${input.title}`,
    `summary: 此页已于 ${when} 废弃`,
    "tags: [tombstone]",
    "lifecycle: archived",
    "publish_status: tombstone",
    "---",
    "",
    `# [已废弃] ${input.title}`,
    "",
    `> 此页于 ${when} 被标记为废弃${input.reason ? `，原因：${input.reason}` : ""}。`,
    "",
  ];
  if (input.replacedBy) {
    lines.push(`内容已迁移到：${input.replacedBy}`, "");
  }
  lines.push(
    "保留此记录是为了让引用过它的地方能看到「这里曾经有内容，现在没有了」，",
    "而不是让人以为从未写过。",
    "",
    `<!-- ow:meta ${JSON.stringify({ schema: 1, page: input.pagePath, tombstone: true, at: when })} -->`,
    "",
  );
  return lines.join("\n");
}

/** 把平台侧一页改成墓碑 */
export async function tombstonePage(opts: TombstoneOptions): Promise<TombstoneResult> {
  const ledger = readLedger(opts.vaultDir);
  const entry = ledger.pages[opts.pagePath];
  if (!entry) {
    return { pagePath: opts.pagePath, action: "skipped", message: "账本里没有这页，无需墓碑" };
  }
  if (entry.status === "tombstone") {
    return { pagePath: opts.pagePath, action: "skipped", message: "已是墓碑" };
  }

  const abs = join(opts.vaultDir, opts.pagePath);
  let title = opts.pagePath;
  if (existsSync(abs)) {
    const text = readFileSync(abs, "utf8");
    const m = text.match(/^---[\s\S]*?\ntitle:\s*(.+)$/m);
    if (m) title = m[1].trim().replace(/^["']|["']$/g, "");
  }

  const body = renderTombstone({
    pagePath: opts.pagePath,
    title,
    reason: opts.reason,
  });

  if (opts.dryRun) {
    return { pagePath: opts.pagePath, action: "tombstoned", message: "干跑：将写墓碑（未实际调用）" };
  }

  try {
    await opts.client.updateDocument({
      documentId: Number(entry.document_id),
      content: body,
      baseVersion: entry.version ?? 1,
    });
    markTombstone(opts.vaultDir, opts.pagePath);
    return { pagePath: opts.pagePath, action: "tombstoned" };
  } catch (e) {
    return { pagePath: opts.pagePath, action: "failed", message: String(e).slice(0, 300) };
  }
}

/** 本地页被删但平台还在：对账时列出来，提示要墓碑 */
export function orphanedOnPlatform(vaultDir: string, projectRoot: string): string[] {
  const ledger = readLedger(vaultDir);
  const out: string[] = [];
  for (const [pagePath, entry] of Object.entries(ledger.pages)) {
    if (entry.status === "tombstone") continue;
    if (!existsSync(join(vaultDir, pagePath))) out.push(pagePath);
  }
  return out;
}
