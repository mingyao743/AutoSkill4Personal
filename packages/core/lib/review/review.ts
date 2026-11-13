/**
 * `ow review`：唯一的交互入口（方案 §11.3）。
 *
 * **为什么只有这一个交互入口**：后台流程（定时器、watcher）不能弹窗问人——
 * dsh 的 headless 模式根本没有可交互的前台。所以后台只写 pending 队列，
 * 人主动跑 `ow review` 时才逐条确认。
 *
 * 交互按键：
 *   [a] 应用     —— 跑条目里的 `action.cli`
 *   [d] 看 diff  —— 只对能算 diff 的类型显示
 *   [s] 跳过     —— 移除这条（下次触发还会再进队）
 *   [x] 不再问   —— 写进 policy.json，同类以后直接放行
 *   [q] 退出
 *
 * **非 tty 自动退化成 `--list`**：CI、管道、重定向都能跑，不会挂住。
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  listPending, removePending, allowItem, isAllowed, kindLabel,
  type PendingEntry,
} from "./pending.ts";

export interface ReviewOptions {
  vaultDir: string;
  /** 只列不交互（非 tty 自动开启） */
  listOnly?: boolean;
  /** 自动应用所有（等同每条都按 a），危险，只在显式 --yes 时用 */
  yes?: boolean;
  /** 显示已被策略放行的条目 */
  showAllowed?: boolean;
  /** 输出流（测试可注入） */
  write?: (s: string) => void;
}

export interface ReviewOutcome {
  total: number;
  applied: number;
  skipped: number;
  allowed: number;
  /** 用户中途退出时剩下的条数 */
  remaining: number;
  /** 应用失败的条目 */
  failed: Array<{ item: PendingEntry; error: string }>;
}

/** 是否可交互（有 tty 且不是 CI） */
export function isInteractive(): boolean {
  if (process.env.CI) return false;
  if (process.env.OW_NO_TTY) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** 渲染一条待确认事项 */
export function renderItem(item: PendingEntry, index: number, total: number): string {
  const lines: string[] = [];
  const sev = item.severity === "high" ? "⚠ " : "";
  lines.push(`[${index + 1}/${total}] ${sev}${item.title || kindLabel(item.kind)}`);

  const d = item.detail ?? {};
  if (d.skill) {
    const ver = d.from != null || d.to != null ? `  v${d.from ?? "?"} → v${d.to ?? "?"}` : "";
    lines.push(`    ${d.skill}${d.skill_id ? `（skill ${String(d.skill_id).slice(0, 8)}…）` : ""}${ver}`);
    if (d.files != null) lines.push(`    ${d.files} 个文件${d.diff_summary ? `，${d.diff_summary}` : ""}`);
  }
  if (d.path) lines.push(`    ${d.path}`);
  if (d.doc_id) lines.push(`    平台文档 id=${d.doc_id}${d.filename ? ` ${d.filename}` : ""}`);
  if (d.dir) lines.push(`    ${d.dir}`);
  if (d.count != null) lines.push(`    ${d.count} 个`);
  if (d.reason) lines.push(`    原因：${d.reason}`);
  if (item.action?.effect) lines.push(`    应用后：${item.action.effect}`);

  const keys = ["[a] 应用"];
  if (canDiff(item)) keys.push("[d] 看 diff");
  keys.push("[s] 跳过", "[x] 不再问", "[q] 退出");
  lines.push(`    ${keys.join("   ")}`);
  return lines.join("\n");
}

/** 哪些类型能显示 diff（只有技能/文档覆盖类有对比物） */
export function canDiff(item: PendingEntry): boolean {
  return (
    (item.kind === "skill-overwrite" || item.kind === "doc-conflict" || item.kind === "skill-conflict") &&
    typeof item.detail?.diff === "string"
  );
}

/** 跑条目里的 CLI 命令；返回是否成功 */
export function applyItem(item: PendingEntry): { ok: boolean; error?: string } {
  const cli = item.action?.cli;
  if (!cli) return { ok: false, error: "这条没有可执行的命令（只能看）" };

  // 只允许跑 `ow` 开头的命令：pending 文件可能来自别处，不能当任意命令执行器
  if (!/^\s*ow\s/.test(cli)) {
    return { ok: false, error: `拒绝执行非 ow 命令：${cli.slice(0, 60)}` };
  }

  const parts = cli.trim().split(/\s+/).slice(1); // 去掉 `ow`
  // 用当前 node 跑 CLI 入口，避免依赖全局 PATH 里有没有 `ow`
  const cliEntry = process.env.OW_CLI_ENTRY;
  const argv = cliEntry
    ? [process.execPath, "--experimental-strip-types", cliEntry, ...parts]
    : [process.execPath, "--experimental-strip-types", "packages/cli/src/main.ts", ...parts];

  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: "pipe" });
  if (r.status === 0) return { ok: true };
  const msg = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ");
  return { ok: false, error: msg || `退出码 ${r.status}` };
}

/** 主流程 */
export async function runReview(opts: ReviewOptions): Promise<ReviewOutcome> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const all = listPending(opts.vaultDir).filter(
    (e) => opts.showAllowed || !isAllowed(opts.vaultDir, e),
  );

  const outcome: ReviewOutcome = {
    total: all.length, applied: 0, skipped: 0, allowed: 0, remaining: 0, failed: [],
  };

  if (all.length === 0) {
    write("没有待确认事项。\n");
    return outcome;
  }

  const listOnly = opts.listOnly || (!opts.yes && !isInteractive());

  if (listOnly || opts.yes) {
    // 非交互：只打印，不等待
    write(`待确认 ${all.length} 项\n\n`);
    for (let i = 0; i < all.length; i++) {
      write(renderItem(all[i], i, all.length) + "\n\n");
    }
    if (listOnly) {
      write("（非交互环境，未处理。到终端跑 `ow review` 可逐条确认）\n");
      outcome.remaining = all.length;
      return outcome;
    }
    // --yes：全部应用
    for (const item of all) {
      const r = applyItem(item);
      if (r.ok) {
        outcome.applied++;
        removePending(item);
        write(`✓ ${item.title || kindLabel(item.kind)}\n`);
      } else {
        outcome.failed.push({ item, error: r.error ?? "未知错误" });
        write(`✗ ${item.title || kindLabel(item.kind)}：${r.error}\n`);
      }
    }
    return outcome;
  }

  // 交互
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));

  write(`待确认 ${all.length} 项\n\n`);
  try {
    for (let i = 0; i < all.length; i++) {
      const item = all[i];
      write(renderItem(item, i, all.length) + "\n");

      let decided = false;
      while (!decided) {
        const ans = await ask("> ");
        switch (ans) {
          case "a":
          case "y": {
            const r = applyItem(item);
            if (r.ok) {
              outcome.applied++;
              removePending(item);
              write("  ✓ 已应用\n\n");
            } else {
              outcome.failed.push({ item, error: r.error ?? "未知错误" });
              write(`  ✗ 失败：${r.error}\n\n`);
            }
            decided = true;
            break;
          }
          case "d": {
            if (canDiff(item)) write(`\n${String(item.detail.diff).slice(0, 4000)}\n\n`);
            else write("  这条没有 diff 可看\n");
            break;
          }
          case "s":
          case "": {
            outcome.skipped++;
            removePending(item);
            write("  → 已跳过（下次触发会重新入队）\n\n");
            decided = true;
            break;
          }
          case "x": {
            const scope = await ask("  只放行这一条 [1] 还是整个类型都不再问 [2]？（默认 1）> ");
            allowItem(opts.vaultDir, item, scope === "2" ? "kind" : "item");
            outcome.allowed++;
            removePending(item);
            write(`  → 已记住：${scope === "2" ? `以后不再问「${kindLabel(item.kind)}」` : "这一条以后不再问"}\n\n`);
            decided = true;
            break;
          }
          case "q":
          case "quit": {
            outcome.remaining = all.length - i;
            write(`\n退出，还剩 ${outcome.remaining} 项。\n`);
            rl.close();
            return outcome;
          }
          default:
            write("  不认识的按键。a=应用 d=diff s=跳过 x=不再问 q=退出\n");
        }
      }
    }
  } finally {
    rl.close();
  }

  write(
    `\n完成：应用 ${outcome.applied}、跳过 ${outcome.skipped}、` +
    `记住 ${outcome.allowed}${outcome.failed.length > 0 ? `、失败 ${outcome.failed.length}` : ""}\n`,
  );
  return outcome;
}
