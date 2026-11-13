#!/usr/bin/env node
/**
 * 统一触发逻辑回归：shouldExtractOnTurn / unreviewedUserTurns / EXTRACT_EVERY_N_TURNS。
 * 不调模型、不写库，纯内存验证"每 N 个未审 user 轮才抽"的 stateless 闸。
 *
 * 跑法：node --experimental-strip-types packages/core/scripts/smoke-turn-trigger.ts
 *
 * 用例来历：capture_knowledge/kb_harvest 去掉后，全 agent 统一成"每 N 轮自动抽"，
 * 闸逻辑在 core 一份（pi before_agent_start + dsh dispatchPipeline 共用）。改
 * capture-orchestration.ts 的 shouldExtractOnTurn / EXTRACT_EVERY_N_TURNS 前先跑。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldExtractOnTurn, unreviewedUserTurns, EXTRACT_EVERY_N_TURNS,
} from "../lib/capture-orchestration.ts";
import type { MessageEntry } from "../lib/base/types.ts";

// 确定性：指向空临时目录，loadAtoms() 返回 [] → coveredIds 空 → 所有 user 消息都算未审
process.env.AUTOSKILL_DATA_DIR = mkdtempSync(join(tmpdir(), "autoskill-smoke-turn-"));

let pass = 0;
let fail = 0;
const t = (name: string, cond: boolean, extra = ""): void => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const E = (id: string, role: string): MessageEntry => ({
  type: "message", id, parentId: null, timestamp: "2026-11-13T10:00:00Z",
  message: { role, content: [{ type: "text", text: "x" }] as never },
} as MessageEntry);

// 造 N 个 user 轮（每轮 user + assistant 一对）
const userTurns = (n: number): MessageEntry[] => {
  const out: MessageEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(E(`u${i}`, "user"));
    out.push(E(`a${i}`, "assistant"));
  }
  return out;
};

const SID = "smoke-test-session"; // 无 atom 引用 → coveredIds 空

console.log("\n--- 统一触发：每 N 个未审 user 轮抽一次 ---");

t("EXTRACT_EVERY_N_TURNS 默认 30", EXTRACT_EVERY_N_TURNS === 30, `(got ${EXTRACT_EVERY_N_TURNS})`);

t("unreviewedUserTurns 只数 user（5 user + 5 assistant → 5）",
  unreviewedUserTurns(userTurns(5), SID) === 5);

t("unreviewedUserTurns 全 assistant → 0",
  unreviewedUserTurns([E("a1", "assistant"), E("a2", "assistant")], SID) === 0);

t("unreviewedUserTurns 空数组 → 0", unreviewedUserTurns([], SID) === 0);

t("5 轮 < N=30 → 不抽 (pending=5)",
  shouldExtractOnTurn(userTurns(5), SID).extract === false &&
  shouldExtractOnTurn(userTurns(5), SID).pending === 5);

t("29 轮 < N=30 → 不抽（边界）",
  shouldExtractOnTurn(userTurns(29), SID).extract === false);

t("30 轮 = N=30 → 抽（边界命中）",
  shouldExtractOnTurn(userTurns(30), SID).extract === true &&
  shouldExtractOnTurn(userTurns(30), SID).pending === 30);

t("35 轮 > N=30 → 抽（catch-up，pending=35）",
  shouldExtractOnTurn(userTurns(35), SID).extract === true &&
  shouldExtractOnTurn(userTurns(35), SID).pending === 35);

t("自定义 N=10：10 轮命中",
  shouldExtractOnTurn(userTurns(10), SID, 10).extract === true);

t("自定义 N=10：9 轮不命中",
  shouldExtractOnTurn(userTurns(9), SID, 10).extract === false);

t("N=0 → 不抽（n>0 守卫，防除零/失控）",
  shouldExtractOnTurn(userTurns(30), SID, 0).extract === false);

t("threshold 回传配置值",
  shouldExtractOnTurn(userTurns(5), SID, 10).threshold === 10);

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
