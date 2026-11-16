/**
 * `ow doc` —— 对**已发布**文档的字段级修改（不重发正文）。
 *
 *   ow doc rename <page|UUID> <新文件名>   改平台文件名（自动补 .md，台账同步）
 *   ow doc tag <page|UUID> [--add a,b] [--remove x,y] [--set a,b]
 *
 * 目标解析见 core/lib/todo.ts resolveDocTarget：台账页路径或平台 UUID。
 * 两个操作都是先 read_document 拿 version（乐观锁）再 update_document。
 */
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { nextTags, resolveDocTarget, syncLedgerFilename } from "../../../core/lib/todo.ts";
import { needVault, out, isJson } from "../vault-ctx.ts";
import { flagString, type ParsedArgs } from "../args.ts";

const HELP = `ow doc —— 已发布文档的字段级修改

用法：
  ow doc rename <page|UUID> <新文件名>   改平台文件名（台账同步）
  ow doc tag <page|UUID> [--add a,b] [--remove x,y] [--set a,b]

说明：
  <page> 是台账里的 vault 相对路径（如 references/foo.md）；<UUID> 是平台 doc_id。
  平台 tag 上限 20 字符，超长会静默截断——项目分组用 p:<短名>。
  正文改动请走 ow publish（有门禁与版本管理），这里只动文件名和 tag。`;

/** read_document 的 tags 只能从这里拿（metadata 或顶层，实测两种都有过） */
function tagsOf(doc: { tags?: unknown; metadata?: { tags?: unknown } }): string[] {
  const raw = doc.metadata?.tags ?? doc.tags;
  return Array.isArray(raw) ? raw.map(String) : [];
}

export async function runDoc(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  const vault = needVault(args);
  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });

  if (sub === "rename") {
    const target = args.positional[1];
    const newName = args.positional[2];
    if (!target || !newName) { process.stderr.write("用法：ow doc rename <page|UUID> <新文件名>\n"); return 2; }
    const { docId, pagePath } = resolveDocTarget(vault.dir, target);
    const filename = newName.endsWith(".md") ? newName : `${newName}.md`;
    const cur = await client.readDocument(docId);
    const res = await client.updateDocument({
      documentId: docId,
      baseVersion: cur.version ?? 1,
      filename,
    });
    const version = res.version;
    const ledgerSynced = pagePath ? syncLedgerFilename(vault.dir, docId, filename) : false;
    out(args,
      `✓ 改名：${cur.filename || "(原名为空)"} → ${filename}（v${version ?? "?"}）` +
      `${ledgerSynced ? "\n  台账已同步" : ""}\n  验证：ow query "${filename.replace(/\.md$/, "").slice(0, 12)}"`,
      { docId, filename, version });
    return 0;
  }

  if (sub === "tag") {
    const target = args.positional[1];
    if (!target) { process.stderr.write("用法：ow doc tag <page|UUID> [--add a,b] [--remove x,y] [--set a,b]\n"); return 2; }
    const split = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
    const o = { set: split(flagString(args, "set")), add: split(flagString(args, "add")), remove: split(flagString(args, "remove")) };
    if (!o.set && !o.add && !o.remove) { process.stderr.write("至少给一个 --add / --remove / --set\n"); return 2; }
    const { docId } = resolveDocTarget(vault.dir, target);
    const cur = await client.readDocument(docId);
    const { tags, warnings } = nextTags(tagsOf(cur), o);
    const res = await client.updateDocument({
      documentId: docId,
      baseVersion: cur.version ?? 1,
      tags,
    });
    const human = [
      ...warnings,
      `✓ tags（v${res.version ?? "?"}）：${tags.join("、") || "（已清空）"}`,
    ].join("\n");
    if (isJson(args)) out(args, human, { docId, tags, warnings });
    else out(args, human);
    return 0;
  }

  process.stderr.write(`未知子命令：ow doc ${sub}\n\n${HELP}\n`);
  return 2;
}
