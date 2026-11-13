/**
 * 编译器 prompt 组装。
 *
 * 输入：技能正文（编译内核）+ 窗口文本 + index 摘要 + hot + 项目约定
 * 输出：system + user 两条消息，交给 `compiler/run.ts` 调 LLM
 *
 * 预算：system 侧技能正文 ≤20KB（超了截断，因为技能是固定开销，每窗都要付）；
 * user 侧窗口已经由 `trigger/window.ts` 裁到 120k 字符。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { indexSummary } from "../vault/index.ts";
import { renderWindowText, type WindowPayload } from "../trigger/window.ts";

/** 技能正文预算：每窗都付，必须压住 */
export const SKILL_MAX_CHARS = 20_000;

export interface PromptInput {
  vaultDir: string;
  window: WindowPayload;
  /** 编译内核技能目录（agent-skills/ow-compiler） */
  skillDir: string;
  /** 现存页面的 index 摘要（合并判断用） */
  pageLimit?: number;
}

export interface CompilePrompt {
  system: string;
  user: string;
  /** 实际用了多少字符，进报告 */
  stats: { systemChars: number; userChars: number; pages: number };
}

/** 读技能正文：SKILL.md + references/*.md，按预算拼接 */
export function loadCompilerSkill(skillDir: string): string {
  const parts: string[] = [];
  const main = join(skillDir, "SKILL.md");
  if (existsSync(main)) parts.push(readFileSync(main, "utf8"));

  const refDir = join(skillDir, "references");
  if (existsSync(refDir)) {
    // 只读编译必需的四个；cross-linker 在 P3 才用
    for (const name of ["llm-wiki.md", "wiki-capture.md", "wiki-ingest.md"]) {
      const p = join(refDir, name);
      if (existsSync(p)) parts.push(`\n\n---\n\n# 参考：${name}\n\n${readFileSync(p, "utf8")}`);
    }
  }
  const text = parts.join("\n");
  return text.length > SKILL_MAX_CHARS ? `${text.slice(0, SKILL_MAX_CHARS)}\n\n（技能正文已截断）` : text;
}

export function buildCompilePrompt(input: PromptInput): CompilePrompt {
  const skill = loadCompilerSkill(input.skillDir);
  const index = indexSummary(input.vaultDir, input.pageLimit ?? 60);
  const hot = readIfExists(join(input.vaultDir, "hot.md"));
  const agents = readIfExists(join(input.vaultDir, "AGENTS.md"));
  const windowText = renderWindowText(input.window);

  const system = [
    "你是知识编译器。把一段真实工作会话提炼成可复用的 markdown 知识页。",
    "",
    "# 你的技能与规则",
    "",
    skill,
    "",
    "# 输出契约",
    "",
    "只输出一个 JSON 对象，不要任何解释文字：",
    "```json",
    JSON.stringify({
      pages: [
        {
          path: "concepts/example.md",
          title: "页面标题",
          summary: "一句话摘要",
          tags: ["tag1"],
          body: "markdown 正文，不含 frontmatter",
          publish_as: "document",
          base_confidence: 0.8,
          lifecycle: "active",
          sources: ["session:xxx"],
        },
      ],
      skipped: [{ reason: "no-knowledge", detail: "这段对话只是问答，没有可复用结论" }],
    }, null, 2),
    "```",
    "",
    "硬性要求：",
    "- 最多 8 页；宁少勿多，一页讲一件事",
    "- `path` 必须以 concepts/ entities/ skills/ references/ synthesis/ journal/ 之一开头",
    "- `body` 里不要写 frontmatter，不要写 `# 标题`（标题由 title 字段给）",
    "- 引用了已有页面时用 `[[路径|标题]]` 形式，路径必须在上面的「现存页面」里",
    "- 没有值得沉淀的内容时，pages 返回空数组，skipped 说明原因",
  ].join("\n");

  const user = [
    "# 项目约定",
    "",
    agents || "（无）",
    "",
    "# 现存页面（避免重复造页，可引用）",
    "",
    index || "（空库，这是第一批页）",
    "",
    "# 最近改动的页面",
    "",
    hot || "（无）",
    "",
    `# 待编译会话（${input.window.agent} / ${input.window.session_id} / 第 ${input.window.from_turn}–${input.window.to_turn} 轮）`,
    "",
    windowText,
    "",
    "# 现在输出 JSON",
  ].join("\n");

  return {
    system,
    user,
    stats: {
      systemChars: system.length,
      userChars: user.length,
      pages: input.pageLimit ?? 60,
    },
  };
}

function readIfExists(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
