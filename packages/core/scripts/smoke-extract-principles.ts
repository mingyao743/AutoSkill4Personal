// 冒烟测试：存的分诊层（8 类型 / 准入规则 / 类型推导 / 窗口 id 唯一性）
// 运行：node --experimental-strip-types packages/core/scripts/smoke-extract-principles.ts
import { buildSystemPrompt } from "../lib/extract/prompt.ts";
import { validateAtom } from "../lib/extract/validate.ts";
import { normalizeAtom, isMechanicalG4 } from "../lib/extract/extract-core.ts";
import {
  DOC_TYPES, categoryForType, keepAsForType, admissionGate, declaredSource,
} from "../lib/base/admission.ts";
import { buildWindows } from "../lib/extract/window.ts";
import type { MessageEntry } from "../lib/base/types.ts";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}${detail ? `：${detail}` : ""}`); failed++; }
};

// ---------- 1. prompt 契约 ----------
const sp = buildSystemPrompt();
ok(sp.includes("doc_type"), "prompt 要求 doc_type");
for (const t of DOC_TYPES) ok(sp.includes(t), `prompt 含类型 ${t}`);
ok(sp.includes("why") && sp.includes("不存会损失什么"), "prompt 强制 why");
ok(sp.includes("expires_when"), "prompt 要求失效条件");
ok(sp.includes("拆成"), "prompt 要求拆解");
ok(sp.includes("客户材料"), "prompt 承认工件类价值");
ok(!sp.includes("44 切片"), "prompt 不再注入 44 切片清单");

// ---------- 2. 类型表（8 个，查表推导） ----------
ok(DOC_TYPES.length === 8, "顶层类型 = 8");
const expect: Record<string, [string, string]> = {
  sop: ["02", "instruction"], spec: ["01", "instruction"], template: ["03", "instruction"],
  case: ["04", "reference"], postmortem: ["05", "instruction"], convention: ["01", "instruction"],
  index: ["01", "data"], rubric: ["01", "instruction"],
};
for (const t of DOC_TYPES) {
  const [cat, keep] = expect[t];
  ok(categoryForType(t) === cat && keepAsForType(t) === keep, `映射 ${t} → ${cat}/${keep}`);
}

// ---------- 3. 准入规则 ----------
const base = {
  content: "正常内容",
  sources: [declaredSource("01a1ae83-57bc-7377", "m1")],
  why: "不存的话下次还要重新排查一遍同样的环境问题",
  keep_as: "instruction",
};
ok(admissionGate(base, { requireWhy: true, hasGrounding: true }).ok, "准入规则放行合法知识卡片");
ok(!admissionGate({ ...base, sources: [] }, { requireWhy: true }).ok, "准入规则拒无来源");
ok(!admissionGate({ ...base, why: "有用" }, { requireWhy: true }).ok, "准入规则拒空价值理由");
ok(!admissionGate(base, { requireWhy: true, hasGrounding: false }).ok, "准入规则拒无接地（G4）");
ok(!admissionGate({ ...base, content: "key=sk-" + "a".repeat(24) }).ok, "准入规则拒 API key");
ok(admissionGate({ ...base, content: "联系 13812345678" }).ok, "instruction 不因手机号被拦");
ok(!admissionGate({ ...base, content: "联系 13812345678", keep_as: "data" }).ok, "data 类因 PII 被拦");

// ---------- 4. 类型推导（normalizeAtom） ----------
const mkEntry = (id: string, role: string): MessageEntry =>
  ({ type: "message", id, parentId: null, timestamp: "", message: { role, content: "x" } } as MessageEntry);
const entries = [
  mkEntry("m1", "user"), mkEntry("m2", "assistant"), mkEntry("m3", "toolResult"), mkEntry("m4", "assistant"),
];
const w = { window_id: "win_ab12cd34_001", session_id: "ab12cd34", msg_range: ["m1", "m4"] as [string, string] };
const validIds = new Set(entries.map((e) => e.id));

const sop = normalizeAtom(
  { doc_type: "sop", content: "先关服务再改配置", why: "顺序反了会丢未落盘数据", domain: "ops-test", confidence: 0.8, grounding: "G2", msg_range: ["m3", "m4"], step: "1. stop 2. edit 3. start" },
  w, validIds, "offline-pipeline",
);
ok(sop.category === "02" && sop.keep_as === "instruction", "sop → 02/instruction");
ok(sop.doc_type === "sop" && sop.atom_type.length > 0, "sop 带类型与兜底细标签");
ok(validateAtom(sop, []).ok, "合法 sop 过校验", validateAtom(sop, []).errors.join(";"));

const idx = normalizeAtom(
  { doc_type: "index", content: "导出入口在 src/export/web.ts", why: "每次都要重新翻目录才能找到", domain: "ops-test", confidence: 0.8, grounding: "G2", msg_range: ["m3", "m4"], concept_name: "导出入口", definition: "src/export/web.ts", expires_when: "目录重构后失效" },
  w, validIds, "offline-pipeline",
);
ok(idx.keep_as === "data" && idx.category === "01", "index → 01/data");

const badConv = normalizeAtom(
  { doc_type: "convention", content: "测试文件必须与源码同目录", why: "不遵守会导致 CI 找不到用例", domain: "ops-test", confidence: 0.8, grounding: "G3", msg_range: ["m3", "m4"], concept_name: "测试布局", definition: "同目录" },
  w, validIds, "offline-pipeline",
);
ok(!validateAtom(badConv, []).ok, "convention 缺 expires_when 被拒");

const conflict = normalizeAtom(
  { doc_type: "sop", category: "05", content: "先关服务再改配置", why: "顺序反了会丢未落盘数据", domain: "ops-test", confidence: 0.8, grounding: "G2", msg_range: ["m3", "m4"], step: "1. stop 2. edit" },
  w, validIds, "offline-pipeline",
);
ok(conflict.category === "02", "doc_type 覆盖模型自报的 category", conflict.category);

// ---------- 5. 机械 G4 仍生效 ----------
const pure = normalizeAtom(
  { doc_type: "spec", content: "纯 assistant 推演", why: "不知道有没有用但它看起来很重要", domain: "ops-test", confidence: 0.9, groundung: "G2", msg_range: ["m2", "m2"], concept_name: "x", definition: "y" },
  w, validIds, "offline-pipeline",
);
ok(isMechanicalG4(pure, entries), "[m2,m2] 纯 assistant 判 G4");

// ---------- 6. 窗口 id 唯一性（回归：dsh session-<uuid> 前缀撞车） ----------
const mk = (id: string): MessageEntry => mkEntry(id, "user");
const wa = buildWindows([mk("a1"), mk("a2")], "session-aaaaaaaa-1111-2222");
const wb = buildWindows([mk("b1"), mk("b2")], "session-bbbbbbbb-3333-4444");
ok(wa[0].window_id !== wb[0].window_id, "两个 dsh 会话窗口 id 不撞车", `${wa[0].window_id} vs ${wb[0].window_id}`);
ok(/^win_[a-f0-9]+_\d+$/.test(wa[0].window_id), "窗口 id 合法", wa[0].window_id);
const wp = buildWindows([mk("p1"), mk("p2")], "01a1ae83-57bc-7377-a262-c4aa8c012d9c");
ok(wp[0].window_id === "win_01a1ae83_001", "pi 会话窗口 id 保持不变（不破坏幂等）", wp[0].window_id);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
if (failed > 0) process.exit(1);
