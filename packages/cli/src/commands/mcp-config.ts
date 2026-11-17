/**
 * `ow mcp-config` —— 生成各 agent 宿主接入 qdoc.chat MCP 的 JSON 片段。
 *
 * 三家宿主的 MCP 配置是同构的 `mcpServers` 结构（实测自三家文档）：
 *   qoder      → ~/.qoder-cn/settings.json 顶层键（没有该文件可直接整个写入）
 *   codebuddy  → 同上结构（CodeBuddy Code CLI）
 *   workbuddy  → 桌面版「连接器 → 自定义连接器」UI 里粘贴（与 CodeBuddy 格式一致）
 *   raw        → 只有 qdoc 服务器对象本身，供嵌进已有配置
 *
 * 安全：JSON 只打 stdout（方便 `ow mcp-config --host qoder > 目标文件`），
 * 提示语走 stderr；**不写任何文件**，token 换了重跑一次即可。
 *
 * alwaysAllow 只放只读工具——写操作（发布/改字段/待办写入）保留逐次确认。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flagString, type ParsedArgs } from "../args.ts";

const HELP = `ow mcp-config —— 生成宿主接入 qdoc MCP 的 JSON（含 token，勿外传）

用法：
  ow mcp-config [--host qoder|codebuddy|workbuddy|raw]
  （pi 没有内置 MCP，不需要本命令）

  JSON 走 stdout，说明走 stderr，可重定向：
    ow mcp-config --host qoder > ~/.qoder-cn/settings.json
  workbuddy 的输出粘到「连接器 → 自定义连接器」配置框。`;

const QDOC_URL = "https://qdoc.chat/mcp";

/** 只读工具白名单：这些 agent 可以直接调；写操作保持逐次确认 */
const READ_ONLY_TOOLS = [
  "list_documents",
  "read_document",
  "search_documents",
  "list_document_tags",
  "list_todo_items",
  "list_todo_projects",
  "list_available_skills",
];

function loadToken(): string {
  const p = join(homedir(), ".config", "qdoc", "token");
  if (!existsSync(p)) {
    process.stderr.write(`找不到 token：${p}\n`);
    process.exit(2);
  }
  const token = readFileSync(p, "utf8").trim();
  if (!token) {
    process.stderr.write(`token 文件为空：${p}\n`);
    process.exit(2);
  }
  return token;
}

export async function runMcpConfig(args: ParsedArgs): Promise<number> {
  if (args.positional[0] === "help" || args.flags["--help"]) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const host = flagString(args, "host") ?? "qoder";
  if (host === "pi") {
    process.stderr.write(
      "pi 没有内置 MCP 客户端（0.84.x 实测），不需要 mcpServers 配置。\n" +
      "qdoc 通过 adapter-pi 扩展 + ow CLI 接入：npm run install-skill -- --host pi\n",
    );
    return 2;
  }
  if (!["qoder", "codebuddy", "workbuddy", "raw"].includes(host)) {
    process.stderr.write(`未知宿主：${host}（可选 qoder|codebuddy|workbuddy|raw；pi 无需 MCP）\n`);
    return 2;
  }
  const token = loadToken();
  const server = {
    type: "http",
    url: QDOC_URL,
    headers: { Authorization: `Bearer ${token}` },
    alwaysAllow: READ_ONLY_TOOLS,
    description: "qdoc 知识库与待办（文档查/发布/改字段/待办）",
  };
  const body = host === "raw" ? server : { mcpServers: { qdoc: server } };

  const hints: Record<string, string> = {
    qoder: "# 写入 ~/.qoder-cn/settings.json（已有该文件则把 mcpServers 键合并进去），重启 Qoder CLI 后 /mcp 验证",
    codebuddy: "# 写入 CodeBuddy Code CLI 的 settings（~/.codebuddy/ 下，见 /docs/cli/codebuddy-dir），/mcp 验证",
    workbuddy: "# 粘贴到 WorkBuddy「技能/连接器 → 连接器 → 自定义连接器」配置框，保存后测试连接",
    raw: "# 嵌入任意支持 mcpServers 结构的宿主配置",
  };
  process.stderr.write(`${hints[host]}\n`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  return 0;
}
