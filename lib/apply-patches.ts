/**
 * 方案 1 应用器：串行消费 intake 提案队列，幂等、自愈、无锁。
 *
 * 语义：
 *  - 提案 = knowledge/intake/<patch_id>.patch.json（生产者只追加唯一名文件，零协调）
 *  - 按创建序串行应用；已应用的跳过
 *  - update 时校验 base_skill_sha：基于的版本已过期（别人先应用过）→ 丢弃提案，
 *    原子退回 pending（本来就没标记），下次会话重做 —— 冲突靠重做消化，不靠锁
 *  - "写文件 + 标记原子"绑同一事务：标记永远不先于内容落地
 *  - 并发 applier 竞态 → 丢标记 → 重做（见 skill-state.ts 并发注释），不会出现
 *    "标记了但内容丢了"或知识丢失
 *
 * 输出目录：默认 ~/.pi/agent/skills/，AUTOSKILL_SKILLS_DIR 可覆盖（与 package-skill 一致）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { kbDir, loadAtoms, logError } from "./atom-store.ts";
import { loadSkillState, saveSkillState } from "./skill-state.ts";
import { appendUsage } from "./usage-store.ts";

export interface SkillPatch {
  patch_id: string;
  created_at: string;
  author?: string;
  domain: string;
  action: "update" | "create";
  /** 提案所基于的 SKILL.md sha1（update 必填；失配=过期提案，丢弃自愈） */
  base_skill_sha?: string;
  /** 本提案整合的原子（幂等单位；丢弃提案时这些原子留 pending 重做） */
  atom_ids: string[];
  /** 完整新 SKILL.md 内容（全量替换，非 diff） */
  skill_md: string;
  /** 附带文件：相对 skill 目录的路径 → 完整内容（references/…） */
  files?: Record<string, string>;
}

export function skillsDir(): string {
  return process.env.AUTOSKILL_SKILLS_DIR ?? join(homedir(), ".pi", "agent", "skills");
}
export function intakeDir(): string {
  return join(kbDir(), "intake");
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

const atomicWrite = (path: string, content: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

export interface ApplyReport {
  applied: string[];   // patch_id
  discarded: string[]; // patch_id（过期/失效，原子留 pending 自愈）
  failed: string[];    // patch_id（IO 异常，留队列下次再试）
}

/** 应用整个队列（幂等，可随时重跑）。不抛异常——失败项留在队列里等下次。 */
export function applyPatches(): ApplyReport {
  const report: ApplyReport = { applied: [], discarded: [], failed: [] };
  if (!existsSync(intakeDir())) return report;

  const files = readdirSync(intakeDir())
    .filter((f) => f.endsWith(".patch.json"))
    .map((f) => {
      const p = JSON.parse(readFileSync(join(intakeDir(), f), "utf8")) as SkillPatch;
      return { file: f, patch: p };
    })
    // 稳定全序：并发 applier 也按同一顺序消费
    .sort((a, b) => (a.patch.created_at + a.patch.patch_id).localeCompare(b.patch.created_at + b.patch.patch_id));

  for (const { file, patch } of files) {
    try {
      const state = loadSkillState();
      if (state.appliedPatches[patch.patch_id]) { rmSync(join(intakeDir(), file)); continue; } // 已应用：清文件防重复扫描

      const skillDir = join(skillsDir(), patch.domain);
      const skillMdPath = join(skillDir, "SKILL.md");

      if (patch.action === "update") {
        if (!existsSync(skillMdPath)) { // 目标不存在：视为失效（可能是误写 domain）
          report.discarded.push(patch.patch_id);
          logError(`patch ${patch.patch_id} 丢弃：目标 skill ${patch.domain} 不存在`);
          rmSync(join(intakeDir(), file));
          continue;
        }
        const cur = sha1(readFileSync(skillMdPath, "utf8"));
        if (patch.base_skill_sha && cur !== patch.base_skill_sha) {
          // 基于版本已过期：别人先应用了。丢弃提案，原子留 pending，下次会话重做。
          report.discarded.push(patch.patch_id);
          logError(`patch ${patch.patch_id} 丢弃：基版本失配（已过期的提案，原子退回 pending 重做）`);
          rmSync(join(intakeDir(), file));
          continue;
        }
      } else { // create
        if (existsSync(skillMdPath)) {
          report.discarded.push(patch.patch_id);
          logError(`patch ${patch.patch_id} 丢弃：skill ${patch.domain} 已存在（create 目标冲突）`);
          rmSync(join(intakeDir(), file));
          continue;
        }
      }

      // 落内容（先内容后标记）
      atomicWrite(skillMdPath, patch.skill_md);
      for (const [rel, content] of Object.entries(patch.files ?? {})) {
        if (rel.includes("..")) continue; // 防路径逃逸
        atomicWrite(join(skillDir, rel), content);
      }
      // 标记：同一事务（state 原子写）—— 崩溃最坏=内容已落但未标记 → 重做幂等
      const st = loadSkillState();
      st.integrated = [...new Set([...st.integrated, ...patch.atom_ids])];
      st.appliedPatches[patch.patch_id] = new Date().toISOString();
      st.domainEdits = st.domainEdits ?? {};
      st.domainEdits[patch.domain] = (st.domainEdits[patch.domain] ?? 0) + 1; // darwin 体检触发计数
      saveSkillState(st);
      appendUsage([{ ts: new Date().toISOString(), session: "apply", skill: patch.domain, event: "edited" }]);
      rmSync(join(intakeDir(), file)); // 已应用：出队列
      report.applied.push(patch.patch_id);
    } catch (e) {
      report.failed.push(patch.patch_id ?? file);
      logError(`patch ${file} 应用失败（留队列重试）: ${String(e).slice(0, 200)}`);
    }
  }
  return report;
}

/** bootstrap：把已有 skill 覆盖的原子全部标记已整合（批量打包后用） */
export function markDomainIntegrated(domains: string[]): number {
  const ids = loadAtoms()
    .filter((a) => domains.includes(a.domain || "general"))
    .map((a) => a.atom_id);
  if (ids.length) {
    const st = loadSkillState();
    st.integrated = [...new Set([...st.integrated, ...ids])];
    saveSkillState(st);
  }
  return ids.length;
}
