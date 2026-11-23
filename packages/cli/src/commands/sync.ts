/**
 * `ow sync`：技能双向同步。
 *
 * 推：本地 → 平台（`import_skill_from_files` / `update_skill`）
 * 拉：平台 → 本地（两级：轻量列表 + 全量内容比对）
 *
 * 自动检查：每天第一次有用户活动时跑一次（见 sync/auto-check.ts）；
 * `ow sync` 保留为手动全量/补跑入口：
 *  - `--light`：`list_available_skills`（2.9KB / 29ms）→ 发现新增、移除/禁用
 *  - 全量：逐个 `get_skill`（1.27MB / 3.7s）→ 发现内容更新
 *
 * 为什么不全量：6 个技能全量 1.27MB，每小时一次就是 30MB/天。
 * 为什么不能只轻量：`list_available_skills` 不返回 version，查不出内容更新。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { QdocMcpClient } from "../../../core/lib/publish/mcp.ts";
import { scanSkillsDir, pushSkill, checkEligibility, extractSkillDescription } from "../../../core/lib/publish/skill.ts";
import { pullSkills, checkLight, describePull, readSkillDir, extractSkillFiles } from "../../../core/lib/sync/pull-skill.ts";
import {
  recordPush, manifestStatsAll, stalePendingEnableAll, hashSkillFiles,
} from "../../../core/lib/sync/manifest.ts";
import { queueSkillOverwrite, queueSkillPendingEnable } from "./review.ts";
import { isAllowed } from "../../../core/lib/review/pending.ts";
import { needVault, out } from "../vault-ctx.ts";
import { flagBool, flagString, type ParsedArgs } from "../args.ts";
import { HOST_DIRS, hostSkillDir, type HostName } from "../../../core/lib/sync/install.ts";

const SYNC_HOSTS: HostName[] = ["dsh", "pi", "qoder", "codebuddy", "opencode"];

/** 本地技能目录（宿主不同位置不同；与 install-skill / drift 共用一份 HOST_DIRS） */
export function localSkillsDir(host: string): string {
  if (host in HOST_DIRS) return hostSkillDir(host as HostName);
  return join(homedir(), ".dsh", "skills");
}

/** 读取 no-push 名单：~/.config/qdoc/no-push.json（JSON 数组）里的 skill 不会被推送到平台 */
function readNoPushList(): Set<string> {
  try {
    const raw = readFileSync(join(homedir(), ".config", "qdoc", "no-push.json"), "utf-8");
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

export async function runSync(args: ParsedArgs): Promise<number> {
  const v = needVault(args);
  const dryRun = flagBool(args, "dry-run");
  const direction = flagString(args, "direction") ?? "both";
  const hostArg = flagString(args, "host") ?? "dsh";
  if (hostArg !== "all" && !SYNC_HOSTS.includes(hostArg as HostName)) {
    process.stderr.write(`未知宿主：${hostArg}（可选 ${SYNC_HOSTS.join("|")}|all）\n`);
    return 2;
  }
  const hostList: HostName[] = hostArg === "all" ? SYNC_HOSTS : [hostArg as HostName];
  const lightOnly = flagBool(args, "light");
  const adopt = flagBool(args, "adopt");
  const only = flagString(args, "only");
  const yes = flagBool(args, "yes");
  // --skills-root 覆盖默认位置：多宿主、自定义目录、或沙箱里指向可写区
  // 指定它时只处理第一个宿主，避免把同一个目录写四遍。
  const skillsRootOverride = flagString(args, "skills-root");
  const pushRoot = skillsRootOverride ?? localSkillsDir(hostList[0]);
  const effectiveHosts = skillsRootOverride ? [hostList[0]] : hostList;

  const client = new QdocMcpClient({ token: process.env.QDOC_TOKEN });
  await client.initialize();

  const lines: string[] = [];
  let pushed = 0;
  let pulled = 0;

  // ---------- 轻量检查（29ms，无论哪个方向都先跑） ----------
  const light = await checkLight({ client, vaultDir: v.dir, host: hostList[0] });
  if (light.healed.length > 0) {
    lines.push(`✓ 待启用自愈：${light.healed.join(", ")} 已在平台启用`);
  }
  if (light.newOnPlatform.length > 0) {
    lines.push(`· 平台新增：${light.newOnPlatform.join(", ")}`);
  }
  if (light.missingOnPlatform.length > 0) {
    lines.push(`· 平台已禁用/移除：${light.missingOnPlatform.join(", ")}（本地保留，未删）`);
  }
  const stale = stalePendingEnableAll(v.dir);
  if (stale.length > 0) {
    lines.push(
      `⚠ 这些技能推上去超过 7 天仍未启用：${stale.join(", ")}`,
      "  平台没有启用 API，需要到 qdoc.chat 技能页手动点一下「启用」。",
    );
  }

  if (lightOnly) {
    const st = manifestStatsAll(v.dir);
    lines.push("", `清单：共 ${st.total}（拉取 ${st.pulled} / 推送 ${st.pushed} / 本地 ${st.local}），待启用 ${st.pendingEnable}`);
    out(args, lines.join("\n"), {
      light: { healed: light.healed, newOnPlatform: light.newOnPlatform, missingOnPlatform: light.missingOnPlatform },
      manifest: st,
    });
    return 0;
  }

  // ---------- 推：本地 → 平台 ----------
  if (direction === "both" || direction === "push") {
    lines.push("", `推送（本地 ${pushRoot}；多宿主只以 ${hostList[0]} 为准）：`);
    const noPush = readNoPushList();
    const local = scanSkillsDir(pushRoot).filter((s) => !only || s.name === only);
    for (const s of local) {
      if (noPush.has(s.name)) {
        lines.push(`⊘ ${s.name}：跳过推送（no-push 名单）`);
        continue;
      }
      const elig = checkEligibility(s);
      if (!elig.ok) {
        lines.push(`⊘ ${s.name}：不可推（${elig.reasons.join("；")}）`);
        continue;
      }
      const desc = readSkillDescription(s.dir) ?? `${s.name} 技能`;

      // **唯一的不可回滚操作**：覆盖平台已有的同名技能。
      // 没带 --yes 就不推，只入队等人确认——这是方案 §11.1 的核心防线。
      const existing = light.available.find((p) => p.name === s.name);
      if (existing && !dryRun && !yes) {
        const detail = (await client.getSkill(existing.id)) as { version?: number; files?: unknown[] };
        const remoteFiles = extractSkillFiles(detail);
        const same = remoteFiles.length > 0 && hashSkillFiles(remoteFiles) === hashSkillFiles(s.files);
        const descSame = (existing.description ?? "") === desc;
        if (same && descSame) {
          lines.push(`＝ ${s.name}：unchanged（内容与平台一致，未推）`);
          continue;
        }
        if (same && !descSame) {
          // 文件一字未变、只有 description 对不上（提取器曾把 YAML 折叠标量读成 ">"）。
          // 这不是覆盖内容，是修坏值——不走确认队列，直接更 description。
          const r = await pushSkill({ client, skill: s, platformSkills: light.available, description: desc });
          if (r.action === "updated") pushed++;
          lines.push(`→ ${s.name}：desc 修复（文件未变，仅更新 description，v${r.version ?? "?"}）`);
          continue;
        }
        // 用户说过「以后不再问」就照办（ow review 里按过 x）
        const probe = {
          kind: "skill-overwrite" as const,
          created_at: "",
          severity: "high" as const,
          title: "",
          detail: { skill: s.name },
          action: { reversible: false },
        };
        if (!isAllowed(v.dir, probe)) {
          queueSkillOverwrite(v.dir, {
            skill: s.name,
            skillId: existing.id,
            from: typeof detail.version === "number" ? detail.version : undefined,
            to: (typeof detail.version === "number" ? detail.version : 0) + 1,
            files: s.files.length,
          });
          lines.push(`⚠ ${s.name}：会覆盖线上 v${detail.version ?? "?"}，已入队待确认（ow review）`);
          continue;
        }
        lines.push(`→ ${s.name}：已放行（曾选「不再问」），直接覆盖`);
      }

      const r = await pushSkill({
        client, skill: s, platformSkills: light.available, description: desc, dryRun,
      });
      if (r.action === "imported" || r.action === "updated") pushed++;
      lines.push(`→ ${s.name}：${r.action}${r.message ? `（${r.message}）` : ""}`);

      if (!dryRun && r.action === "imported" && r.needsEnable) {
        queueSkillPendingEnable(v.dir, { skill: s.name, skillId: r.skillId, files: s.files.length });
      }
      if (!dryRun && (r.action === "imported" || r.action === "updated")) {
        recordPush(v.dir, s.name, {
          skill_id: r.skillId ?? null,
          version: r.version ?? 0,
          sha: hashSkillFiles(s.files),
          target: s.dir,
          pendingEnable: r.needsEnable === true,
        }, hostList[0]);
      }
    }
  }

  // ---------- 拉：平台 → 本地 ----------
  if (direction === "both" || direction === "pull") {
    for (const h of effectiveHosts) {
      const skillsRoot = skillsRootOverride ?? localSkillsDir(h);
      lines.push("", `拉取（平台 → ${h}: ${skillsRoot}）：`);
      const results = await pullSkills({ client, vaultDir: v.dir, skillsRoot, dryRun, adopt, host: h });
      const adoptable: string[] = [];
      for (const r of results) {
        if (r.action === "created" || r.action === "updated" || r.action === "adopted") pulled++;
        if (r.action === "adoptable") adoptable.push(r.name);
        lines.push(describePull(r));
      }
      if (adoptable.length > 0) {
        lines.push(
          "",
          `有 ${adoptable.length} 个本地技能内容与平台不同，未自动接管：${adoptable.join(", ")}`,
          "  · 想交给平台管：ow sync --direction pull --adopt（保留本地内容，后续平台更新会覆盖）",
          "  · 想自己留着：什么都不做，本工具永远不碰它",
        );
      }
    }
  }

  const st = manifestStatsAll(v.dir);
  lines.push(
    "",
    `合计：推送 ${pushed}、拉取 ${pulled}${dryRun ? "（干跑）" : ""}`,
    `清单：共 ${st.total}（拉取 ${st.pulled} / 推送 ${st.pushed} / 本地 ${st.local}），待启用 ${st.pendingEnable}`,
  );
  out(args, lines.join("\n"), {
    pushed, pulled, dryRun, manifest: st, platform: light.available.length,
  });
  return 0;
}

/** 从 SKILL.md 的 frontmatter 读 description（平台 import 必填） */
function readSkillDescription(dir: string): string | null {
  const files = readSkillDir(dir);
  const skill = files.find((f) => f.path === "SKILL.md");
  if (!skill) return null;
  return extractSkillDescription(skill.content);
}
