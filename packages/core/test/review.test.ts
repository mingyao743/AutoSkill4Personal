/** 待确认队列：去重、排序、策略放行、7 天升级、通知限流 */
import { mkdtempSync, existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  addPending, listPending, removePending, countPending, requiresDecision,
  pendingByKind, dedupeKey, kindLabel, isAllowed, allowItem, resetPolicy,
  readPolicy, stalePending, pendingSummary, ESCALATE_AFTER_DAYS,
  type PendingItem,
} from "../lib/review/pending.ts";
import {
  shouldNotify, readNotifyState, writeNotifyState, today, summarize,
  MAX_PER_DAY, NOTIFY_KINDS, detectNotifier,
} from "../lib/review/notify.ts";
import { renderItem, canDiff, applyItem, isInteractive } from "../lib/review/review.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-rv-"));

function item(over: Partial<PendingItem> = {}): PendingItem {
  return {
    kind: "skill-overwrite",
    created_at: new Date().toISOString(),
    severity: "high",
    title: "技能推送会覆盖线上",
    detail: { skill: "qdoc", from: 3, to: 4, files: 7 },
    action: {
      cli: "ow sync --direction push --only qdoc --yes",
      reversible: false,
      effect: "平台上的 qdoc 会被本地版本覆盖，无法回滚",
    },
    ...over,
  };
}

section("入队与读取");
{
  const v = tmp();
  eq(countPending(v), 0, "空队列");
  const f = addPending(v, item());
  ok(existsSync(f), "文件已建");
  eq(countPending(v), 1, "一条");
  const list = listPending(v);
  eq(list[0].kind, "skill-overwrite", "kind 正确");
  eq(list[0].detail.skill, "qdoc", "detail 保留");
  ok(list[0].file.startsWith(v), "带文件路径");
  rmSync(v, { recursive: true, force: true });
}

section("去重：同 kind + 同目标只留一条");
{
  const v = tmp();
  addPending(v, item());
  addPending(v, item());          // 同一条再来
  eq(countPending(v), 1, "重复入队不累积");

  addPending(v, item({ detail: { skill: "other" } }));
  eq(countPending(v), 2, "不同目标各留一条");
  rmSync(v, { recursive: true, force: true });
}

section("去重键：按 kind + 目标");
{
  eq(dedupeKey(item()), "skill-overwrite::qdoc", "技能类按 skill");
  eq(dedupeKey(item({ kind: "doc-conflict", detail: { path: "a.md" } })), "doc-conflict::a.md", "文档类按 path");
  eq(dedupeKey(item({ kind: "budget-exhausted", detail: {} })), "budget-exhausted::", "无目标");
}

section("排序：high 在前，同级别新的在前");
{
  const v = tmp();
  const now = Date.now();
  addPending(v, item({ severity: "low", detail: { skill: "low1" }, created_at: new Date(now).toISOString() }));
  addPending(v, item({ severity: "high", detail: { skill: "hi-old" }, created_at: new Date(now - 1000).toISOString() }));
  addPending(v, item({ severity: "high", detail: { skill: "hi-new" }, created_at: new Date(now + 1000).toISOString() }));
  addPending(v, item({ severity: "normal", detail: { skill: "mid" }, created_at: new Date(now).toISOString() }));

  const order = listPending(v).map((e) => e.detail.skill);
  eq(order, ["hi-new", "hi-old", "mid", "low1"], "high 优先且新的在前");
  rmSync(v, { recursive: true, force: true });
}

section("只问不可回滚的");
{
  const v = tmp();
  addPending(v, item({ detail: { skill: "a" }, action: { reversible: false } }));
  addPending(v, item({ kind: "skill-pending-enable", detail: { skill: "b" }, action: { reversible: true } }));
  eq(countPending(v), 2, "队列两条都在");
  eq(requiresDecision(v).length, 1, "但只有一条需要人决策");
  eq(requiresDecision(v)[0].detail.skill, "a", "是需要决策那条");
  rmSync(v, { recursive: true, force: true });
}

section("按 kind 统计");
{
  const v = tmp();
  addPending(v, item({ detail: { skill: "a" } }));
  addPending(v, item({ detail: { skill: "b" } }));
  addPending(v, item({ kind: "skill-conflict", detail: { skill: "c" }, action: { reversible: true } }));
  const byKind = pendingByKind(v);
  eq(byKind["skill-overwrite"], 2, "覆盖类 2 条");
  eq(byKind["skill-conflict"], 1, "冲突类 1 条");
  rmSync(v, { recursive: true, force: true });
}

section("kind 标签");
{
  eq(kindLabel("skill-overwrite"), "技能推送会覆盖线上", "已知类型");
  eq(kindLabel("unknown" as never), "unknown", "未知类型回退原值");
}

section("策略：单条放行");
{
  const v = tmp();
  const it = item();
  ok(!isAllowed(v, it), "默认不放行");
  allowItem(v, it, "item");
  ok(isAllowed(v, it), "放行后生效");
  ok(!isAllowed(v, item({ detail: { skill: "other" } })), "其他目标仍会问");
  rmSync(v, { recursive: true, force: true });
}

section("策略：整类放行");
{
  const v = tmp();
  allowItem(v, item(), "kind");
  ok(isAllowed(v, item({ detail: { skill: "any" } })), "整类都放行");
  ok(!isAllowed(v, item({ kind: "doc-conflict", detail: { path: "x" } })), "其他类型不受影响");
  rmSync(v, { recursive: true, force: true });
}

section("策略：重置");
{
  const v = tmp();
  allowItem(v, item(), "kind");
  allowItem(v, item({ detail: { skill: "b" } }), "item");
  resetPolicy(v);
  const p = readPolicy(v);
  eq(p.allow, [], "单条清空");
  eq(p.allowKinds, [], "整类清空");
  rmSync(v, { recursive: true, force: true });
}

section("7 天升级");
{
  const v = tmp();
  addPending(v, item({ detail: { skill: "old" }, created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() }));
  addPending(v, item({ detail: { skill: "new" } }));
  eq(stalePending(v, 7).map((e) => e.detail.skill), ["old"], "10 天前那条超期");
  eq(stalePending(v, 30).length, 0, "30 天阈值下都不超期");
  eq(ESCALATE_AFTER_DAYS, 7, "默认 7 天");
  rmSync(v, { recursive: true, force: true });
}

section("队列摘要");
{
  const v = tmp();
  eq(pendingSummary(v), "没有待确认事项", "空");
  addPending(v, item({ detail: { skill: "a" }, action: { reversible: false } }));
  addPending(v, item({ kind: "skill-conflict", detail: { skill: "b" }, action: { reversible: true } }));
  const s = pendingSummary(v);
  ok(s.includes("2 项"), "总数");
  ok(s.includes("1 项需人决策"), "需决策数");
  rmSync(v, { recursive: true, force: true });
}

section("移除条目");
{
  const v = tmp();
  addPending(v, item());
  const e = listPending(v)[0];
  removePending(e);
  eq(countPending(v), 0, "已移除");
  ok(!existsSync(e.file), "文件已删");
  rmSync(v, { recursive: true, force: true });
}

section("坏文件被隔离");
{
  const v = tmp();
  addPending(v, item());
  const dir = join(v, ".ow", "pending");
  writeFileSync(join(dir, "broken.json"), "{不是 json", "utf8");
  const list = listPending(v);
  eq(list.length, 1, "坏文件不算条目");
  ok(readdirSync(dir).some((f) => f.includes(".corrupt-")), "坏文件已改名隔离");
  rmSync(v, { recursive: true, force: true });
}

// ---------------- 通知 ----------------

section("通知：只报 high 且限流");
{
  const st = { date: today(), count: 0, sent: [] };
  eq(shouldNotify(item(), st, true).should, true, "high + 开启 → 通知");
  eq(shouldNotify(item(), st, false).should, false, "关闭 → 不通知");
  eq(shouldNotify(item({ severity: "normal" }), st, true).should, false, "normal → 不通知");
  eq(shouldNotify(item({ kind: "gate-rejected" }), st, true).should, false, "非白名单类型 → 不通知");

  const full = { date: today(), count: MAX_PER_DAY, sent: [] };
  ok(!shouldNotify(item(), full, true).should, "超日限 → 不通知");

  const dup = { date: today(), count: 1, sent: ["skill-overwrite::qdoc"] };
  ok(!shouldNotify(item(), dup, true).should, "同类已发 → 不通知");
}

section("通知：跨天重置");
{
  const v = tmp();
  writeNotifyState(v, { date: "2020-01-01", count: 3, sent: ["x"] });
  const st = readNotifyState(v);
  eq(st.count, 0, "跨天计数归零");
  eq(st.sent, [], "跨天记录清空");
  rmSync(v, { recursive: true, force: true });
}

section("通知：正文简短");
{
  const s = summarize(item());
  ok(s.includes("qdoc"), "含技能名");
  ok(s.includes("v3→v4"), "含版本变化");
  ok(s.includes("ow review"), "指引到 review");
  ok(s.length < 80, "足够短");
}

section("通知白名单只有两类");
{
  eq([...NOTIFY_KINDS].sort(), ["budget-exhausted", "skill-overwrite"], "只有这两类值得打断人");
}

section("通知工具探测不抛错");
{
  const n = detectNotifier();
  ok(n === null || typeof n.cmd === "string", "返回 null 或命令名");
}

// ---------------- 渲染与执行 ----------------

section("渲染：显示关键信息与按键");
{
  const e = { ...item(), file: "/x" };
  const s = renderItem(e, 0, 3);
  ok(s.includes("1/3"), "显示序号");
  ok(s.includes("qdoc"), "技能名");
  ok(s.includes("v3 → v4"), "版本变化");
  ok(s.includes("7 个文件"), "文件数");
  ok(s.includes("[a] 应用"), "应用键");
  ok(s.includes("[s] 跳过"), "跳过键");
  ok(s.includes("[x] 不再问"), "记住键");
  ok(s.includes("应用后"), "说明后果");
}

section("渲染：可回滚的条目不显示「应用后」");
{
  const e = { ...item({ action: { reversible: true } }), file: "/x" };
  ok(!renderItem(e, 0, 1).includes("应用后"), "无副作用就不吓人");
}

section("canDiff：只有带 diff 的覆盖类");
{
  ok(canDiff({ ...item({ detail: { skill: "a", diff: "-旧 +新" } }), file: "/x" }), "有 diff");
  ok(!canDiff({ ...item({ detail: { skill: "a" } }), file: "/x" }), "无 diff");
  ok(!canDiff({ ...item({ kind: "skill-pending-enable", detail: { diff: "x" } }), file: "/x" }), "非覆盖类不给 diff");
}

section("applyItem：拒绝非 ow 命令");
{
  const r = applyItem({ ...item({ action: { cli: "rm -rf /", reversible: false } }), file: "/x" });
  eq(r.ok, false, "拒绝执行");
  ok(r.error?.includes("拒绝"), "报出原因");
}

section("applyItem：无命令时报错不崩");
{
  const r = applyItem({ ...item({ action: { reversible: false } }), file: "/x" });
  eq(r.ok, false, "没有命令");
}

section("文件名唯一：同毫秒同类不互相覆盖");
{
  const v = tmp();
  // 连续快速入队 10 条同类不同目标
  for (let i = 0; i < 10; i++) {
    addPending(v, item({ detail: { skill: `s${i}` } }));
  }
  eq(countPending(v), 10, "10 条全在（同毫秒也不覆盖）");
  const names = readdirSync(join(v, ".ow", "pending"));
  eq(new Set(names).size, 10, "文件名各不相同");
  rmSync(v, { recursive: true, force: true });
}

section("isInteractive：CI 环境下为 false");
{
  const old = process.env.CI;
  process.env.CI = "1";
  eq(isInteractive(), false, "CI 里不交互");
  if (old === undefined) delete process.env.CI; else process.env.CI = old;
}

process.exit(summary());
