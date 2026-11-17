/**
 * 独立上传台账：`.publish/uploads.json`。
 *
 * 平台 `upload_document` 只支持“新建”，没有“替换原件”的 API；同一个文件
 * 重复上传会在平台留下多篇文档（无 delete）。所以按**文件内容 sha256** 记账：
 * 内容没变就跳过；内容变了才新建，并明确告诉用户旧文档仍在线。
 *
 * key = sha256(file bytes)。改名但内容相同会被视为同一文件；需要重新上传时
 * 用 `--force`。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UploadEntry {
  file_hash: string;
  document_id: number | string;
  filename: string;
  size: number;
  tags: string[];
  source_file_url?: string;
  parsed_format?: string;
  parsed_chars?: number;
  sensitive_warnings: string[];
  is_safe: boolean;
  uploaded_at: string;
}

export interface UploadLedger {
  schema: 1;
  files: Record<string, UploadEntry>;
}

export function uploadLedgerPath(vaultDir: string): string {
  return join(vaultDir, ".publish", "uploads.json");
}

export function hashFileBytes(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

export function readUploadLedger(vaultDir: string): UploadLedger {
  const p = uploadLedgerPath(vaultDir);
  if (!existsSync(p)) return { schema: 1, files: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<UploadLedger>;
    return { schema: 1, files: raw.files ?? {} };
  } catch {
    try { renameSync(p, `${p}.corrupt-${Date.now()}`); } catch { /* 忽略 */ }
    return { schema: 1, files: {} };
  }
}

export function writeUploadLedger(vaultDir: string, ledger: UploadLedger): void {
  const p = uploadLedgerPath(vaultDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
  renameSync(tmp, p);
}

export function getUpload(vaultDir: string, fileHash: string): UploadEntry | null {
  return readUploadLedger(vaultDir).files[fileHash] ?? null;
}

export function recordUpload(vaultDir: string, entry: UploadEntry): void {
  const ledger = readUploadLedger(vaultDir);
  ledger.files[entry.file_hash] = entry;
  writeUploadLedger(vaultDir, ledger);
}

export function listUploads(vaultDir: string): UploadEntry[] {
  return Object.values(readUploadLedger(vaultDir).files).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
}
