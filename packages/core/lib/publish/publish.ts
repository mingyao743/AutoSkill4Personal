/**
 * 发布主流程：一页 markdown → 平台文档。
 *
 * 步骤：读页 → 渲染 → 跑门禁 → （create | update | skip）→ 记账本
 *
 * **幂等性靠三样东西**：账本里的 body_hash（跳过未变）、document_id（更新而非重建）、
 * filename 前缀（找不到账本时按前缀兜底匹配）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLedger, recordFailure, recordPublish, shouldRetry, type LedgerEntry } from "./ledger.ts";
import { describeGates, runGates, type GateResult } from "./gate.ts";
import { toPlatformFilename, legacyFilename, projectTag } from "./naming.ts";
import { renderForPublish, parseMetaComment } from "../vault/render.ts";
import { bodyHash } from "../vault/frontmatter.ts";
import { applyRedactPolicy, type RedactPolicy } from "../security/redact.ts";
import type { QdocMcpClient, DocSummary } from "./mcp.ts";

export interface PublishPageOptions {
  client: QdocMcpClient;
  vaultDir: string;
  /** 项目根（filename 前缀用） */
  projectRoot: string;
  /** vault 内相对路径，如 `concepts/foo.md` */
  pagePath: string;
  /** 干跑：只跑门禁不真的发 */
  dryRun?: boolean;
  /** 平台已有同标题文档（调用方预取；不传则本函数自己查） */
  existing?: DocSummary;
}

export interface PublishPageResult {
  pagePath: string;
  action: "created" | "updated" | "skipped" | "blocked" | "failed";
  documentId?: number | string;
  filename?: string;
  version?: number;
  gate: GateResult;
  message?: string;
}

/** 发布一页 */
export async function publishPage(opts: PublishPageOptions): Promise<PublishPageResult> {
  const abs = join(opts.vaultDir, opts.pagePath);
  if (!existsSync(abs)) {
    return {
      pagePath: opts.pagePath,
      action: "failed",
      gate: emptyGate(),
      message: "页面文件不存在",
    };
  }
  const markdown = readFileSync(abs, "utf8");
  const ledger = readLedger(opts.vaultDir);
  const entry: LedgerEntry | null = ledger.pages[opts.pagePath] ?? null;

  // 连续失败太多次：不再自动重试，交人工
  if (!shouldRetry(entry)) {
    return {
      pagePath: opts.pagePath,
      action: "failed",
      gate: emptyGate(),
      message: `已连续失败 ${entry?.failures} 次（${entry?.last_error ?? ""}），需人工处理`,
    };
  }

  // 脱敏：默认 block（有高危密钥就拒绝发布）。
  // 必须放在渲染**之前**——`--redact replace` 改的是要发出去的正文，
  // 放到渲染之后就会改到带 meta 注释的版本，正文与本地对不上。
  const redactPolicy: RedactPolicy = opts.redact ?? "block";
  const redacted = applyRedactPolicy(markdown, redactPolicy);
  if (!redacted.allowed) {
    return {
      pagePath: opts.pagePath,
      action: "blocked",
      gate: emptyGate(),
      message: redacted.messages.join("\n"),
    };
  }
  const outgoing = redacted.text;

  // 渲染：剥本地字段 + wikilink 改写 + 追加 meta 注释
  const rendered = renderForPublish(outgoing, {
    pagePath: opts.pagePath,
    contentHash: bodyHash(markdown),
  });

  // 平台已有同标题文档？账本优先（含可达性校验），其次按 filename 扫描
  const found = opts.existing
    ? { doc: opts.existing, healed: false }
    : await findExisting(opts, rendered.title);
  const existing = found.doc;

  const gate = runGates({
    path: opts.pagePath,
    markdown: outgoing,
    // `warn` 策略下用户已明确表示「知道有密钥，还是要发」，
    // 否则脱敏策略与门禁会互相打架（策略说放行，门禁又拦）。
    skipPrivacyGate: redactPolicy === "warn" || (redactPolicy === "replace" && redacted.replaced > 0),
    existing: existing ? { id: existing.id, filename: existing.filename, version: existing.version } : undefined,
    // 自愈重建时**忘掉**上次发布哈希：平台文档已不在，hash 相等不该再触发 skip
    publishedHash: found.healed ? undefined : entry?.body_hash,
    allowUpdate: true,
  });

  if (!gate.pass) {
    return {
      pagePath: opts.pagePath,
      action: "blocked",
      gate,
      message: describeGates(gate),
    };
  }
  if (gate.action === "skip") {
    return { pagePath: opts.pagePath, action: "skipped", gate, message: "正文未变，跳过" };
  }
  if (opts.dryRun) {
    return {
      pagePath: opts.pagePath,
      action: gate.action === "update" ? "updated" : "created",
      gate,
      message: `干跑：将 ${gate.action}（未实际调用平台）`,
    };
  }

  const filename = existing?.filename ?? toPlatformFilename(opts.pagePath);
  // create 时打上项目 tag：search/list 都能按它过滤（前缀已废，分组靠 tag）
  const createTags = [...new Set([...(rendered.tags ?? []), projectTag(opts.projectRoot)])];

  try {
    if (gate.action === "update" && existing) {
      const res = await opts.client.updateDocument({
        documentId: existing.id,
        content: rendered.text,
        baseVersion: existing.version ?? 1,
      });
      const id = res?.doc_id ?? res?.id ?? existing.id;
      recordPublish(opts.vaultDir, opts.pagePath, {
        document_id: id,
        filename,
        version: res?.version,
        body_hash: gate.hash,
        publish_as: "document",
        status: "published",
      });
      return {
        pagePath: opts.pagePath,
        action: "updated",
        documentId: id,
        filename,
        version: res?.version,
        gate,
      };
    }

    const res = await opts.client.createDocument({
      filename,
      content: rendered.text,
      tags: createTags,
    });
    const id = res.doc_id ?? res.id;
    if (id == null) throw new Error(`create_document 未返回 id：${JSON.stringify(res)}`);
    recordPublish(opts.vaultDir, opts.pagePath, {
      document_id: id,
      filename,
      version: res.version,
      body_hash: gate.hash,
      publish_as: "document",
      status: "published",
    });
    return {
      pagePath: opts.pagePath,
      action: "created",
      documentId: id,
      filename,
      version: res.version,
      gate,
    };
  } catch (e) {
    const msg = String(e).slice(0, 300);
    recordFailure(opts.vaultDir, opts.pagePath, msg);
    return { pagePath: opts.pagePath, action: "failed", gate, message: msg };
  }
}

/** 批量发布（按页顺序，失败不中断） */
export async function publishPages(
  opts: Omit<PublishPageOptions, "pagePath"> & { pagePaths: string[] },
): Promise<PublishPageResult[]> {
  const out: PublishPageResult[] = [];
  for (const pagePath of opts.pagePaths) {
    out.push(await publishPage({ ...opts, pagePath }));
  }
  return out;
}

/**
 * 找平台侧已有文档。返回 `healed: true` 表示「台账里的 doc 已确认不存在，
 * 本次要重建」——调用方应忘掉上次发布哈希，避免门禁误判 skip。
 *
 * 顺序：
 *   1. 账本 document_id 直取——**先验可达性**（`read_document` 探一下）。
 *      token 重新生成后命名空间可能变，旧 doc_id 会查无此文（2026-11-16 实测）。
 *      只把「确认不存在」当自愈信号，认证/网络错误原样抛出（那类错误下
 *      create 也会失败，不会造成重复创建）。
 *   2. 按 filename 扫描（新旧两种形式都认）——兜「换了机器/台账丢了」。
 *
 * 平台 id 已是 UUID（旧数字 id 定义上不可达），`search_documents` 对 filename
 * 不敏感，所以扫描用 list_documents 翻页。
 */
async function findExisting(
  opts: PublishPageOptions,
  title: string,
): Promise<{ doc?: DocSummary; healed: boolean }> {
  const ledger = readLedger(opts.vaultDir);
  const entry = ledger.pages[opts.pagePath];
  if (entry?.document_id != null) {
    // 平台 2026-11-16 起 doc_id 只收 UUID 字符串（实测 pydantic 报
    // "Input should be a valid string"）——台账里的旧数字 id 定义上不可达，
    // 直接重建，不浪费一次探测。
    if (typeof entry.document_id === "number") {
      recordFailure(opts.vaultDir, opts.pagePath,
        `台账 doc_id ${entry.document_id} 是旧数字 id（平台已改 UUID），本次将重建`);
      return { healed: true };
    }
    try {
      const fresh = await opts.client.readDocument(entry.document_id);
      // 平台侧为准（version 可能比台账新）
      return {
        doc: {
          id: fresh.id ?? entry.document_id,
          filename: fresh.filename || entry.filename,
          version: fresh.version ?? entry.version,
        },
        healed: false,
      };
    } catch (e) {
      const msg = String(e);
      if (/不存在|not\s*found|找不到|无效|invalid|no such|validation error/i.test(msg)) {
        recordFailure(opts.vaultDir, opts.pagePath,
          `台账 doc_id ${entry.document_id} 不可达（${msg.slice(0, 80)}），本次将重建`);
        return { healed: true };
      }
      throw e; // 认证/网络错误：让上层 recordFailure 兜住，不盲目重建
    }
  }

  const expected = toPlatformFilename(opts.pagePath);
  const legacy = legacyFilename(opts.pagePath, opts.projectRoot);
  try {
    for (let offset = 0; offset < 500; offset += 50) {
      const batch = await opts.client.listDocuments({ limit: 50, offset });
      if (batch.length === 0) break;
      const hit = batch.find((d) => d.filename === expected || d.filename === legacy);
      if (hit) return { doc: hit, healed: false };
      if (batch.length < 50) break;
    }
  } catch {
    // 查不到就当新建；真撞了平台会报错，由 recordFailure 兜住
  }
  return { healed: false };
}

function emptyGate(): GateResult {
  return { pass: false, action: "skip", issues: [], hash: "" };
}

/** 从平台正文还原来源（「查」时用） */
export function provenanceOf(platformContent: string): Record<string, unknown> | null {
  return parseMetaComment(platformContent);
}
