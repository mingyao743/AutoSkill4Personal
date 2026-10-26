/**
 * compaction 抢救核心：被压缩区的原子抢救 + 自定义 summary 生成。
 * 从 extension 抽出为纯函数（不依赖 @earendil-works/*，可独立测试）。
 *
 * 抢救是唯一免审入口：原子直入 published，confidence 下限 0.7。
 */
import type { MessageEntry, Window } from "./types.ts";
import { buildWindows } from "./window.ts";
import { buildSystemPrompt, loadCatalog } from "./prompt.ts";
import { serializeEntries } from "./serialize.ts";
import { acceptedOnly, extractWindow } from "./extract-core.ts";
import { appendAtoms, existingAtomIds, extractedWindowIds, logError, type KnowledgeAtom } from "./atom-store.ts";
import { chatComplete } from "./llm.ts";

export interface RescueResult {
  ok: boolean; // 抽取是否完成（false = 全部窗口失败，调用方决定放行默认 compaction）
  savedAtoms: KnowledgeAtom[]; // published 原子
  windowCount: number;
}

/**
 * 抢救被压缩区的知识原子。
 * @param toSummarize  firstKeptEntryId 之前的 message entries（带真实 id）
 * @param sessionId    8 位短 session id
 */
export async function rescueAtoms(
  toSummarize: MessageEntry[],
  sessionId: string,
  signal?: AbortSignal,
): Promise<RescueResult> {
  const windows = buildWindows(toSummarize, sessionId);
  if (windows.length === 0) return { ok: true, savedAtoms: [], windowCount: 0 };

  // 已抽过的窗口跳过（quit 终采/手动回填可能已覆盖）
  const done = extractedWindowIds();
  const pending = windows.filter((w: Window) => !done.has(w.window_id));

  const catalog = loadCatalog();
  const systemPrompt = buildSystemPrompt(catalog);
  const knownAtomIds = existingAtomIds();
  const saved: KnowledgeAtom[] = [];
  let failedWindows = 0;

  for (const w of pending) {
    if (signal?.aborted) return { ok: false, savedAtoms: saved, windowCount: windows.length };
    const result = await extractWindow(w, catalog, {
      systemPrompt,
      extractedBy: "compaction-rescue",
      status: "published", // 唯一免审入口
      confidenceFloor: 0.7,
    });
    if (!result.ok) {
      failedWindows++;
      logError(`${w.window_id} compaction抢救失败 ${result.error}: ${result.rawPreview ?? ""}`);
      continue;
    }
    const accepted = acceptedOnly(result, knownAtomIds);
    if (accepted.length > 0) {
      appendAtoms(accepted);
      saved.push(...accepted);
    }
    for (const r of result.rejected) {
      logError(`${w.window_id} compaction抢救拒(${r.reason}): ${r.atom.content.slice(0, 200)}`);
    }
  }

  return {
    ok: failedWindows < pending.length || pending.length === 0,
    savedAtoms: saved,
    windowCount: windows.length,
  };
}

/**
 * compaction summary：主模型独立调用（流式、不限 max_tokens）。
 * 标准摘要 + 已抢救原子索引（模型可引用 atom_id 知识已存档）。
 */
export async function generateCompactionSummary(
  toSummarize: MessageEntry[],
  previousSummary: string | undefined,
  atomIds: string[],
  signal?: AbortSignal,
): Promise<string> {
  const atomIndex = atomIds.length
    ? `\n\n本段对话的知识原子已抽取存档（知识库 atom_id，正文可引用）:\n${atomIds.map((id) => `- ${id}`).join("\n")}`
    : "";
  const system =
    "你是会话压缩器。为即将被压缩丢弃的对话生成结构化 markdown 摘要，须保留：主要目标、关键决策及理由、" +
    "重要代码/文件变更、未竟工作、阻塞与下一步。摘要将替换整段历史，须自足可续接工作。" +
    "篇幅克制，按节组织，不要输出 JSON。";
  const user = `${previousSummary ? `先前摘要（供衔接）：\n${previousSummary}\n\n` : ""}<conversation>\n${serializeEntries(toSummarize)}\n</conversation>${atomIndex}`;
  const res = await chatComplete({ system, user, signal });
  return res.text.trim();
}
