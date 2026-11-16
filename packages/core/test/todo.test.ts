/** ow todo / ow doc 的纯辅助：格式化、tag 计算、目标解析 */
import { ok, eq, section, summary } from "./_harness.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksLikeUuid, dueShort, formatTodoItems, nextTags, resolveDocTarget, syncLedgerFilename,
} from "../lib/todo.ts";
import { readLedger, writeLedger } from "../lib/publish/ledger.ts";
import type { TodoItem } from "../lib/publish/mcp.ts";

section("UUID 与日期");
ok(looksLikeUuid("94895c80-6b5c-4d7e-915e-16ce2183aa9c"), "标准 UUID");
ok(!looksLikeUuid("33"), "数字 id 不是 UUID");
ok(!looksLikeUuid("references/foo.md"), "路径不是 UUID");
eq(dueShort("2026-11-20"), "11-20", "日期只留月-日");
eq(dueShort("2026-11-20 09:30:00"), "11-20", "带时间也只留月-日");
eq(dueShort(null), "", "空截止");

section("待办格式化：排序与标记");
const items: TodoItem[] = [
  { id: "c", title: "无截止", priority: 1 },
  { id: "a", title: "截止更晚", priority: 0, due_date: "2026-11-25" },
  { id: "b", title: "截止更早", priority: 3, due_date: "2026-11-18" },
  { id: "d", title: "已完成", is_done: true, priority: 0, due_date: "2026-11-18" },
];
const lines = formatTodoItems(items).split("\n");
// 排序：先按截止（无截止最后），同截止按优先级 → d(11-18,P0) b(11-18,P3) a(11-25) c(无)
ok(lines[0].startsWith("✓") && lines[0].includes("已完成"), "同截止下高优先级在前（恰为已完成项）");
ok(lines[1].includes("截止更早") && lines[1].startsWith("○"), "未完成用 ○");
ok(lines[3].includes("无截止"), "无截止的排最后");
ok(lines[1].includes("P3") && lines[0].includes("P0"), "优先级标注");
ok(lines[1].includes("(id=b)"), "带完整 id 供 done/edit 用");
eq(formatTodoItems([]), "（无待办）", "空列表");

section("tag 计算：增删与 20 字符上限警告");
eq(nextTags(["a", "b"], { add: ["b", "c"] }).tags.join(","), "a,b,c", "add 去重追加");
eq(nextTags(["a", "b"], { remove: ["a"] }).tags.join(","), "b", "remove");
eq(nextTags(["a", "b"], { set: ["x"] }).tags.join(","), "x", "set 整体替换");
const warn = nextTags(["a"], { add: ["project:autoskill4personal"] }).warnings;
eq(warn.length, 1, "超长 tag 给警告");
ok(warn[0].includes("p:<短名>"), "警告里带建议形式");

section("doc 目标解析与台账同步");
const dir = mkdtempSync(join(tmpdir(), "owtodo-"));
writeLedger(dir, {
  schema: 1,
  pages: {
    "references/foo.md": {
      document_id: "60c40bd1-7010-4886-80dd-f8ba15754abd",
      filename: "references-foo.md",
      version: 2,
      body_hash: "sha256:x",
      publish_as: "document",
      status: "published",
      published_at: "2026-11-16T00:00:00Z",
    },
    "references/old.md": {
      document_id: 33,
      filename: "references-old.md",
      version: 1,
      body_hash: "sha256:y",
      publish_as: "document",
      status: "published",
      published_at: "2026-11-16T00:00:00Z",
    },
  },
});
eq(resolveDocTarget(dir, "60c40bd1-7010-4886-80dd-f8ba15754abd").docId,
  "60c40bd1-7010-4886-80dd-f8ba15754abd", "UUID 直用");
eq(resolveDocTarget(dir, "references/foo.md").docId,
  "60c40bd1-7010-4886-80dd-f8ba15754abd", "台账 key 命中");
eq(resolveDocTarget(dir, "references-foo.md").docId,
  "60c40bd1-7010-4886-80dd-f8ba15754abd", "按台账 filename 反查");
let threw = "";
try { resolveDocTarget(dir, "references/old.md"); } catch (e) { threw = String(e); }
ok(threw.includes("ow publish"), "旧数字 id 给出自愈指引而非含糊报错");
threw = "";
try { resolveDocTarget(dir, "references/nope.md"); } catch (e) { threw = String(e); }
ok(threw.includes("没找到"), "未知目标明确报错");

ok(syncLedgerFilename(dir, "60c40bd1-7010-4886-80dd-f8ba15754abd", "foo-新名.md"), "同步命中");
eq(readLedger(dir).pages["references/foo.md"].filename, "foo-新名.md", "台账 filename 已更新");
ok(!syncLedgerFilename(dir, "00000000-0000-0000-0000-000000000000", "x.md"), "无关 doc 不同步");

// 测试目录留给系统清理，避免误删
void mkdirSync; void writeFileSync;
process.exit(summary());
