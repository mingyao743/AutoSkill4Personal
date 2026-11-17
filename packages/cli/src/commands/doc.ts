/**
 * `ow doc` —— 已发布文档的字段级修改 + 独立文件上传/下载。
 *
 *   ow doc rename <page|UUID> <新文件名>   改平台文件名（自动补 .md，台账同步）
 *   ow doc tag <page|UUID> [--add a,b] [--remove x,y] [--set a,b]
 *   ow doc upload <file> [--tag a,b] [--private] [--sensitive-policy block|warn|allow]
 *   ow doc download <page|UUID> [--out <file>] [--max-bytes N]
 *   ow doc uploads                       列出本 vault 的上传台账
 *
 * PDF/DOCX 是**独立平台文档**（upload_document），不是知识页附件。
 * 平台没有“替换原件”的 API，重复上传会新建文档；台账按文件 sha256 去重。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  QdocMcpClient, normalizeSensitivePolicy, type SensitivePolicy,
} from "../../../core/lib/publish/mcp.ts";
import { nextTags, resolveDocTarget, syncLedgerFilename } from "../../../core/lib/todo.ts";
import { projectTag } from "../../../core/lib/publish/naming.ts";
import {
  getUpload, hashFileBytes, listUploads, recordUpload,
} from "../../../core/lib/publish/upload-ledger.ts";
import { needVault, out, isJson } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

const HELP = `ow doc —— 文档字段修改 + 独立文件上传/下载

用法：
  ow doc rename <page|UUID> <新文件名>   改平台文件名（台账同步）
  ow doc tag <page|UUID> [--add a,b] [--remove x,y] [--set a,b]
  ow doc upload <file> [选项]            上传 PDF/DOCX/MD/TXT（独立文档）
  ow doc download <page|UUID> [--out f]  下载上传文档的原件
  ow doc uploads                         列出本 vault 的上传台账

upload 选项：
  --tag a,b                 附标签（自动追加项目 tag p:<短名>）
  --private                 is_safe=true：文档不进入 AI 检索
  --sensitive-policy <p>    block（默认）/ warn / allow
  --force                   即使文件 hash 已上传过也重新上传（会新建文档）
  --dry-run                 只打印文件信息，不调平台

说明：
  <page> 是台账里的 vault 相对路径（如 references/foo.md）；<UUID> 是平台 doc_id。
  PDF/DOCX 由平台解析成 Markdown；正文用 ow query / read_document_content(format=markdown) 读。
  平台无删除、无原件替换：同一文件改了内容要重新上传，旧文档仍在线。`;

/** 解析并校验平台敏感策略 */
function policyOf(args: ParsedArgs): SensitivePolicy | null {
  const raw = flagString(args, "sensitive-policy") ?? flagString(args, "policy");
  if (!raw) return "block";
  if (raw === "block" || raw === "warn" || raw === "allow") return raw;
  process.stderr.write(`未知 --sensitive-policy：${raw}（可选 block|warn|allow）\n`);
  return null;
}

/** read_document 的 tags 只能从这里拿（metadata 或顶层） */
function tagsOf(doc: { tags?: unknown; metadata?: { tags?: unknown } }): string[] {
  const raw = doc.metadata?.tags ?? doc.tags;
  return Array.isArray(raw) ? raw.map(String) : [];
}

function splitTags(s?: string): string[] {
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}

const UPLOAD_EXT = new Set([".pdf", ".docx", ".md", ".txt"]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function uploadDoc(args: ParsedArgs, vaultDir: string, projectRoot: string): Promise<number> {
  const fileArg = args.positional[1];
  if (!fileArg) {
    process.stderr.write("用法：ow doc upload <file> [--tag a,b] [--private] [--sensitive-policy block|warn|allow]\n");
    return 2;
  }
  const file = resolve(process.cwd(), fileArg);
  if (!existsSync(file)) {
    process.stderr.write(`文件不存在：${file}\n`);
    return 2;
  }
  const ext = extname(file).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) {
    process.stderr.write(`不支持的文件类型：${ext || "(无扩展名)"}（支持 PDF/DOCX/MD/TXT）\n`);
    return 2;
  }
  const policy = policyOf(args);
  if (!policy) return 2;
  const st = statSync(file);
  if (st.size > MAX_UPLOAD_BYTES) {
    process.stderr.write(`文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过平台上限 20MB\n`);
    return 2;
  }

  const content = readFileSync(file);
  const hash = hashFileBytes(content);
  const filename = basename(file);
  const tags = [...new Set([...splitTags(flagString(args, "tag") ?? flagString(args, "tags")), projectTag(projectRoot)])].slice(0, 10);
  const isSafe = flagBool(args, "private");
  const force = flagBool(args, "force");
  const dryRun = flagBool(args, "dry-run");

  const prev = getUpload(vaultDir, hash);
  if (prev && !force) {
    out(args, [
      `＝ 已上传过（hash ${hash.slice(0, 19)}…）`,
      `  doc_id：${prev.document_id}`,
      `  文件名：${prev.filename}`,
      `  原上传：${prev.uploaded_at}`,
      "  文件未变，未重复上传；要强制重传加 --force（会在平台新建一篇）",
    ].join("\n"), { status: "unchanged", upload: prev });
    return 0;
  }

  if (dryRun) {
    out(args, [
      "（干跑，未调用平台）",
      `文件：${filename}（${(st.size / 1024 / 1024).toFixed(2)}MB）`,
      `hash：${hash}`,
      `策略：sensitive=${policy} / private=${isSafe}`,
      `tags：${tags.join("、")}`,
    ].join("\n"), { status: "dry-run", filename, size: st.size, hash, policy, tags, isSafe });
    return 0;
  }

  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
  try {
    const res = await client.uploadDocument({
      filename, content, tags, isSafe, sensitivePolicy: policy,
    });
    const id = res.doc_id ?? res.id;
    if (id == null) throw new Error(`upload_document 未返回 id：${JSON.stringify(res).slice(0, 200)}`);
    const warnings = res.sensitive_warnings ?? [];
    recordUpload(vaultDir, {
      file_hash: hash,
      document_id: id,
      filename: res.filename ?? filename,
      size: res.size ?? st.size,
      tags,
      source_file_url: res.source_file_url,
      parsed_format: res.parsed_format,
      parsed_chars: res.parsed_chars,
      sensitive_warnings: warnings,
      is_safe: isSafe,
      uploaded_at: new Date().toISOString(),
    });
    const lines = [
      `↑ 已上传：${filename}（id=${id}, v${res.version ?? "?"}）`,
      `  解析：${res.parsed_format ?? "?"} / ${res.parsed_chars ?? "?"} 字符`,
      res.source_file_url ? `  原件：${res.source_file_url}` : "",
      warnings.length ? `  ⚠ 平台敏感告警 ${warnings.length} 条：` : "",
      ...warnings.map((w) => `    - ${w}`),
      "  下一步：ow doc tag <UUID> --add ... / ow query 关键词",
    ].filter(Boolean);
    out(args, lines.join("\n"), { status: "uploaded", doc_id: id, version: res.version, upload: { ...res, hash } });
    return 0;
  } catch (e) {
    const msg = String(e).slice(0, 500);
    process.stderr.write(`上传失败：${msg}\n`);
    if (/敏感|sensitive/i.test(msg)) {
      process.stderr.write(
        "平台敏感检测拒绝了该文件。处理：修改原件后重传；或显式评估后用 --sensitive-policy warn（会写入并返回告警）。\n",
      );
    }
    return 1;
  }
}

async function downloadDoc(args: ParsedArgs, vaultDir: string): Promise<number> {
  const target = args.positional[1];
  if (!target) {
    process.stderr.write("用法：ow doc download <page|UUID> [--out <file>]\n");
    return 2;
  }
  const { docId } = resolveDocTarget(vaultDir, target);
  const maxBytes = Number(flagString(args, "max-bytes") ?? 5 * 1024 * 1024);
  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
  try {
    const res = await client.readDocumentSource(docId, Math.min(Math.max(maxBytes, 1), 20 * 1024 * 1024));
    if (!res.content_base64) {
      process.stderr.write(`文档 ${docId} 没有保留原件（纯 Markdown 创建的文档没有 source file）\n`);
      return 1;
    }
    const outPath = resolve(process.cwd(), flagString(args, "out") ?? basename(res.filename ?? `${String(docId)}.bin`));
    writeFileSync(outPath, Buffer.from(res.content_base64, "base64"));
    out(args, [
      `↓ 已下载：${outPath}`,
      `  文件名：${res.filename ?? "?"}`,
      `  大小：${res.size ?? "?"} bytes / mime=${res.mime ?? "?"}`,
      res.truncated ? "  ⚠ 平台返回被 max_bytes 截断，文件可能不完整；加大 --max-bytes" : "",
    ].filter(Boolean).join("\n"), { status: "downloaded", path: outPath, ...res, content_base64: undefined });
    return res.truncated ? 1 : 0;
  } catch (e) {
    process.stderr.write(`下载失败：${String(e).slice(0, 300)}\n`);
    return 1;
  }
}

export async function runDoc(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  const vault = needVault(args);

  if (sub === "upload") return uploadDoc(args, vault.dir, vault.projectRoot);
  if (sub === "download") return downloadDoc(args, vault.dir);

  if (sub === "uploads") {
    const list = listUploads(vault.dir);
    const lines = list.length
      ? list.map((u) => `${u.document_id}  ${u.filename}  ${(u.size / 1024 / 1024).toFixed(2)}MB  ${u.sensitive_warnings.length ? `⚠${u.sensitive_warnings.length}` : ""}`)
      : ["（无上传记录）"];
    out(args, lines.join("\n"), { uploads: list });
    return 0;
  }

  if (sub === "rename") {
    const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
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
    const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
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
