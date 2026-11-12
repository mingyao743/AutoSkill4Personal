#!/usr/bin/env node
/**
 * 知识管线 CLI：一条会话 → 覆盖派生 → **一段式抽取** → 准入 → 落库 → 水位推进。
 *
 * 用法：
 *   node --experimental-strip-types packages/core/scripts/pipeline.ts <session.jsonl[.zstd]> \
 *     [--mode incremental|backfill] [--max-batches N] [--budget N] [--batch-chars 12000] \
 *     [--model ID] [--domains a,b,c] [--domain-hint NAME] [--two-stage] [--no-overlap] \
 *     [--home ~/.pi/agent] [--data-dir DIR] [--dry] [--json]
 *
 * 说明：
 *   --mode incremental（默认）只处理未覆盖的消息；backfill 重扫全量
 *   --max-batches N 本次最多几批；--budget N 本次 token 上限
 *   --two-stage 走旧两段式（触发扫描 → 知识抽取），只用于对比期验收，验收通过后删除
 *   --no-overlap 每批不带上一批最后 1 轮作只读上下文
 *   --dry 只跑不落库/不写水位/不写 drop 账（仍调用模型）
 *   --json 输出机器可读报告
 *   --no-home 不读 ~/.pi/agent 的模型配置（dsh 等宿主用环境变量解析凭据）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setHostContext } from "../lib/context.ts";
import { loadAtoms } from "../lib/atom-store.ts";
import { parseSession } from "../lib/window.ts";
import { runPipeline } from "../lib/pipeline.ts";

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
  console.error("用法: pipeline.ts <session.jsonl[.zstd]> [--mode incremental|backfill] [--max-batches N] [--dry]");
  process.exit(1);
}

const noHome = has("--no-home"); // dsh 等非 pi 宿主：不要读 ~/.pi 的模型配置
const home = one("--home") ?? join(homedir(), ".pi", "agent");
const dataDir = one("--data-dir") ?? join(home, "data", "autoskill", "knowledge");
setHostContext({ host: "cli", dataDir, homeDir: !noHome && existsSync(home) ? home : undefined });

const mode = one("--mode") === "backfill" ? "backfill" : "incremental";
const maxBatches = Number(one("--max-batches") ?? 0) || undefined;
const budgetTokens = Number(one("--budget") ?? 0) || undefined;
const batchChars = Number(one("--batch-chars") ?? 12_000);
const model = one("--model");
const dryRun = has("--dry");
const jsonOut = has("--json");
const twoStage = has("--two-stage");
const overlap = !has("--no-overlap");
const domainHint = one("--domain-hint");

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

// 主题清单：默认取知识卡片池高频主题，防止模型自造主题
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

const report = await runPipeline({
  sessionId,
  entries,
  harness: "cli",
  mode,
  model,
  batchChars,
  maxBatches,
  budgetTokens,
  domainOptions,
  domainHint,
  dryRun,
  twoStage,
  overlap,
  onProgress: (e) => {
    if (e.type !== "batch" || jsonOut) return;
    console.error(
      `批 ${e.index}/${e.total}｜${twoStage ? "候选" : "出卡"} ${e.candidates} 知识卡片 ${e.atoms} 丢弃 ${e.dropped}｜` +
      `in ${e.tokensIn} out ${e.tokensOut}｜${(e.ms / 1000).toFixed(1)}s`,
    );
  },
});

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`会话 ${report.sessionId}｜${twoStage ? "两段式（旧）" : "一段式"}`);
  console.log(`覆盖 ${report.covered} / 待审 ${report.unreviewed}｜批 ${report.processedBatches}/${report.batches}`);
  console.log(`${twoStage ? "候选" : "出卡"} ${report.candidates}｜知识卡片 ${report.atoms}｜丢弃 ${report.dropped}｜被拒 ${report.rejected}`);
  if (!twoStage) {
    console.log(
      `压缩 ${report.compressRatio}（fail-safe 透传 ${report.compressFallback} 条、净收益不足不压 ${report.compressNoGain} 条）｜` +
      `drop 账 ${report.dropRows} 行（兜底补 ${report.autoDropped}）｜无价值批 ${report.noValueBatches}｜格式重跑 ${report.retriedBatches}｜申请回读 ${report.needContext}｜未交代 ${report.unaccounted}｜拒卡孤儿补账 ${report.orphanedByReject}`,
    );
    console.log(
      `带 pending_fields ${report.pendingFieldCards} 张（特化字段已不强制，仅观测）｜quote 非逐字 ${report.quoteUnverified} 张（已标记未拦）`,
    );
    const rr = Object.entries(report.rejectReasons).sort((a, b) => b[1] - a[1]);
    const rs = report.rejectSamples ?? {};
    if (rr.length > 0) console.log(`拒绝原因：${rr.map(([k, n]) => `${rs[k] ?? k} ×${n}`).join("；")}`);
  }
  console.log(`token in ${report.tokensIn} out ${report.tokensOut}｜${(report.elapsedMs / 1000).toFixed(1)}s${report.stopped ? `｜${report.stopped}` : ""}`);
  for (const a of report.newAtoms) {
    console.log(`  [${a.doc_type}] ${a.domain}｜${a.content.slice(0, 80)}`);
  }
}
