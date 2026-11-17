/** setup 一键安装：dry-run 不应写盘/联网，且 JSON 形状稳定 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");

section("setup --dry-run --host pi");
{
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", join(REPO, "scripts", "setup.ts"), "--host", "pi", "--dry-run", "--json"],
    { cwd: REPO, encoding: "utf8", timeout: 30_000 },
  );
  const d = JSON.parse(out) as { ok: boolean; hosts: string[]; steps: Array<{ name: string; ok: boolean }>; errors: string[] };
  eq(d.ok, true, "dry-run 成功");
  eq(d.hosts, ["pi"], "只处理 pi");
  ok(d.steps.some((s) => s.name === "预检"), "有预检步骤");
  ok(d.steps.some((s) => s.name === "仓库技能"), "有仓库技能步骤");
  ok(d.steps.every((s) => s.ok), "dry-run 所有步骤通过");
  eq(d.errors, [], "无错误");
}

section("未知宿主拒绝");
{
  let code = 0;
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", join(REPO, "scripts", "setup.ts"), "--host", "nope", "--dry-run"],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    code = err.status ?? 1;
    stderr = err.stderr ?? "";
  }
  eq(code, 2, "退出码 2");
  ok(stderr.includes("未知宿主"), "给出宿主说明", stderr);
}

process.exit(summary());
