#!/usr/bin/env node
/**
 * 跑全部新测试。每个文件独立进程（互不污染全局状态，如 QDOC_MACHINE_DIR）。
 *
 * 用法：node --experimental-strip-types packages/core/test/run-all.ts
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

let failed = 0;
const results: Array<{ name: string; ok: boolean; out: string }> = [];

for (const f of files) {
  const path = join(here, f);
  try {
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", path],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    results.push({ name: f, ok: true, out });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    failed += 1;
    results.push({ name: f, ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` });
  }
}

for (const r of results) {
  const tail = r.out.trim().split("\n").filter((l) => /pass \/|失败项|FAIL/.test(l)).join("\n");
  process.stdout.write(`${r.ok ? "✓" : "✗"} ${r.name}\n`);
  if (tail) process.stdout.write(`${tail.split("\n").map((l) => `    ${l}`).join("\n")}\n`);
}

const total = results.length;
process.stdout.write(`\n${total - failed}/${total} 个测试文件通过\n`);
process.exit(failed > 0 ? 1 : 0);
