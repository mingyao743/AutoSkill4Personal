#!/usr/bin/env node
/**
 * 触发扫描校准脚本：对一条真实会话跑"覆盖派生 + 触发扫描"，报告成本与召回。
 *
 * ⚠️ **已过时（2026-11-12）**：一段式已定为唯一路径，没有独立扫描这一段了，本工具测的"扫描召回率"不再是有效指标。
 *    请改用 `scripts/extract-calibrate.ts`（端到端召回 + drop 质量 + 重合度分布 + 盲评样本）。
 *    保留原因：`--two-stage` 回退路径还在，质量验收通过后连同 `lib/trigger-scan.ts` 一起删除。
 *
 * 用法：
 *   node --experimental-strip-types packages/core/scripts/trigger-scan-calibrate.ts <session.jsonl[.zstd]> \
 *     [--home ~/.pi/agent] [--data-dir DIR] [--batch-chars 12000] [--model ID] \
 *     [--budget 60000] [--limit N] [--probe "文本"]... [--dry] [--out FILE]
 *
 * 说明：
 *   --dry      只做覆盖 + 序列化，不调用模型（0 成本）
 *   --probe    已知信号探针，可多次传；报告命中情况
 *   --limit    只跑前 N 批（试跑省钱）
 *
 * 产物：控制台摘要 + runs.jsonl 一行 +（可选）完整候选 JSON
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setHostContext } from "../lib/context.ts";
import { resolveStandaloneConfig } from "../lib/llm.ts";
import { parseSession } from "../lib/window.ts";
import { coverageReport, uncoveredEntries } from "../lib/coverage.ts";
import { batchLines, runScan, serializeForScan } from "../lib/trigger-scan.ts";

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
const one = (name: string): string | undefined => flags.get(name)?.[0];
const many = (name: string): string[] => flags.get(name) ?? [];
const has = (name: string): boolean => flags.has(name);

const sessionPath = positional[0];
if (!sessionPath) {
  console.error("用法: trigger-scan-calibrate.ts <session.jsonl[.zstd]> [--dry] [--limit N] [--probe 文本]...");
  process.exit(1);
}

const home = one("--home") ?? join(homedir(), ".pi", "agent");
const dataDir = one("--data-dir") ?? process.env.AUTOSKILL_DATA_DIR ?? join(home, "data", "autoskill", "knowledge");
setHostContext({ host: "cli", dataDir, homeDir: existsSync(home) ? home : undefined });

const batchChars = Number(one("--batch-chars") ?? 12_000);
const budgetTokens = Number(one("--budget") ?? 0) || undefined;
const maxBatches = Number(one("--limit") ?? 0) || undefined;
const model = one("--model");
const dry = has("--dry");
const ignoreCoverage = has("--ignore-coverage");
const outPath = one("--out");
// 校准产物单独落盘：宿主数据目录可能只读（沙箱/权限），不要污染真实知识库
const outDir = one("--out-dir") ?? join(tmpdir(), "autoskill-calibrate");
const probes = many("--probe");

// ---------- 读会话 ----------
const readLines = (p: string): string[] =>
  p.endsWith(".zstd")
    ? execFileSync("zstd", ["-d", "-c", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n")
    : readFileSync(p, "utf8").split("\n");

const lines = readLines(sessionPath);
const entries = parseSession(lines);

// 会话 id 优先取 header（pi v3 / dsh v4 都有）
let sessionId = basename(sessionPath).replace(/\.jsonl(\.zstd)?$/, "");
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line) as { type?: string; id?: string };
    if (e.type === "session" && typeof e.id === "string") { sessionId = e.id; break; }
  } catch { /* 跳过损坏行 */ }
}

// ---------- 覆盖 ----------
const cov = coverageReport(entries, sessionId);
const pending = ignoreCoverage ? entries : uncoveredEntries(entries, sessionId);

console.log(`会话 ${sessionId}`);
console.log(`消息 ${cov.total}｜已覆盖 ${cov.covered}｜待审 ${cov.unreviewed}`);
if (pending.length === 0) {
  console.log("没有待审消息（全部已覆盖）");
  process.exit(0);
}

// ---------- 序列化 ----------
const ser = serializeForScan(pending);
const chars = ser.reduce((n, l) => n + l.text.length, 0);
const batches = batchLines(ser, batchChars);
console.log(`序列化 ${ser.length} 条 / ${chars} 字符 → ${batches.length} 批（每批 ≤${batchChars} 字符）`);

if (dry) {
  const byRole = new Map<string, number>();
  for (const l of ser) byRole.set(l.role, (byRole.get(l.role) ?? 0) + l.text.length);
  console.log("各角色字符:", Object.fromEntries(byRole));
  console.log("(dry：未调用模型)");
  process.exit(0);
}

// ---------- 模型配置 ----------
const { config, reason } = resolveStandaloneConfig();
if (!config) { console.error(`无可用 LLM 配置：\n${reason}`); process.exit(1); }
console.log(`模型 ${model ?? config.model}｜批大小 ${batchChars}${budgetTokens ? `｜预算 ${budgetTokens}` : ""}`);

// ---------- 跑触发扫描 ----------
const t0 = Date.now();
const report = await runScan(pending, {
  model,
  batchChars,
  budgetTokens,
  maxBatches,
  onBatch: (b) => {
    const inTok = b.usage?.promptTokens ?? 0;
    const outTok = b.usage?.completionTokens ?? 0;
    const line = {
      ts: new Date().toISOString(), batch: b.index, total: b.total, chars: b.chars,
      candidates: b.candidates, inTok, outTok, ms: b.ms,
    };
    // 逐批落盘：即使外层管道缓冲，也能 tail 进度文件看实时状态
    try {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      appendFileSync(join(outDir, "progress.jsonl"), JSON.stringify(line) + "\n");
    } catch { /* 进度落盘失败不影响主流程 */ }
    console.log(`  批 ${b.index}/${b.total}｜${b.chars} 字符 → 候选 ${b.candidates}｜in ${inTok} out ${outTok}｜${(b.ms / 1000).toFixed(1)}s`);
  },
});
const elapsedMs = Date.now() - t0;

// ---------- 探针 ----------
const probeResults = probes.map((p) => {
  const ids = new Set(pending.filter((e) => {
    const c = e.message?.content;
    const text = typeof c === "string" ? c : (c ?? []).map((b) => (b as { text?: string }).text ?? "").join("\n");
    return text.includes(p);
  }).map((e) => e.id));
  const hit = report.candidates.filter((c) => ids.has(c.msg_id));
  return { probe: p, messages: ids.size, hit: hit.length > 0, kinds: [...new Set(hit.map((h) => h.kind))] };
});

// ---------- 汇总 ----------
const byKind: Record<string, number> = {};
for (const c of report.candidates) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
const totalTokens = report.tokensIn + report.tokensOut;

console.log(`\n候选 ${report.candidates.length} 个（唯一 msg_id）`);
console.log("kind 分布:", byKind);
console.log(`token：in ${report.tokensIn} / out ${report.tokensOut} / 合计 ${totalTokens}`);
console.log(`耗时 ${(elapsedMs / 1000).toFixed(1)}s｜批 ${report.batches}/${batches.length}${report.stopped ? `｜${report.stopped}` : ""}`);
for (const r of probeResults) {
  console.log(`探针「${r.probe.slice(0, 20)}」: ${r.hit ? "命中" : "未命中"}（${r.messages} 条消息）`);
}

// ---------- 落盘 ----------
const result = {
  ts: new Date().toISOString(),
  session: sessionId,
  model: model ?? config.model,
  batchChars,
  coverage: cov,
  serialized: { lines: ser.length, chars },
  batches: { used: report.batches, total: batches.length },
  candidates: report.candidates,
  byKind,
  tokens: { in: report.tokensIn, out: report.tokensOut, total: totalTokens },
  elapsedMs,
  probes: probeResults,
  stopped: report.stopped ?? null,
};
const target = outPath ?? join(outDir, "trigger-scan-calibrate.json");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(target, JSON.stringify(result, null, 2));
appendFileSync(
  join(outDir, "runs.jsonl"),
  JSON.stringify({
    ts: result.ts, kind: "trigger-scan-calibrate", harness: "cli", session: sessionId,
    covered: cov.covered, reviewed: ser.length, candidates: report.candidates.length,
    tokensIn: report.tokensIn, tokensOut: report.tokensOut, batches: report.batches, elapsedMs,
    stopped: result.stopped,
  }) + "\n",
);
console.log(`\n已写入 ${target}`);
