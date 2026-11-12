/**
 * 知识管线：覆盖派生 → 一段式抽取 → 准入 → 落库 → 推进审阅水位。
 *
 * 设计约束（见 design/ONE_STAGE_EXTRACT.md、design/TRIGGER_PLAN.md）：
 *  - 按"批"推进：每批 = 一次 LLM 调用（检测 + 成卡 + 定性 + drop 记账）+ 准入 + 落库 + 写水位，
 *    整批成功才推进水位；预算/失败中断不写水位，下次从断点继续
 *  - 分批按轮次对齐：一轮对话绝不切开（lib/compress.ts batchByTurn）
 *  - veto 边界：模型声明 no_value 或给出空 cards + 完整 drops 是**行使否决权**，
 *    只记 drop 账、推进水位，绝不重跑追问；重跑只针对格式不合格（缺账/JSON 非法）
 *  - 不加锁重复跑：进程内 + 文件锁双保险
 *
 * 旧两段式（trigger-scan 发现候选 → knowledge-extract 写卡片）保留在 `twoStage: true` 后面，
 * 供对比期跑验收（design/ONE_STAGE_EXTRACT.md §八#3）；验收通过后删除。
 */
import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbDir, appendAtoms, existingAtomIds, loadAtoms, type KnowledgeAtom } from "./atom-store.ts";
import { coveredIds } from "./coverage.ts";
import { appendReviewed } from "./review-log.ts";
import { appendDrops, appendRejected } from "./drop-log.ts";
import {
  batchByTurn, compressStats, overlapTurn, serializeForExtract, type ExtractLine,
} from "./compress.ts";
import {
  cardToAtom, copyRatio, runOneStageBatch, quoteIsVerbatim, fillMissingSpecialized,
  type OneStageCard,
} from "./one-stage.ts";
import { admissionGate } from "./admission.ts";
import { validateAtom } from "./validate.ts";
import { isMechanicalG4 } from "./extract-core.ts";
// 旧两段式（twoStage 开关）
import { batchLines, scanBatch, serializeForScan, type ScanLine } from "./trigger-scan.ts";
import { extractCandidates } from "./knowledge-extract.ts";
import type { MessageEntry } from "./types.ts";

export type HarnessKind = "pi" | "dsh" | "cli";

export interface PipelineOptions {
  sessionId: string;
  entries: MessageEntry[];
  harness: HarnessKind;
  /** backfill 忽略覆盖，重扫全量 */
  mode?: "incremental" | "backfill";
  model?: string;
  /** 每批压缩后字符上限（默认 12000） */
  batchChars?: number;
  /** 本次最多处理几批 */
  maxBatches?: number;
  /** 总 token 预算 */
  budgetTokens?: number;
  /** 已有主题清单（防主题拆碎） */
  domainOptions?: string[];
  /** 主题兜底名 */
  domainHint?: string;
  knownAtomIds?: Set<string>;
  signal?: AbortSignal;
  /** 只报告不落库（dry-run） */
  dryRun?: boolean;
  /**
   * 走旧两段式（trigger-scan → knowledge-extract）。默认 false = 一段式。
   * 只用于对比期验收，验收通过后连同 lib/trigger-scan.ts 一起删除。
   */
  twoStage?: boolean;
  /** 每批带上一批最后 1 轮作只读上下文（默认 true；防跨批的"方案 → 纠正"被切散） */
  overlap?: boolean;
  /** 判重用的已知卡片摘要（默认从卡片池取最近 40 条首行） */
  knownCards?: string[];
  onProgress?: (e: PipelineEvent) => void;
}

export type PipelineEvent =
  | {
      type: "batch";
      index: number;
      total: number;
      /** 一段式下 = 本批出卡数；两段式下 = 扫描候选数 */
      candidates: number;
      atoms: number;
      dropped: number;
      tokensIn: number;
      tokensOut: number;
      ms: number;
    }
  | { type: "skip"; reason: string };

export interface PipelineReport {
  sessionId: string;
  covered: number;
  unreviewed: number;
  batches: number;
  processedBatches: number;
  /** 一段式下等于卡片数（无候选中间态）；两段式下是扫描候选数 */
  candidates: number;
  atoms: number;
  dropped: number;
  rejected: number;
  tokensIn: number;
  tokensOut: number;
  elapsedMs: number;
  stopped?: string;
  newAtoms: KnowledgeAtom[];
  /** 压缩 fail-safe 断言未过、原样透传的消息条数（验收 §七#8） */
  compressFallback: number;
  /** 压完不比原文小、干脆不压的消息条数（净收益检查） */
  compressNoGain: number;
  /** 压缩后/原文 字符比（验收用） */
  compressRatio: number;
  /** 模型声明"整批无价值"的批次数（行使否决权，不重跑） */
  noValueBatches: number;
  /** 因格式不合格而重跑过的批次数 */
  retriedBatches: number;
  /** 模型申请回读原文的消息条数（二期按需回读的信号量，一期只统计不执行） */
  needContext: number;
  /** drop 账写出的行数 */
  dropRows: number;
  /** 批内没交代的 user 消息里、由代码兜底补账的条数（>0 说明模型在静默忽略用户消息） */
  autoDropped: number;
  /** 批内既没进卡也没进 drop 的消息总数（观测指标，不强制交代） */
  unaccounted: number;
  /** 带 `pending_fields` 的卡片数（模型没按类型填特化字段；抽取路径已不强制，仅作观测） */
  pendingFieldCards: number;
  /** quote 非逐字（打了 quote_verified:false 标记，不拦）的卡片数 */
  quoteUnverified: number;
  /** 卡片被拒后失去归属、由代码补记 drop 行的 user 消息数（>0 = 闸门拒掉了带 P0 的卡） */
  orphanedByReject: number;
  /** 准入/校验拒绝原因计数（调阈值用：没有它就分不清是"重合度太严"还是"接地不足"） */
  rejectReasons: Record<string, number>;
  /** 每个归一化 key 对应的第一条原始原因（key 里的数字被归一成 N，只留 key 会看不出实际阈值） */
  rejectSamples: Record<string, string>;
}

/** 拒绝原因归一化：只留原因类别，不带具体内容（便于聚合计数） */
function reasonKey(r: string): string {
  const first = r.split(";")[0] ?? r;
  return first.replace(/\d+/g, "N").slice(0, 60);
}

const running = new Set<string>();
const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(sessionId: string): string {
  const short = sessionId.replace(/^session-/, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toLowerCase();
  return join(kbDir(), "locks", `${short || "unknown"}.lock`);
}

/** 进程内 + 文件锁；拿不到就跳过本轮（不阻塞、不重复烧 token） */
export function acquireLock(sessionId: string): boolean {
  if (running.has(sessionId)) return false;
  const p = lockPath(sessionId);
  try {
    if (existsSync(p)) {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      unlinkSync(p); // 过期锁回收
    }
    mkdirSync(join(kbDir(), "locks"), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  } catch {
    // 数据目录只读时退化为进程内锁（同一进程不重复跑）
  }
  running.add(sessionId);
  return true;
}

export function releaseLock(sessionId: string): void {
  running.delete(sessionId);
  try {
    if (existsSync(lockPath(sessionId))) unlinkSync(lockPath(sessionId));
  } catch {
    // 清理失败留给过期回收
  }
}

function writeRun(report: PipelineReport, harness: HarnessKind, mode: string, stage: string): void {
  try {
    mkdirSync(kbDir(), { recursive: true });
    appendFileSync(join(kbDir(), "runs.jsonl"), JSON.stringify({
      ts: new Date().toISOString(), kind: "pipeline", harness, mode, stage,
      session: report.sessionId, covered: report.covered, unreviewed: report.unreviewed,
      batches: report.processedBatches, candidates: report.candidates, atoms: report.atoms,
      dropped: report.dropped, rejected: report.rejected,
      tokensIn: report.tokensIn, tokensOut: report.tokensOut,
      compressFallback: report.compressFallback, compressNoGain: report.compressNoGain,
      compressRatio: report.compressRatio,
      noValueBatches: report.noValueBatches, retriedBatches: report.retriedBatches,
      needContext: report.needContext, dropRows: report.dropRows,
      autoDropped: report.autoDropped, unaccounted: report.unaccounted,
      pendingFieldCards: report.pendingFieldCards, quoteUnverified: report.quoteUnverified,
      orphanedByReject: report.orphanedByReject,
      rejectReasons: report.rejectReasons,
      rejectSamples: report.rejectSamples,
      elapsedMs: report.elapsedMs, stopped: report.stopped ?? null,
    }) + "\n");
  } catch {
    // 运行账本写失败不影响主流程
  }
}

/** 判重用的已知卡片摘要：最近 N 条非资料层卡片的首行 */
export function recentCardTitles(pool: KnowledgeAtom[], limit = 40): string[] {
  return pool
    .filter((a) => a.keep_as !== "data")
    .slice(-limit)
    .map((a) => {
      const first = String(a.content ?? "").split("\n")[0]?.trim() ?? "";
      return first.length > 60 ? first.slice(0, 60) + "…" : first;
    })
    .filter((t) => t.length > 0);
}

/** 一段式：一批一次 LLM 调用 → 卡片 + drop 账 */
async function runOneStageBatches(
  opts: PipelineOptions,
  report: PipelineReport,
  pending: MessageEntry[],
  known: Set<string>,
  atomsPool: KnowledgeAtom[],
  dryRun: boolean,
): Promise<void> {
  const batchChars = opts.batchChars ?? 12_000;
  const lines: ExtractLine[] = serializeForExtract(pending);
  const stats = compressStats(lines);
  report.compressFallback = stats.fallback;
  report.compressNoGain = stats.noGain;
  report.compressRatio = stats.ratio;

  const batches = batchByTurn(lines, batchChars);
  report.batches = batches.length;
  const maxBatches = opts.maxBatches && opts.maxBatches > 0 ? Math.min(opts.maxBatches, batches.length) : batches.length;
  const knownCards = opts.knownCards ?? recentCardTitles(atomsPool);
  let seq = 0;

  for (let i = 0; i < maxBatches; i++) {
    if (opts.signal?.aborted) { report.stopped = "aborted"; break; }
    if (opts.budgetTokens && report.tokensIn + report.tokensOut >= opts.budgetTokens) {
      report.stopped = "budget";
      break;
    }
    const batch = batches[i];
    const ov = opts.overlap === false || i === 0 ? [] : overlapTurn(batches[i - 1]);

    let res;
    try {
      res = await runOneStageBatch(batch, {
        model: opts.model,
        signal: opts.signal,
        overlap: ov,
        domainOptions: opts.domainOptions,
        knownCards,
        domainHint: opts.domainHint,
      });
    } catch (e) {
      report.stopped = `one-stage failed: ${String(e).slice(0, 120)}`;
      break;
    }
    report.tokensIn += res.tokensIn;
    report.tokensOut += res.tokensOut;
    if (res.attempts > 1) report.retriedBatches++;

    // 格式不合格（缺 drop 账 / JSON 非法）→ 不推进水位，下次重扫这一段
    if (!res.output.formatOk) {
      report.stopped = `format invalid: ${res.output.formatError ?? "unknown"}`;
      break;
    }

    // quote 逐字校验的比对对象 = 模型实际看到的压缩文本，不是原始会话日志：
    // 原始日志里 tool-call 的 arguments 是 JSON 字符串（换行被转义成字面量 \n），
    // 拿它做子串匹配会把合法引用误判成编造（实测误判 11/38）。
    const userIdSet = new Set(batch.filter((l) => l.role === "user").map((l) => l.id));
    const lineText = new Map([...batch, ...ov].map((l) => [l.id, l.text]));
    const lineIdx = [...batch, ...ov].map((l) => l.id);
    const textsInRange = (msgIds: string[]): Array<string | undefined> => {
      const at = msgIds.map((id) => lineIdx.indexOf(id)).filter((x) => x >= 0);
      if (!at.length) return msgIds.map((id) => lineText.get(id));
      return lineIdx.slice(Math.min(...at), Math.max(...at) + 1).map((id) => lineText.get(id));
    };

    const batchNew: KnowledgeAtom[] = [];
    // 被拒卡片留档：只计数的话，"闸门是不是误杀"事后无法判断
    // 收集本批被拒卡片引用的 msg_ids：卡片被拒后，它引用的 user 消息会变成
    // "既没卡也没 drop 行"的孤儿（实测 3 条，其中 2 条是 P0 探针），批尾要收口
    const batchRejects: Array<{ reason: string; ids: string[] }> = [];
    const reject = (
      stage: "admission" | "validate" | "build",
      reason: string,
      card: OneStageCard,
      atom?: KnowledgeAtom,
    ) => {
      report.rejected++;
      batchRejects.push({ reason, ids: (card.source?.msg_ids ?? []).map(String) });
      const k = reasonKey(reason);
      report.rejectReasons[k] = (report.rejectReasons[k] ?? 0) + 1;
      if (!report.rejectSamples[k]) report.rejectSamples[k] = reason.slice(0, 120);
      if (dryRun) return;
      const str = (v: unknown): string | null => {
        const t = v == null ? "" : String(v).trim();
        return t || null;
      };
      appendRejected(opts.sessionId, i + 1, {
        reason,
        stage,
        doc_type: String(atom?.doc_type ?? card.type ?? ""),
        domain: String(atom?.domain ?? card.domain ?? ""),
        value: str(atom?.value_tier ?? card.value),
        grounding: str(atom?.grounding ?? card.grounding),
        content: String(atom?.content ?? card.body ?? ""),
        quote: String(atom?.source_quote ?? card.source?.quote ?? ""),
        msg_ids: card.source?.msg_ids ?? [],
      });
    };
    for (const card of res.output.cards as OneStageCard[]) {
      const built = cardToAtom(card, opts.entries, opts.sessionId, seq + 1, opts.domainHint);
      if ("error" in built) {
        reject("build", built.error, card);
        continue;
      }
      if (known.has(built.atom_id)) continue; // 幂等
      // 只打标记不拦（2026-11-12 决议）：实测唯一一例"非逐字"是"注释与代码不一致"的高价值卡，
      // 硬闸门会把它和真摘抄一起杀掉；标记交给人确认环节判断。
      const quoteOk = quoteIsVerbatim(card.source?.quote ?? "", textsInRange(card.source?.msg_ids ?? []));
      (built as Record<string, unknown>).quote_verified = quoteOk;
      if (!quoteOk) report.quoteUnverified++;
      const gate = admissionGate(built, {
        requireWhy: true,
        hasGrounding: !isMechanicalG4(built, opts.entries),
        // 方向：copyRatio(原文, 正文) = 正文有多少逐字抄自原文。
        // 比对对象是 msg_range 的全部原文，不是模型自己挑的那句 quote（只比 quote 太窄，
        // 正文可以抄区间内别处绕过闸门；且 quote 短于 16 字时旧实现直接返回 1）
        copyRatio: copyRatio(
          textsInRange(card.source?.msg_ids ?? []).filter((x): x is string => !!x).join("\n"),
          built.content,
        ),
      });
      if (!gate.ok) {
        reject("admission", gate.reasons.join(";"), card, built);
        continue;
      }
      // 特化字段不再强制（2026-11-12 决议）：下游除 assemble.ts 读 skeleton 外无人消费，
      // 强制它只会把真实知识挡在门外。prompt 里继续要求（软约束），缺了记 pending_fields 供观测。
      // 名字类字段仍用 title 代填——名字换名字是合理的，且比空着好用。
      if (fillMissingSpecialized(built).length > 0) report.pendingFieldCards++;
      const v = validateAtom(built, [], undefined, { requireSpecialized: false });
      if (!v.ok) {
        reject("validate", v.errors.join(";"), card, built);
        continue;
      }
      seq++;
      known.add(built.atom_id);
      batchNew.push(built);
      report.needContext += Array.isArray(card.need_context) ? card.need_context.length : 0;
    }
    // ---- 收口不变式：批内每条 user 消息最终必须有归属（卡片区间 / drop 行）----
    // 契约只管到模型输出为止；卡片被准入拒掉之后，它引用的 user 消息就无家可归了。
    // 这里在准入之后补一次，reason 写明是被哪一类拒的，账就不会出现"看着交代了其实丢了"。
    const bIdx = new Map(batch.map((l, k) => [l.id, k]));
    const coveredByLanded = new Set<string>();
    for (const a of batchNew) {
      for (const src of a.sources ?? []) {
        const r = src.msg_range ?? [];
        const at = r.map((id) => bIdx.get(id)).filter((x): x is number => x !== undefined);
        if (at.length === 2) {
          for (const l of batch.slice(Math.min(...at), Math.max(...at) + 1)) coveredByLanded.add(l.id);
        } else {
          for (const id of r) coveredByLanded.add(id);
        }
      }
    }
    const droppedIds = new Set<string>(
      (res.output.drops ?? []).flatMap((d) => (d.msg_ids ?? []).map(String)),
    );
    const orphanReason = new Map<string, string>();
    for (const r of batchRejects) {
      for (const id of r.ids) {
        if (!userIdSet.has(id) || coveredByLanded.has(id) || droppedIds.has(id)) continue;
        if (!orphanReason.has(id)) orphanReason.set(id, `卡片被拒：${r.reason.slice(0, 40)}`);
      }
    }
    if (orphanReason.size > 0) {
      report.orphanedByReject += orphanReason.size;
      if (!dryRun) {
        // 同一批号补记，reason 各自带上拒因，便于事后追
        const groups = new Map<string, string[]>();
        for (const [id, why] of orphanReason) {
          const arr = groups.get(why) ?? [];
          arr.push(id);
          groups.set(why, arr);
        }
        for (const [why, ids] of groups) {
          report.dropRows += appendDrops(
            opts.sessionId,
            i + 1,
            [{ msg_ids: ids, reason: why, axis: "—" }],
            { noValue: false, cards: res.output.cards.length },
          );
        }
      }
    }

    report.candidates += res.output.cards.length;
    report.atoms += batchNew.length;
    report.dropped += res.output.drops.length;
    report.autoDropped += res.output.autoDropped;
    report.unaccounted += res.output.unaccounted.length;
    if (res.output.noValue) report.noValueBatches++;

    // drop 账：dry-run 也统计行数，但不落盘
    if (!dryRun) {
      report.dropRows += appendDrops(opts.sessionId, i + 1, res.output.drops, {
        noValue: res.output.noValue,
        cards: res.output.cards.length,
      });
    }

    if (batchNew.length > 0 && !dryRun) {
      try {
        appendAtoms(batchNew);
      } catch (e) {
        report.stopped = `write failed: ${String(e).slice(0, 120)}`;
        break;
      }
      report.newAtoms.push(...batchNew);
    }

    // 整批成功（含 no_value：模型行使否决权也算审过）→ 推进水位
    if (!dryRun) {
      appendReviewed({
        session_id: opts.sessionId,
        start: batch[0].id,
        end: batch[batch.length - 1].id,
        kind: "extract",
      });
    }
    report.processedBatches++;

    opts.onProgress?.({
      type: "batch",
      index: report.processedBatches,
      total: batches.length,
      candidates: res.output.cards.length,
      atoms: report.atoms,
      dropped: report.dropped,
      tokensIn: report.tokensIn,
      tokensOut: report.tokensOut,
      ms: res.ms,
    });
  }
}

/** 旧两段式：扫描发现候选 → 抽取成卡片（对比期保留） */
async function runTwoStageBatches(
  opts: PipelineOptions,
  report: PipelineReport,
  pending: MessageEntry[],
  known: Set<string>,
  dryRun: boolean,
): Promise<void> {
  const batchChars = opts.batchChars ?? 12_000;
  const lines: ScanLine[] = serializeForScan(pending);
  const batches = batchLines(lines, batchChars);
  report.batches = batches.length;
  const maxBatches = opts.maxBatches && opts.maxBatches > 0 ? Math.min(opts.maxBatches, batches.length) : batches.length;

  for (let i = 0; i < maxBatches; i++) {
    if (opts.signal?.aborted) { report.stopped = "aborted"; break; }
    if (opts.budgetTokens && report.tokensIn + report.tokensOut >= opts.budgetTokens) {
      report.stopped = "budget";
      break;
    }
    const batch = batches[i];
    const batchStart = batch[0].id;
    const batchEnd = batch[batch.length - 1].id;

    // 1) 发现
    let scan;
    try {
      scan = await scanBatch(batch, { model: opts.model, signal: opts.signal });
    } catch (e) {
      report.stopped = `trigger-scan failed: ${String(e).slice(0, 120)}`;
      break;
    }
    report.tokensIn += scan.usage?.promptTokens ?? 0;
    report.tokensOut += scan.usage?.completionTokens ?? 0;
    report.candidates += scan.candidates.length;

    // 2) 抽取
    if (scan.candidates.length > 0) {
      const d = await extractCandidates({
        sessionId: opts.sessionId,
        entries: opts.entries,
        candidates: scan.candidates,
        model: opts.model,
        batchSize: Math.max(scan.candidates.length, 1),
        domainOptions: opts.domainOptions,
        knownAtomIds: known,
        signal: opts.signal,
      });
      report.tokensIn += d.tokensIn;
      report.tokensOut += d.tokensOut;
      report.dropped += d.dropped.length;
      report.rejected += d.rejected.length;
      if (d.atoms.length > 0 && !dryRun) {
        try {
          appendAtoms(d.atoms);
        } catch (e) {
          report.stopped = `write failed: ${String(e).slice(0, 120)}`;
          break;
        }
        report.newAtoms.push(...d.atoms);
      }
      report.atoms += d.atoms.length;
      if (d.stopped) {
        report.stopped = d.stopped;
        // 抽取中断：本批不算已审
        break;
      }
    }

    // 3) 整批成功 → 推进水位（dry-run 不写）
    if (!dryRun) appendReviewed({ session_id: opts.sessionId, start: batchStart, end: batchEnd, kind: "discover" });
    report.processedBatches++;

    opts.onProgress?.({
      type: "batch",
      index: report.processedBatches,
      total: batches.length,
      candidates: scan.candidates.length,
      atoms: report.atoms,
      dropped: report.dropped,
      tokensIn: report.tokensIn,
      tokensOut: report.tokensOut,
      ms: scan.ms,
    });
  }
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineReport> {
  const t0 = Date.now();
  const dryRun = opts.dryRun === true;
  const mode = opts.mode ?? "incremental";
  const known = opts.knownAtomIds ?? existingAtomIds();
  const atomsPool = loadAtoms();

  const coveredSet = coveredIds(opts.entries, opts.sessionId, atomsPool);
  const covered = coveredSet.size;
  const unreviewedEntries = opts.entries.filter((e) => {
    const role = e.message?.role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
  const pending = mode === "backfill"
    ? unreviewedEntries
    : unreviewedEntries.filter((e) => !coveredSet.has(e.id));

  const report: PipelineReport = {
    sessionId: opts.sessionId,
    covered,
    unreviewed: pending.length,
    batches: 0,
    processedBatches: 0,
    candidates: 0,
    atoms: 0,
    dropped: 0,
    rejected: 0,
    tokensIn: 0,
    tokensOut: 0,
    elapsedMs: 0,
    newAtoms: [],
    compressFallback: 0,
    compressNoGain: 0,
    compressRatio: 0,
    noValueBatches: 0,
    retriedBatches: 0,
    needContext: 0,
    dropRows: 0,
    autoDropped: 0,
    unaccounted: 0,
    pendingFieldCards: 0,
    quoteUnverified: 0,
    orphanedByReject: 0,
    rejectReasons: {},
    rejectSamples: {},
  };

  if (pending.length === 0) {
    report.elapsedMs = Date.now() - t0;
    return report;
  }

  if (!dryRun && !acquireLock(opts.sessionId)) {
    report.stopped = "locked";
    report.elapsedMs = Date.now() - t0;
    return report;
  }

  const stage = opts.twoStage ? "two-stage" : "one-stage";
  try {
    if (opts.twoStage) await runTwoStageBatches(opts, report, pending, known, dryRun);
    else await runOneStageBatches(opts, report, pending, known, atomsPool, dryRun);
  } finally {
    if (!dryRun) {
      releaseLock(opts.sessionId);
      report.elapsedMs = Date.now() - t0;
      writeRun(report, opts.harness, mode, stage);
    } else {
      report.elapsedMs = Date.now() - t0;
    }
  }

  return report;
}
