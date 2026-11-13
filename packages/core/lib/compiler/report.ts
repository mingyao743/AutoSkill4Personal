/**
 * 编译报告：把一次编译的结果落成 `compile-report.json`，并写页面到 vault。
 *
 * 报告是「编译器 → 发布器」的契约（方案 §4）：候选页由编译器初判，
 * 发布器仍要过 7 道门禁。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bodyHash, renderFrontmatter, type Frontmatter, type PublishAs, type PublishStatus } from "../vault/frontmatter.ts";
import { guardPage } from "../vault/guard.ts";
import type { CompileRunResult, RawPage } from "./run.ts";
import type { WindowPayload } from "../trigger/window.ts";

export interface PageResult {
  path: string;
  title: string;
  action: "created" | "updated" | "skipped";
  reason?: string;
}

export interface CompileReport {
  schema: 1;
  window_hash: string;
  agent: string;
  session_id: string;
  from_turn: number;
  to_turn: number;
  model: string;
  started_at: string;
  elapsed_ms: number;
  pages_created: number;
  pages_updated: number;
  pages_skipped: Array<{ path?: string; reason: string; detail?: string }>;
  /** 这次编译是自动触发还是用户点名（方案 §6.5）；事后能分清哪页是哪来的 */
  trigger?: "auto" | "manual";
  publish_candidates: string[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  warnings: string[];
}

export const MAX_PAGES_PER_WINDOW = 8;

export interface WritePagesOptions {
  vaultDir: string;
  window: WindowPayload;
  result: CompileRunResult;
  /** 自动 / 手动（方案 §6.5）；缺省记 auto */
  trigger?: "auto" | "manual";
}

/** 把编译结果写进 vault，返回报告 */
export function writeCompileResult(opts: WritePagesOptions): CompileReport {
  const { vaultDir, window, result } = opts;
  const trigger = opts.trigger ?? "auto";
  const startedAt = new Date(Date.now() - result.elapsedMs).toISOString();
  const warnings: string[] = [];
  const skipped: CompileReport["pages_skipped"] = [];
  const candidates: string[] = [];
  let created = 0;
  let updated = 0;

  let pages = result.pages;
  if (pages.length > MAX_PAGES_PER_WINDOW) {
    warnings.push(`编译器产出 ${pages.length} 页，超出上限 ${MAX_PAGES_PER_WINDOW}，已截断`);
    skipped.push(...pages.slice(MAX_PAGES_PER_WINDOW).map((p) => ({
      path: p.path,
      reason: "over-page-limit",
    })));
    pages = pages.slice(0, MAX_PAGES_PER_WINDOW);
  }
  for (const s of result.skipped) skipped.push({ reason: s.reason, detail: s.detail });

  for (const page of pages) {
    const sources = page.sources?.length ? page.sources : [`session:${window.session_id}`];
    const guard = guardPage({
      vaultDir,
      candidatePath: page.path,
      sources,
      title: page.title,
    });

    if (guard.decision === "blocked") {
      skipped.push({ path: page.path, reason: guard.reason, detail: `撞上 ${guard.existingPath}` });
      continue;
    }

    const meta: Frontmatter = {
      title: page.title,
      summary: page.summary,
      tags: page.tags,
      sources,
      provenance: `${window.agent}:${window.session_id}#${window.from_turn}-${window.to_turn}`,
      base_confidence: page.base_confidence ?? 0.6,
      lifecycle: page.lifecycle ?? "active",
      publish_as: normalizePublishAs(page.publish_as),
      publish_status: "pending",
      source_agent: window.agent,
      source_session: window.session_id,
      source_turns: `${window.from_turn}-${window.to_turn}`,
    };

    const text = `${renderFrontmatter(meta)}${page.body.trim()}\n`;
    const abs = join(vaultDir, page.path);
    mkdirSync(dirname(abs), { recursive: true });
    const existed = existsSync(abs);
    writeFileSync(abs, text, "utf8");

    if (guard.decision === "update" && guard.existingPath && guard.existingPath !== page.path) {
      // 合并到已有页（同源同题）：把新正文追加到已有页，标 deprecated 来源
      warnings.push(`${page.path} 判定应合并到 ${guard.existingPath}，当前实现为独立写入`);
    }

    if (existed) updated += 1;
    else created += 1;
    if (meta.publish_as !== "local") candidates.push(page.path);
  }

  const report: CompileReport = {
    schema: 1,
    window_hash: window.hash,
    trigger,
    agent: window.agent,
    session_id: window.session_id,
    from_turn: window.from_turn,
    to_turn: window.to_turn,
    model: result.model,
    started_at: startedAt,
    elapsed_ms: result.elapsedMs,
    pages_created: created,
    pages_updated: updated,
    pages_skipped: skipped,
    publish_candidates: candidates,
    usage: result.usage,
    warnings,
  };

  writeReport(vaultDir, report);
  return report;
}

function normalizePublishAs(v: string | undefined): PublishAs {
  return v === "skill" || v === "local" ? v : "document";
}

/** 报告落盘：`.ow/reports/<window_hash 短码>.json` + 最新一份 `compile-report.json` */
export function writeReport(vaultDir: string, report: CompileReport): void {
  const dir = join(vaultDir, ".ow", "reports");
  mkdirSync(dir, { recursive: true });
  const short = report.window_hash.replace(/^sha256:/, "").slice(0, 12);
  writeFileSync(join(dir, `${short}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(vaultDir, ".ow", "compile-report.json"), JSON.stringify(report, null, 2), "utf8");
}

/** 读最近一次报告（`ow status` / 调试用） */
export function readLastReport(vaultDir: string): CompileReport | null {
  const p = join(vaultDir, ".ow", "compile-report.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CompileReport;
  } catch {
    return null;
  }
}

/** 校验模型产出的一页是否够格发布（结构层，门禁的廉价前置） */
export function validatePage(page: RawPage): { ok: boolean; reason?: string } {
  if (!page.path.endsWith(".md")) return { ok: false, reason: "not-markdown" };
  if (page.body.trim().length < 80) return { ok: false, reason: "body-too-short" };
  if (!page.title.trim()) return { ok: false, reason: "no-title" };
  return { ok: true };
}

export { bodyHash };
