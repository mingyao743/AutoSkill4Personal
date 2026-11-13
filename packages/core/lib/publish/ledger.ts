/**
 * 发布账本：`.qdoc/.publish/ledger.json`。
 *
 * 记什么：每页在平台侧的 `document_id` / `version` / `body_hash` / `filename`。
 *
 * 为什么必须有：平台没有 namespace、没有 delete、`update_document` 需要 document_id。
 * 不记账本，第二次发布就不知道「这页上次发到哪个 id 了」，只能靠 filename 搜，
 * 而 filename 可以被人工改。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PublishAs, PublishStatus } from "../vault/frontmatter.ts";

export interface LedgerEntry {
  /** 平台 document_id */
  document_id: number | string;
  /** 平台 filename（含前缀，见 §9.2） */
  filename: string;
  /** 平台 version */
  version?: number;
  /** 已发布的正文哈希（不含 frontmatter） */
  body_hash: string;
  /** 页面 hash（含 frontmatter），用于「页面是否变过」 */
  page_hash?: string;
  publish_as: PublishAs;
  status: PublishStatus;
  published_at: string;
  updated_at?: string;
  /** 发布失败次数，用于退避与告警 */
  failures?: number;
  last_error?: string;
}

export interface Ledger {
  schema: 1;
  /** key = vault 内相对路径 */
  pages: Record<string, LedgerEntry>;
}

export function ledgerPath(vaultDir: string): string {
  return join(vaultDir, ".publish", "ledger.json");
}

export function readLedger(vaultDir: string): Ledger {
  const p = ledgerPath(vaultDir);
  if (!existsSync(p)) return { schema: 1, pages: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Ledger>;
    return { schema: 1, pages: raw.pages ?? {} };
  } catch {
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      /* 挪不动就算了 */
    }
    return { schema: 1, pages: {} };
  }
}

export function writeLedger(vaultDir: string, ledger: Ledger): void {
  const p = ledgerPath(vaultDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
  renameSync(tmp, p);
}

export function getEntry(vaultDir: string, pagePath: string): LedgerEntry | null {
  return readLedger(vaultDir).pages[pagePath] ?? null;
}

/** 发布成功后写账本 */
export function recordPublish(
  vaultDir: string,
  pagePath: string,
  entry: Omit<LedgerEntry, "published_at">,
): void {
  const ledger = readLedger(vaultDir);
  const prev = ledger.pages[pagePath];
  ledger.pages[pagePath] = {
    ...entry,
    published_at: prev?.published_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    failures: 0,
    last_error: undefined,
  };
  writeLedger(vaultDir, ledger);
}

/** 发布失败记账（用于退避：连续失败 3 次后不再自动重试） */
export function recordFailure(vaultDir: string, pagePath: string, error: string): void {
  const ledger = readLedger(vaultDir);
  const prev = ledger.pages[pagePath];
  if (!prev) return; // 从没成功过的不记，避免账本膨胀
  ledger.pages[pagePath] = {
    ...prev,
    failures: (prev.failures ?? 0) + 1,
    last_error: error.slice(0, 300),
  };
  writeLedger(vaultDir, ledger);
}

/** 是否该放弃自动重试 */
export const MAX_FAILURES = 3;

export function shouldRetry(entry: LedgerEntry | null): boolean {
  return (entry?.failures ?? 0) < MAX_FAILURES;
}

/** 墓碑：平台没有 delete，只能改状态（§9.5） */
export function markTombstone(vaultDir: string, pagePath: string): void {
  const ledger = readLedger(vaultDir);
  const prev = ledger.pages[pagePath];
  if (!prev) return;
  ledger.pages[pagePath] = { ...prev, status: "tombstone", updated_at: new Date().toISOString() };
  writeLedger(vaultDir, ledger);
}

/** 账本统计（`ow status` 用） */
export function ledgerStats(vaultDir: string): {
  total: number; published: number; pending: number; tombstone: number; failing: number;
} {
  const pages = Object.values(readLedger(vaultDir).pages);
  return {
    total: pages.length,
    published: pages.filter((p) => p.status === "published").length,
    pending: pages.filter((p) => p.status === "pending").length,
    tombstone: pages.filter((p) => p.status === "tombstone").length,
    failing: pages.filter((p) => (p.failures ?? 0) >= MAX_FAILURES).length,
  };
}
