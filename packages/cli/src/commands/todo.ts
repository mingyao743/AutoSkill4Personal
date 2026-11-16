/**
 * `ow todo` —— 平台待办的纯透传（不进台账、不入门禁）。
 *
 *   ow todo list [--all] [--due YYYY-MM-DD] [--project <名|id>]
 *   ow todo add <标题> [--priority 0-3] [--due YYYY-MM-DD] [--project <名|id>] [--note 说明]
 *   ow todo done <id> / undone <id>
 *   ow todo edit <id> [--title s] [--note s] [--priority N] [--due D] [--clear-due] [--project]
 *   ow todo projects
 *
 * todo 是瞬态状态：平台没有删除（只有完成/取消完成），item_id 是全量字符串。
 */
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { dueShort, formatTodoItems } from "../../../core/lib/todo.ts";
import { out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

const HELP = `ow todo —— 平台待办（纯透传）

用法：
  ow todo list [--all] [--due YYYY-MM-DD] [--project <名|id>] [--json]
  ow todo add <标题> [--priority 0-3] [--due YYYY-MM-DD] [--project <名|id>] [--note 说明]
  ow todo done <id>          完成待办
  ow todo undone <id>        取消完成
  ow todo edit <id> [--title s] [--note s] [--priority N] [--due D] [--clear-due]
  ow todo projects           列项目与完成统计

注意：平台无删除，只有完成/取消完成；item_id 用 list 输出的完整 id。`;

/** `--project <名|id>` → 解析成 project_id（名字精确匹配，id 前缀匹配） */
async function resolveProject(client: QdocMcpClient, ref: string): Promise<string> {
  const projects = await client.listTodoProjects();
  const hit = projects.find((p) => p.name === ref) ?? projects.find((p) => p.id === ref) ??
    projects.find((p) => p.id.startsWith(ref));
  if (!hit) {
    throw new Error(`没找到项目 "${ref}"。现有：${projects.map((p) => p.name).join("、") || "（无）"}`);
  }
  return hit.id;
}

/** edit/done 的前置：把 item 连同 version 捞出来（version 供乐观锁） */
async function fetchItem(client: QdocMcpClient, id: string) {
  const items = await client.listTodoItems({ includeDone: true, limit: 200 });
  const hit = items.find((t) => t.id === id || t.id.startsWith(id));
  if (!hit) throw new Error(`没找到待办 "${id}"。先 ow todo list 拿完整 id。`);
  return hit;
}

export async function runTodo(args: ParsedArgs): Promise<number> {
  try {
    return await todoDispatch(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // token 是分权限的（todo:read / todo:write）：旧 token 没有待办权限，给出可执行的修复动作
    if (/todo:read|todo:write|令牌缺少权限/.test(msg)) {
      process.stderr.write(
        `${msg}\n当前 token 没有待办权限。去 qdoc.chat 重新生成 token（勾选待办/ todo 权限），` +
        `然后更新 ~/.config/qdoc/token。\n`,
      );
      return 1;
    }
    throw e;
  }
}

async function todoDispatch(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0] ?? "list";
  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });

  if (sub === "list") {
    const projectRef = flagString(args, "project");
    const items = await client.listTodoItems({
      includeDone: flagBool(args, "all"),
      dueBefore: flagString(args, "due"),
      projectId: projectRef ? await resolveProject(client, projectRef) : undefined,
    });
    const open = items.filter((t) => !t.is_done).length;
    out(args, `${formatTodoItems(items)}\n\n共 ${items.length} 条（未完成 ${open}）`, { items });
    return 0;
  }

  if (sub === "add") {
    const title = args.positional.slice(1).join(" ").trim();
    if (!title) { process.stderr.write("用法：ow todo add <标题> [--priority N] [--due D]\n"); return 2; }
    const projectRef = flagString(args, "project");
    const item = await client.createTodoItem({
      title,
      description: flagString(args, "note"),
      priority: flagString(args, "priority") ? Number(flagString(args, "priority")) : undefined,
      dueDate: flagString(args, "due"),
      projectId: projectRef ? await resolveProject(client, projectRef) : undefined,
    });
    out(args, `✓ 已添加：${item.title}${item.due_date ? `（截止 ${dueShort(item.due_date)}）` : ""}\n  id=${item.id}`, { item });
    return 0;
  }

  if (sub === "done" || sub === "undone") {
    const id = args.positional[1];
    if (!id) { process.stderr.write(`用法：ow todo ${sub} <id>\n`); return 2; }
    const item = await fetchItem(client, id);
    const res = await client.completeTodoItem({ itemId: item.id, done: sub === "done", baseVersion: item.version });
    out(args, `${res.is_done ? "✓ 已完成" : "○ 已取消完成"}：${res.id === item.id ? item.title : res.title ?? item.title}`, { item: res });
    return 0;
  }

  if (sub === "edit") {
    const id = args.positional[1];
    if (!id) { process.stderr.write("用法：ow todo edit <id> [--title s] [--priority N] ...\n"); return 2; }
    const item = await fetchItem(client, id);
    const projectRef = flagString(args, "project");
    const res = await client.updateTodoItem({
      itemId: item.id,
      baseVersion: item.version ?? 1,
      title: flagString(args, "title"),
      description: flagString(args, "note"),
      priority: flagString(args, "priority") != null ? Number(flagString(args, "priority")) : undefined,
      dueDate: flagString(args, "due"),
      clearDueDate: flagBool(args, "clear-due"),
      projectId: projectRef ? await resolveProject(client, projectRef) : undefined,
      isDone: flagBool(args, "done") ? true : flagBool(args, "undone") ? false : undefined,
    });
    out(args, `✓ 已更新：${res.title}（v${res.version}）`, { item: res });
    return 0;
  }

  if (sub === "projects") {
    const projects = await client.listTodoProjects();
    const lines = projects.map((p) =>
      `${p.is_archived ? "[归档] " : ""}${p.name}：${p.done_count ?? 0}/${p.total_count ?? 0} 完成 (id=${p.id})`);
    out(args, lines.join("\n") || "（无项目）", { projects });
    return 0;
  }

  if (sub === "help" || sub === "--help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  process.stderr.write(`未知子命令：ow todo ${sub}\n\n${HELP}\n`);
  return 2;
}

/** 供 `ow --help` 引用的一句话说明 */
export const TODO_BRIEF = "todo        平台待办（list/add/done/edit/projects，纯透传）";
