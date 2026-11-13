import { rebuildIndex, rebuildHot, scanPages } from "../../../core/lib/vault/index.ts";
import { appendLog } from "../../../core/lib/vault/index.ts";
import { needVault, out } from "../vault-ctx.ts";
import type { ParsedArgs } from "../args.ts";

export async function runMaintain(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const idx = rebuildIndex(v.dir);
  const hot = rebuildHot(v.dir);
  appendLog(v.dir, `手动整理：索引 ${idx.pages} 页，热缓存 ${hot.pages} 页`);
  out(args, [
    `索引重建：${idx.pages} 页`,
    `热缓存：${hot.pages} 页（近 7 天改动）`,
    `路径：${v.dir}`,
  ].join("\n"), { pages: idx.pages, hot: hot.pages, vault: v.dir });
  return 0;
}
