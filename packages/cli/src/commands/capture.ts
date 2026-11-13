/**
 * `ow capture`：手动编译一个会话（跳过 30 轮闸）。
 *
 * 两种用法：
 *   ow capture                       # 自动找当前目录最新会话
 *   ow capture --session <文件>       # 指定会话文件
 *   ow capture --plan                # 只看会编译哪些窗口，不烧 token
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runCapture, planWindows, describeCredentialSituation } from "../../../core/lib/trigger/capture.ts";
import { latestSessionFileIn } from "../../../adapter-dsh/src/session-path.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

/** 编译内核技能目录 */
function compilerSkillDir(): string {
  return resolve(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), "..", "..", "..", "agent-skills", "ow-compiler");
}

export async function runCaptureCmd(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const explicit = flagString(args, "session");
  const file = explicit ?? latestSessionFileIn(undefined, process.cwd());

  if (!file || !existsSync(file)) {
    process.stderr.write(
      "找不到会话文件。\n" +
      (explicit ? `指定路径不存在：${explicit}\n` : "当前目录下没有 dsh 会话记录。\n") +
      "用 --session <文件> 指定，或在 agent 里说「小q 沉淀」。\n",
    );
    return 2;
  }

  const planOnly = flagBool(args, "plan");
  const opts = {
    sessionFile: file,
    vaultDir: v.dir,
    skillDir: compilerSkillDir(),
    turns: Number(flagString(args, "turns") ?? 30),
    maxWindows: Number(flagString(args, "max-windows") ?? 8),
    planOnly,
  };

  if (planOnly) {
    const wins = planWindows(opts);
    if (wins.length === 0) {
      out(args, "没有待编译窗口（会话未满一个窗口，或已全部编译过）。", { windows: [] });
      return 0;
    }
    const lines = [`会话：${file}`, `凭据：${describeCredentialSituation()}`, ""];
    for (const w of wins) {
      const mark = w.signal.keep ? "✓" : "✗";
      lines.push(`${mark} 第 ${w.from_turn}–${w.to_turn} 轮（${w.turns} 轮 / ${w.chars} 字符）`);
      lines.push(`   信号：${w.signal.reason}  工具调用 ${w.signal.stats.toolCalls} 次`);
    }
    lines.push("", `共 ${wins.length} 个窗口，其中 ${wins.filter((w) => w.signal.keep).length} 个会编译`);
    out(args, lines.join("\n"), { windows: wins, credential: describeCredentialSituation() });
    return 0;
  }

  const r = await runCapture(opts);
  switch (r.status) {
    case "subagent":
      out(args, "这是子代理会话，不参与知识编译。", { status: r.status });
      return 0;
    case "empty":
      out(args, "会话文件里没有可解析事件。", { status: r.status });
      return 0;
    case "nothing-pending":
      out(args, "没有待编译轮次（已全部编译过）。", { status: r.status });
      return 0;
    case "planned":
      out(args, `切出 ${r.windows.length} 个窗口，但都被信号门剔除（不值得编译）。`, {
        status: r.status,
        windows: r.windows,
      });
      return 0;
    case "no-llm":
      out(args, [
        "CLI 进程没有可用的模型凭据，无法直接编译。",
        `原因：${r.reason}`,
        "",
        "已排队，等宿主会话接手：",
        ...r.queued.map((q) => `  · ${q}`),
        "",
        "两条出路：",
        "  1. 回 agent 里说「小q 沉淀」——用宿主自己的凭据编译（推荐）",
        "  2. 配独立凭据：export OPENAI_API_KEY=... 或 AUTOSKILL_PROVIDER=...",
      ].join("\n"), { status: r.status, reason: r.reason, queued: r.queued });
      return 3;
    case "compiled": {
      const total = r.reports.reduce((n, x) => n + x.pages_created + x.pages_updated, 0);
      out(args, [
        `编译完成：${r.reports.length} 个窗口，产出 ${total} 页（模型 ${r.model}）`,
        ...r.reports.map((x) =>
          `  第 ${x.from_turn}–${x.to_turn} 轮：新增 ${x.pages_created}、更新 ${x.pages_updated}、跳过 ${x.pages_skipped.length}`),
        "",
        "下一步：ow publish",
      ].join("\n"), { status: r.status, reports: r.reports });
      return 0;
    }
    case "error":
      process.stderr.write(`编译失败：${r.error}\n`);
      return 1;
  }
}
