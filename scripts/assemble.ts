#!/usr/bin/env node
/**
 * P1 组装：atoms.jsonl → knowledge/cards/
 *
 * 流程：
 *   1. 读原子（默认全部，--published-only 只取已审）
 *   2. 按 (category, domain) 分组 → 组内 LLM 判重聚类（结果缓存 dedup-cache.json，原子集不变不重跑）
 *   3. 簇合并：merged_content（LLM 吸收各条信息）或最高置信度原文 + sources 并集 + 最高 confidence
 *   4. 按 5 类既定组装方式渲染卡片（确定性渲染，无 LLM）：
 *      01 业务认知 → 知识卡片（按切片分节）
 *      02 SOP      → 流程清单（step 时序）
 *      03 模板     → 骨架集（skeleton 代码块）
 *      04 案例     → 完整案例（保留上下文）
 *      05 复盘     → 问题→根因→修复 全链路
 *   5. 生成 INDEX.md
 *
 * 组装是视图，原子是事实：不改动 atoms.jsonl，可反复重建（--rebuild 即删目录重来）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/assemble.ts [--domain X] [--category 01] [--published-only]
 *        [--no-llm] [--dry] [--rebuild]
 *   --no-llm    跳过判重（每原子独立成卡，调试渲染用）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatComplete, extractJsonFromText } from "../lib/llm.ts";
import { atomsPath, kbDir, loadAtoms, type KnowledgeAtom } from "../lib/atom-store.ts";

// ---------- 参数 ----------
const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const filterDomain = opt("domain");
const filterCategory = opt("category");
const publishedOnly = has("published-only");
const noLlm = has("no-llm") || !!process.env.EXTRACTION_NO_LLM;
const dryRun = has("dry");
const rebuild = has("rebuild");

const CATEGORY_DIRS: Record<string, string> = {
  "01": "01-business", // 业务认知
  "02": "02-sop",      // 操作SOP
  "03": "03-templates",// 模板与骨架
  "04": "04-cases",    // 案例与样例
  "05": "05-lessons",  // 问题与复盘
};
const CATEGORY_NAMES: Record<string, string> = {
  "01": "业务认知", "02": "操作SOP", "03": "模板与骨架", "04": "案例与样例", "05": "问题与复盘",
};
const CARDS_DIR = join(kbDir(), "cards");
const CACHE_PATH = join(kbDir(), "dedup-cache.json");

// ---------- 1. 分组 ----------
const all = loadAtoms().filter((a) => {
  if (publishedOnly && a.status !== "published") return false;
  if (filterDomain && (a.domain || "general") !== filterDomain) return false;
  if (filterCategory && a.category !== filterCategory) return false;
  return true;
});
if (all.length === 0) {
  console.error(`无原子（${atomsPath()} ${publishedOnly ? "只看 published" : "全部"}）`);
  process.exit(1);
}
const groups = new Map<string, KnowledgeAtom[]>();
for (const a of all) {
  const key = `${a.category}|${a.domain || "general"}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(a);
}
console.log(`原子 ${all.length} 个 → ${groups.size} 组 (category|domain)${noLlm ? "，--no-llm 跳过判重" : ""}`);

// ---------- 2. LLM 判重（组内，缓存） ----------
interface Cluster { ids: string[]; merged_content?: string }
const cache: Record<string, { inputHash: string; clusters: Cluster[] }> =
  existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};

const groupHash = (atoms: KnowledgeAtom[]): string =>
  createHash("sha1").update(atoms.map((a) => a.atom_id).sort().join(",")).digest("hex").slice(0, 16);

const CHUNK = 40; // 每次判重的原子数上限（跨块重复下次组装迭代覆盖）

async function dedupGroup(atoms: KnowledgeAtom[]): Promise<Cluster[]> {
  const out: Cluster[] = [];
  for (let i = 0; i < atoms.length; i += CHUNK) {
    const chunk = atoms.slice(i, i + CHUNK);
    const h = groupHash(chunk);
    const cached = cache[h];
    if (cached) { out.push(...cached.clusters); continue; }

    const listing = chunk.map((a) =>
      `- ${a.atom_id} [${a.atom_type}] conf=${a.confidence}\n  ${a.content.replace(/\n/g, " ").slice(0, 300)}`
    ).join("\n");
    const system = `你是知识原子判重器。输入是同一知识域内的一批原子（id、切片名、置信度、内容）。
找出表达"同一知识"的重复/近似重复原子，输出聚类合并建议。

规则：
1. 只在内容陈述同一事实/规则/步骤/问题时合并；互补细节、不同粒度、不同场景的原子不合并。
2. 合并簇输出 merged_content：吸收各条信息的最佳表述（200字内、可独立复用）。
3. 非重复原子不要出现在输出里（保留为独立原子）。
只输出 JSON：{"clusters":[{"ids":["atom_xxx","atom_yyy"],"merged_content":"..."}]}，无重复则 {"clusters":[]}。`;
    const user = `原子清单：\n${listing}`;

    let clusters: Cluster[] = [];
    let parseOk = false;
    try {
      const res = await chatComplete({ system, user });
      const j = extractJsonFromText(res.text);
      if (j) {
        const parsed = JSON.parse(j) as { clusters?: Cluster[] };
        const validIds = new Set(chunk.map((a) => a.atom_id));
        clusters = (parsed.clusters ?? []).filter(
          (c) => Array.isArray(c.ids) && c.ids.length >= 2 && c.ids.every((id) => validIds.has(id))
        );
        parseOk = true;
      }
    } catch (e) {
      console.error(`  判重调用失败（本块保留独立原子）: ${String(e).slice(0, 150)}`);
    }
    if (parseOk) cache[h] = { inputHash: h, clusters }; // 失败不缓存，下次重试
    out.push(...clusters);
  }
  return out;
}

const clustersByGroup = new Map<string, KnowledgeAtom[]>(); // 合并后的原子（含 singleton）
let totalClusters = 0;
for (const [key, atoms] of groups) {
  const clusters = noLlm ? [] : await dedupGroup(atoms);
  totalClusters += clusters.length;
  const inCluster = new Set(clusters.flatMap((c) => c.ids));
  const merged: KnowledgeAtom[] = atoms.filter((a) => !inCluster.has(a.atom_id)); // singleton 原样
  for (const c of clusters) {
    const members = atoms.filter((a) => c.ids.includes(a.atom_id));
    const canon = members.reduce((best, a) => (a.confidence > best.confidence ? a : best), members[0]);
    merged.push({
      ...canon,
      content: c.merged_content?.trim() || canon.content,
      sources: members.flatMap((m) => m.sources),
      confidence: Math.max(...members.map((m) => m.confidence)),
      refs: [...new Set(members.flatMap((m) => m.refs ?? []))],
      version: Math.max(...members.map((m) => m.version ?? 1)),
    });
    totalClusters++;
  }
  clustersByGroup.set(key, merged);
}
if (!noLlm && !dryRun) writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
console.log(`判重完成：${totalClusters} 个合并簇`);

// ---------- 3. 渲染卡片 ----------
const fmtSources = (a: KnowledgeAtom): string =>
  (a.sources ?? []).map((s) => `${s.session_id}:${s.msg_range[0]}→${s.msg_range[1]}`).join(", ") || "agent声明";

/** 原子 → markdown 条目（通用元信息 + 特化字段） */
function renderAtom(a: KnowledgeAtom, extra: string): string {
  return `### ${a.atom_type} · ${a.atom_id}\n\n${a.content}\n\n` +
    (extra ? extra + "\n" : "") +
    `- 置信度 ${a.confidence}｜状态 ${a.status}｜来源 ${fmtSources(a)}\n`;
}
const fieldList = (a: KnowledgeAtom, fields: string[]): string =>
  fields
    .filter((f) => a[f] != null && a[f] !== "")
    .map((f) => `  - ${f}: ${String(Array.isArray(a[f]) ? a[f].join("；") : a[f])}`)
    .join("\n");

const renderers: Record<string, (a: KnowledgeAtom) => string> = {
  "01": (a) => renderAtom(a, fieldList(a, ["concept_name", "definition", "boundary", "rules"])),
  "02": (a) => renderAtom(a,
    `  - step: ${String(a.step ?? "").replace(/\n/g, "\n    ")}\n` +
    fieldList(a, ["step_order", "prerequisites", "inputs", "outputs", "checkpoints", "exceptions"]) +
    (a.command ? `\n  - command:\n    \`\`\`bash\n    ${String(a.command).replace(/`/g, "\\`")}\n    \`\`\`` : "")),
  "03": (a) => renderAtom(a,
    fieldList(a, ["template_name", "purpose", "fields"]) +
    (a.skeleton ? `\n  - skeleton:\n    \`\`\`\n    ${String(a.skeleton).replace(/`/g, "\\`")}\n    \`\`\`` : "")),
  "04": (a) => renderAtom(a, fieldList(a, ["case_name", "background", "solution", "process", "result", "highlights", "limitations", "applicable_conditions"])),
  "05": (a) => renderAtom(a, fieldList(a, ["problem", "scenario", "impact", "root_cause", "temp_fix", "permanent_fix", "improvements"])),
};

if (!dryRun) {
  if (rebuild && existsSync(CARDS_DIR)) rmSync(CARDS_DIR, { recursive: true });
  mkdirSync(CARDS_DIR, { recursive: true });
}

const indexRows: string[] = ["| 卡片 | 原子数 |", "|---|---|"];
for (const [key, atoms] of [...clustersByGroup.entries()].sort()) {
  const [category, domain] = key.split("|");
  const dir = CATEGORY_DIRS[category] ?? `0${category}-misc`;
  const cardPath = join(CARDS_DIR, dir, `${domain}.md`);
  const name = CATEGORY_NAMES[category] ?? category;
  const total = groups.get(key)!.length;

  // 按切片分节；节内按置信度降序
  const bySlice = new Map<string, KnowledgeAtom[]>();
  for (const a of atoms) {
    if (!bySlice.has(a.atom_type)) bySlice.set(a.atom_type, []);
    bySlice.get(a.atom_type)!.push(a);
  }
  const sections = [...bySlice.entries()]
    .sort((x, y) => y[1].length - x[1].length)
    .map(([slice, list]) =>
      `## ${slice}（${list.length}）\n\n` +
      list.sort((x, y) => y.confidence - x.confidence)
        .map((a) => renderers[category]?.(a) ?? renderAtom(a, ""))
        .join("\n")
    ).join("\n");

  const md = `# ${domain} · ${name}\n\n` +
    `> 知识卡片（组装视图，源：${atomsPath()} 可重建）。原子 ${total} 个${total !== atoms.length ? `，判重合并后 ${atoms.length} 个` : ""}。生成于 ${new Date().toISOString().slice(0, 10)}。\n\n` +
    sections + "\n";
  if (!dryRun) {
    mkdirSync(join(CARDS_DIR, dir), { recursive: true });
    writeFileSync(cardPath, md);
    console.log(`  ${cardPath}（${atoms.length} 原子 / ${bySlice.size} 切片）`);
  }
  indexRows.push(`| [${dir}/${domain}.md](${dir}/${domain}.md) | ${atoms.length} |`);
}

if (!dryRun) {
  writeFileSync(join(CARDS_DIR, "INDEX.md"), `# 知识卡片索引\n\n共 ${groups.size} 张卡片。\n\n${indexRows.join("\n")}\n`);
  console.log(`\n完成：${groups.size} 张卡片 → ${CARDS_DIR}`);
}
