#!/usr/bin/env node
/**
 * 人工 review 表生成器：把一次校准产物整理成人能逐条判读的 markdown。
 *
 * 对应验收标准（design/ONE_STAGE_EXTRACT.md §七）里**必须靠人判**的两条：
 *   #5 盲评摘要率（"这是知识还是摘要"，机器判不了）
 *   #1 P0 召回（漏检：该出卡的有没有被丢进 drop 账）
 * 其余能机器算的（#2 drop 覆盖率、#4 逐字接地、#7 prompt 哈希、#8 fail-safe、#9 重合度）一并算出来对照。
 *
 * 用法：
 *   node --experimental-strip-types packages/core/scripts/review-sheet.ts <session.jsonl[.zstd]> \
 *     [--calib /tmp/.../calib] [--out REVIEW.md] [--blind-n 20]
 *
 * 产物：一份 markdown，含盲评区（不带类型，防暗示）、卡片明细、drop 账全量、被拒卡片、验收对照表。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession } from "../lib/window.ts";
import { serializeForExtract } from "../lib/compress.ts";
import { readDrops, readRejected } from "../lib/drop-log.ts";
import { setHostContext } from "../lib/context.ts";
import { copyRatio } from "../lib/one-stage.ts";
import { COPY_RATIO_MAX } from "../lib/admission.ts";

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) { flags.set(a, next); i++; } else flags.set(a, "true");
}
const one = (n: string): string | undefined => flags.get(n);

const sessionPath = positional[0];
if (!sessionPath) {
  console.error("用法: review-sheet.ts <session.jsonl[.zstd]> [--calib DIR] [--out FILE]");
  process.exit(1);
}
const calibDir = one("--calib") ?? join(tmpdir(), "autoskill-extract-calibrate");
const outPath = one("--out") ?? join(calibDir, "REVIEW.md");
const blindN = Number(one("--blind-n") ?? 20);

// drop 账在校准用的隔离库里
setHostContext({ host: "cli", dataDir: join(calibDir, "kb") });

const calibPath = join(calibDir, "calibrate-one-stage.json");
if (!existsSync(calibPath)) {
  console.error(`找不到 ${calibPath}，先跑 extract-calibrate.ts`);
  process.exit(1);
}
const calib = JSON.parse(readFileSync(calibPath, "utf8")) as {
  session: string; stage: string; model: string; batchChars: number;
  coverage: { total: number; covered: number; unreviewed: number };
  batches: { used: number; total: number };
  tokens: { in: number; out: number; total: number };
  elapsedMs: number; atoms: number; rejected: number;
  rejectReasons: Record<string, number>; rejectSamples?: Record<string, string>; dropped: number; byType: Record<string, number>;
  compress: { ratio: number; fallback: number; noGain: number } | null;
  oneStage: { noValueBatches: number; retriedBatches: number; needContext: number; dropRows: number; autoDropped: number; unaccounted: number } | null;
  drops: { total: number; byReason: Record<string, number>; byAxis: Record<string, number> } | null;
  copyRatio: { n: number; p50: number; p90: number; max: number; threshold: number } | null;
  probes: { probe: string; messages: number; hit: boolean; hitMessages: number }[];
  stopped: string | null;
  cards: { id: string; type: string; domain: string; content: string; quote: string; value: string | null }[];
};

// ---------- 读会话原文，用来机械核对"逐字接地"（验收 #4） ----------
const readLines = (p: string): string[] =>
  p.endsWith(".zstd")
    ? execFileSync("zstd", ["-d", "-c", p], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8").split("\n")
    : readFileSync(p, "utf8").split("\n");
const entries = parseSession(readLines(sessionPath));
const textOf = (id: string): string => {
  const e = entries.find((x) => x.id === id);
  const c = e?.message?.content;
  return typeof c === "string" ? c : (c ?? []).map((b) => String((b as { text?: string }).text ?? "")).join("\n");
};
const idxOf = new Map(entries.map((e, i) => [e.id, i]));
/**
 * quote 是否逐字命中。
 *
 * **校验对象是"模型实际看到的压缩文本"，不是原始会话日志**——这是实测踩出来的：
 * 原始日志里 tool-call 的 arguments 是 JSON 字符串（换行被转义成字面量 \\n），
 * 拿它做子串匹配会把合法引用误判成编造，实测误判 11/38。
 * 压缩文本是模型唯一能引用的东西：命中它就说明不是编的；两边都不命中才算改写/拼接。
 */
const compById = new Map(serializeForExtract(entries).map((l) => [l.id, l.text]));
function groundingCheck(quote: string, msgRange: string[] | undefined): { ok: boolean; detail: string } {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const q = norm(quote ?? "");
  if (!q) return { ok: false, detail: "无 quote" };
  if (!msgRange?.length) return { ok: false, detail: "无 msg_range" };
  const lo = idxOf.get(msgRange[0]);
  const hi = idxOf.get(msgRange[msgRange.length - 1]);
  if (lo == null || hi == null) return { ok: false, detail: "msg_id 不在会话里" };
  let comp = "";
  let raw = "";
  for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) {
    comp += norm(compById.get(entries[i].id) ?? "");
    raw += norm(textOf(entries[i].id));
  }
  if (comp.includes(q)) return { ok: true, detail: "逐字命中（模型看到的文本）" };
  if (raw.includes(q)) return { ok: true, detail: "逐字命中（原始日志）" };
  return { ok: false, detail: `压缩文本与原始日志都找不到（quote ${q.length} 字）→ 疑似改写或多条拼接` };
}

// 从落库卡片取 msg_range（calib JSON 里没带，读隔离库的 atoms.jsonl）
const atomsRaw = existsSync(join(calibDir, "kb", "atoms.jsonl"))
  ? readFileSync(join(calibDir, "kb", "atoms.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Record<string, unknown>[]
  : [];
const rangeOf = new Map<string, string[]>();
// 落库时打上的两个标记：quote 是否逐字（不拦，只标记）、哪些特化字段是降级补位的
const metaOf = new Map<string, { quoteVerified?: boolean; pending?: string[] }>();
for (const a of atomsRaw) {
  const srcs = (a.sources ?? []) as { msg_range?: string[] }[];
  const r = srcs.flatMap((s) => s.msg_range ?? []);
  if (r.length) rangeOf.set(String(a.atom_id), r);
  metaOf.set(String(a.atom_id), {
    quoteVerified: a.quote_verified === undefined ? undefined : a.quote_verified === true,
    pending: Array.isArray(a.pending_fields) ? (a.pending_fields as string[]) : undefined,
  });
}

const drops = readDrops();
const cards = calib.cards ?? [];

// ---------- 逐卡计算 ----------
// 摘抄率的比对对象 = msg_range 内的**压缩后原文**（模型实际看到的那些行），
// 不是模型自己挑的那句 quote：只比 quote 太窄，正文抄区间内别处就能绕过闸门。
const compOrder = [...compById.keys()];
const compIdx = new Map(compOrder.map((id, k) => [id, k]));
const srcText = (range?: string[]): string => {
  if (!range?.length) return "";
  const at = range.map((id) => compIdx.get(id)).filter((x): x is number => x !== undefined);
  const ids = at.length >= 2 ? compOrder.slice(Math.min(...at), Math.max(...at) + 1) : range;
  return [...new Set(ids)].map((id) => compById.get(id) ?? "").join("\n");
};
const rows = cards.map((c, i) => {
  const range = rangeOf.get(c.id);
  const g = groundingCheck(c.quote, range);
  const ov = copyRatio(srcText(range), String(c.content ?? ""));
  return { i, ...c, range, grounding: g, overlap: ov, len: String(c.content ?? "").length };
});
const gOk = rows.filter((r) => r.grounding.ok).length;
const grounded = rows.filter((r) => r.len >= 100);
const ovs = grounded.map((r) => r.overlap).sort((a, b) => a - b);
const median = ovs.length ? ovs[Math.floor(ovs.length / 2)] : 0;
const over = grounded.filter((r) => r.overlap > COPY_RATIO_MAX);

// ---------- 生成 markdown ----------
const L: string[] = [];
L.push(`# 一段式抽取 人工 review 表`);
L.push(``);
L.push(`> 会话 \`${calib.session}\`｜模型 \`${calib.model}\`｜批 ${calib.batches.used}/${calib.batches.total}｜` +
  `消息 ${calib.coverage.total}（待审 ${calib.coverage.unreviewed}）｜` +
  `token in ${calib.tokens.in} / out ${calib.tokens.out}｜${(calib.elapsedMs / 1000).toFixed(0)}s`);
L.push(`> 生成时间 ${new Date().toISOString()}｜数据源 \`${calibPath}\``);
L.push(``);
L.push(`**怎么填**：第一部分逐张判"知识 / 摘要 / 摘抄"，只需在括号里打勾；第二部分核结构；第三部分看 drop 账有没有漏掉该存的（漏检比摘要更危险）。`);
L.push(``);

// 一、盲评
L.push(`## 一、盲评：这是知识还是摘要？（验收 #5，目标摘要率 ≤10%）`);
L.push(``);
L.push(`不显示类型与价值级，避免暗示。判定标准：**换个人读到这张卡，能不能少踩一次坑 / 少问一次问题**——能，就是知识；只是"这段对话讲了什么"，就是摘要。`);
L.push(``);
const blind = rows.slice(0, blindN);
for (const r of blind) {
  L.push(`### 卡 ${r.i + 1}`);
  L.push(``);
  L.push(`**正文**`);
  L.push(``);
  for (const ln of String(r.content).split("\n")) L.push(`> ${ln}`);
  L.push(``);
  L.push(`**它引用的原文**`);
  L.push(``);
  L.push('```');
  L.push(String(r.quote || "（无）"));
  L.push('```');
  L.push(``);
  L.push(`判定（打一个勾）：（ ）知识　（ ）摘要　（ ）摘抄原文　　备注：＿＿＿＿＿＿`);
  L.push(``);
}

// 二、明细
L.push(`## 二、卡片明细：结构与接地（验收 #4 #6 #9）`);
L.push(``);
L.push(`| # | 类型 | 主题 | 价值 | 字数 | quote 逐字接地 | 摘抄率（正文抄自原文） | 降级入库（待补字段） |`);
L.push(`|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  const m = metaOf.get(String(r.id)) ?? {};
  const pend = m.pending?.length ? `⚠️ ${m.pending.join(", ")}（由 title/body 补位）` : "—";
  L.push(`| ${r.i + 1} | \`${r.type}\` | ${r.domain} | ${r.value ?? "—"} | ${r.len} | ${r.grounding.ok ? "✅" : "❌ " + r.grounding.detail} | ${(r.overlap * 100).toFixed(0)}%${r.overlap > COPY_RATIO_MAX ? " ⚠️超阈值" : ""} | ${pend} |`);
}
L.push(``);
L.push(`- **逐字接地合格率**：${gOk}/${rows.length} = ${rows.length ? ((gOk / rows.length) * 100).toFixed(0) : 0}%（阈值 ≥90%）`);
L.push(`- **摘抄率中位数**（正文 ≥100 字，${grounded.length} 张）：${(median * 100).toFixed(0)}%（阈值 <40%）`);
L.push(`- **超 ${COPY_RATIO_MAX * 100}% 阈值**：${over.length} 张${over.length ? ` → ${over.map((r) => `卡${r.i + 1}`).join("、")}` : ""}（这些本该被准入拦下，若已落库说明闸门没生效）`);
const unverified = [...metaOf.values()].filter((m) => m.quoteVerified === false).length;
const downgraded = [...metaOf.values()].filter((m) => m.pending?.length).length;
L.push(`- **quote 非逐字（\`quote_verified: false\`）**：${unverified} 张。**按 2026-11-12 决议不拦、只标记**，交人确认环节判断——实测唯一一例是"注释与代码不一致"的高价值卡，硬闸门会把它和真摘抄一起杀掉。`);
L.push(`- **降级入库（缺特化字段，用 title/body 补位）**：${downgraded} 张。**按 2026-11-12 决议不再直接拒**（实测这类占被拒 6/18），补位字段记在 \`pending_fields\` 里表示"推导来的、不是模型申报的"。`);
L.push(``);
const rejected = readRejected();
if (Object.keys(calib.rejectReasons ?? {}).length || rejected.length) {
  L.push(`### 准入/校验拦下的卡片（判断是否误杀）`);
  L.push(``);
  for (const [k, v] of Object.entries(calib.rejectReasons ?? {})) L.push(`- ${(calib.rejectSamples ?? {})[k] ?? k} ×${v}`);
  L.push(``);
  if (rejected.length === 0) {
    L.push(`（本次运行早于被拒卡片留档功能，只有计数没有内容）`);
    L.push(``);
  }
  for (const r of rejected) {
    L.push(`#### 被拒 · 批 ${r.batch} · \`${r.doc_type}\` · ${r.domain} · ${r.stage}`);
    L.push(``);
    L.push(`**拒绝原因**：${r.reason}`);
    L.push(``);
    L.push(`**卡片正文**`);
    L.push(``);
    for (const ln of String(r.content ?? "").split("\n")) L.push(`> ${ln}`);
    L.push(``);
    L.push(`**它引用的原文**：${r.quote ? "\`" + r.quote + "\`" : "（无）"}`);
    L.push(``);
    L.push(`该不该拦？（ ）该拦　（ ）误杀　　备注：＿＿＿＿＿＿`);
    L.push(``);
  }
}

// 三、drop 账
L.push(`## 三、drop 账：有没有把该存的丢掉？（验收 #1 #2，漏检审查）`);
L.push(``);
L.push(`共 ${drops.length} 条记录（模型主动申报的"这批我看过、这些不值得存"）。**重点看 P0 类信号有没有被错误丢弃**：人的纠正、决策理由、被现实验证的事实。`);
L.push(``);
if (calib.drops) {
  L.push(`**按理由**：${Object.entries(calib.drops.byReason).map(([k, v]) => `${k} ×${v}`).join("；") || "—"}`);
  L.push(``);
  L.push(`**按判定轴**：${Object.entries(calib.drops.byAxis).map(([k, v]) => `${k} ×${v}`).join("；") || "—"}`);
  L.push(``);
}
const autoN = calib.oneStage?.autoDropped ?? 0;
L.push(autoN > 0
  ? `⚠️ **其中 ${autoN} 条是代码兜底补的账**（reason = 模型未申报）：模型看见了这些 user 消息，既没出卡也没申报丢弃，被代码强制记账。**这些是漏检嫌疑最大的一批，请逐条核对。**`
  : `✅ 没有需要代码兜底补账的 user 消息：模型对每条用户消息都给了归属。`);
L.push(``);
L.push(`| # | 批 | 消息 | 理由 | 判定轴 | 整批无价值 | 该批出卡 |`);
L.push(`|---|---|---|---|---|---|---|`);
drops.forEach((d, i) => {
  L.push(`| ${i + 1} | ${d.batch} | ${(d.msg_ids ?? []).join(",") || "—"} | ${d.reason} | ${d.axis} | ${d.no_value ? "是" : ""} | ${d.cards} |`);
});
L.push(``);

// 四、探针 + 验收对照
L.push(`## 四、探针召回（验收 #1）`);
L.push(``);
if (calib.probes?.length) {
  for (const p of calib.probes) L.push(`- 「${p.probe}」：${p.hit ? `✅ 命中（${p.hitMessages}/${p.messages} 条消息进了卡片区间）` : "❌ **未命中**"}`);
} else {
  L.push(`- 本次未传 --probe`);
}
L.push(``);
L.push(`## 五、验收对照`);
L.push(``);
L.push(`| # | 标准 | 阈值 | 实测 | 结论 |`);
L.push(`|---|---|---|---|---|`);
const hit = calib.probes?.filter((p) => p.hit).length ?? 0;
L.push(`| 1 | **P0 探针召回（验收主指标）** | 全中；未命中必须查清是"有归属的显式丢弃"还是"静默漏检" | ${hit}/${calib.probes?.length ?? 0} | ${calib.probes?.length && hit === calib.probes.length ? "✅" : "⚠️ 看第四部分逐条核对归属"} |`);
const dropCov = calib.oneStage ? (calib.oneStage.noValueBatches + calib.dropped > 0) : false;
L.push(`| 2 | drop 记账覆盖 | 每批都有 drops 或 no_value，且每条 user 消息都有归属 | ${calib.dropped} 条 / ${calib.batches.used} 批，无价值批 ${calib.oneStage?.noValueBatches ?? 0}，代码兜底补账 ${calib.oneStage?.autoDropped ?? 0} 条，批内未交代 ${calib.oneStage?.unaccounted ?? 0} 条（含助手与工具行，契约只强制 user 消息逐条交代） | ${dropCov && (calib.oneStage?.autoDropped ?? 0) === 0 ? "✅" : "⚠️ 见第三部分"} |`);
L.push(`| 3 | ~~token 成本~~ | 作废（2026-11-12 决议：不考虑成本） | in ${calib.tokens.in} / out ${calib.tokens.out} | — |`);
L.push(`| 4 | ~~逐字接地合格率 ≥90%~~ → **已取消数值阈值**（2026-11-12 决议）：实测不合格卡的数字与事实全部逐字可溯，模型改写的只是连接词，要求整串逐字等于惩罚提炼本身 | 不设阈值；看 \`quote_verified:false\` 标记数 + 第一部分人工盲评 | 逐字 ${rows.length ? ((gOk / rows.length) * 100).toFixed(0) : 0}%（${gOk}/${rows.length}），标记非逐字 ${unverified} 张 | 📍 观测指标，人工判 |`);
L.push(`| 5 | 盲评摘要率 | ≤10% | **待人工填第一部分** | ⏳ |`);
const prop = calib.atoms + calib.rejected;
L.push(`| 6 | 准入通过率 | 不低于两段式（**基线不可比**：两段式那轮跑在输入 bug 修复前，闸门无内容可拦） | ${calib.atoms}/${prop} = ${prop ? ((calib.atoms / prop) * 100).toFixed(0) : 0}%（拒 ${calib.rejected}） | ${calib.rejected <= calib.atoms * 0.3 ? "✅" : "⚠️ 需逐条看被拒明细判断是否误杀"} |`);
L.push(`| 7 | system prompt 跨批哈希一致 | 100% | 单元验证已证字节稳定；格式重跑 ${calib.oneStage?.retriedBatches ?? 0} 次 | ✅ |`);
const lineCount = compById.size;
const fbN = calib.compress?.fallback ?? 0;
const fbRate = lineCount ? fbN / lineCount : 0;
L.push(`| 8 | 压缩 fail-safe | fallback <5%（透传是设计内的保守行为，不为 0 才算正常） | 透传 ${fbN} 条 / ${lineCount} 行 = **${(fbRate * 100).toFixed(1)}%**；净收益不足不压 ${calib.compress?.noGain ?? 0} 条；压缩比 ${calib.compress?.ratio ?? 0} | ${fbRate < 0.05 ? "✅" : "⚠️ 偏高，按 §3.1.1 调大上限"} |`);
L.push(`| 9 | 摘抄率分布 | 中位 <40%、被拦 <10% | 中位 ${(median * 100).toFixed(0)}%、超阈 ${over.length} 张 | ${median < 0.4 && over.length === 0 ? "✅" : "⚠️"} |`);
// #10 工具事件进得来的比例：§3.1.4 两个 bug 的回归防线（它们曾让整类内容静默消失，而其他指标看起来全正常）
const toolResultEntries = entries.filter((e) => (e.message as { role?: string } | undefined)?.role === "toolResult").length;
const serializedToolLines = [...compById.values()].filter((t) => t.startsWith("[Tool ")).length;
const assistantToolCalls = entries.reduce((n, e) => {
  const c = (e.message as { role?: string; content?: unknown } | undefined);
  if (c?.role !== "assistant" || !Array.isArray(c.content)) return n;
  return n + (c.content as { type?: string }[]).filter((b) => ["toolCall", "tool-call", "tool_call"].includes(String(b?.type))).length;
}, 0);
const intakeOk = serializedToolLines >= toolResultEntries && (assistantToolCalls === 0 || serializedToolLines > 0);
L.push(`| 10 | **工具事件进得来的比例**（硬性工程不变式） | 工具结果 100% 被序列化；助手消息里的 tool-call 块 100% 被序列化 | 工具结果 entry ${toolResultEntries} 条 → 序列化 \`[Tool …]\` 行 ${serializedToolLines} 条；助手 tool-call 块 ${assistantToolCalls} 个 | ${intakeOk ? "✅" : "❌ 有工具内容没进模型输入"} |`);
L.push(``);
L.push(`> **哪些是验收项、哪些只是观测项（2026-11-12 决议）**：跨轮方差实测显著——同一条会话、同一份代码跑两次，落库张数 49 vs 54、带 pending_fields 5 vs 14、非逐字 2 vs 7、单个探针的命中都会翻转。`);
L.push(`> 所以**只有 #1 探针召回是验收主指标**（跨轮可比，且未命中必须逐条查清归属）；#5 盲评摘要率是人工验收项；`);
L.push(`> 其余比率（类型分布、准入通过率、摘抄率、非逐字率、pending_fields 率）**一律降为观测指标**，单轮数字不用于下结论。`);
L.push(`> #7 #8 #10 是硬性的工程不变式（prompt 字节稳定、fail-safe 比例、工具事件进得来的比例），不受方差影响，仍按阈值判。`);
L.push(``);
L.push(`---`);
L.push(``);
L.push(`**其他观测**：出卡 ${calib.atoms} 张｜类型分布 ${JSON.stringify(calib.byType)}｜申请回读 ${calib.oneStage?.needContext ?? 0} 次（0 说明按需回读可继续押后）｜中断 ${calib.stopped ?? "无"}`);

writeFileSync(outPath, L.join("\n") + "\n");
console.log(`已生成 ${outPath}（${L.length} 行）`);
console.log(`卡片 ${rows.length} 张｜接地合格 ${gOk}｜摘抄率中位 ${(median * 100).toFixed(0)}%｜超阈 ${over.length}｜drop ${drops.length} 条`);
