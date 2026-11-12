#!/usr/bin/env node
/**
 * 知识抽取校准 CLI：触发扫描候选 → 知识卡片（不写真实库，产物落临时目录）。
 *
 * ⚠️ **已过时（2026-11-12）**：一段式已定为唯一路径，本工具只服务旧两段式（吃 trigger-scan-calibrate 的候选）。
 *    端到端校准请改用 `scripts/extract-calibrate.ts`，人工 review 表用 `scripts/review-sheet.ts`。
 *    保留原因：`--two-stage` 回退路径还在，质量验收通过后连同 `lib/knowledge-extract.ts` 一起删除。
 *
 * 用法：
 *   node --experimental-strip-types packages/core/scripts/knowledge-extract.ts <session.jsonl[.zstd]> \
 *     [candidates.json] [--limit N] [--batch 12] [--context 1200] [--model ID] \
 *     [--domain X] [--home ~/.pi/agent] [--out FILE] [--out-dir DIR]
 *
 * candidates.json 默认读 <out-dir>/trigger-scan-calibrate.json（trigger-scan-calibrate.ts 的产物）。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setHostContext } from "../lib/context.ts";
import { resolveStandaloneConfig } from "../lib/llm.ts";
import { parseSession } from "../lib/window.ts";
import { extractCandidates } from "../lib/knowledge-extract.ts";
import { loadAtoms } from "../lib/atom-store.ts";
import type { ScanCandidate } from "../lib/trigger-scan.ts";

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
const one = (n: string) => flags.get(n)?.[0];
const has = (n: string) => flags.has(n);

const sessionPath = positional[0];
if (!sessionPath) {
  console.error("用法: knowledge-extract.ts <session.jsonl[.zstd]> [candidates.json] [--limit N] [--dry]");
  process.exit(1);
}
const home = one("--home") ?? join(homedir(), ".pi", "agent");
const outDir = one("--out-dir") ?? join(tmpdir(), "autoskill-calibrate");
const candidatesPath = positional[1] ?? join(outDir, "trigger-scan-calibrate.json");
setHostContext({ host: "cli", dataDir: join(home, "data", "autoskill", "knowledge"), homeDir: existsSync(home) ? home : undefined });

const limit = Number(one("--limit") ?? 0) || 0;
const batchSize = Number(one("--batch") ?? 12);
const maxContextChars = Number(one("--context") ?? 1200);
const model = one("--model");
const domainHint = one("--domain");
// 主题清单：从现有知识卡片池取高频主题，防止模型把主题拆碎（可用 --domains a,b,c 覆盖）
const domainOptions = one("--domains")
  ? one("--domains")!.split(",").map((d) => d.trim()).filter(Boolean)
  : (() => {
      const count = new Map<string, number>();
      for (const a of loadAtoms()) {
        const d = (a.domain || "").trim();
        if (d) count.set(d, (count.get(d) ?? 0) + 1);
      }
      return [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([d]) => d);
    })();
const dry = has("--dry");
const outPath = one("--out") ?? join(outDir, "extract-result.json");

// ---------- 读会话 ----------
const readLines = (p: string): string[] =>
  p.endsWith(".zstd")
    ? execFileSync("zstd", ["-d", "-c", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n")
    : readFileSync(p, "utf8").split("\n");

const lines = readLines(sessionPath);
const entries = parseSession(lines);
let sessionId = "";
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const e = JSON.parse(line) as { type?: string; id?: string };
    if (e.type === "session" && typeof e.id === "string") { sessionId = e.id; break; }
  } catch { /* 跳过 */ }
}
if (!sessionId) sessionId = sessionPath.split("/").pop()!.replace(/\.jsonl(\.zstd)?$/, "");

// ---------- 读候选 ----------
if (!existsSync(candidatesPath)) {
  console.error(`找不到候选文件: ${candidatesPath}（先跑 trigger-scan-calibrate.ts）`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(candidatesPath, "utf8")) as { candidates?: ScanCandidate[] };
const all = Array.isArray(raw.candidates) ? raw.candidates : [];
const candidates = limit > 0 ? all.slice(0, limit) : all;
console.log(`会话 ${sessionId}｜消息 ${entries.length}｜候选 ${candidates.length}/${all.length}`);

if (dry) {
  const { expandRange, buildCandidateContext } = await import("../lib/knowledge-extract.ts");
  let total = 0;
  for (const c of candidates) {
    const r = expandRange(entries, c.msg_id);
    const ctx = r ? buildCandidateContext(entries, r, maxContextChars) : "";
    total += ctx.length;
    console.log(`  ${c.msg_id.slice(0, 8)} ${c.kind.padEnd(10)} 区间 ${r ? r.join("→") : "未找到"} ｜上下文 ${ctx.length} 字`);
  }
  console.log(`上下文合计 ${total} 字符｜分批 ${Math.ceil(candidates.length / batchSize)}（每批 ${batchSize}）`);
  process.exit(0);
}

// ---------- 模型 ----------
const { config, reason } = resolveStandaloneConfig();
if (!config) { console.error(`无可用 LLM 配置：\n${reason}`); process.exit(1); }
console.log(`模型 ${model ?? config.model}｜每批 ${batchSize}｜上下文 ≤${maxContextChars}`);

// ---------- 知识抽取 ----------
const t0 = Date.now();
const report = await extractCandidates({
  sessionId,
  entries,
  candidates,
  domainHint,
  domainOptions,
  model,
  batchSize,
  maxContextChars,
  onBatch: (b) => {
    try {
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      appendFileSync(join(outDir, "extract-progress.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), batch: b.index, total: b.total,
        atoms: b.atoms, dropped: b.dropped, inTok: b.tokensIn, outTok: b.tokensOut, ms: b.ms,
      }) + "\n");
    } catch { /* 进度落盘失败不影响主流程 */ }
    console.log(`  批 ${b.index}/${b.total}｜知识卡片 ${b.atoms} 丢弃 ${b.dropped}｜in ${b.tokensIn} out ${b.tokensOut}｜${(b.ms / 1000).toFixed(1)}s`);
  },
});
const elapsedMs = Date.now() - t0;

// ---------- 结果 ----------
console.log(`\n知识卡片 ${report.atoms.length} 条｜丢弃 ${report.dropped.length}｜被拒 ${report.rejected.length}｜token in ${report.tokensIn} out ${report.tokensOut}｜${(elapsedMs / 1000).toFixed(1)}s`);
for (const a of report.atoms) {
  console.log(`\n[${a.doc_type}] ${a.domain}｜${a.atom_id}`);
  console.log(`  ${a.content.slice(0, 160)}${a.content.length > 160 ? "…" : ""}`);
  console.log(`  why: ${a.why}`);
  if (a.expires_when) console.log(`  失效: ${a.expires_when}`);
}
if (report.rejected.length) {
  console.log("\n被拒:");
  for (const r of report.rejected.slice(0, 10)) console.log(`  - ${r.reason}｜${r.content}`);
}
if (report.dropped.length) {
  console.log("\n丢弃:");
  for (const d of report.dropped.slice(0, 10)) console.log(`  - ${d.anchor.slice(0, 8)}｜${d.reason}`);
}

const result = {
  ts: new Date().toISOString(), session: sessionId, model: model ?? config.model,
  candidates: candidates.length, atoms: report.atoms, dropped: report.dropped, rejected: report.rejected,
  tokens: { in: report.tokensIn, out: report.tokensOut }, batches: report.batches,
  elapsedMs, stopped: report.stopped ?? null,
};
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`\n已写入 ${outPath}`);
