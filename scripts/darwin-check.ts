#!/usr/bin/env node
/**
 * darwin-skill 体检记账（体检本体由 agent 按 skills/darwin-skill/SKILL.md 的流程执行）
 * 用法：
 *   node --experimental-strip-types scripts/darwin-check.ts                # 查看各 skill 触发状态
 *   node --experimental-strip-types scripts/darwin-check.ts --done <domain> # 体检完成后记账（清零计数）
 *
 * 数据源：skill-state.json（整合账本）+ usage.jsonl（使用/反馈日志，见 lib/usage-store.ts）
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  darwinDue, darwinCheckDone, loadSkillState, darwinThreshold, darwinUseThreshold,
  pendingSummary,
} from "../lib/skill-state.ts";
import { usageSummary } from "../lib/usage-store.ts";

const args = process.argv.slice(2);
const doneIdx = args.indexOf("--done");

if (doneIdx >= 0) {
  const domain = args[doneIdx + 1];
  if (!domain || domain.startsWith("--")) { console.error("用法: darwin-check.ts --done <domain>"); process.exit(1); }
  darwinCheckDone(domain);
  console.log(`已记账：${domain} 体检完成（计数清零）`);
  process.exit(0);
}

const st = loadSkillState();
const th = darwinThreshold();
const useTh = darwinUseThreshold();
const pend = pendingSummary();
const usage = usageSummary();

// 全量 skill 目录 = 已部署的 skills 目录 ∪ state/usage 里出现过记录的域
const skillsRoot = process.env.AUTOSKILL_SKILLS_DIR ?? join(homedir(), ".pi", "agent", "skills");
const deployed = existsSync(skillsRoot)
  ? new Set(readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
  : new Set<string>();
const domains = new Set<string>([...deployed, ...Object.keys(st.domainEdits), ...Object.keys(st.lastDarwinCheck), ...usage.keys()]);

const dueMap = new Map(darwinDue().map((d) => [d.domain, d.trigger]));

console.log(`待整合原子：${pend.total} 条｜体检阈值：修改 ${th} 次 / 使用 ${useTh} 次 / 拒绝率>50%（样本≥5）\n`);
console.log("skill\t\t加载\t采纳率\t自体检修改\t上次体检\t状态");
for (const d of [...domains].sort()) {
  const u = usage.get(d) ?? { loaded: 0, accepted: 0, rejected: 0, edited: 0 };
  const edits = st.domainEdits[d] ?? 0;
  const last = st.lastDarwinCheck[d]?.slice(0, 10) ?? "从未";
  const feedback = u.accepted + u.rejected;
  const rate = feedback > 0 ? `${Math.round((u.accepted / feedback) * 100)}%` : "—";
  let status = "—";
  const trigger = dueMap.get(d);
  if (trigger?.includes("reject")) status = `🔴 拒绝率过高(${trigger})`;
  else if (trigger) status = `🔴 建议体检(${trigger})`;
  else if (deployed.has(d) && u.loaded === 0 && feedback === 0 && (st.domainEdits[d] ?? 0) === 0) status = "💀 零使用";
  console.log(`${d}\t${u.loaded}\t${rate}\t${edits}\t\t${last}\t${status}`);
}
if (domains.size === 0) console.log("（尚无数据——使用审计与增量修改记录都为空）");
