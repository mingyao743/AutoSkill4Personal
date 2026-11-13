#!/usr/bin/env node
/**
 * 一段式抽取校准脚本：对一条真实会话跑完整管线，报告成本、召回、drop 质量与摘要率盲评样本。
 *
 * 取代已删除的 trigger-scan-calibrate（测两段式扫描召回率，两段式已退场）。
 * 正则时代的 hot_hit / cold_found 指标已归档删除（正则已退场，实验已完成）。
 *
 * 用法：
 *   node --experimental-strip-types packages/core/scripts/extract-calibrate.ts <session.jsonl[.zstd]> \
 *     [--limit N] [--budget N] [--batch-chars 12000] [--model ID] \
 *     [--probe "已知信号文本"]... [--out-dir DIR] [--home ~/.pi/agent]
 *
 * 安全：**永远跑在隔离的临时知识库上**（<out-dir>/kb），绝不写真实知识库。
 *
 * 对应验收标准（design/ONE_STAGE_EXTRACT.md §七）：
 *   #1 P0 召回（用 --probe 量）  #2 成本  #3 drop 账完整性  #5 摘要率盲评（导出样本）
 *   #8 压缩 fail-safe 比例       #9 摘抄率分布（调 §八#4 阈值用）
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setHostContext } from "../lib/context.ts";
import { resolveStandaloneConfig } from "../lib/llm.ts";
import { parseSession } from "../lib/window.ts";
import { coverageReport } from "../lib/coverage.ts";
import { runPipeline } from "../lib/pipeline.ts";
import { readDrops, dropStats } from "../lib/drop-log.ts";
import { copyRatio } from "../lib/one-stage.ts";
import { COPY_RATIO_MAX } from "../lib/admission.ts";
import { serializeForExtract } from "../lib/compress.ts";

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string[]>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) {
    if (!flags.has(a)) flags.set(a, []);
    flags.get(a)!.push(next);
    i++;
  } else {
    if (!flags.has(a)) flags.set(a, []);
    flags.get(a)!.push("true");
  }
}
const one = (n: string): string | undefined => flags.get(n)?.[0];
const many = (n: string): string[] => flags.get(n) ?? [];
const has = (n: string): boolean => flags.has(n);

const sessionPath = positional[0];
if (!sessionPath) {
  console.error("用法: extract-calibrate.ts <session.jsonl[.zstd]> [--limit N] [--probe 文本]...");
  process.exit(1);
}

const home = one("--home") ?? join(homedir(), ".pi", "agent");
// 隔离：校准产物与临时知识库都落 tmp，绝不碰真实数据目录
const outDir = one("--out-dir") ?? join(tmpdir(), "autoskill-extract-calibrate");
const dataDir = join(outDir, "kb");
setHostContext({ host: "cli", dataDir, homeDir: existsSync(home) ? home : undefined });

const batchChars = Number(one("--batch-chars") ?? 12_000);
const budgetTokens = Number(one("--budget") ?? 0) || undefined;
const maxBatches = Number(one("--limit") ?? 0) || undefined;
const model = one("--model");
const probes = many("--probe");

// ---------- 读会话 ----------
const readLines = (p: string): string[] =>
  p.endsWith(".zstd")
    ? execFileSync("zstd", ["-d", "-c", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n")
    : readFileSync(p, "utf8").split("\n");

const lines = readLines(sessionPath);
const entries = parseSession(lines);
let sessionId = basename(sessionPath).replace(/\.jsonl(\.zstd)?$/, "");
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line) as { type?: string; id?: string };
    if (e.type === "session" && typeof e.id === "string") { sessionId = e.id; break; }
  } catch { /* 跳过损坏行 */ }
}

const { config, reason } = resolveStandaloneConfig();
if (!config) { console.error(`无可用 LLM 配置：\n${reason}`); process.exit(1); }

const cov = coverageReport(entries, sessionId);
console.log(`会话 ${sessionId}｜一段式`);
console.log(`消息 ${cov.total}｜已覆盖 ${cov.covered}｜待审 ${cov.unreviewed}`);
console.log(`模型 ${model ?? config.model}｜批 ≤${batchChars} 字符${maxBatches ? `｜最多 ${maxBatches} 批` : ""}${budgetTokens ? `｜预算 ${budgetTokens}` : ""}`);
console.log(`临时知识库 ${dataDir}（隔离，不写真实库）`);
if (cov.unreviewed === 0) { console.log("没有待审消息"); process.exit(0); }

mkdirSync(outDir, { recursive: true });

// ---------- 跑管线 ----------
const t0 = Date.now();
const report = await runPipeline({
  sessionId,
  entries,
  harness: "cli",
  model,
  batchChars,
  maxBatches,
  budgetTokens,
  onProgress: (e) => {
    if (e.type !== "batch") return;
    const line = { ts: new Date().toISOString(), batch: e.index, total: e.total, cards: e.candidates, atoms: e.atoms, dropped: e.dropped, inTok: e.tokensIn, outTok: e.tokensOut, ms: e.ms };
    try { appendFileSync(join(outDir, "progress.jsonl"), JSON.stringify(line) + "\n"); } catch { /* 进度落盘失败不影响主流程 */ }
    console.log(`  批 ${e.index}/${e.total}｜出卡 ${e.candidates} 落库 ${e.atoms} 丢弃 ${e.dropped}｜in ${e.tokensIn} out ${e.tokensOut}｜${(e.ms / 1000).toFixed(1)}s`);
  },
});
const elapsedMs = Date.now() - t0;

// ---------- 探针：已知信号有没有出卡（验收 #1） ----------
const entryText = (id: string): string => {
  const e = entries.find((x) => x.id === id);
  const c = e?.message?.content;
  return typeof c === "string" ? c : (c ?? []).map((b) => String((b as { text?: string }).text ?? "")).join("\n");
};
const cardIds = new Set<string>();
for (const a of report.newAtoms) for (const s of a.sources ?? []) for (const id of s.msg_range ?? []) cardIds.add(id);
// msg_range 是区间端点，命中的消息可能落在区间内部：按 entries 顺序展开
const coveredByCards = new Set<string>();
const idxOf = new Map(entries.map((e, i) => [e.id, i]));
for (const a of report.newAtoms) {
  for (const s of a.sources ?? []) {
    const [lo, hi] = [idxOf.get(s.msg_range?.[0] ?? ""), idxOf.get(s.msg_range?.[1] ?? "")];
    if (lo == null || hi == null) continue;
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) coveredByCards.add(entries[i].id);
  }
}
void cardIds;
const probeResults = probes.map((p) => {
  const ids = entries.filter((e) => entryText(e.id).includes(p)).map((e) => e.id);
  const hit = ids.filter((id) => coveredByCards.has(id));
  return { probe: p, messages: ids.length, hit: hit.length > 0, hitMessages: hit.length };
});

// ---------- drop 质量（验收 #3） ----------
const drops = readDrops();
const ds = dropStats(drops);

// ---------- 摘抄率分布（调阈值用，验收 #9） ----------
// 比对对象是 msg_range 内的**压缩后原文**（模型实际看到的），不是模型自己挑的那句 quote
const compLines = serializeForExtract(entries);
const compById = new Map(compLines.map((l) => [l.id, l.text]));
const compOrder = compLines.map((l) => l.id);
const compIdx = new Map(compOrder.map((id, k) => [id, k]));
const srcText = (a: { sources?: { msg_range?: string[] }[] }): string => {
  const ids: string[] = [];
  for (const sc of a.sources ?? []) {
    const r = sc.msg_range ?? [];
    const at = r.map((id) => compIdx.get(id)).filter((x): x is number => x !== undefined);
    if (at.length >= 2) ids.push(...compOrder.slice(Math.min(...at), Math.max(...at) + 1));
    else ids.push(...r);
  }
  return [...new Set(ids)].map((id) => compById.get(id) ?? "").join("\n");
};
const overlaps = report.newAtoms
  .map((a) => ({ id: a.atom_id, type: a.doc_type, ratio: copyRatio(srcText(a), String(a.content ?? "")), len: String(a.content ?? "").length }))
  .filter((o) => o.len >= 100)
  .sort((a, b) => a.ratio - b.ratio);
const q = (p: number): number => (overlaps.length === 0 ? 0 : overlaps[Math.min(overlaps.length - 1, Math.floor(overlaps.length * p))].ratio);

// ---------- 类型分布 ----------
const byType: Record<string, number> = {};
for (const a of report.newAtoms) byType[String(a.doc_type ?? "?")] = (byType[String(a.doc_type ?? "?")] ?? 0) + 1;

// ---------- 汇总 ----------
const total = report.tokensIn + report.tokensOut;
console.log(`\n=== 成本 ===`);
console.log(`token：in ${report.tokensIn} / out ${report.tokensOut} / 合计 ${total}｜耗时 ${(elapsedMs / 1000).toFixed(1)}s｜批 ${report.processedBatches}/${report.batches}`);
console.log(`压缩比 ${report.compressRatio}｜fail-safe 透传 ${report.compressFallback} 条｜净收益不足不压 ${report.compressNoGain} 条`);
console.log(`无价值批 ${report.noValueBatches}｜格式重跑 ${report.retriedBatches}｜申请回读 ${report.needContext}｜drop 账 ${report.dropRows} 行`);
console.log(`user 消息兜底补账 ${report.autoDropped} 条（>0 = 模型静默忽略了用户消息）｜批内未交代消息 ${report.unaccounted} 条`);
console.log(`卡片被拒导致失去归属、由代码补记 drop 的 user 消息 ${report.orphanedByReject} 条（>0 = 闸门拒掉了带用户消息的卡，账已收口不丢）`);
console.log(`带 pending_fields ${report.pendingFieldCards} 张（模型没按类型填特化字段；抽取路径已不强制，仅作观测）｜quote 非逐字 ${report.quoteUnverified} 张（已标记未拦）`);
console.log(`\n=== 产出 ===`);
console.log(`落库卡片 ${report.atoms}｜被拒 ${report.rejected}｜drop ${report.dropped}`);
console.log("类型分布:", byType);
const rr = Object.entries(report.rejectReasons).sort((a, b) => b[1] - a[1]);
const rs = report.rejectSamples ?? {};
// 显示原始原因而不是归一化 key：key 里的数字被换成 N，看不出实际阈值
if (rr.length > 0) console.log("拒绝原因:", Object.fromEntries(rr.map(([k, n]) => [rs[k] ?? k, n])));
console.log(`\n=== drop 账 ===`);
console.log(`共 ${ds.total} 条｜按理由:`, ds.byReason);
console.log("按判定轴:", ds.byAxis);
console.log(`\n=== 摘抄率（正文逐字抄自 msg_range 原文的比例，仅正文 ≥100 字，阈值 ${COPY_RATIO_MAX}）===`);
console.log(`样本 ${overlaps.length}｜中位 ${q(0.5).toFixed(2)}｜P90 ${q(0.9).toFixed(2)}｜最大 ${overlaps.length ? overlaps[overlaps.length - 1].ratio.toFixed(2) : "0"}`);
for (const r of probeResults) console.log(`探针「${r.probe.slice(0, 24)}」: ${r.hit ? `命中（${r.hitMessages}/${r.messages} 条）` : "**未命中**"}`);

// ---------- 盲评样本（验收 #5：人工判"知识还是摘要"，不带类型以免暗示） ----------
const blind = report.newAtoms.slice(0, 20).map((a, i) => ({
  n: i + 1,
  content: a.content,
  quote: a.source_quote ?? "",
  why: a.why ?? "",
  // 判定栏留空给人填：knowledge | summary
  verdict: "",
}));
writeFileSync(join(outDir, "blind-review-sample.jsonl"), blind.map((b) => JSON.stringify(b)).join("\n") + (blind.length ? "\n" : ""));

const result = {
  ts: new Date().toISOString(),
  session: sessionId,
  stage: "one-stage",
  model: model ?? config.model,
  batchChars,
  coverage: cov,
  batches: { used: report.processedBatches, total: report.batches },
  tokens: { in: report.tokensIn, out: report.tokensOut, total },
  elapsedMs,
  atoms: report.atoms,
  rejected: report.rejected,
  rejectReasons: report.rejectReasons,
  rejectSamples: report.rejectSamples,
  dropped: report.dropped,
  byType,
  compress: { ratio: report.compressRatio, fallback: report.compressFallback, noGain: report.compressNoGain },
  oneStage: { noValueBatches: report.noValueBatches, retriedBatches: report.retriedBatches, needContext: report.needContext, dropRows: report.dropRows, autoDropped: report.autoDropped, unaccounted: report.unaccounted, pendingFieldCards: report.pendingFieldCards, quoteUnverified: report.quoteUnverified, orphanedByReject: report.orphanedByReject },
  drops: ds,
  copyRatio: { n: overlaps.length, p50: q(0.5), p90: q(0.9), max: overlaps.length ? overlaps[overlaps.length - 1].ratio : 0, threshold: COPY_RATIO_MAX },
  probes: probeResults,
  stopped: report.stopped ?? null,
  cards: report.newAtoms.map((a) => ({ id: a.atom_id, type: a.doc_type, domain: a.domain, content: a.content, quote: a.source_quote ?? "", value: a.value_tier ?? null })),
};
const target = join(outDir, "calibrate-one-stage.json");
writeFileSync(target, JSON.stringify(result, null, 2));
appendFileSync(join(outDir, "runs.jsonl"), JSON.stringify({
  ts: result.ts, kind: "extract-calibrate", stage: result.stage, session: sessionId,
  batches: report.processedBatches, atoms: report.atoms, rejected: report.rejected, dropped: report.dropped,
  tokensIn: report.tokensIn, tokensOut: report.tokensOut, elapsedMs, stopped: result.stopped,
}) + "\n");
console.log(`\n已写入 ${target}`);
console.log(`盲评样本 ${blind.length} 条 → ${join(outDir, "blind-review-sample.jsonl")}`);
if (report.stopped) console.log(`⚠️ 中断：${report.stopped}`);
