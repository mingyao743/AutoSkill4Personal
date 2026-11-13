/**
 * 极简参数解析：`ow <命令> [位置参数] [--flag] [--key=value]`。
 * 不引 commander——只需要十几个命令，且要能在 `node --experimental-strip-types`
 * 下零依赖跑起来。
 */
export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        // `--dry-run` 后面跟另一个 flag 或没有 → 当布尔
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (!command) {
      command = a;
      continue;
    }
    positional.push(a);
  }
  return { command, positional, flags };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}
