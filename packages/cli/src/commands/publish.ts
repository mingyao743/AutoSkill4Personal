import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanPages } from "../../../core/lib/vault/index.ts";
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { publishPages, type PublishPageResult } from "../../../core/lib/publish/publish.ts";
import { defaultRedactPolicy } from "../../../core/lib/security/redact.ts";
import { readLedger } from "../../../core/lib/publish/ledger.ts";
import { tombstonePage } from "../../../core/lib/publish/tombstone.ts";
import { orphanedOnPlatform } from "../../../core/lib/publish/tombstone.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

export async function runPublish(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const dryRun = flagBool(args, "dry-run");
  const only = flagString(args, "page");
  const doTombstone = flagBool(args, "tombstone");

  const ledger = readLedger(v.dir);

  // 待发布：publish_as != local 且账本里没有「已发布且哈希一致」的页
  const all = scanPages(v.dir);
  let targets = all
    .filter((p) => {
      const as = p.meta.publish_as;
      return as !== "local";
    })
    .map((p) => p.path);

  if (only) targets = targets.filter((t) => t.includes(only));
  if (targets.length === 0) {
    out(args, "没有待发布页面。", { published: [], count: 0 });
    return 0;
  }

  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
  await client.initialize();

  const results = await publishPages({
    client,
    vaultDir: v.dir,
    projectRoot: v.projectRoot,
    pagePaths: targets,
    dryRun,
    redact: (flagString(args, "redact") as "block" | "replace" | "warn" | undefined) ?? defaultRedactPolicy(),
  });

  // 本地已删但平台还在 → 提示墓碑
  const orphans = orphanedOnPlatform(v.dir, v.projectRoot);
  if (doTombstone) {
    for (const p of orphans) {
      const r = await tombstonePage({ client, vaultDir: v.dir, pagePath: p, dryRun });
      process.stdout.write(`墓碑 ${p}：${r.action}${r.message ? `（${r.message}）` : ""}\n`);
    }
  }

  const code = reportResults(args, results, dryRun, orphans, !!ledger);
  const notice = client.takeNotice();
  if (notice) process.stdout.write(`\n⚠ 平台提示：${notice}\n`);
  return code;
}

function reportResults(
  args: ParsedArgs,
  results: PublishPageResult[],
  dryRun: boolean,
  orphans: string[],
  hasLedger: boolean,
): number {
  const by = (a: PublishPageResult["action"]) => results.filter((r) => r.action === a);
  const lines: string[] = [];
  if (dryRun) lines.push("（干跑模式，未实际调用平台）");

  for (const r of results) {
    const mark = r.action === "created" ? "＋" : r.action === "updated" ? "↻" : r.action === "skipped" ? "＝" : "✗";
    lines.push(`${mark} ${r.pagePath} → ${r.action}${r.documentId ? ` (id=${r.documentId})` : ""}`);
    if (r.action === "blocked" || r.action === "failed") {
      for (const i of r.gate.issues.filter((x) => x.severity === "block")) {
        lines.push(`    ✗ [${i.gate}] ${i.message}`);
      }
      if (r.message) lines.push(`    ${r.message}`);
    }
  }
  lines.push("");
  lines.push(
    `合计：新建 ${by("created").length}、更新 ${by("updated").length}、` +
    `跳过 ${by("skipped").length}、拦截 ${by("blocked").length}、失败 ${by("failed").length}`,
  );
  if (orphans.length && !hasLedger) {
    lines.push("", `本地已删但平台可能还有 ${orphans.length} 页，可跑 --tombstone 处理`);
  }

  out(args, lines.join("\n"), { results, orphans });
  return by("failed").length > 0 ? 1 : 0;
}
