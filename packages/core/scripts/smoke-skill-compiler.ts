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
import {
  cardsForBrief, docTypesForValidation, extractSkillMd, generateSkill, type GenerateCard,
} from "../lib/generate-skill.ts";
import {
  POSITIVE_PASS, POSITIVE_PROBES, NEGATIVE_PASS, NEGATIVE_PROBES,
  buildRouteReport, cleanDescription, competitionFingerprint, loadRouteCache,
  parseJsonStringArray, probeCacheKey, routeReportBlocksApply, routeReportPath,
  routeTestSkill, saveRouteCache, scoreJudgments,
  type RouteCandidate, type RouteJudgment, type RouteProbes,
} from "../lib/route-test.ts";
import { clearChatCompleter, setChatCompleter, type ChatCompleter } from "../lib/llm.ts";
import { loadCompileState, saveCompileState, lastCompileHashes } from "../lib/compile-state.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// ============================================================
// 6. 正文生成（mock 驱动，不碰真实凭据）
// generateSkill 只调 chatComplete → setChatCompleter 注入 mock 即可隔离 LLM。
// 三类场景：一次通过 / 两次修复后通过 / 两次仍失败（保留 draft、无提案）。
(async () => {
console.log("\n--- 6. 正文生成（mock 驱动） ---");

// 简报 + 卡片：5 张 sop/spec，3 个会话，过就绪门；一张超 400 字验证“简报截断、生成取全量”
const longContent = "GPU OOM 排查步骤：先看显存，再降 batch size，检查容器 limit。" + "细节".repeat(250);
const genPool: KnowledgeAtom[] = [
  atom({ doc_type: "sop", content: longContent }),
  atom({ doc_type: "sop", content: "OOM 时先确认是显存不足还是容器限制：看 nvidia-smi 与 docker stats" }),
  atom({ doc_type: "spec", content: "口径：OOM 只算显存不足，不算容器 CPU 限制" }),
  atom({ doc_type: "sop", content: "降 batch size 后必须复测 3 个 epoch 确认不复发", sources: [{ session_id: "s2", window_id: "sig_s2_001", msg_range: ["m1", "m2"] }] }),
  atom({ doc_type: "sop", content: "显存碎片化时重启进程比降 batch 更有效", sources: [{ session_id: "s3", window_id: "sig_s3_001", msg_range: ["m1", "m2"] }] }),
];
const genReady = checkReadiness("demo", genPool, { lastHash: "different" });
ok(genReady.ready, "生成用例：5 张 sop/spec / 3 会话 → 就绪", genReady.blockers.join("；"));
const genBrief = buildCompileBrief("demo", genReady, selectMaterials(genPool, { now: NOW })).json;
const genCards: GenerateCard[] = cardsForBrief(genBrief, genPool);
eq(genCards.length, genBrief.selection.picked.length, "cardsForBrief 取回全部选中卡片");

// 关键契约：简报里 content 截断到 400 字，cardsForBrief 取全量（生成器要拿完整正文）
const longCard = genCards.find((c) => c.content.length > 400);
ok(longCard !== undefined, "cardsForBrief 返回完整正文（>400 字未被截断）");
if (longCard) {
  const inBrief = genBrief.selection.picked.find((r) => r.atom.atom_id === longCard.atom_id);
  eq(String(inBrief!.atom.content).length, 400, "同一张卡：简报截断 400、cardsForBrief 取全量");
}
eq(docTypesForValidation(genBrief)[0], "sop", "docTypes 主类型（sop）在前，决定步骤阈值与预算");

const genValidateOpts = { domain: "demo", docTypes: ["sop"], bodyBudget: BODY_BUDGET.sop, availableRefs: ["references/05-问题与复盘.md"] };

// 三段 canned 输出：GOOD 过；BAD_A 缺章节/步骤；BAD_B 含 atom_ 元数据
const GOOD_SKILL = `---
name: demo
description: GPU 训练 OOM 排查，适用于显存不足、容器限制、batch size 调整等场景。当训练任务报 CUDA out of memory 或需要确认显存预算时加载。
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
// BAD_A：缺 步骤 / 失败与回退 → M1 + M2 多错
const BAD_A = `---
name: demo
description: GPU 训练 OOM 排查，适用于显存不足、容器限制等场景。
---

## 何时用
- 训练报 OOM

## 判断
| 如果 | 那么 |
|---|---|
| 显存满 | 降 batch |
`;
// BAD_B：结构齐全但正文含 atom_ 元数据 → M4 单错
const BAD_B = `---
name: demo
description: GPU 训练 OOM 排查，适用于显存不足、容器限制等场景。
---

## 何时用
- 训练报 OOM

## 步骤
1. 看 nvidia-smi
2. 降 batch size
3. 检查容器 limit

## 失败与回退
- 仍 OOM → 换更小模型

## 边界
- 仅单机多卡；来源 atom_1234567890ab
`;

// 先确认 canned 标本本身的判定符合预期（隔离生成环的 bug）
ok(validateSkillMd(GOOD_SKILL, genValidateOpts).ok, "GOOD 标本单独校验通过", validateSkillMd(GOOD_SKILL, genValidateOpts).errors.join("；"));
ok(!validateSkillMd(BAD_A, genValidateOpts).ok, "BAD_A 标本单独校验失败");
ok(validateSkillMd(BAD_A, genValidateOpts).errors.some((e) => e.includes("步骤")), "BAD_A 失败原因含“缺步骤”");
ok(!validateSkillMd(BAD_B, genValidateOpts).ok, "BAD_B 标本单独校验失败");
has(validateSkillMd(BAD_B, genValidateOpts).errors.join(), "atom_", "BAD_B 失败原因是 atom_ 元数据");

// mock completer：按顺序吐 canned 输出；记录调用次数与最后一次 user prompt（看错误是否回喂）
function mockCompleter(responses: string[]): { fn: ChatCompleter; calls: () => number; lastUser: () => string } {
  let i = 0;
  let lastUser = "";
  const fn: ChatCompleter = async (opts) => {
    lastUser = opts.user;
    const text = responses[i] ?? responses[responses.length - 1];
    i++;
    return { text, model: "mock" };
  };
  return { fn, calls: () => i, lastUser: () => lastUser };
}
async function runGen(responses: string[]) {
  const m = mockCompleter(responses);
  setChatCompleter(m.fn);
  try {
    const result = await generateSkill({ brief: genBrief, cards: genCards, writingGuide: "写法指引占位", validateOpts: genValidateOpts });
    return { result, calls: m.calls(), lastUser: m.lastUser() };
  } finally {
    clearChatCompleter();
  }
}

// 场景 1：一次通过
{
  const { result, calls, lastUser } = await runGen([GOOD_SKILL]);
  ok(result.ok, "一次通过：ok=true");
  eq(result.attempts, 1, "一次通过：attempts=1");
  eq(calls, 1, "一次通过：只调 1 次 LLM");
  eq(result.history.length, 1, "一次通过：history 只 1 项");
  eq(result.draft.trim(), GOOD_SKILL.trim(), "一次通过：draft == GOOD");
  ok(!lastUser.includes("未通过"), "首次调用不带“未通过”回喂");
}

// 场景 2：两次修复后通过（BAD_A → BAD_B → GOOD）
{
  const { result, calls, lastUser } = await runGen([BAD_A, BAD_B, GOOD_SKILL]);
  ok(result.ok, "两次修复后通过：ok=true");
  eq(result.attempts, 3, "两次修复后通过：attempts=3（初始 + 2 次重写）");
  eq(calls, 3, "两次修复后通过：调 3 次 LLM");
  eq(result.history.length, 3, "两次修复后通过：history 3 项");
  ok(!result.history[0].ok && !result.history[1].ok && result.history[2].ok, "前两次失败、第三次通过");
  has(result.history[0].errors.join(), "步骤", "第一次失败原因含“缺步骤”");
  has(result.history[1].errors.join(), "atom_", "第二次失败原因含“atom_ 元数据”");
  has(lastUser, "未通过", "重写时把上一次错误回喂（user prompt 含“未通过”）");
  has(lastUser, "atom_", "第三次重写回喂的是第二次的错误（atom_）");
}

// 场景 3：两次仍失败（BAD_A → BAD_B → BAD_A）→ 保留 draft、无提案（ok=false）
{
  const { result, calls } = await runGen([BAD_A, BAD_B, BAD_A]);
  ok(!result.ok, "两次仍失败：ok=false");
  eq(result.attempts, 3, "两次仍失败：用满 3 次调用");
  eq(calls, 3, "两次仍失败：调 3 次 LLM");
  eq(result.history.length, 3, "两次仍失败：history 3 项");
  ok(result.history.every((h) => !h.ok), "三次都未通过");
  ok(result.draft.trim().length > 0, "失败也保留 draft（供人工修）");
  eq(result.draft.trim(), BAD_A.trim(), "保留的是最后一次输出（BAD_A）");
  ok(!result.report.ok, "失败时 report.ok=false（CLI 据此不生成提案）");
}

// extractSkillMd：剥代码围栏 / 剥前导寒暄 / 无 frontmatter 原样返回
eq(extractSkillMd("---\nname: x\n---\nbody\n").trim(), "---\nname: x\n---\nbody", "extractSkillMd：直出 --- 不动");
const fenced = extractSkillMd("```markdown\n---\nname: x\n---\nbody\n```");
ok(fenced.includes("---\nname: x") && !fenced.startsWith("```"), "extractSkillMd：剥 markdown 围栏");
ok(extractSkillMd("这是技能：\n---\nname: x\n---\nbody").startsWith("---"), "extractSkillMd：剥前导寒暄到 ---");
ok(!extractSkillMd("没有 frontmatter 的纯文本").includes("---"), "extractSkillMd：找不到 --- 原样返回（交校验器报缺 frontmatter）");

// ============================================================
console.log("\n--- 7. 路由自测（⑤，mock 驱动） ---");

// 7a. 纯函数：判分阈值 / 缓存键 / JSON 解析 / description 清洗
eq(POSITIVE_PROBES, 5, "正样本数 5");
eq(NEGATIVE_PROBES, 3, "负样本数 3");
eq(POSITIVE_PASS, 4, "正样本通过线 4/5");
eq(NEGATIVE_PASS, 2, "负样本通过线 2/3");
const jAll = (ranked: string[]): RouteJudgment[] => [
  ...Array(POSITIVE_PROBES).fill(0).map((_, i) => ({ probe: `p${i}`, kind: "positive" as const, rankedFirst: ranked[i] })),
  ...Array(NEGATIVE_PROBES).fill(0).map((_, i) => ({ probe: `n${i}`, kind: "negative" as const, rankedFirst: ranked[POSITIVE_PROBES + i] })),
];
{
  const sc1 = scoreJudgments(jAll(["t","t","t","t","t","o1","o2","o1"]), "t");
  ok(sc1.ok, "判分：全正命中+全负不命中 → ok", sc1.failures.join("；"));
  eq(sc1.positiveHits, 5, "判分：正命中 5");
  eq(sc1.negativePass, 3, "判分：负通过 3");
  const sc2 = scoreJudgments(jAll(["o1","t","t","t","t","o1","o2","o1"]), "t");
  ok(sc2.ok, "判分：1 正误命中（4/5）仍通过");
  eq(sc2.positiveHits, 4, "判分：4/5");
  const sc3 = scoreJudgments(jAll(["o1","o2","t","t","t","o1","o2","o1"]), "t");
  ok(!sc3.ok, "判分：2 正误命中（3/5）不通过");
  eq(sc3.failures.length, 2, "判分：记 2 条失败样例");
  const sc4 = scoreJudgments(jAll(["t","t","t","t","t","t","t","o1"]), "t");
  ok(!sc4.ok, "判分：2 负误命中（1/3 通过）不通过", sc4.failures.join("；"));
  ok(sc4.failures.some((f) => f.includes("不该命中")), "判分：负样本失败写明'不该命中'");
}
// 缓存键：description 或竞争集合变了就失效
{
  const a: RouteCandidate = { name: "gpu-oom", description: "dA" };
  const b: RouteCandidate = { name: "model-quant", description: "dB" };
  const c: RouteCandidate = { name: "ci-debug", description: "dC" };
  eq(probeCacheKey(a, [a, b]), probeCacheKey(a, [a, b]), "缓存键：相同 target+竞争 → 同键");
  ok(probeCacheKey(a, [a, b]) !== probeCacheKey({ name: "gpu-oom", description: "dA2" }, [a, b]), "缓存键：description 变 → 键变");
  ok(probeCacheKey(a, [a, b]) !== probeCacheKey(a, [a, b, c]), "缓存键：竞争集合变 → 键变");
  eq(competitionFingerprint([a, b]), competitionFingerprint([b, a]), "竞争指纹：与顺序无关");
}
// parseJsonStringArray / cleanDescription
eq(JSON.stringify(parseJsonStringArray('["a","b","c"]', 3)), JSON.stringify(["a","b","c"]), "parseJsonStringArray：解析数组");
eq(JSON.stringify(parseJsonStringArray('```json\n["a","b"]\n```', 2)), JSON.stringify(["a","b"]), "parseJsonStringArray：剥围栏");
eq(JSON.stringify(parseJsonStringArray('["a"]', 3)), JSON.stringify(["a","none","none"]), "parseJsonStringArray：不足补 none");
eq(JSON.stringify(parseJsonStringArray('["a","b","c","d"]', 2)), JSON.stringify(["a","b"]), "parseJsonStringArray：超长截断");
eq(parseJsonStringArray("no array here", 2).length, 0, "parseJsonStringArray：无数组 → 空");
eq(cleanDescription('```markdown\nnew desc\n```'), "new desc", "cleanDescription：剥围栏");
eq(cleanDescription('"quoted"'), "quoted", "cleanDescription：剥引号");
eq(cleanDescription("description: 实际内容"), "实际内容", "cleanDescription：去 description: 前缀");

// 7b. --apply 路由门（routeReportBlocksApply）
{
  const d = mkdtempSync(join(tmpdir(), "autoskill-route-gate-"));
  eq(routeReportPath(d, "demo"), join(d, "demo.route.json"), "route 报告路径");
  const failRep = { target: "demo", ok: false, positiveHits: 3, negativePass: 3, rewrites: 2, finalDescription: "d", generatedAt: "t", failures: ['正样本应命中 demo，实际判给 "x"'] };
  writeFileSync(routeReportPath(d, "demo"), JSON.stringify(failRep));
  const blk = routeReportBlocksApply(d, "demo");
  ok(blk.blocked && blk.report!.ok === false, "路由门：失败报告 → 拦截");
  writeFileSync(routeReportPath(d, "demo"), JSON.stringify({ ...failRep, ok: true, failures: [] }));
  ok(!routeReportBlocksApply(d, "demo").blocked, "路由门：通过报告 → 放行");
  rmSync(routeReportPath(d, "demo"));
  ok(!routeReportBlocksApply(d, "demo").blocked, "路由门：无报告 → 放行（不强制做过路由自测）");
  rmSync(d, { recursive: true, force: true });
}

// 7c. routeTestSkill（mock completer 按 system prompt 分发）
const rtCandidates: RouteCandidate[] = [
  { name: "gpu-oom", description: "Use when GPU 训练报 CUDA out of memory、显存不足、batch size OOM、nvidia-smi 显存满" },
  { name: "model-quant", description: "Use when 量化模型、GPTQ/AWQ、显存不够装下完整模型、int4/int8 量化" },
  { name: "ci-debug", description: "Use when CI 流水线失败、GitHub Actions 报错、测试在 CI 挂本地不挂" },
];
const rtTarget = rtCandidates[0];
const fixedProbes: RouteProbes = {
  positive: ["训练报 CUDA out of memory", "显存满 batch size 调", "nvidia-smi 显存不足", "OOM 排查显存", "batch size OOM 复测"],
  negative: ["模型太大怎么量化", "CI 测试挂本地不挂", "GPTQ int4 量化配置"],
};
function mockRoute(opts: { judgeArrays: string[][]; rewritten?: string }): { fn: ChatCompleter; calls: () => { probe: number; judge: number; rewrite: number }; lastRewriteUser: () => string } {
  const calls = { probe: 0, judge: 0, rewrite: 0 };
  let ji = 0;
  let lastRewriteUser = "";
  const fn: ChatCompleter = async (o) => {
    if (o.system.includes("生成探针")) { calls.probe++; return { text: JSON.stringify(fixedProbes), model: "mock" }; }
    if (o.system.includes("最该加载")) {
      calls.judge++;
      const arr = opts.judgeArrays[ji] ?? opts.judgeArrays[opts.judgeArrays.length - 1];
      ji++;
      return { text: JSON.stringify(arr), model: "mock" };
    }
    if (o.system.includes("重写")) { calls.rewrite++; lastRewriteUser = o.user; return { text: opts.rewritten ?? "改写后的 description", model: "mock" }; }
    return { text: "", model: "mock" };
  };
  return { fn, calls: () => ({ ...calls }), lastRewriteUser: () => lastRewriteUser };
}
async function runRoute(judgeArrays: string[][], rewritten?: string) {
  const m = mockRoute({ judgeArrays, rewritten });
  setChatCompleter(m.fn);
  const cacheDir = mkdtempSync(join(tmpdir(), "autoskill-route-"));
  try {
    const r = await routeTestSkill({ target: rtTarget, candidates: rtCandidates, cachePath: join(cacheDir, "route-cache.json") });
    return { r, calls: m.calls(), lastRewriteUser: m.lastRewriteUser() };
  } finally {
    clearChatCompleter();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
const PASS_ARR = ["gpu-oom","gpu-oom","gpu-oom","gpu-oom","gpu-oom","model-quant","ci-debug","model-quant"];
const FAIL_ARR = ["model-quant","ci-debug","gpu-oom","gpu-oom","gpu-oom","ci-debug","model-quant","ci-debug"]; // 正 3/5

// 场景 1：一次通过
{
  const { r, calls } = await runRoute([PASS_ARR]);
  ok(r.ok, "路由：一次通过 ok=true");
  eq(r.rewrites, 0, "路由：rewrites=0");
  eq(r.positiveHits, 5, "路由：正 5/5");
  eq(r.negativePass, 3, "路由：负 3/3");
  eq(r.attempts.length, 1, "路由：1 次 attempt");
  eq(calls.probe, 1, "路由：一次通过生成 1 次探针");
  eq(calls.judge, 1, "路由：一次通过判 1 次");
  eq(calls.rewrite, 0, "路由：一次通过不重写");
}
// 场景 2：失败 → 重写 1 次后通过
{
  const { r, calls, lastRewriteUser } = await runRoute([FAIL_ARR, PASS_ARR], "改写后的 description 含触发短语");
  ok(r.ok, "路由：重写 1 次后通过 ok=true");
  eq(r.rewrites, 1, "路由：rewrites=1");
  eq(r.attempts.length, 2, "路由：2 次 attempt");
  ok(!r.attempts[0].ok && r.attempts[1].ok, "路由：第 1 次失败、第 2 次通过");
  eq(r.finalDescription, "改写后的 description 含触发短语", "路由：finalDescription 用重写版");
  ok(r.finalDescription !== r.originalDescription, "路由：重写后 description 变了");
  eq(calls.rewrite, 1, "路由：重写 1 次");
  has(lastRewriteUser, "失败", "路由：重写 prompt 回喂失败样例");
  has(r.attempts[0].failures.join(), "model-quant", "路由：第 1 次失败样例含误命中的技能名");
}
// 场景 3：重写 2 次仍失败 → ok=false（阻断 --apply）
{
  const { r, calls } = await runRoute([FAIL_ARR, FAIL_ARR, FAIL_ARR], "改写后仍不行");
  ok(!r.ok, "路由：重写 2 次仍失败 ok=false");
  eq(r.rewrites, 2, "路由：rewrites=2（用满）");
  eq(r.attempts.length, 3, "路由：3 次 attempt");
  ok(r.attempts.every((a) => !a.ok), "路由：三次都未通过");
  eq(calls.rewrite, 2, "路由：重写 2 次（上限）");
  eq(calls.judge, 3, "路由：判 3 次");
  const report = buildRouteReport(r);
  ok(!report.ok && report.failures.length > 0, "buildRouteReport：失败报告 ok=false 且带 failures");
}
// 7d. 探针缓存：同 target+竞争第二次不调探针生成；竞争变了失效
{
  const cacheDir = mkdtempSync(join(tmpdir(), "autoskill-route-cache2-"));
  const cachePath = join(cacheDir, "route-cache.json");
  const m1 = mockRoute({ judgeArrays: [PASS_ARR] });
  setChatCompleter(m1.fn);
  const r1 = await routeTestSkill({ target: rtTarget, candidates: rtCandidates, cachePath });
  clearChatCompleter();
  eq(m1.calls().probe, 1, "缓存：首次生成探针 1 次");
  ok(r1.ok, "缓存：首次通过");
  ok(existsSync(cachePath), "缓存：route-cache.json 落盘");
  const m2 = mockRoute({ judgeArrays: [PASS_ARR] });
  setChatCompleter(m2.fn);
  const r2 = await routeTestSkill({ target: rtTarget, candidates: rtCandidates, cachePath });
  clearChatCompleter();
  eq(m2.calls().probe, 0, "缓存：第二次命中缓存，不调探针生成");
  eq(m2.calls().judge, 1, "缓存：第二次仍要判（判定不缓存）");
  ok(r2.ok, "缓存：第二次通过");
  const m3 = mockRoute({ judgeArrays: [PASS_ARR] });
  setChatCompleter(m3.fn);
  await routeTestSkill({ target: rtTarget, candidates: [...rtCandidates, { name: "new-skill", description: "d" }], cachePath });
  clearChatCompleter();
  eq(m3.calls().probe, 1, "缓存：竞争集合变 → 失效，重新生成探针");
  rmSync(cacheDir, { recursive: true, force: true });
}

// 7e. --apply 子进程：失败路由报告拒绝写提案；无报告放行
{
  const APPLY_SKILL = `---
name: demo
description: GPU 训练 OOM 排查，适用于显存不足、容器限制、batch size 调整等场景。当训练任务报 CUDA out of memory 时加载。
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
`;
  ok(validateSkillMd(APPLY_SKILL, { domain: "demo", docTypes: ["sop"] }).ok, "--apply 用例：SKILL.md 通过校验", validateSkillMd(APPLY_SKILL, { domain: "demo", docTypes: ["sop"] }).errors.join("；"));
  const d = mkdtempSync(join(tmpdir(), "autoskill-apply-gate-"));
  const skillsDir = join(d, "skills");
  const compileDir = join(d, "compile");
  mkdirSync(compileDir, { recursive: true });
  const skillMd = join(d, "demo.SKILL.md");
  writeFileSync(skillMd, APPLY_SKILL);
  const runCli = (args: string[]): { status: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", "packages/core/scripts/compile-skills.ts", ...args], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, out };
    } catch (e: any) {
      return { status: e.status ?? 1, out: String(e.stderr ?? "") + String(e.stdout ?? "") };
    }
  };
  // 失败路由报告 → 拒绝
  writeFileSync(routeReportPath(compileDir, "demo"), JSON.stringify({ target: "demo", ok: false, positiveHits: 3, negativePass: 3, rewrites: 2, finalDescription: "d", generatedAt: "t", failures: ["正样本应命中 demo，实际判给 x"] }));
  const r1 = runCli(["--domain", "demo", "--apply", skillMd, "--skills-dir", skillsDir, "--data-dir", d, "--brief-dir", compileDir]);
  ok(r1.status !== 0, "--apply 子进程：失败路由报告 → exit 非 0");
  has(r1.out, "路由自测报告失败", "--apply 子进程：拒绝原因含'路由自测报告失败'");
  // 无路由报告 → 放行，写提案
  rmSync(routeReportPath(compileDir, "demo"));
  const r2 = runCli(["--domain", "demo", "--apply", skillMd, "--skills-dir", skillsDir, "--data-dir", d, "--brief-dir", compileDir]);
  eq(r2.status, 0, "--apply 子进程：无路由报告 → exit 0");
  has(r2.out, "提案已写入", "--apply 子进程：无路由报告 → 写提案");
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
