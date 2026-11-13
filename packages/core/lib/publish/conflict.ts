/**
 * 发布冲突：平台侧被人工改过时，不盲目覆盖。
 *
 * 判定：平台 `version` > 账本记的 `version`，说明有人在我们上次发布之后
 * 直接在网页上改过这份文档。此时若本地也变了，两边都有新内容 → 冲突。
 *
 * 处理：把两边都落盘到 `.publish/conflicts/<page>.{local,remote}.md`，
 * 等 `ow review` 让人选（§11.3 —— 这是少数必须人工的地方）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLedger } from "./ledger.ts";
import type { QdocMcpClient, DocSummary } from "./mcp.ts";

export interface ConflictRecord {
  pagePath: string;
  localPath: string;
  remotePath: string;
  localHash: string;
  remoteHash: string;
  localVersion?: number;
  remoteVersion?: number;
  detectedAt: string;
}

export interface DetectInput {
  client: QdocMcpClient;
  vaultDir: string;
  pagePath: string;
  /** 平台侧当前文档（含 version） */
  remote: DocSummary;
  /** 本地正文哈希 */
  localHash: string;
}

export function conflictsDir(vaultDir: string): string {
  return join(vaultDir, ".publish", "conflicts");
}

/**
 * 是否冲突。
 *
 * 不冲突的两种情况：
 *  - 平台 version 与账本一致（没人动过）
 *  - 本地哈希与账本一致（本地没动，平台动了 → 直接以平台为准，不冲突）
 */
export function isConflict(input: DetectInput): boolean {
  const ledger = readLedger(input.vaultDir);
  const entry = ledger.pages[input.pagePath];
  if (!entry) return false; // 从没发过，谈不上冲突
  const remoteVersion = input.remote.version ?? 0;
  const knownVersion = entry.version ?? 0;
  if (remoteVersion <= knownVersion) return false;
  // 本地也没变 → 平台更新是唯一变化，不算冲突（下次发布会把它盖回去，但那是有意的）
  if (entry.body_hash === input.localHash) return false;
  return true;
}

/** 落盘冲突现场，等人工裁决 */
export async function recordConflict(
  input: DetectInput & { localMarkdown: string },
): Promise<ConflictRecord> {
  const dir = conflictsDir(input.vaultDir);
  mkdirSync(dir, { recursive: true });

  const safe = input.pagePath.replace(/[/\\]/g, "__").replace(/\.md$/, "");
  const localPath = join(dir, `${safe}.local.md`);
  const remotePath = join(dir, `${safe}.remote.md`);

  writeFileSync(localPath, input.localMarkdown, "utf8");

  let remoteText = "";
  try {
    remoteText = await input.client.readDocumentContent(Number(input.remote.id));
  } catch (e) {
    remoteText = `<!-- 读取平台正文失败：${String(e).slice(0, 200)} -->`;
  }
  writeFileSync(remotePath, remoteText, "utf8");

  const ledger = readLedger(input.vaultDir);
  const entry = ledger.pages[input.pagePath];
  const record: ConflictRecord = {
    pagePath: input.pagePath,
    localPath,
    remotePath,
    localHash: input.localHash,
    remoteHash: entry?.body_hash ?? "",
    localVersion: entry?.version,
    remoteVersion: input.remote.version,
    detectedAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, `${safe}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** 列出所有未裁决冲突 */
export function listConflicts(vaultDir: string): ConflictRecord[] {
  const dir = conflictsDir(vaultDir);
  if (!existsSync(dir)) return [];
  const out: ConflictRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ConflictRecord);
    } catch {
      /* 损坏的记录跳过 */
    }
  }
  return out.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

/** 裁决后清场 */
export function resolveConflict(vaultDir: string, pagePath: string): void {
  const dir = conflictsDir(vaultDir);
  if (!existsSync(dir)) return;
  const safe = pagePath.replace(/[/\\]/g, "__").replace(/\.md$/, "");
  for (const suffix of [".json", ".local.md", ".remote.md"]) {
    try {
      rmSync(join(dir, `${safe}${suffix}`), { force: true });
    } catch {
      /* 清不掉就留着，不影响正确性 */
    }
  }
}
