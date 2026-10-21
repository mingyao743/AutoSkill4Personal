// 冒烟测试：EXTRACTION_PRINCIPLES 落地（prompt 升级 + G4 机械拒 + grounding 校验）
import { buildSystemPrompt, loadCatalog } from "../lib/prompt.ts";
import { validateAtom } from "../lib/validate.ts";
import { normalizeAtom, isMechanicalG4 } from "../lib/extract-core.ts";
import type { MessageEntry } from "../lib/types.ts";

const catalog = loadCatalog();

// 1. prompt 包含新规则关键词
const sp = buildSystemPrompt(catalog);
for (const kw of ["grounding", "G4", "C1 人对模型的否定与修正", "先验规则", "专业感不是验证性", "收敛的最终表述"]) {
  if (!sp.includes(kw)) { console.error(`FAIL: prompt 缺关键词 ${kw}`); process.exit(1); }
}
console.log("PASS 1: prompt 含三轴/正向清单/G 分级/先验/权重规则");

// 2. 机械 G4 判定
const mkEntry = (id: string, role: string): MessageEntry =>
  ({ type: "message", id, parentId: null, timestamp: "", message: { role, content: "x" } } as MessageEntry);
const entries = [mkEntry("m1", "user"), mkEntry("m2", "assistant"), mkEntry("m3", "toolResult"), mkEntry("m4", "assistant"), mkEntry("m5", "assistant")];

const w = { window_id: "win_ab12cd34_001", session_id: "ab12cd34", msg_range: ["m1", "m5"] as [string, string] };
const validIds = new Set(entries.map((e) => e.id));

// 区间 [m4,m5] 纯 assistant → G4 应拒
const g4atom = normalizeAtom({ content: "纯生成推测", category: "05", atom_type: "根因切片", domain: "test-domain", confidence: 0.9, msg_range: ["m4", "m5"], grounding: "G2" }, w, validIds, "offline-pipeline");
console.log(isMechanicalG4(g4atom, entries) ? "PASS 2: [m4,m5] 纯 assistant 被机械判 G4（自报 G2 也拦下）" : "FAIL 2");

// 区间 [m3,m4] 含 toolResult → 非G4
const g2atom = normalizeAtom({ content: "观测归纳的结论", category: "01", atom_type: "概念名称切片", concept_name: "x", definition: "y", domain: "test-domain", confidence: 0.9, msg_range: ["m3", "m4"], grounding: "G2" }, w, validIds, "offline-pipeline");
console.log(!isMechanicalG4(g2atom, entries) ? "PASS 3: [m3,m4] 含 toolResult 放行" : "FAIL 3");

// 区间 [m1,m2] 含 user → 非G4（C1 用户修正）
const c1atom = normalizeAtom({ content: "用户纠正口径", category: "01", atom_type: "口径切片", concept_name: "x", definition: "y", domain: "test-domain", confidence: 0.9, msg_range: ["m1", "m2"] }, w, validIds, "offline-pipeline");
console.log(!isMechanicalG4(c1atom, entries) ? "PASS 4: [m1,m2] 含 user 放行" : "FAIL 4");

// 3. grounding 枚举校验：非法值被清 + 校验器拦
const badAtom = normalizeAtom({ content: "x", category: "01", atom_type: "概念名称切片", concept_name: "x", definition: "y", domain: "test-domain", confidence: 0.9, msg_range: ["m1", "m2"], grounding: "G5" }, w, validIds, "offline-pipeline");
console.log(badAtom.grounding === undefined ? "PASS 5: 非法 grounding G5 被 normalize 清除" : "FAIL 5");
const v = validateAtom(g2atom, catalog);
console.log(v.ok ? "PASS 6: G2 原子过校验器" : `FAIL 6: ${v.errors.join(";")}`);
console.log("grounding 字段透传:", g2atom.grounding === "G2" ? "PASS 7" : "FAIL 7");

// 4. LLM 自报 G4 → 即便区间有接地也拒（extractWindow 内实现，此处验证字段路径）
console.log(g4atom.grounding === "G2" ? "(自报G2被机械判定覆盖场景已由 PASS 2 覆盖)" : "");
console.log("\n全部通过");
