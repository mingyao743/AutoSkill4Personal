#!/usr/bin/env node
/**
 * 离线抽取 CLI（P0）：
 *   scripts/extract.ts <session.jsonl | 目录> [选项]
 *
 * 流程：读 session.jsonl → 内存切窗(user msg 对齐) → 跳过已抽窗口(从 atoms.jsonl 派生)
 *      → extractWindow(lib/extract-core 共享引擎) → 幂等去重 → atoms.jsonl(draft)
 *
 * 选项：
 *   --dry              只跑不写（验证用）
 *   --model <id>       抽取模型（默认 ~/.pi/agent/settings.json 的主模型）
 *   --limit <n>        本次最多处理窗口数（控成本）
 *   --window-entries <n>  每窗最大消息数（默认 100）
 *   --max-chars <n>    每窗字符预算（默认 80000）
 *   --show-prompt      打印首个窗口的序列化文本前 2000 字符后退出（调试）
 *
 * 运行：node --experimental-strip-types scripts/extract.ts <...>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { buildWindows, parseSession } from "../lib/window.ts";
import { serializeEntries } from "../lib/serialize.ts";
import { buildSystemPrompt, buildSkillFeedbackSystemPrompt, buildSkillFeedbackUserPrompt, loadCatalog, windowMentionsSkill } from "../lib/prompt.ts";
import { acceptedOnly, extractWindow } from "../lib/extract-core.ts";
import {
  appendAtoms, existingAtomIds, extractedWindowIds, logError,
} from "../lib/atom-store.ts";
import { appendUsage, existingUsageKeys, type UsageEvent } from "../lib/usage-store.ts";
import { chatComplete, extractJsonFromText } from "../lib/llm.ts";


// ---------- 辅助函数 ----------
const readLines = (p: string): string[] => readFileSync(p, "utf8").split("\n");

/** 文件名 → 8 位短 session id（如 01a0aef7） */
function sessionIdFromFile(filename: string): string {
  const m = filename.match(/_([0-9a-f]{8})-[0-9a-f]{4}-/);
  if (m) return m[1];
  return filename.replace(/\.jsonl$/, "").replace(/[^0-9a-f]/g, "").slice(0, 8) || "unknown";
}

// ---------- 参数 ----------
const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const next = args[i + 1];
    if (next && !next.startsWith("--")) { flags.set(a, next); i++; }
    else flags.set(a, "true");
  } else positional.push(a);
}
const dryRun = flags.get("--dry") === "true";
const limit = flags.has("--limit") ? Number(flags.get("--limit")) : Infinity;
const model = flags.get("--model");
const windowEntries = flags.has("--window-entries") ? Number(flags.get("--window-entries")) : 100;
const maxChars = flags.has("--max-chars") ? Number(flags.get("--max-chars")) : 80_000;

if (positional.length === 0) {
  console.error("用法: node --experimental-strip-types scripts/extract.ts <session.jsonl | 目录> [--dry] [--limit n] [--model id]");
  process.exit(1);
}

// ---------- session 文件收集 ----------
const files: string[] = [];
for (const p of positional) {
  const st = statSync(p);
  if (st.isDirectory()) {
    files.push(
      ...readdirSync(p)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(p, f))
    );
  } else files.push(p);
}
files.sort();

// ---------- 主流程 ----------
const catalog = loadCatalog();
const systemPrompt = buildSystemPrompt(catalog);
const doneWindows = extractedWindowIds();
const knownAtomIds = existingAtomIds();

let totalAtoms = 0, totalDropped = 0, totalSkippedWindows = 0, totalFeedback = 0, feedbackScanned = 0;
const categoryCounts: Record<string, number> = {};

/** skill 反馈判定（usage 审计）：窗口含 SKILL.md 字样才扫，结果追加 usage.jsonl */
async function scanSkillFeedback(
  windowText: string,
  windowId: string,
  sessionId: string,
  model?: string,
): Promise<number> {
  if (!windowMentionsSkill(windowText)) return 0; // 零成本跳过
  let text: string;
  try {
    const res = await chatComplete({
      system: buildSkillFeedbackSystemPrompt(),
      user: buildSkillFeedbackUserPrompt(windowText),
      model,
    });
    text = res.text;
  } catch (e) {
    logError(`[${windowId}] skill反馈扫描 LLM失败: ${String(e).slice(0, 200)}`);
    return 0;
  }
  const jsonStr = extractJsonFromText(text);
  if (!jsonStr) return 0;
  let verdicts: { skill?: string; verdict?: string; evidence?: string }[] = [];
  try {
    const obj = JSON.parse(jsonStr) as { verdicts?: unknown };
    verdicts = Array.isArray(obj.verdicts)
      ? (obj.verdicts.filter((v) => typeof v === "object" && v !== null) as typeof verdicts)
      : [];
  } catch {
    return 0;
  }
  const known = existingUsageKeys();
  const events: UsageEvent[] = [];
  for (const v of verdicts) {
    if (!v.skill || (v.verdict !== "accepted" && v.verdict !== "rejected")) continue; // unclear 不落账
    const ev: UsageEvent = {
      ts: new Date().toISOString(),
      session: sessionId,
      window_id: windowId,
      skill: v.skill.trim(),
      event: v.verdict,
      evidence: (v.evidence ?? "").slice(0, 200),
    };
    // 幂等：同 window_id+skill+event 已存在则跳过
    if (known.has(`${windowId}|${ev.skill}|${ev.event}`)) continue;
    known.add(`${windowId}|${ev.skill}|${ev.event}`);
    events.push(ev);
  }
  if (events.length) appendUsage(events);
  return events.length;
}

for (const file of files) {
  const sessionId = sessionIdFromFile(basename(file));
  const entries = parseSession(readLines(file));
  const windows = buildWindows(entries, sessionId, { maxEntries: windowEntries, maxChars });
  const pending = windows.filter((w) => !doneWindows.has(w.window_id));
  totalSkippedWindows += windows.length - pending.length;
  console.log(`\n=== ${sessionId} (${basename(file)})`);
  console.log(`消息 ${entries.length} 条 → ${windows.length} 窗（已抽 ${windows.length - pending.length}，待抽 ${pending.length}）`);
  if (pending.length === 0) continue;

  if (flags.get("--show-prompt") === "true") {
    console.log("--- 序列化预览 ---");
    console.log(serializeEntries(pending[0].entries).slice(0, 2000));
    console.log("--- 系统提示词 ---");
    console.log(systemPrompt.slice(0, 2000));
    process.exit(0);
  }

  let processed = 0;
  for (const w of pending) {
    if (processed >= limit) break;
    processed++;

    const result = await extractWindow(w, catalog, { systemPrompt, model, extractedBy: "offline-pipeline" });

    if (!result.ok) {
      console.error(`  [${w.window_id}] ${result.error}`);
      logError(`${w.window_id} ${result.error}: ${result.rawPreview ?? ""}`);
      continue;
    }

    for (const r of result.rejected) {
      totalDropped++;
      console.error(`  [${w.window_id}] 原子被拒: ${r.reason.slice(0, 200)}`);
      logError(`${w.window_id} 原子被拒(${r.reason}): ${JSON.stringify(r.atom).slice(0, 500)}`);
    }

    const accepted = acceptedOnly(result, knownAtomIds);
    if (accepted.length > 0) {
      doneWindows.add(w.window_id);
      if (!dryRun) appendAtoms(accepted);
    }
    for (const a of accepted) {
      totalAtoms++;
      categoryCounts[a.category] = (categoryCounts[a.category] ?? 0) + 1;
    }
    const total = result.atoms.length + result.rejected.length;
    console.log(`  [${w.window_id}] ${w.entry_count} 条消息 → 抽取 ${total}，入库 ${accepted.length}，拒 ${result.rejected.length}`);

    // skill 反馈扫描（原子抽取成功后追加 pass；--dry 时只计数不写账）
    feedbackScanned++;
    const nVerdicts = await scanSkillFeedback(serializeEntries(w.entries), w.window_id, sessionId, model);
    totalFeedback += nVerdicts;
    if (nVerdicts > 0) console.log(`    └─ skill 反馈: ${nVerdicts} 条判定${dryRun ? "（dry 不写）" : ""}`);
  }
}

// ---------- 汇总 ----------
console.log(`\n========== 汇总 ==========`);
console.log(`窗口跳过(已抽): ${totalSkippedWindows}`);
console.log(`原子入库: ${totalAtoms}（dry=${dryRun}），被拒: ${totalDropped}`);
console.log(`skill 反馈扫描: 扫了 ${feedbackScanned} 窗，判定入库 ${totalFeedback} 条`);
for (const c of Object.keys(categoryCounts).sort()) {
  const cat = catalog.find((x) => x.category === c);
  console.log(`  ${c} ${cat?.name ?? ""}: ${categoryCounts[c]}`);
}
if (totalAtoms === 0 && totalDropped === 0) console.log("(无产出——检查 errors.log)");
