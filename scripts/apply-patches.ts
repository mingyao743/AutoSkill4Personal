#!/usr/bin/env node
/**
 * 应用 intake 提案队列（幂等，可随时重跑）。
 * 用法：node --experimental-strip-types scripts/apply-patches.ts [--mark-all]
 *   --mark-all  bootstrap：把当前全部原子标记为已整合（首次批量打包后用一次）
 */
import { applyPatches } from "../lib/apply-patches.ts";
import { markIntegrated, pendingSummary } from "../lib/skill-state.ts";
import { loadAtoms } from "../lib/atom-store.ts";

if (process.argv.includes("--mark-all")) {
  const count = markIntegrated(loadAtoms().map((a) => a.atom_id)).integrated.length;
  console.log(`bootstrap：已整合标记共 ${count} 条原子`);
  process.exit(0);
}

const r = applyPatches();
const pend = pendingSummary();
console.log(
  `提案队列：应用 ${r.applied.length}，丢弃(自愈重做) ${r.discarded.length}，失败(留队列) ${r.failed.length}\n` +
  `待整合原子：${pend.total} 条${pend.total ? `（${Object.entries(pend.byDomain).map(([d, n]) => `${d}:${n}`).join(", ")}）` : ""}`
);
if (r.applied.length) console.log(`  applied: ${r.applied.join(", ")}`);
if (r.discarded.length) console.log(`  discarded: ${r.discarded.join(", ")}`);
if (r.failed.length) console.log(`  failed: ${r.failed.join(", ")}`);
