/**
 * SKILL_COMPILER 确定性部分的回归（不调模型、不写真实库）。
 *
 * 覆盖：就绪门 / 选材器 / 短效判定 / 契约校验 M1–M6 / 编译简报。
 * 运行：node --experimental-strip-types packages/core/scripts/smoke-skill-compiler.ts
 */
import type { KnowledgeAtom } from "../lib/atom-store.ts";
import {
  bodyBudgetFor, countTransientWording, formatValidation, parseSkillMd, validateSkillMd,
  requiredSectionsFor, BODY_BUDGET,
} from "../lib/skill-contract.ts";
import {
  buildCompileBrief, checkReadiness, compileDue, effectiveDocType, inputHash, instructionAtomsOf,
  primaryDocType, sanitizeDomainName, scoreAtom, selectMaterials, sessionCount, transientReport,
} from "../lib/compile-skill.ts";
import { loadCompileState, saveCompileState, lastCompileHashes } from "../lib/compile-state.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHostContext } from "../lib/context.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` → ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown, name: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const has = (s: string, sub: string, name: string): void => ok(s.includes(sub), name, `未包含 ${sub}`);

const NOW = Date.parse("2026-11-12T00:00:00.000Z");
let seq = 0;
function atom(over: Partial<KnowledgeAtom> = {}): KnowledgeAtom {
  seq++;
  const id = over.atom_id ?? `atom_${String(seq).padStart(12, "0")}`;
  return {
    atom_id: id,
    category: "02",
    atom_type: "动作切片",
    content: `知识内容 ${seq}`,
    domain: "demo",
    sources: [{ session_id: "s1", window_id: `sig_s1_${String(seq).padStart(3, "0")}`, msg_range: ["m1", "m2"] }],
    confidence: 0.8,
    version: 1,
    superseded_by: null,
    refs: [],
    status: "draft",
    extracted_at: "2026-11-01T00:00:00.000Z",
    extracted_by: "signal-distill",
    ...over,
  } as KnowledgeAtom;
}
const withSession = (a: KnowledgeAtom, sid: string): KnowledgeAtom => ({
  ...a,
  sources: [{ ...a.sources[0], session_id: sid }],
});

// ============================================================
console.log("\n--- 1. 就绪门 ---");
const five = [atom(), atom(), atom(), withSession(atom(), "s2"), withSession(atom(), "s3")];
eq(instructionAtomsOf("demo", five).length, 5, "按主题过滤 instruction 卡片");
eq(sessionCount(five), 3, "跨会话去重计数");
const ready = checkReadiness("demo", five, { lastHash: "different" });
ok(ready.ready, "5 张 / 3 会话 → 就绪");
eq(ready.blockers, [], "就绪时无阻断项");

const four = five.slice(0, 4);
ok(!checkReadiness("demo", four, { lastHash: "x" }).ready, "4 张 → 不就绪");
has(checkReadiness("demo", four, { lastHash: "x" }).blockers.join(), "未达就绪门 5 张", "报出卡片数门槛");

const oneSession = five.map((a) => withSession(a, "s1"));
ok(!checkReadiness("demo", oneSession, { lastHash: "x" }).ready, "单会话 → 不就绪");
has(checkReadiness("demo", oneSession, { lastHash: "x" }).blockers.join(), "2 个", "报出会话门槛");

const h = inputHash("demo", five);
ok(h !== inputHash("demo", five.slice(0, 4)), "加卡片后指纹变化");
eq(checkReadiness("demo", five, { lastHash: h }).changed, false, "指纹相同 → 内容未变");
ok(!checkReadiness("demo", five, { lastHash: h }).ready, "内容未变 → 阻断");
ok(checkReadiness("demo", five, { lastHash: h, force: true }).ready, "--force 跳过内容未变");
eq(checkReadiness("demo", five, { lastHash: undefined }).changed, true, "无历史指纹 → 视为已变化");

// 短效知识：三条判据全中
const stale = five.map((a) => atom({ category: "01", doc_type: "spec", extracted_by: "compaction-rescue", content: "当前状态：已实现 M1 本次跑通", sources: a.sources }));
const tr = transientReport(stale);
ok(tr.rescueRatio === 1 && tr.proceduralRatio < 0.2 && tr.staleRatio === 1, "三条判据的比率都算对");
eq(tr.count, 3, "三条判据全命中");
ok(tr.stale, "≥2 条命中 → 判为短效知识");
ok(!checkReadiness("demo", stale, { force: false }).ready, "短效知识阻断编译");
ok(checkReadiness("demo", stale, { force: true }).ready, "--force 可强制编译短效主题");
has(checkReadiness("demo", stale, {}).blockers.join(), "短效知识", "阻断原因写明短效");

// 单条命中不阻断（避免把纯 spec 主题误杀）
const conceptOnly = five.map((a) => atom({ category: "01", sources: a.sources, content: "口径：什么算误杀，哪些不算。排除的理解：按关键词判。" }));
const tr2 = transientReport(conceptOnly);
eq(tr2.hits, ["low-procedural"], "纯口径主题只命中“程序性低”");
ok(!tr2.stale, "单条命中不判 short-lived");
ok(checkReadiness("demo", conceptOnly, {}).ready, "单条命中不阻断编译");

eq(sanitizeDomainName("GPU_Train_Ops"), "gpu-train-ops", "域名 sanitize 成 kebab-case");
ok(checkReadiness("GPU_Train_Ops", five.map((a) => ({ ...a, domain: "GPU_Train_Ops" })), {}).warnings.some((w) => w.includes("kebab-case")), "域名不规范给 warning");

// ============================================================
console.log("\n--- 2. 选材器 ---");
const sop = atom({ doc_type: "sop", content: "1. 先看显存\n2. 再降 batch size" });
const spec = atom({ doc_type: "spec", content: "口径：OOM 只算显存不足，不算容器限制" });
const caseAtom = atom({ category: "04", doc_type: "case", content: "某次真实 OOM 的完整记录" });
const staleSpec = atom({ doc_type: "spec", content: "本次已实现的口径，M1 完成" });
eq(effectiveDocType(sop), "sop", "doc_type 直接采用");
eq(effectiveDocType(atom({ doc_type: undefined, category: "05" })), "postmortem", "旧卡片按目录推断类型");

ok(scoreAtom(sop, NOW).score > scoreAtom(spec, NOW).score, "程序性卡片分数更高");
const multi = atom({
  doc_type: "spec",
  sources: [
    { session_id: "s1", window_id: "sig_s1_001", msg_range: ["m1", "m2"] },
    { session_id: "s2", window_id: "sig_s2_001", msg_range: ["m3", "m4"] },
  ],
});
ok(scoreAtom(multi, NOW).parts.multiSession === 2, "跨会话复现 +2");
ok(scoreAtom(staleSpec, NOW).parts.stalePenalty === 2, "短效表述 -2");
ok(scoreAtom(atom({ extracted_at: "2026-11-05T00:00:00.000Z" }), NOW).parts.freshness === 2, "30 天内 +2");
ok(scoreAtom(atom({ extracted_at: "2026-09-20T00:00:00.000Z" }), NOW).parts.freshness === 1, "90 天内 +1");
ok(scoreAtom(atom({ extracted_at: "2026-01-01T00:00:00.000Z" }), NOW).parts.freshness === 0, "超过 90 天 +0");

const budgetAtoms = [
  atom({ content: "A".repeat(100) }),
  atom({ content: "B".repeat(100) }),
  atom({ content: "C".repeat(100) }),
];
const sel = selectMaterials(budgetAtoms, { budgetChars: 250, now: NOW });
eq(sel.picked.length, 2, "预算 250 只装得下 2 张 100 字卡片");
eq(sel.overflow.length, 1, "装不下的进 references");
eq(sel.usedChars, 200, "已用字数正确");

const withCase = selectMaterials([sop, caseAtom], { budgetChars: 10_000, now: NOW });
ok(withCase.picked.every((r) => r.docType !== "case"), "case 永不进正文");
ok(withCase.overflow.some((r) => r.docType === "case"), "case 进 references");

eq(primaryDocType([spec, spec, sop]), "spec", "多数类型作主类型");
eq(primaryDocType([sop, spec]), "sop", "平票时程序性优先");
const grouped = selectMaterials([atom({ doc_type: "postmortem", content: "p1" }), atom({ doc_type: "postmortem", content: "p2" })], { now: NOW });
ok(grouped.groups.some((g) => g.docType === "postmortem" && g.atomIds.length === 2), "同类多卡聚合提示");
eq(bodyBudgetFor(["sop"]), BODY_BUDGET.sop, "sop 预算 8000");
eq(bodyBudgetFor(["convention"]), BODY_BUDGET.convention, "convention 预算 2500");
eq(bodyBudgetFor([]), 6000, "无类型 → 默认 6000");
eq(
  selectMaterials([
    atom({ doc_type: "spec", content: "s1" }),
    atom({ doc_type: "spec", content: "s2" }),
    atom({ doc_type: "spec", content: "s3" }),
    atom({ doc_type: "postmortem", content: "p1" }),
  ], { now: NOW }).budgetChars,
  4000,
  "预算按主类型（spec 4000），不按出现过的最大档（postmortem 5000）",
);

// ============================================================
console.log("\n--- 3. 契约校验 ---");
const goodSop = `---
name: demo-sop
description: GPU 训练 OOM 排查知识库，适用于显存不足、容器限制、batch size 调整等场景。当训练任务报 CUDA out of memory 或需要确认显存预算时加载。
---

## 何时用
- 训练任务报 CUDA out of memory

## 判断
| 如果 | 那么 |
|---|---|
| nvidia-smi 显存满 | 先降 batch size |
| 容器 limit 小于卡显存 | 调大 limit |
| 显存碎片化 | 重启进程 |

## 步骤
1. 复现并记录 nvidia-smi
2. 降 batch size 复测
3. 检查容器 limit

## 失败与回退
- 仍 OOM → 换更小模型

## 边界
- 仅单机多卡

## 验证
- 连续跑 3 个 epoch 不 OOM

## 何时读 references
| 你现在的处境 | 读这个 |
|---|---|
| 需要完整报错清单 | references/05-问题与复盘.md |
`;
const goodReport = validateSkillMd(goodSop, {
  domain: "demo-sop",
  docTypes: ["sop"],
  availableRefs: ["references/05-问题与复盘.md"],
});
ok(goodReport.ok, "合规 sop 通过确定性关卡", goodReport.errors.join("；"));
eq(goodReport.stats.steps, 3, "步骤数 3");
eq(goodReport.stats.references, 1, "references 计数 1");
ok(goodReport.needsRoutingTest && goodReport.checks.some((c) => c.id === "M3" && c.ok), "M3 标记为未执行但不阻断");
has(formatValidation(goodReport), "M3 路由自测（未执行）", "报告里明示 M3 未做");

ok(!validateSkillMd(goodSop.replace("## 步骤", "## 流程"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "缺 步骤 章节 → M1 拒");
ok(!validateSkillMd(goodSop.replace("3. 检查容器 limit", ""), { domain: "demo-sop", docTypes: ["sop"] }).ok, "步骤不足 3 条 → M2 拒");
ok(!validateSkillMd(goodSop.replace("1. 复现并记录 nvidia-smi\n2. 降 batch size 复测\n3. 检查容器 limit", "1. 只做一步"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "sop 少于 3 步被拒");
ok(!validateSkillMd(goodSop.replace("## 边界", "## 边界\n- atom_1234567890ab 归档"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "atom_ 元数据 → M4 拒");
ok(!validateSkillMd(goodSop.replace("GPU 训练 OOM 排查知识库，适用于显存不足、容器限制、batch size 调整等场景。当训练任务报 CUDA out of memory 或需要确认显存预算时加载。", "GPU 训练 OOM 领域知识库，由 AutoSkill 生成，涉及显存时加载"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "描述模板句式 → M4 拒");
ok(!validateSkillMd(goodSop.replace("- 仍 OOM → 换更小模型", "- 本次已实现，今天验证"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "短效表述 ≥2 次 → M4 拒");
ok(!validateSkillMd(goodSop, { domain: "demo-sop", docTypes: ["sop"], bodyBudget: 100 }).ok, "超预算 → M5 拒");
ok(!validateSkillMd(goodSop.replace("GPU 训练 OOM 排查知识库", "X".repeat(1001)), { domain: "demo-sop", docTypes: ["sop"] }).ok, "description 超 1000 字 → M5 拒");
ok(!validateSkillMd(goodSop.replace("| 需要完整报错清单 | references/05-问题与复盘.md |", "| references/05-问题与复盘.md | references/05-问题与复盘.md |"), { domain: "demo-sop", docTypes: ["sop"], availableRefs: ["references/05-问题与复盘.md"] }).ok, "分诊表行只有文件名 → M5 拒");
ok(!validateSkillMd(goodSop, { domain: "demo-sop", docTypes: ["sop"], availableRefs: [] }).ok, "引用的 references 不存在 → M6 拒");
ok(validateSkillMd(goodSop.replace("## 失败与回退", "## 失败与回退"), { domain: "demo-sop", docTypes: ["sop"] }).ok, "不提供 references 清单时跳过闭合检查（只告警）");

const pmBad = `---
name: demo-pm
description: 复盘知识库，适用于排障、根因分析、故障复盘等场景。
---

## 失败与回退
- 某次故障
`;
const pmReport = validateSkillMd(pmBad, { domain: "demo-pm", docTypes: ["postmortem"] });
ok(!pmReport.ok && pmReport.errors.some((e) => e.includes("验证")), "postmortem 缺 验证 → M1 拒");

const convBad = `---
name: demo-conv
description: 环境约定知识库，适用于路径、版本、命名约定等场景。
---

## 边界
- 仅限本机
`;
ok(!validateSkillMd(convBad, { domain: "demo-conv", docTypes: ["convention"] }).ok, "convention 缺失效条件 → M1 拒");

ok("error" in parseSkillMd("# 没有 frontmatter"), "缺 frontmatter 被解析层拒");
ok(!validateSkillMd(goodSop, { domain: "other-name", docTypes: ["sop"] }).ok, "frontmatter.name 与目标主题不一致 → M1 拒");
eq(requiredSectionsFor("sop"), ["步骤", "失败与回退"], "sop 最小节子集");

// 主类型不同，预算不同：同一篇正文在 convention 档会超预算
ok(!validateSkillMd(goodSop, { domain: "demo-sop", docTypes: ["convention"] }).ok, "同一正文按 convention 档 2500 字超预算");

// ============================================================
console.log("\n--- 4. 编译简报 ---");
const brief = buildCompileBrief("demo", ready, selectMaterials(five.map((a) => ({ ...a, doc_type: "sop" })), { now: NOW }));
has(brief.markdown, "# 编译简报：demo", "简报标题");
has(brief.markdown, "## 一、就绪门", "简报有就绪门");
has(brief.markdown, "## 五、生成契约", "简报有生成契约");
ok(brief.json.contract.requiredSections.includes("步骤"), "契约里带必含章节");
ok(brief.json.selection.picked.every((r) => String(r.atom.content).length <= 400), "简报里正文截断到 400 字");
has(brief.markdown, "--domain demo", "简报里的下一步命令带主题名");
eq(countTransientWording("本次已实现 M1，今天跑通"), 4, "短效表述计数");

// ============================================================
console.log("\n--- 5. 编译到期提示 + 状态文件 ---");
eq(compileDue(five, {}, { limit: 10 }).map((d) => d.skillName), ["demo"], "过了就绪门 → 出现在编译到期列表");
eq(compileDue(four, {}, { limit: 10 }), [], "没过就绪门 → 不出现");
eq(compileDue(five, { demo: inputHash("demo", five) }, { limit: 10 }), [], "内容未变 → 不出现");
eq(compileDue(five, { demo: "old" }, { limit: 10 }).length, 1, "指纹过期 → 重新出现");
eq(compileDue(five, {}, { limit: 0 }).length, 0, "limit=0 返回空（显式语义）");

const tmp = mkdtempSync(join(tmpdir(), "autoskill-compile-state-"));
setHostContext({ host: "cli", dataDir: tmp });
saveCompileState({ version: 1, domains: { demo: { inputHash: "abc123", briefAt: "2026-11-12T00:00:00.000Z" } } });
eq(loadCompileState().domains.demo.inputHash, "abc123", "编译状态可读回");
eq(lastCompileHashes(), { demo: "abc123" }, "宿主提示取到指纹表");
saveCompileState({ version: 1, domains: {} });
eq(lastCompileHashes(), {}, "清空后指纹表为空");
rmSync(tmp, { recursive: true, force: true });

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
