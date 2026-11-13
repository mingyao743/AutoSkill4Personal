import { linkVault, unlinkVault } from "../../../core/lib/vault/link.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

export async function runLink(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const name = flagString(args, "name") ?? "wiki";
  if (flagBool(args, "remove")) {
    const ok = unlinkVault(v.projectRoot, name);
    out(args, ok ? `已删除软链 ${name}` : `没有可删除的软链 ${name}`, { removed: ok });
    return 0;
  }
  const r = linkVault(v.projectRoot, name);
  out(args, `${r.action}：${r.path} -> ${r.target}${r.reason ? `（${r.reason}）` : ""}`, r);
  return 0;
}
