#!/usr/bin/env node
/**
 * P2 skill 打包器：knowledge/cards/<category>/<domain>.md → ~/.pi/agent/skills/<domain>/SKILL.md
 *
 * 规则：
 *   - frontmatter：name=<domain>（kebab-case 已保证）、description=LLM 生成的路由描述（≤300字，
 *     说明"是什么+何时用"——description 决定模型何时自动加载本技能）
 *   - 正文自适应：卡片总量 < 15k 字符 → 全部内联进 SKILL.md（单文件即读即用）；
 *     否则卡片拷贝到 references/，SKILL.md 只放总览并指引按需阅读
 *   - 幂等：重复打包覆盖旧目录
 *
 * 用法：
 *   node --experimental-strip-types scripts/package-skill.ts <domain> [--dest <dir>] [--dry]
 *   node --experimental-strip-types scripts/package-skill.ts --all
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatComplete, extractJsonFromText } from "../lib/llm.ts";
import { kbDir, loadAtoms } from "../lib/atom-store.ts";

const CARDS_DIR = join(kbDir(), "cards");
const CATEGORY_LABELS: Record<string, string> = {
  "01": "业务认知", "02": "操作SOP", "03": "模板与骨架", "04": "案例与样例", "05": "问题与复盘",
};

// ---------- 参数 ----------
const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const allMode = has("all");
const dryRun = has("dry");
const destRoot = opt("dest") ?? join(homedir(), ".pi", "agent", "skills");
const domains = allMode
  ? new Set([...readdirSync(CARDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((cat) =>
        readdirSync(join(CARDS_DIR, cat.name))
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.replace(/\.md$/, "")))])
  : new Set(args.filter((a) => !a.startsWith("--")));

if (domains.size === 0) {
  console.error("用法: package-skill.ts <domain> | --all [--dest dir] [--dry]");
  process.exit(1);
}

// ---------- 收集某 domain 的全部卡片 ----------
function cardsFor(domain: string): { category: string; path: string; content: string }[] {
  const out: { category: string; path: string; content: string }[] = [];
  if (!existsSync(CARDS_DIR)) return out;
  for (const catDir of readdirSync(CARDS_DIR).sort()) {
    if (catDir === "INDEX.md") continue;
    const p = join(CARDS_DIR, catDir, `${domain}.md`);
    if (existsSync(p)) {
      const category = catDir.slice(0, 2);
      out.push({ category, path: p, content: readFileSync(p, "utf8") });
    }
  }
  return out;
}

// ---------- LLM 生成路由描述 ----------
async function genDescription(domain: string, cards: { category: string; content: string }[]): Promise<string> {
  const atomCount = loadAtoms().filter((a) => (a.domain || "general") === domain).length;
  const digest = cards
    .map((c) => `【${CATEGORY_LABELS[c.category] ?? c.category}】\n` + c.content.replace(/^#.*\n|^>.*\n/gm, "").slice(0, 1200))
    .join("\n\n");
  const system = `你是技能路由描述生成器。给定一个业务域的知识卡片内容，为其生成 skill 的 description（模型据此决定何时加载本技能）。
要求：中文，一句话说明这是什么领域的知识库，再用一句"适用于/涵盖"列举典型场景（排障、操作、概念查询等）。总长 ≤ 200 字。只输出 description 文本本身，不要 JSON、不要引号。`;
  const user = `业务域: ${domain}（${atomCount} 个知识原子）\n\n${digest}`;
  try {
    const res = await chatComplete({ system, user });
    return res.text.trim().replace(/^["「]|["」]$/g, "").slice(0, 1000);
  } catch (e) {
    console.error(`  description 生成失败，用确定性回退: ${String(e).slice(0, 120)}`);
    const cats = cards.map((c) => CATEGORY_LABELS[c.category] ?? c.category).join("、");
    return `${domain} 领域知识库（${cats}），由 AutoSkill 从 pi 会话中抽取。涉及 ${domain} 相关的排障、操作、概念问题时加载。`;
  }
}

// ---------- 打包 ----------
let done = 0;
for (const domain of domains) {
  const cards = cardsFor(domain);
  if (cards.length === 0) { console.error(`跳过 ${domain}：无卡片`); continue; }

  const totalChars = cards.reduce((n, c) => n + c.content.length, 0);
  const inline = totalChars < 15_000;

  // agent 增量维护的 skill 不被批量重建覆盖（丢精修）；检查在 LLM 调用前，跳过不烧 token
  const skillDir = join(destRoot, domain);
  const existingMd = existsSync(join(skillDir, "SKILL.md"))
    ? readFileSync(join(skillDir, "SKILL.md"), "utf8") : "";
  if (existingMd.includes("agent-maintained") && !has("force")) {
    console.log(`跳过 ${domain}：agent 增量维护中（重建会丢精修；--force 强制覆盖）`);
    continue;
  }
  const description = await genDescription(domain, cards);
  const overview = cards
    .map((c) => inline
      ? c.content
      : `- references/${c.category}-${CATEGORY_LABELS[c.category] ?? c.category}.md —— ${CATEGORY_LABELS[c.category]}（${c.content.length} 字符）`)
    .join("\n\n");

  const md =
`---
name: ${domain}
description: ${description}
---

# ${domain} 知识技能包

> 由 AutoSkill 知识管道自动打包（${new Date().toISOString().slice(0, 10)}）：pi 会话 → 知识原子 → 卡片 → 本技能。
> 原子带溯源（session id + 消息 id）与置信度；知识可被 capture_knowledge 工具增量补充后重新打包。

${inline
  ? `## 内容（全部内联）\n\n${overview}\n`
  : `## 内容（按需阅读 references/）\n\n${overview}\n\n使用规则：涉及本域的具体问题时，先读对应的 references 文件再动手；卡片内"来源"字段可回溯原始会话。\n`}
`;

  if (dryRun) {
    console.log(`[dry] ${skillDir}/SKILL.md（${inline ? "内联" : "references"}，description=${description.slice(0, 80)}…）`);
  } else {
    rmSync(skillDir, { recursive: true, force: true });
    mkdirSync(join(skillDir, inline ? "" : "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), md);
    if (!inline) {
      for (const c of cards) {
        cpSync(c.path, join(skillDir, "references", `${c.category}-${CATEGORY_LABELS[c.category] ?? c.category}.md`));
      }
    }
    console.log(`✓ ${skillDir}（${inline ? "内联" : "references/"}，${totalChars} 字符，description ${description.length} 字）`);
  }
  done++;
}
console.log(`\n完成：${done}/${domains.size} 个技能${dryRun ? "（dry）" : ` → ${destRoot}`}`);
