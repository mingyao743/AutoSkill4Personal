/** CLI 命令共用的 vault 定位与输出辅助 */
import { resolveVault, type VaultInfo } from "../../core/lib/vault/init.ts";
import { flagString, flagBool, type ParsedArgs } from "./args.ts";

export function needVault(args: ParsedArgs): VaultInfo {
  const explicit = flagString(args, "vault");
  const v = resolveVault({ cwd: explicit ?? process.cwd(), autoInit: false });
  if (!v) {
    throw new Error(
      `没找到 .qdoc/ 知识库（从 ${explicit ?? process.cwd()} 向上查找）。\n` +
      "先跑 `ow init` 初始化。",
    );
  }
  return v;
}

export function isJson(args: ParsedArgs): boolean {
  return flagBool(args, "json");
}

export function out(args: ParsedArgs, human: string, data?: unknown): void {
  if (isJson(args)) {
    process.stdout.write(`${JSON.stringify(data ?? { text: human }, null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}
