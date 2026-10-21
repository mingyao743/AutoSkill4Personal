#!/usr/bin/env node
/**
 * darwin-skill 体检记账（体检本体由 agent 按 skills/darwin-skill/SKILL.md 的流程执行）
 * 用法：
 *   node --experimental-strip-types scripts/darwin-check.ts                # 查看各 skill 触发状态
 *   node --experimental-strip-types scripts/darwin-check.ts --done <domain> # 体检完成后记账（清零计数）
 */
import { darwinDue, darwinCheckDone, loadSkillState, darwinThreshold, pendingSummary } from "../lib/skill-state.ts";

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
const pend = pendingSummary();
const domains = new Set([...Object.keys(st.domainEdits), ...Object.keys(st.lastDarwinCheck)]);
console.log(`待整合原子：${pend.total} 条｜体检阈值：增量修改 ${th} 次\n`);
console.log("skill\t\t自体检以来修改\t上次体检\t状态");
for (const d of [...domains].sort()) {
  const edits = st.domainEdits[d] ?? 0;
  const last = st.lastDarwinCheck[d]?.slice(0, 10) ?? "从未";
  const due = edits >= th ? "🔴 建议体检" : "—";
  console.log(`${d}\t${edits}\t\t${last}\t${due}`);
}
if (domains.size === 0) console.log("（尚无增量修改记录——批量打包的 skill 不计，agent 提案应用才开始计）");
