/** 独立上传台账：按文件 sha256 去重 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  getUpload, hashFileBytes, listUploads, readUploadLedger, recordUpload,
} from "../lib/publish/upload-ledger.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-upload-"));

section("hash 稳定且区分内容");
{
  eq(hashFileBytes(Buffer.from("a")), hashFileBytes(Buffer.from("a")), "同内容同 hash");
  ok(hashFileBytes(Buffer.from("a")) !== hashFileBytes(Buffer.from("b")), "不同内容不同 hash");
}

section("记录/读取/列出");
{
  const vault = tmp();
  const hash = hashFileBytes(Buffer.from("pdf-bytes"));
  eq(getUpload(vault, hash), null, "空台账");
  recordUpload(vault, {
    file_hash: hash,
    document_id: "doc-1",
    filename: "a.pdf",
    size: 9,
    tags: ["p:x"],
    parsed_format: "markdown",
    parsed_chars: 12,
    sensitive_warnings: [],
    is_safe: false,
    uploaded_at: "2026-11-17T00:00:00.000Z",
  });
  eq(getUpload(vault, hash)?.document_id, "doc-1", "按 hash 取回");
  eq(readUploadLedger(vault).files[hash].filename, "a.pdf", "落盘内容");
  eq(listUploads(vault).length, 1, "列出");
  rmSync(vault, { recursive: true, force: true });
}

section("corrupt 台账不崩");
{
  const vault = tmp();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(vault, ".publish"), { recursive: true });
  writeFileSync(join(vault, ".publish", "uploads.json"), "{bad", "utf8");
  eq(Object.keys(readUploadLedger(vault).files), [], "坏文件当空台账");
  rmSync(vault, { recursive: true, force: true });
}

process.exit(summary());
