#!/usr/bin/env node
/**
 * `ow` 命令行入口。
 *
 * 命令一览（方案 §6.5）：
 *   ow init          初始化 .qdoc/ vault
 *   ow status        状态（轮次水位 / 待发布 / 预算 / 锁）
 *   ow capture       手动编译当前会话
 *   ow publish       发布待发布页到平台
 *   ow query         在线检索平台文档
 *   ow sync          技能双向同步
 *   ow review        处理待确认队列
 *   ow link          建 wiki -> .qdoc 软链
 *   ow maintain      重建索引 / 热缓存
 */
import { parseArgs } from "./args.ts";
import { runInit } from "./commands/init.ts";
import { runStatus } from "./commands/status.ts";
import { runPublish } from "./commands/publish.ts";
import { runQuery } from "./commands/query.ts";
import { runSync } from "./commands/sync.ts";
import { runMaintain } from "./commands/maintain.ts";
import { runReviewCmd } from "./commands/review.ts";
import { runLink } from "./commands/link.ts";
import { runCaptureCmd } from "./commands/capture.ts";
import { runPromote } from "./commands/promote.ts";

const HELP = `ow —— qdoc 知识库工具

用法：ow <命令> [选项]

命令：
  init        初始化 .qdoc/ vault（幂等）
  status      状态：轮次水位、待发布、预算、锁
  capture     手动编译会话（--plan 只看窗口，--session 指定文件）
  publish     把 pending 页推到 qdoc.chat
  query <词>  在线检索已发布文档
  sync        技能双向同步（推 + 拉）
  review      处理待确认队列
  link        建 wiki -> .qdoc 软链
  maintain    重建 index.md / hot.md

选项：
  --vault <dir>   指定 vault（默认从 cwd 向上找）
  --dry-run       只跑门禁，不真的调平台
  --json          输出 JSON（供 skill 解析）
  --session <f>   capture 用的会话文件
  --plan          capture 只切窗不编译
  --help          显示本帮助
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (args.command) {
      case "init": return await runInit(args);
      case "status": return await runStatus(args);
      case "publish": return await runPublish(args);
      case "query": return await runQuery(args);
      case "sync": return await runSync(args);
      case "review": return await runReviewCmd(args);
      case "link": return await runLink(args);
      case "maintain": return await runMaintain(args);
      case "capture": return await runCaptureCmd(args);
      case "promote": return await runPromote(args);
      default:
        process.stderr.write(`未知命令：${args.command}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`错误：${e instanceof Error ? e.message : String(e)}\n`);
    if (process.env.OW_DEBUG === "1" && e instanceof Error) process.stderr.write(`${e.stack}\n`);
    return 1;
  }
}

process.exit(await main());
