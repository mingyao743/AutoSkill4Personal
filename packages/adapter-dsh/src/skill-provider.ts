/**
 * AutoSkill dsh skill provider（M2 实现）。
 *
 * list(): 每知识主题一个 candidate——从 atoms.jsonl 派生 domain 集合，
 *         description 取该主题最新知识卡片的内容首段（<500 字符，命中 dsh 目录截断阈值）。
 * get(candidate): 返回该主题全文。数据目录形态下从卡片（cards/<category>/<domain>.md）
 *            拼装正文；无卡片时由知识卡片聚合生成；同时记 loaded 使用账（唯一真相源）。
 *
 * dsh 校验规则（实测 dsh-skill/lib/index.js validateCandidate）：
 *   name 必须命中 /^[a-z0-9]+(-[a-z0-9]+)*$/（kebab-case）；
 *   description 非空字符串；invocation 两布尔可选但合法；source/rank/provider 必填。
 */
import type { SkillCandidate, SkillDefinition, SkillProvider } from "@deepseek-ai/dsh-skill";
import type { HostContext } from "../../core/lib/context.ts";
import { instructionAtoms, type KnowledgeAtom } from "../../core/lib/atom-store.ts";
import { usageSummary, appendUsage, type SkillUsage } from "../../core/lib/usage-store.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** dsh 候选 rank 约定：filesystem provider 用 100-600；自定义 provider 取更低位不与文件系统竞争 */
const AUTOSKILL_RANK = 50;

/** 卡片类别目录名 → 展示标签（与 assemble.ts 口径一致） */
const CATEGORY_LABELS: Record<string, string> = {
	"01": "业务认知", "02": "操作SOP", "03": "模板与骨架", "04": "案例与样例", "05": "问题与复盘",
};

/**
 * 类别 → assemble.ts 实际写出的目录名。
 * 旧实现直接用 "01".."05" 拼路径，而 assemble.ts 写的是 `01-business` 等带后缀的目录，
 * 于是 provider 永远找不到组卡产物、悄悄退回知识卡片聚合——两个宿主读到的正文因此分叉。
 */
const CATEGORY_DIRS: Record<string, string> = {
	"01": "01-business", "02": "02-sop", "03": "03-templates", "04": "04-cases", "05": "05-lessons",
};

export function autoskillProvider(h: HostContext): SkillProvider & { name: string } {
	return {
		name: "autoskill",

		async list(): Promise<SkillCandidate[]> {
			const domains = collectDomains(h.dataDir);
			const usage = usageSummary();
			return [...domains].map(([domain, latest]) => ({
				name: domain,
				description: summarize(latest, usage.get(domain)),
				invocation: { modelInvocable: true, userInvocable: true },
				source: "autoskill-atoms",
				rank: AUTOSKILL_RANK,
				provider: "autoskill",
			}));
		},

		async get(candidate): Promise<SkillDefinition | undefined> {
			const content = domainBody(h.dataDir, candidate.name);
			if (content === undefined) return undefined;
			// loaded 使用账：provider.get 是模型读 skill 的唯一真相源（比 pi 模糊匹配精确）
			appendUsage([{
				ts: new Date().toISOString(),
				session: "live",
				skill: candidate.name,
				event: "loaded",
				evidence: "dsh provider.get()",
			}]);
			return {
				name: candidate.name,
				description: candidate.description,
				invocation: candidate.invocation,
				source: candidate.source,
				provider: "autoskill",
				content,
			};
		},
	};
}

// ---------------- 数据访问（复用 core 知识卡片池） ----------------

/** 主题集合：按 atoms.jsonl 的 domain 聚合，value = 该主题最新一条知识卡片（描述派生源） */
function collectDomains(dataDir: string): Map<string, KnowledgeAtom> {
	const map = new Map<string, KnowledgeAtom>();
	for (const a of instructionAtoms()) {
		const d = sanitizeDomain(a.domain || "general");
		const prev = map.get(d);
		if (!prev || (a.extracted_at ?? "") > (prev.extracted_at ?? "")) map.set(d, a);
	}
	return map;
}

/** 知识卡片 domain 可能含下划线/大写等 dsh 不接受的字符，转 kebab-case */
function sanitizeDomain(d: string): string {
	return d.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "general";
}

/** 候选描述：主题内知识卡片类型/条数统计 + 最新知识卡片内容首句（≤500 字符） */
function summarize(latest: KnowledgeAtom, u: SkillUsage | undefined): string {
	const head = (latest.content ?? "").split("\n")[0].slice(0, 200);
	const types = latest.atom_type ? `最新切片：${latest.atom_type}` : "";
	const usageNote = u?.loaded ? `（已加载 ${u.loaded} 次）` : "";
	return `${head}${types ? `｜${types}` : ""}${usageNote}`.slice(0, 500);
}

/** 主题全文：优先读组卡产物 cards/<category-dir>/<domain>.md，其次从知识卡片聚合 */
function domainBody(dataDir: string, domain: string): string | undefined {
	// 组卡产物按 (category, domain) 分文件，一个 domain 可能同时落在多个类目里
	// （spec 在 01、sop 在 02、postmortem 在 05）。全部拼起来 —— 与 pi 侧
	// package-skill 的 cardsFor(domain) 同口径；只取第一个会让两个宿主的正文分叉。
	const parts: string[] = [];
	for (const cat of Object.keys(CATEGORY_DIRS)) {
		const p = join(dataDir, "cards", CATEGORY_DIRS[cat], `${domain}.md`);
		if (!existsSync(p)) continue;
		parts.push(readFileSync(p, "utf8").trim());
	}
	if (parts.length > 0) return parts.join("\n\n---\n\n") + "\n";
	// 无组卡：知识卡片聚合兜底（保证 provider get 永不静默失败）
	const atoms = instructionAtoms().filter((a) => sanitizeDomain(a.domain || "general") === domain);
	if (atoms.length === 0) return undefined;
	atoms.sort((a, b) => (a.category || "").localeCompare(b.category || "") || (b.extracted_at ?? "").localeCompare(a.extracted_at ?? ""));
	const sections = new Map<string, KnowledgeAtom[]>();
	for (const a of atoms) {
		const cat = a.category || "00";
		if (!sections.has(cat)) sections.set(cat, []);
		sections.get(cat)!.push(a);
	}
	let out = `# ${domain} 知识技能包\n\n> 由 AutoSkill 知识管道自动聚合（dsh provider 实时拼装）：知识卡片 → 本正文。\n`;
	for (const [cat, list] of [...sections].sort()) {
		out += `\n## ${CATEGORY_LABELS[cat] ?? cat}\n\n`;
		for (const a of list) out += `- [${a.atom_type}](${a.atom_id.slice(7)}) ${a.content.split("\n")[0]}\n`;
	}
	return out;
}
