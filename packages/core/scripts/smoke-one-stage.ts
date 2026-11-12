#!/usr/bin/env node
/**
 * 一段式抽取回归测试：不调模型、不写库，纯内存验证压缩、契约、准入三条链路。
 *
 * 跑法：node --experimental-strip-types packages/core/scripts/smoke-one-stage.ts
 *
 * 每条用例都对应一个真实抓到过的 bug 或一条设计约束，注释里写了来历——
 * 改 compress.ts / one-stage.ts / admission.ts 之前先跑一遍。
 */
import {
  serializeForExtract, batchByTurn, overlapTurn, compressStats, compressArgs, parseArgs,
  assertErrorLinesKept, errorLines, isHarnessNoise, harnessNoiseCount,
} from "../lib/compress.ts";
import {
  parseOneStageOutput, autoFillDrops, copyRatio, extractSystemPrompt, buildUserPrompt,
  cardToAtom, rangeFromIds, quoteIsVerbatim, fillMissingSpecialized,
} from "../lib/one-stage.ts";
import { validateAtom } from "../lib/validate.ts";
import { admissionGate, COPY_RATIO_MAX, transienceFlag } from "../lib/admission.ts";
import { parseSession } from "../lib/window.ts";
import type { MessageEntry } from "../lib/types.ts";

let pass = 0;
let fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const E = (id: string, role: string, content: unknown, toolName?: string): MessageEntry => ({
  type: "message", id, parentId: null, timestamp: "2026-11-11T10:00:00Z",
  message: { role, content: content as never, ...(toolName ? { toolName } : {}) },
} as MessageEntry);
const txt = (s: string) => [{ type: "text", text: s }];

console.log("\n--- 1. 分级压缩：命令完整、报错逐字、stdout 压掉 ---");
const longOut = Array.from({ length: 400 }, (_, i) => `ok line ${i}`).join("\n")
  + "\nError: cannot find module 'typebox'\n    at foo.ts:12:3\nfatal: build failed";
const entries: MessageEntry[] = [
  E("m1", "user", txt("跑一下测试")),
  E("m2", "assistant", [
    { type: "text", text: "好的" },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm test --filter core -- --reporter=verbose 2>&1 | tail -50" } },
  ]),
  E("m3", "toolResult", txt(longOut), "bash"),
  E("m4", "assistant", txt("测试失败了，缺依赖。" + "补充说明".repeat(800))),
  E("m5", "user", txt("不对，先跑 lint 再跑 test，反了会漏掉类型错误")),
];
const lines = serializeForExtract(entries);
t("5 条消息全部序列化", lines.length === 5, `got ${lines.length}`);
t("pi 形状：命令行完整保留", lines[1].text.includes("pnpm test --filter core -- --reporter=verbose 2>&1 | tail -50"));
t("报错行逐字保留", lines[2].text.includes("Error: cannot find module 'typebox'") && lines[2].text.includes("fatal: build failed"));
t("成功 stdout 压掉 + 留取回凭证", lines[2].text.includes("📦 [压掉 #m3") && lines[2].text.includes("need_context 里报 m3"));
t("fail-safe 未误触发", lines[2].fallback !== true);
t("助手长文首尾截断", lines[3].text.includes("…(中略)…"));
t("用户消息全文保留", lines[4].text.includes("不对，先跑 lint 再跑 test"));

console.log("\n--- 2. dsh 形状：tool-call 连字符 + arguments 是 JSON 字符串 ---");
// 来历：blocksOf 原先只认 pi 的 toolCall，dsh 会话里 224 条助手消息有 170 条被整条跳过，
// 命令行全丢（实测 288 entries → 118 行）。这条用例锁住两种形状都认。
const dshEntries: MessageEntry[] = [
  E("d1", "user", txt("看看目录")),
  E("d2", "assistant", [
    { type: "reasoning", text: "我先看一下目录结构" },
    { type: "tool-call", id: "c1", name: "bash", arguments: '{"command": "pwd && ls -la", "description": "list"}' },
  ]),
  E("c1", "toolResult", txt("/repo\ntotal 8\ndrwxr-xr-x  5 x  staff  160 Nov 10 09:26 ."), "bash"),
];
const dl = serializeForExtract(dshEntries);
t("dsh 助手消息没被整条跳过", dl.length === 3, `got ${dl.length}`);
t("dsh 命令行解析出来了", dl[1].text.includes("pwd && ls -la"), dl[1].text.slice(0, 100));
t("reasoning(thinking) 不进抽取", !dl[1].text.includes("我先看一下目录结构"));
t("dsh 工具结果按成功输出压缩", dl[2].text.includes("✅") && dl[2].text.includes("/repo"));
t("parseArgs 解析 JSON 字符串", JSON.stringify(parseArgs('{"a":1}')) === '{"a":1}');
t("parseArgs 非法 JSON 退化成纯文本", parseArgs("not json") === "not json");

console.log("\n--- 3. fail-safe：只在'命令被截断'时触发，写文件正文不算 ---");
// 来历：write/edit 的 content 超 600 字也触发整条透传，实测 98/522 条（19%）远超 5% 阈值，
// 而且透传的全是文件正文不是命令。改成命令 2000 / 正文 600 分档后降到 3.8%。
const longContent = "x".repeat(5000);
const writeFile = serializeForExtract([
  E("w1", "assistant", [{ type: "tool-call", id: "w", name: "write", arguments: JSON.stringify({ file_path: "/a/b.ts", content: longContent }) }]),
]);
t("写文件正文被截断", writeFile[0].text.includes("…(内容截断，原 5000 字)"), writeFile[0].text.slice(-60));
t("写文件正文截断**不**触发 fail-safe 透传", writeFile[0].fallback !== true);
const longCmd = "echo " + "y".repeat(3000);
const shellMsg = serializeForExtract([
  E("s1", "assistant", [{ type: "tool-call", id: "s", name: "bash", arguments: JSON.stringify({ command: longCmd }) }]),
]);
t("长命令截断**要**触发 fail-safe 透传", shellMsg[0].fallback === true);
t("命令上限 2000 内不截断", compressArgs("bash", { command: "z".repeat(1900) }).truncated === false);
t("compressArgs 分档：命令 kind=command", compressArgs("bash", { command: longCmd }).kind === "command");
t("compressArgs 分档：文件正文 kind=content", compressArgs("write", { content: longContent }).kind === "content");
t("compressArgs 结构化参数只留 key + 前 80 字", compressArgs("web_fetch", { url: "https://example.com/" + "p".repeat(200) }).kind === "args");
const hugeErr = Array.from({ length: 60 }, (_, i) => `Error: failure number ${i} with a long tail`).join("\n");
const hl = serializeForExtract([E("x1", "toolResult", txt(hugeErr), "bash")]);
t("报错行超 800 字 → 整条透传", hl[0].fallback === true);
t("透传后报错仍在（assertErrorLinesKept 可用）", assertErrorLinesKept(hugeErr, hl[0].text) || hl[0].text.includes("Error: failure number 0"));
t("errorLines 不误报 '0 errors'", errorLines("Build ok\n0 errors, 2 warnings").length === 0);

console.log("\n--- 3b. harness 元数据过滤（误杀真话比漏过噪声严重得多） ---");
// 来历：实测 64 条 user 消息里 22 条（34%）是纯时间戳元数据，模型每批都要为它们记账
const META = "Time sampled while preparing turn 1, step 1: 2026-11-10T09:28:51+08:00[Asia/Shanghai]\n"
  + "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n"
  + "Elapsed since the preceding model-visible message: unavailable.";
t("纯元数据判为噪声", isHarnessNoise(META) === true);
t("元数据 + 一个字确认 → **保留**（\"好\"就是 P0 决策信号）", isHarnessNoise(META.replace(/Elapsed.*/, "好")) === false);
t("元数据 + 真实内容 → 保留", isHarnessNoise(META + "\n请把这个改成一段式，成本不用考虑") === false);
t("普通用户消息 → 保留", isHarnessNoise("不对，先跑 lint 再跑 test") === false);
t("空消息判为噪声", isHarnessNoise("") === true);
t("runtime context 快照 + 真实问题 → 保留", isHarnessNoise(META + "\nCurrent runtime context. This snapshot supersedes earlier runtime-context snapshots.\n跑一下测试") === false);
const noisy = serializeForExtract([E("n1", "user", txt(META)), E("n2", "user", txt("真的问题")), E("n3", "assistant", txt("回答"))]);
t("噪声不进批次、真话进批次", noisy.length === 2 && noisy[0].text.includes("真的问题"));
t("harnessNoiseCount 计数正确", harnessNoiseCount([E("n1", "user", txt(META)), E("n2", "user", txt("真的问题"))]) === 1);

console.log("\n--- 4. 轮次对齐分批 + 净收益检查 ---");
const many: MessageEntry[] = [];
for (let i = 0; i < 12; i++) {
  many.push(E(`u${i}`, "user", txt(`问题 ${i} ` + "x".repeat(900))));
  many.push(E(`a${i}`, "assistant", txt(`回答 ${i} ` + "y".repeat(900))));
}
const ml = serializeForExtract(many);
const batches = batchByTurn(ml, 3000);
t("分成多批", batches.length > 1, `got ${batches.length}`);
const split = batches.some((b) => {
  const ts = new Set(b.map((l) => l.turn));
  return ml.filter((l) => ts.has(l.turn)).length !== b.length;
});
t("没有一批把某轮切开", !split);
t("批间保留上一批最后 1 轮作只读上下文", overlapTurn(batches[0]).length > 0);
const stBig = compressStats(lines);
t("有大工具输出时压缩率 <1", stBig.ratio < 1 && stBig.ratio > 0, JSON.stringify(stBig));
const st = compressStats(ml);
t("全是小消息时触发净收益检查（压完更大就不压）", st.noGain > 0 && st.lines === ml.length, JSON.stringify(st));

console.log("\n--- 5. 输出契约：缺账 / P3 / 否决权 / user 消息归属 ---");
const ids = new Set(["m1", "m2", "m3", "m4", "m5"]);
const userIds = new Set(["m1", "m5"]);
const good = JSON.stringify({
  cards: [{ type: "sop", title: "先 lint 再 test", body: "顺序：1) lint 2) test；反了会漏类型错误", why_lose: "顺序错会漏检类型错误", domain: "ci", source: { msg_ids: ["m5"], quote: "不对，先跑 lint 再跑 test" }, grounding: "G1", value: "P0", step: "1) lint 2) test" }],
  drops: [{ msg_ids: ["m1"], reason: "纯流水账", axis: "—" }],
  no_value: false,
});
const p1 = parseOneStageOutput(good, ids, { userIds });
t("合格输出 formatOk", p1.formatOk === true && p1.cards.length === 1, p1.formatError ?? "");
t("jsonOk 标记为真", p1.jsonOk === true);
t("幻觉 msg_id 被过滤", parseOneStageOutput(
  JSON.stringify({ cards: [{ type: "sop", body: "xxxxxxxx", why_lose: "yyyyyyyy", domain: "d", source: { msg_ids: ["zzz"], quote: "q" } }], drops: [], no_value: false }),
  ids,
).cards.length === 0);
const p3 = parseOneStageOutput(
  JSON.stringify({ cards: [{ type: "spec", body: "架构讲解很长很长", why_lose: "丢了看不懂", domain: "d", value: "P3", source: { msg_ids: ["m4"], quote: "q" } }], drops: [{ msg_ids: ["m1", "m5"], reason: "纯流水账", axis: "—" }], no_value: false }),
  ids, { userIds },
);
t("P3 卡片降级成 drop（不出卡）", p3.cards.length === 0 && p3.drops.some((d) => d.reason === "P3自说自话"));
const noAcc = parseOneStageOutput(JSON.stringify({ cards: [], drops: [], no_value: false }), ids, { userIds });
t("缺 drop 账 → 不合格（允许重跑）", noAcc.formatOk === false, noAcc.formatError ?? "");
const veto = parseOneStageOutput(JSON.stringify({ cards: [], drops: [], no_value: true }), ids, { userIds });
t("no_value → 合格（否决权，绝不重跑）", veto.formatOk === true && veto.noValue === true);
t("no_value 时不追究消息归属", veto.userUnaccounted.length === 0 && veto.unaccounted.length === 0);
const bad = parseOneStageOutput("抱歉我无法处理", ids, { userIds });
t("JSON 非法 → 不合格", bad.formatOk === false && bad.jsonOk === false);
// 来历：实测抓到两条 P0 用户消息（三项架构决策 + 一次术语纠正）进了批次、全文未压缩，
// 模型却既没出卡也没记 drop。契约原先只要求 drops 非空，管不住静默忽略。
const silent = parseOneStageOutput(
  JSON.stringify({ cards: [], drops: [{ msg_ids: ["m2", "m3", "m4"], reason: "纯流水账", axis: "—" }], no_value: false }),
  ids, { userIds },
);
t("user 消息没交代 → 不合格", silent.formatOk === false && (silent.formatError ?? "").includes("user 消息未交代"), silent.formatError ?? "");
t("未交代清单只算 user 消息", silent.userUnaccounted.join(",") === "m1,m5", silent.userUnaccounted.join(","));
t("未交代总数含 assistant/tool（只观测不强制）", silent.unaccounted.length === 2);
const filled = autoFillDrops(silent);
t("兜底补账后合格", filled.formatOk === true);
t("兜底只补 user 消息", filled.autoDropped === 2 && filled.drops.filter((d) => d.reason === "模型未申报").length === 2);
t("兜底理由与模型自报可区分", filled.drops.some((d) => d.reason === "纯流水账") && filled.drops.some((d) => d.reason === "模型未申报"));
t("JSON 非法时禁止兜底（否则整批被伪造成已审）", autoFillDrops(bad).autoDropped === 0 && autoFillDrops(bad).formatOk === false);
t("已合格时兜底是 no-op", autoFillDrops(p1).autoDropped === 0 && autoFillDrops(p1).drops.length === p1.drops.length);

console.log("\n--- 6. 反摘要闸门：摘抄率 + 祈使句 ---");
// copyRatio(原文, 正文) = 正文的碎片有多少逐字抄自原文。参数顺序反了就会误杀，见下面第 3 条
const longSrc = "不对，先跑 lint 再跑 test，反了会漏掉类型错误，这个顺序在 CI 上尤其重要，因为类型检查失败会让后面的测试整批跳过";
t("正文照抄原文 → 摘抄率高", copyRatio(longSrc, longSrc + longSrc.slice(0, 60)) > COPY_RATIO_MAX);
t("正文提炼过 → 摘抄率低", copyRatio(longSrc, "提交前顺序：先 lint 后 test。反过来会漏掉类型错误（m5 纠正，执行验证），CI 上更要守住，否则整批测试被跳过还看不出来") < COPY_RATIO_MAX);
// 🔴 回归用例：这个方向 2026-11-12 写反过，实测误杀 5 张卡（4 张 P0/P1）。
// 旧实现算"quote 的碎片有多少落在正文里"，于是"引一句 4 字原文 + 自己写 356 字分析"= 100% 摘抄。
t("引一句短原文 + 自己写长分析 ≠ 摘抄（旧实现判 100%）", copyRatio(
  "全量重判",
  "- 决策：用户先令全量重判（方案A：从零重判 25428 条，约 20h / 2 亿 tokens，启动后中止）；追问是否在已过滤结果上继续过滤后，改选方案B。\n- 选 B 的理由：水分只在 C3 步骤判分，C3=2 的 15300 条才是真问题，全量重判性价比低。\n- 复判模型定为 svc/glm5.3flash，并发 16，reject_list.csv 留理由供人工复核。",
) < COPY_RATIO_MAX);
t("短原文在长正文里出现不会把比值顶满", copyRatio("就在当前项目下搜", "先对整个主目录做 find/grep，未命中且低效；用户纠正就在当前项目下搜之后，改在项目目录内按文件名加内容 grep，立即命中已有的结构化工具链，省掉一轮重复实现。") < COPY_RATIO_MAX);
t("正文短于一个碎片时按整段判定", copyRatio(longSrc, "先跑lint再跑test") === 1);
t("短正文不是原文子串时判 0（不是 1）", copyRatio(longSrc, "先跑lint再test") === 0);
t("空原文 / 空正文都不崩", copyRatio("", "随便什么正文") === 0 && copyRatio(longSrc, "") === 0);

console.log("\n--- 7. card → atom → 准入 ---");
const atom = cardToAtom(p1.cards[0], entries, "session-abc", 1);
t("cardToAtom 成功", !("error" in atom), JSON.stringify(atom).slice(0, 120));
if (!("error" in atom)) {
  t("数据层字段名保持不变", atom.doc_type === "sop" && atom.extracted_by === "signal-distill" && !!atom.atom_id && atom.keep_as === "instruction");
  t("msg_range 从 msg_ids 推出", Array.isArray(atom.sources[0].msg_range) && atom.sources[0].msg_range[0] === "m5");
  const gate = admissionGate(atom, { requireWhy: true, copyRatio: copyRatio(longSrc, atom.content) });
  t("准入通过", gate.ok === true, gate.reasons.join(";"));
  const copy = { ...atom, content: longSrc + longSrc.slice(0, 60) };
  t("摘抄率超阈值被拒", admissionGate(copy, { requireWhy: true, copyRatio: copyRatio(longSrc, copy.content) }).reasons.some((r) => r.includes("摘抄")));
  t("拒因文案写明方向和上限", admissionGate(copy, { requireWhy: true, copyRatio: 0.95 }).reasons.some((r) => r.includes("逐字抄自原文") && r.includes("上限 60%")));
  const imp = { ...atom, content: "必须先跑 lint 再跑 test，否则会漏掉类型错误。这一条在 CI 流水线上尤其重要，因为类型检查失败会让后面整批测试被跳过，返工成本很高。" };
  t("祈使句开关打开时能拦", admissionGate(imp, { requireWhy: true, checkImperative: true }).reasons.some((r) => r.includes("祈使句")));
  t("祈使句开关默认关（不误杀）", !admissionGate(imp, { requireWhy: true }).reasons.some((r) => r.includes("祈使句")));
  const hist = { ...atom, content: "当时定的是必须先跑 lint 再跑 test，否则会漏掉类型错误。这一条在 CI 流水线上尤其重要，因为类型检查失败会让后面整批测试被跳过，返工成本很高。" };
  t("带历史标记的不算祈使句", admissionGate(hist, { requireWhy: true, checkImperative: true }).reasons.every((r) => !r.includes("祈使句")));
}
t("rangeFromIds 多 id 取最小最大", JSON.stringify(rangeFromIds(entries, ["m5", "m1"])) === JSON.stringify(["m1", "m5"]));

console.log("\n--- 7c. transienceFlag：状态快照/已结案复盘粗判（§三bis 兜底，默认关） ---");
// 耐久：红线 / 契约 / 环境约定 / SOP → 不该被标
t("spec 红线不标", transienceFlag({ content: "理论引用必须从 theory skill 库检索，不得自行生成；检索不到就不引用。排除：为 thm-* 自建占位理论卡。", doc_type: "spec" }) === null);
t("convention 红线不标", transienceFlag({ content: "child-check 不是 git 仓库（git rev-parse 报 fatal），覆盖性重写前必须先把旧版 cp 到 archive/，否则旧设计稿不可逆丢失。", doc_type: "convention" }) === null);
t("sop 不标", transienceFlag({ content: "提交前先 lint 再 test：1) lint 2) test，反了会漏掉类型错误。", doc_type: "sop" }) === null);
t("rubric 口径不标", transienceFlag({ content: "理论引用治理：消费层只写 thm-*，registry 三道闸为完整性/合法性/A2 词表。", doc_type: "rubric" }) === null);
// 状态快照：当前缺口 → 标
t("当前缺口/TODO 标", (transienceFlag({ content: "补齐清单即五缺口：建实例并拍板开放问题、补派生锚点表、定义双值并存 JSON 结构、写取值域校验器。", doc_type: "spec" }) ?? { reason: "" }).reason.includes("缺口"));
// 库存清单：计数 + 多路径 → 标
const inv = transienceFlag({ content: "theories/ 7 库 103 张 capability 卡：er-tong-fa-zhan-xin-li-xue 18 张、fei-er-de 17 张。theme-pool.json 12 主题，scene-templates/T-*.json 各 3 场景。归档在 ~/Downloads/。", doc_type: "index" });
t("库存清单标", inv !== null && inv.reason.includes("库存清单"));
// 已结案复盘：postmortem + 处置标记 + 无可分离教训 → 标
const sag = transienceFlag({ content: "现象：T-0017 引了 thm-008 但 registry 标 retired。根因：闸2 只查 id 不查 status。处置（B 批）：补 retired 拒引 + A2 词表闸，已上线。", doc_type: "postmortem" });
t("已结案复盘标", sag !== null && sag.reason.includes("已结案"));
// postmortem 带可分离失效模式 + 防范 → 不标（这才是该留的复盘）
t("postmortem 带失效模式+防范不标", transienceFlag({ content: "失效模式：成员检查≠合法性检查（id 存在≠引用合法）。防范：校验闸要读 status 字段，retired 不许消费层引用——同类还会在别的 registry 复现。", doc_type: "postmortem" }) === null);
// 门接线：checkTransience 开 → 拦；默认关 → 不拦（防误杀）
if (!("error" in atom)) {
  const transientAtom = { ...atom, content: "补齐清单即五缺口：建实例、补派生锚点表、写校验器。", doc_type: "spec" as const };
  t("checkTransience 开时拦状态快照", admissionGate(transientAtom, { requireWhy: true, checkTransience: true }).reasons.some((r) => r.includes("状态快照")));
  t("checkTransience 默认关（不误杀）", !admissionGate(transientAtom, { requireWhy: true }).reasons.some((r) => r.includes("状态快照")));
}

console.log("\n--- 7b. 两项决议：quote 只标记不拦 + 缺字段降级入库 ---");
// 来历（2026-11-12 实测）：被拒 18 张里 6 张只是没填类型必填字段，内容有据；
// 唯一一条"非逐字引用"是"注释说默认 false、代码是 if(enabled===false) return"这类高价值卡。
t("quote 逐字命中", quoteIsVerbatim("先跑 lint", ["前面的话 先跑 lint 后面的话"]) === true);
t("空白差异不影响判定", quoteIsVerbatim("1. 按类型分档 2. 同一个模型", ["1.按类型分档\n2.同一个模型"]) === true);
t("改写过的判不逐字", quoteIsVerbatim("模型自己合成的一句话", ["原文完全不是这样"]) === false);
t("空 quote 判不逐字", quoteIsVerbatim("", ["随便什么原文"]) === false);
t("原文缺失不崩", quoteIsVerbatim("x", [undefined, ""]) === false);

const partial = cardToAtom(
  { type: "spec", title: "定时组装默认开启", body: "assemble-timer.ts 的注释写默认 false，但代码是 if (config.enabled === false) return，未配置时实际启用。", why_lose: "按注释假设默认关闭会误判行为", domain: "adapter-dsh", source: { msg_ids: ["m5"], quote: "q" }, grounding: "G2", value: "P1" } as never,
  entries, "session-abc", 7,
);
if ("error" in partial) {
  t("构造缺字段的 spec 卡", false, partial.error);
} else {
  t("缺字段时 validateAtom 确实拒", validateAtom(partial, []).ok === false);
  const pending = fillMissingSpecialized(partial);
  t("返回待补清单", pending.includes("concept_name") && pending.includes("definition"), pending.join(","));
  t("名字类用 title 代填（名字换名字，不产生也不丢信息）", (partial as Record<string, unknown>).concept_name === "定时组装默认开启");
  // 🔴 回归：第一版拿正文全文去充内容类字段，结果 problem 和 root_cause 变成同一段正文的
  // 副本（实测 6 处）。字段看着有值、下游选材被骗、人也不会再补——比缺字段更糟。
  t("内容类字段绝不拿正文充数", (partial as Record<string, unknown>).definition === undefined);
  t("待补字段全部记进 pending_fields", JSON.stringify((partial as Record<string, unknown>).pending_fields) === JSON.stringify(pending));
  t("默认仍然严格：不传 requireSpecialized 就拒（回填/人工入口走这条）", validateAtom(partial, []).ok === false);
  t("抽取路径关掉特化字段强制后可入库", validateAtom(partial, [], undefined, { requireSpecialized: false }).ok === true);
  t("关掉强制不影响其他校验（价值理由仍然查）", validateAtom({ ...partial, why: "" }, [], undefined, { requireSpecialized: false }).ok === false);
  // postmortem 是最容易踩重复坑的类型：problem 与 root_cause 都属内容类
  const pm = cardToAtom(
    { type: "postmortem", title: "试点归一脚本卡死", body: "末尾写盘 + 纯数字型号超时导致卡死，改成边跑边写并对纯数字型号加超时跳过。", why_lose: "下次跑全量还会卡死", domain: "机型归一", source: { msg_ids: ["m5"], quote: "q" }, grounding: "G2", value: "P1" } as never,
    entries, "session-abc", 9,
  );
  if (!("error" in pm)) {
    const pf = fillMissingSpecialized(pm);
    t("postmortem 的 problem / root_cause 都记待补且不互抄", pf.includes("problem") && pf.includes("root_cause")
      && (pm as Record<string, unknown>).problem === undefined && (pm as Record<string, unknown>).root_cause === undefined, pf.join(","));
    t("postmortem 缺 problem/root_cause 也能入库（抽取路径）", validateAtom(pm, [], undefined, { requireSpecialized: false }).ok === true);
  } else {
    t("构造 postmortem 卡", false, pm.error);
  }
  t("字段齐全时不动、也不加 pending_fields", (() => {
    const full = cardToAtom(
      { type: "spec", title: "T", body: "正文内容", why_lose: "不存会损失上下文", domain: "d", concept_name: "已有概念", definition: "已有定义", source: { msg_ids: ["m5"], quote: "q" }, grounding: "G2", value: "P1" } as never,
      entries, "session-abc", 8,
    );
    if ("error" in full) return false;
    return fillMissingSpecialized(full).length === 0
      && (full as Record<string, unknown>).pending_fields === undefined
      && (full as Record<string, unknown>).concept_name === "已有概念";
  })());
  t("title 也没有时名字类退回 domain，不塞空串", (() => {
    const noTitle = { ...partial, title: "", concept_name: undefined, atom_id: "atom_test_notitle_001" } as never;
    fillMissingSpecialized(noTitle as never);
    return (noTitle as Record<string, unknown>).concept_name === "adapter-dsh";
  })());
}

console.log("\n--- 8. prompt cache 前提：system prompt 字节稳定 ---");
t("两次调用字节相同", extractSystemPrompt() === extractSystemPrompt());
t("不含日期", !/\d{4}-\d{2}-\d{2}/.test(extractSystemPrompt()));
t("不含批次号", !/batch/i.test(extractSystemPrompt()));
t("契约里写明了 user 消息必须有归属", extractSystemPrompt().includes("必须有归属"));
const up = buildUserPrompt({ batch: lines, overlap: [], domainOptions: ["ci", "deploy"], knownCards: ["旧卡片标题"] });
t("变化内容都在 user message", up.includes("[已有主题清单]") && up.includes("ci / deploy") && up.includes("[已知卡片摘要") && up.includes("[本批消息]"));
t("只读上下文标注禁止出卡", buildUserPrompt({ batch: lines, overlap: lines.slice(0, 1) }).includes("禁止从中出卡"));

console.log("\n--- 9. parseSession 收 dsh 工具事件（回归：曾整类丢失） ---");
const dshLog = [
  '{"type":"session","id":"session-x"}',
  '{"type":"user/message","seq":1,"time":1,"data":{"role":"user","id":"u1","content":[{"type":"text","text":"看下目录"}]}}',
  '{"type":"tool/call","seq":2,"time":2,"data":{"callId":"c1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
  '{"type":"assistant/message","seq":3,"time":3,"data":{"message":{"role":"assistant","id":"a1","content":[{"type":"reasoning","text":"想"},{"type":"tool-call","id":"c1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}]}}}',
  '{"type":"tool/result","seq":4,"time":4,"data":{"message":{"role":"tool","toolCallId":"c1","content":[{"type":"text","text":"Error: boom\\nline2"}]}}}',
];
const parsed = parseSession(dshLog);
t("user + assistant + toolResult 都收进来", parsed.length === 3, `got ${parsed.length}`);
t("工具结果 role 归一成 toolResult", parsed.some((e) => e.message?.role === "toolResult"));
t("工具名从 tool/call 关联上了", parsed.find((e) => e.message?.role === "toolResult")?.message?.toolName === "bash");
t("工具结果 id 用 callId（可被 msg_ids 引用）", parsed.some((e) => e.id === "c1"));
t("id 唯一（重复 id 不重复入列）", new Set(parsed.map((e) => e.id)).size === parsed.length);
t("reasoning 事件不单独成条", parsed.filter((e) => e.message?.role === "assistant").length === 1);
const tl = serializeForExtract(parsed);
t("报错原文能从工具结果里逐字取到", tl.some((l) => l.text.includes("Error: boom")));

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
