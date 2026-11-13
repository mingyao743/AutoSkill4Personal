import { resolveVault, initVault, findGitRoot } from "../../../core/lib/vault/init.ts";
import { linkVault } from "../../../core/lib/vault/link.ts";
import { rebuildIndex, rebuildHot } from "../../../core/lib/vault/index.ts";
import { flagString, flagBool, type ParsedArgs } from "../args.ts";
import { out } from "../vault-ctx.ts";

export async function runInit(args: ParsedArgs): Promise<number> {
  const explicit = flagString(args, "vault");
  const cwd = explicit ?? process.cwd();
  const root = findGitRoot(cwd) ?? cwd;
  const v = initVault(root);
  rebuildIndex(v.dir);
  rebuildHot(v.dir);

  let linkMsg = "";
  if (flagBool(args, "link")) {
    const r = linkVault(v.projectRoot);
    linkMsg = `软链：${r.action} ${r.path} -> ${r.target}`;
  }

  out(args, [
    `vault 就绪：${v.dir}`,
    `项目根：${v.projectRoot}`,
    linkMsg,
    "",
    "下一步：",
    "  1. 在 agent 里正常干活（满 30 轮自动编译），或说「小q 沉淀」立刻编译",
    "  2. `ow publish` 推到 qdoc.chat",
    "  3. 配 token：export QDOC_TOKEN=... 或写到 ~/.config/qdoc/token",
  ].filter(Boolean).join("\n"), { vault: v.dir, projectRoot: v.projectRoot });
  return 0;
}
