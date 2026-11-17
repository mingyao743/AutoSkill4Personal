/** ow doc upload dry-run：不联网、不写平台 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { initVault } from "../lib/vault/init.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const CLI = join(REPO, "packages", "cli", "src", "main.ts");

section("doc upload --dry-run");
{
  const root = mkdtempSync(join(tmpdir(), "qdoc-doc-"));
  const vault = initVault(root);
  const file = join(root, "sample.pdf");
  writeFileSync(file, "%PDF-1.4\n%fake\n", "utf8");
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "doc", "upload", file, "--vault", vault.dir, "--dry-run", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const d = JSON.parse(out) as { status: string; filename: string; size: number; tags: string[] };
  eq(d.status, "dry-run", "dry-run");
  eq(d.filename, "sample.pdf", "filename");
  ok(d.size > 0, "size");
  ok(d.tags.some((t) => t.startsWith("p:")), "自动项目 tag", d.tags.join(","));
  rmSync(root, { recursive: true, force: true });
}

section("不支持的扩展名拒绝");
{
  const root = mkdtempSync(join(tmpdir(), "qdoc-doc2-"));
  const vault = initVault(root);
  const file = join(root, "x.exe");
  writeFileSync(file, "MZ", "utf8");
  let code = 0;
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "doc", "upload", file, "--vault", vault.dir, "--dry-run"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    code = err.status ?? 1;
    stderr = err.stderr ?? "";
  }
  eq(code, 2, "退出码 2");
  ok(stderr.includes("不支持的文件类型"), "明确报错", stderr);
  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
