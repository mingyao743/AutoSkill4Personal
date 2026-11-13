/**
 * 在线查询：**文档不拉到本地**，只在线查（方案 §10.2）。
 *
 * 链路：`search_documents` → 挑最相关的 → `read_document_content` →
 * 从 `<!-- ow:meta -->` 还原来源 → 输出给用户/agent。
 */
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { parseMetaComment } from "../../../core/lib/vault/render.ts";
import { out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

export async function runQuery(args: ParsedArgs): Promise<number> {
  const query = args.positional.join(" ").trim();
  if (!query) {
    process.stderr.write("用法：ow query <关键词>\n");
    return 2;
  }

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
  out(args, `命中 ${hits.length} 篇${note}，显示前 ${detailed.length} 篇：\n\n${human}`, {
    query,
    usedQuery,
    fallback,
    total: hits.length,
    documents: detailed,
  });
  return 0;
}
