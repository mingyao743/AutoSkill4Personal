/**
 * 查询：**本地优先，平台兜底**（方案 §10.10）。
 *
 * 链路：
 *   1. 当前 vault（index 里 title/summary/tags 匹配）——快，带 wikilink，断网可用
 *   2. 本地命中 < 2 条 → `search_documents` 走平台——覆盖所有项目所有设备
 *   3. `read_document_content` 取正文
 *   4. 解析 `<!-- ow:meta -->` 拿 provenance
 *   5. 答案标来源：[local:路径] / [platform:doc 123]
 *
 * 「文档不拉到本地」指的是**不把平台文档落盘成 vault 页**，不是「不查本地」。
 */
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { parseMetaComment } from "../../../core/lib/vault/render.ts";
import { scanPages } from "../../../core/lib/vault/index.ts";
import { findVault } from "../../../core/lib/vault/init.ts";
import { out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

/** 本地命中：在 vault 的 title/summary/tags 里找（不读正文，够快） */
interface LocalHit {
  path: string;
  title: string;
  summary: string;
  tags: string[];
}

function searchLocal(vaultDir: string, query: string, limit: number): LocalHit[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length >= 1);
  const scored: Array<{ hit: LocalHit; score: number }> = [];

  for (const p of scanPages(vaultDir)) {
    const title = (p.title || "").toLowerCase();
    const summary = (p.summary || "").toLowerCase();
    const tags = (p.tags || []).map((t) => t.toLowerCase());
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (tags.some((tag) => tag.includes(t))) score += 2;
      if (summary.includes(t)) score += 1;
    }
    if (score > 0) {
      scored.push({ hit: { path: p.path, title: p.title, summary: p.summary, tags: p.tags }, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.hit);
}

export async function runQuery(args: ParsedArgs): Promise<number> {
  const query = args.positional.join(" ").trim();
  if (!query) {
    process.stderr.write("用法：ow query <关键词>\n");
    return 2;
  }

  // ── 1. 本地优先 ───────────────────────────────────────────
  const vault = findVault(process.cwd());
  const local = vault ? searchLocal(vault.dir, query, 5) : [];
  const localLines = local.map(
    (h) => `## [local] ${h.title || h.path}（${h.path}）\n\n${h.summary}`,
  );

  // 本地命中够多就直接给，不花网络（§10.10：命中 < 2 条才兜底平台）
  if (local.length >= 2 && !flagBool(args, "platform")) {
    out(
      args,
      `本地命中 ${local.length} 篇（未查平台；加 --platform 可一并查）：\n\n${localLines.join("\n\n---\n\n")}`,
      { query, source: "local", local },
    );
    return 0;
  }

  // ── 2. 平台兜底 ───────────────────────────────────────────
  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
  await client.initialize();

  // 平台搜索是**短语精确匹配**：`qdoc MCP` 命中 0，而 `MCP` 命中 1（实测）。
  // 所以整串没结果时按词降级重试，取第一个有结果的词。
  let hits = await client.searchDocuments(query, { limit: 8 });
  let usedQuery = query;
  let fallback = false;
  if (hits.length === 0 && /\s/.test(query.trim())) {
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      const r = await client.searchDocuments(t, { limit: 8 });
      if (r.length > 0) {
        hits = r;
        usedQuery = t;
        fallback = true;
        break;
      }
    }
  }

  if (hits.length === 0) {
    out(args, `没有命中「${query}」的文档。\n（平台搜索按短语精确匹配，试试更短的关键词）`, {
      query,
      hits: [],
    });
    return 0;
  }

  const limit = Number(flagString(args, "limit") ?? 3);
  const detailed: Array<Record<string, unknown>> = [];

  for (const h of hits.slice(0, limit)) {
    let content = "";
    try {
      content = await client.readDocumentContent(Number(h.id));
    } catch (e) {
      content = `（读取失败：${String(e).slice(0, 120)}）`;
    }
    const meta = parseMetaComment(content);
    detailed.push({
      id: h.id,
      filename: h.filename,
      version: h.version,
      updated_at: h.updated_at,
      provenance: meta,
      content,
    });
  }

  const human = detailed
    .map((d) => {
      const p = d.provenance as Record<string, unknown> | null;
      const src = p ? `\n  来源：${p.agent ?? "?"} / ${p.session ?? "?"} / 第 ${p.turns ?? "?"} 轮` : "";
      return `## ${d.filename}（id=${d.id}, v${d.version}）${src}\n\n${String(d.content).slice(0, 2000)}`;
    })
    .join("\n\n---\n\n");

  const notice = client.takeNotice();
  if (notice) process.stdout.write(`⚠ 平台提示：${notice}\n\n`);
  const note = fallback ? `（「${query}」无结果，已降级用「${usedQuery}」）` : "";
  const localPart = localLines.length > 0 ? `**本地 ${local.length} 篇**\n\n${localLines.join("\n\n---\n\n")}\n\n---\n\n` : "";
  out(args, `${localPart}**平台命中 ${hits.length} 篇**${note}，显示前 ${detailed.length} 篇：\n\n${human}`, {
    query,
    usedQuery,
    fallback,
    local,
    total: hits.length,
    documents: detailed,
  });
  return 0;
}
