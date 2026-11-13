/**
 * `ow promote`：把知识页升级成技能。
 *
 * 为什么是手动命令而不是自动：技能会改变 agent 的行为，**质量差的技能比没有更糟**。
 * 所以扫描可以自动，打包必须人看一眼（`--dry-run` 默认）。
 *
 * 流程：
 *   扫描候选 → 打包 → 检查平台限制 → 写盘 / 打印
 *   写盘后要推的话，走 `ow sync --direction push`（会过 review 防线）
 */
import { join } from "node:path";
import { scanCandidates, explainPage, MIN_LINEAGE, MIN_REFS } from "../../../core/lib/promoter/scan.ts";
import {
  packageSkill, writePackage, describePackage, checkPackage, toSkillName,
} from "../../../core/lib/promoter/package.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";

export async function runPromote(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const explain = flagString(args, "explain");
  const dryRun = flagBool(args, "dry-run") || !flagBool(args, "write");
  const limit = Number(flagString(args, "limit") ?? 20);

  // --explain <page>：为什么这页不够格
  if (explain) {
    const r = explainPage(v.dir, explain);
    if (!r.page) {
      process.stderr.write(`找不到页面：${explain}\n`);
      return 2;
    }
    const lines = [
      `页面：${r.page.path}`,
      `标题：${r.page.title}`,
      "",
      `lineage：${r.lineage}（需 ≥${MIN_LINEAGE}）`,
      `被引用：${r.refs}（需 ≥${MIN_REFS}）`,
      `可执行步骤：${r.hasProcedure ? "有" : "无"}`,
      "",
      r.missing.length === 0 ? "✓ 够格升级成技能" : `✗ 还差：${r.missing.join("；")}`,
    ];
    out(args, lines.join("\n"), { explain: r });
    return 0;
  }

  const candidates = scanCandidates(v.dir, { limit });
  if (candidates.length === 0) {
    out(args, [
      "没有够格升级的页面。",
      "",
      `门槛：≥${MIN_LINEAGE} 个独立会话验证、≥${MIN_REFS} 次被引用、有可执行步骤。`,
      "看某一页差在哪：ow promote --explain <页面路径>",
    ].join("\n"), { candidates: [] });
    return 0;
  }

  const lines: string[] = [
    `找到 ${candidates.length} 个技能候选${dryRun ? "（干跑，未写盘）" : ""}：`,
    "",
  ];

  const only = flagString(args, "only");
  const targets = only ? candidates.filter((c) => c.pagePath === only || c.title === only) : candidates;

  if (targets.length === 0) {
    process.stderr.write(`没有匹配「${only}」的候选。\n`);
    return 2;
  }

  const results: Array<{ name: string; ok: boolean; reasons: string[] }> = [];
  for (const c of targets) {
    const pkg = packageSkill(v.dir, c, {
      name: flagString(args, "name"),
      description: flagString(args, "description"),
    });
    const chk = checkPackage(pkg);
    results.push({ name: pkg.name, ok: chk.ok, reasons: chk.reasons });

    lines.push(`[${c.score}] ${c.title}`);
    lines.push(`    ${c.pagePath}  →  技能名 ${pkg.name}`);
    lines.push(`    ${c.reasons.join("；")}`);
    lines.push(`    ${describePackage(pkg)}`);
    if (!chk.ok) {
      lines.push(`    ✗ 不可推：${chk.reasons.join("；")}`);
    }
    lines.push("");

    if (!dryRun && chk.ok) {
      const dir = join(v.dir, "..", "agent-skills", pkg.name);
      const written = writePackage(dir, pkg);
      lines.push(`    → 已写 ${written.length} 个文件到 ${dir}`);
      lines.push(`    → 下一步：ow sync --direction push --only ${pkg.name}`);
      lines.push("");
    }
  }

  lines.push(
    dryRun
      ? "干跑结束。确认无误后加 --write 真正生成。"
      : `已生成 ${results.filter((r) => r.ok).length} 个技能包。`,
  );

  out(args, lines.join("\n"), { dryRun, results, candidates });
  return results.some((r) => !r.ok) ? 1 : 0;
}
