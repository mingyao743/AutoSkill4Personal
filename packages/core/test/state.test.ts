/** 水位线与机器预算 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  readState, writeState, getSessionState, advanceState, sessionKey, statePath,
} from "../lib/trigger/state.ts";
import { checkBudget, recordUsage, readMachineState, machineStatePath } from "../lib/trigger/budget.ts";

section("水位线：读写与推进");
{
  const v = mkdtempSync(join(tmpdir(), "qdoc-st-"));
  eq(readState(v).sessions, {}, "初始为空");

  const key = sessionKey("dsh", "s1");
  eq(key, "dsh:s1", "会话键带宿主前缀");
  eq(getSessionState(v, key).compiled_to_turn, 0, "未编译过从 0 开始");

  advanceState(v, key, { compiled_to_turn: 30, compiled_to_seq: 120, pages: 3 });
  eq(getSessionState(v, key).compiled_to_turn, 30, "推进到 30");
  eq(getSessionState(v, key).pages, 3, "页数累加");

  advanceState(v, key, { compiled_to_turn: 60, pages: 2 });
  eq(getSessionState(v, key).compiled_to_turn, 60, "再推进到 60");
  eq(getSessionState(v, key).pages, 5, "页数继续累加");

  // 水位不回退
  advanceState(v, key, { compiled_to_turn: 45 });
  eq(getSessionState(v, key).compiled_to_turn, 60, "水位不回退（取 max）");

  rmSync(v, { recursive: true, force: true });
}

section("水位线：多会话互不影响");
{
  const v = mkdtempSync(join(tmpdir(), "qdoc-st2-"));
  advanceState(v, sessionKey("dsh", "a"), { compiled_to_turn: 30 });
  advanceState(v, sessionKey("pi", "a"), { compiled_to_turn: 90 });
  eq(getSessionState(v, sessionKey("dsh", "a")).compiled_to_turn, 30, "dsh 会话水位独立");
  eq(getSessionState(v, sessionKey("pi", "a")).compiled_to_turn, 90, "pi 同名会话水位独立");
  rmSync(v, { recursive: true, force: true });
}

section("水位线：损坏文件挪走留证");
{
  const v = mkdtempSync(join(tmpdir(), "qdoc-st3-"));
  mkdirSync(join(v, ".ow"), { recursive: true });
  writeFileSync(statePath(v), "{ 这不是合法 JSON", "utf8");
  eq(readState(v).sessions, {}, "损坏时返回空");
  // 应留下 .corrupt-* 文件
  const files = readdirSync(join(v, ".ow"));
  ok(files.some((f) => f.includes(".corrupt-")), "损坏文件被挪走留证");
  rmSync(v, { recursive: true, force: true });
}

section("机器预算：日累计与上限");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-bud-"));
  process.env.QDOC_MACHINE_DIR = dir;

  const b0 = checkBudget();
  ok(b0.allowed, "初始可用");
  eq(b0.used.compiles, 0, "初始 0 次");

  recordUsage({ inputTokens: 1000, outputTokens: 500, vault: "/a" });
  const b1 = checkBudget();
  eq(b1.used.compiles, 1, "记 1 次");
  eq(b1.used.tokens, 1500, "token 累加");

  recordUsage({ inputTokens: 2000, outputTokens: 1000, vault: "/a" });
  recordUsage({ inputTokens: 500, outputTokens: 200, vault: "/b" });
  const st = readMachineState();
  eq(st.budget.by_vault["/a"], 2, "按 vault 分摊 a");
  eq(st.budget.by_vault["/b"], 1, "按 vault 分摊 b");

  // 次数上限
  const b2 = checkBudget({ maxCompiles: 3 });
  ok(!b2.allowed && b2.reason === "daily-compiles", "达到次数上限被拒");

  // token 上限
  const b3 = checkBudget({ maxCompiles: 100, maxTokens: 1000 });
  ok(!b3.allowed && b3.reason === "daily-tokens", "达到 token 上限被拒");

  rmSync(dir, { recursive: true, force: true });
}

section("机器预算：跨天归零");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-bud2-"));
  process.env.QDOC_MACHINE_DIR = dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(machineStatePath(), JSON.stringify({
    schema: 1,
    budget: { date: "2020-01-01", compiles: 99, input_tokens: 999999, output_tokens: 0, by_vault: {} },
  }), "utf8");
  const b = checkBudget();
  ok(b.allowed, "旧日期自动归零");
  eq(b.used.compiles, 0, "次数归零");
  rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
