#!/usr/bin/env node
/**
 * 技能编译 CLI（确定性三步：就绪门 → 选材 → 契约校验 + 提案）。
 *
 * 用法：
 *   # 1) 生成编译简报（交给 create-skill 写产物；不调 LLM）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --all
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain gpu-train-ops --force
 *
 *   # 2) 校验产出的 SKILL.md（M1/M2/M4/M5/M6；M3 路由自测需要 LLM/人工）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain X --validate path/to/SKILL.md
 *
 *   # 3) 校验通过后写 intake 提案（单一写入者 apply-patches 落盘）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain X --apply path/to/SKILL.md --skills-dir ~/.pi/agent/skills
 *
 * 参数：
 *   --domain X          只处理一个主题
 *   --all               处理全部主题（默认行为；与 --domain 二选一）
 *   --force             跳过“内容无变化”与短效知识阻断（不跳过卡片数/会话数门槛）
 *   --limit N           最多处理 N 个主题
 *   --dry               只算不写（简报/状态都不落盘）
 *   --json              机器可读输出
 *   --brief-dir DIR     简报目录（默认 <dataDir>/compile）
 *   --data-dir DIR      知识数据目录（默认 AUTOSKILL_DATA_DIR → ~/.pi/agent/data/autoskill/knowledge）
 *   --skills-dir DIR    skills 输出目录（--apply 必填；默认 AUTOSKILL_SKILLS_DIR）
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { setHostContext } from "../lib/context.ts";
import { isInstructionAtom, loadAtoms, type KnowledgeAtom } from "../lib/atom-store.ts";
import { intakeDir } from "../lib/apply-patches.ts";
import { loadCompileState, saveCompileState } from "../lib/compile-state.ts";
import {
  buildCompileBrief, checkReadiness, effectiveDocType, instructionAtomsOf, sanitizeDomainName, selectMaterials,
} from "../lib/compile-skill.ts";
import {
  bodyBudgetFor, formatValidation, parseSkillMd, referencePaths, validateSkillMd, type SkillValidationReport,
} from "../lib/skill-contract.ts";

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const flags = new Map<string, string[]>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) {
    if (!flags.has(a)) flags.set(a, []);
    flags.get(a)!.push(next);
    i++;
  } else {
    if (!flags.has(a)) flags.set(a, []);
    flags.get(a)!.push("true");
  }
}
const one = (n: string): string | undefined => flags.get(n)?.[0];
const has = (n: string): boolean => flags.has(n);

const defaultPiData = join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge");
const dataDir = one("--data-dir") ?? process.env.AUTOSKILL_DATA_DIR ?? defaultPiData;
const skillsDir = one("--skills-dir") ?? process.env.AUTOSKILL_SKILLS_DIR;
setHostContext({ host: "cli", dataDir, skillsDir });

const dryRun = has("--dry");
const jsonOut = has("--json");
const force = has("--force");
const domainArg = one("--domain");
const limit = Number(one("--limit") ?? 0) || Infinity;
const briefDir = one("--brief-dir") ?? join(dataDir, "compile");

// ---------------- 编译状态（内容有变化才重编） ----------------
const state = loadCompileState();

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

// ---------------- 工具 ----------------
function allDomains(atoms: readonly KnowledgeAtom[]): string[] {
  const set = new Set<string>();
  for (const a of atoms) if (isInstructionAtom(a)) set.add(String(a.domain ?? "general").trim() || "general");
  return [...set].sort();
}

/** skills/<domain> 下已有的文件（相对路径），给 M6 引用闭合检查用 */
function listSkillFiles(domain: string): Set<string> | undefined {
  if (!skillsDir) return undefined;
  const root = join(skillsDir, sanitizeDomainName(domain));
  if (!existsSync(root)) return undefined;
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.add(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------- 模式 2/3：校验 / 提案 ----------------
const validatePath = one("--validate");
const applyPath = one("--apply");
if (validatePath || applyPath) {
  const file = validatePath ?? applyPath!;
  if (!existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(1); }
  const md = readText(file);
  const parsed = parseSkillMd(md);
  if ("error" in parsed) { console.error(`解析失败：${parsed.error}`); process.exit(1); }
  const domain = domainArg ?? parsed.frontmatter.name;
  const skillName = sanitizeDomainName(domain);
  const atoms = instructionAtomsOf(domain, loadAtoms());
  const selection = selectMaterials(atoms);
  const docTypes = [...new Set(atoms.map(effectiveDocType))];
  const budget = bodyBudgetFor(docTypes);
  const availableRefs = listSkillFiles(domain);
  const report: SkillValidationReport = validateSkillMd(parsed, {
    domain: skillName,
    docTypes,
    bodyBudget: budget,
    availableRefs,
  });

  if (jsonOut) {
    console.log(JSON.stringify({ domain: skillName, ok: report.ok, report }, null, 2));
  } else {
    console.log(`校验 ${file}（主题 ${skillName}，类型 ${docTypes.join("/") || "未知"}，预算 ${budget} 字）\n`);
    console.log(formatValidation(report));
  }

  if (!report.ok) process.exit(1);

  if (applyPath) {
    if (!skillsDir) {
      console.error("\n--apply 需要显式 --skills-dir（或 AUTOSKILL_SKILLS_DIR）：提案最终由 apply-patches 写进该目录，");
      console.error("CLI 不能替宿主猜输出路径（dsh 形态根本不落 SKILL.md 文件）。");
      process.exit(1);
    }
    const skillDir = join(skillsDir, skillName);
    const skillMdPath = join(skillDir, "SKILL.md");
    const exists = existsSync(skillMdPath);
    const current = exists ? readText(skillMdPath) : "";
    if (current.includes("agent-maintained") && !force) {
      console.error(`\n拒绝覆盖 ${skillMdPath}：agent-maintained（批量重建会丢精修；--force 强制）`);
      process.exit(1);
    }
    // references 随提案一起落盘（全量内容，非 diff）；磁盘上还没有的列出来，避免 apply 后断链
    const refFiles: Record<string, string> = {};
    const missingRefs: string[] = [];
    for (const rel of referencePaths(md)) {
      if (rel.includes("..")) continue;
      const abs = join(skillDir, rel);
      if (existsSync(abs)) refFiles[rel] = readText(abs);
      else missingRefs.push(rel);
    }
    const patch = {
      patch_id: `p_${randomBytes(4).toString("hex")}`,
      created_at: new Date().toISOString(),
      author: "compile-skills",
      domain: skillName,
      action: exists ? "update" : "create",
      ...(exists ? { base_skill_sha: sha1(current) } : {}),
      atom_ids: [...new Set([...selection.picked, ...selection.overflow].map((r) => r.atom.atom_id))],
      skill_md: md,
      files: refFiles,
    };
    mkdirSync(intakeDir(), { recursive: true });
    const patchPath = join(intakeDir(), `${patch.patch_id}.patch.json`);
    writeFileSync(patchPath, JSON.stringify(patch, null, 2) + "\n");

    if (missingRefs.length > 0) {
      console.log(`\n⚠ ${missingRefs.length} 个 references 文件在 ${skillDir} 里不存在，未打进提案：`);
      for (const r of missingRefs) console.log(`   - ${r}`);
      console.log("   先把这些文件放到技能目录（或让生成器一并产出文件内容），否则 apply 后引用会断。");
    }
    console.log(`\n✓ 提案已写入 ${patchPath}`);
    console.log(`  应用：node --experimental-strip-types packages/core/scripts/apply-patches.ts --data-dir ${dataDir}`);
    console.log(`  （pi 宿主在下次 session_start 会自动消费）`);
  }
  process.exit(0);
}

// ---------------- 模式 1：生成编译简报 ----------------
const atoms = loadAtoms();
const domains = domainArg ? [domainArg] : allDomains(atoms);
const pickedDomains = domains.slice(0, limit);

interface BriefRow {
  domain: string;
  skillName: string;
  ready: boolean;
  atoms: number;
  sessions: number;
  primaryDocType?: string;
  picked: number;
  overflow: number;
  bodyBudget: number;
  blockers: string[];
  warnings: string[];
  briefPath?: string;
}
const rows: BriefRow[] = [];

for (const domain of pickedDomains) {
  const skillName = sanitizeDomainName(domain);
  const readiness = checkReadiness(domain, atoms, {
    force,
    lastHash: state.domains[skillName]?.inputHash,
  });
  const pool = instructionAtomsOf(domain, atoms);
  const selection = selectMaterials(pool);
  const row: BriefRow = {
    domain,
    skillName,
    ready: readiness.ready,
    atoms: readiness.atomCount,
    sessions: readiness.sessionCount,
    primaryDocType: selection.primaryDocType ?? readiness.primaryDocType,
    picked: selection.picked.length,
    overflow: selection.overflow.length,
    bodyBudget: selection.budgetChars,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
  };

  if (readiness.ready) {
    if (!dryRun) {
      const brief = buildCompileBrief(domain, readiness, selection);
      mkdirSync(briefDir, { recursive: true });
      const mdPath = join(briefDir, `${skillName}.brief.md`);
      writeFileSync(mdPath, brief.markdown);
      writeFileSync(join(briefDir, `${skillName}.brief.json`), JSON.stringify(brief.json, null, 2) + "\n");
      state.domains[skillName] = { inputHash: readiness.inputHash, briefAt: new Date().toISOString() };
      row.briefPath = mdPath;
    }
  }
  rows.push(row);
}

if (!dryRun) saveCompileState(state);

if (jsonOut) {
  console.log(JSON.stringify({ dataDir, briefDir, rows }, null, 2));
  process.exit(0);
}

const ready = rows.filter((r) => r.ready).length;
console.log(`知识卡片池：${atoms.length} 张｜主题 ${pickedDomains.length} 个｜就绪 ${ready}｜阻断 ${rows.length - ready}\n`);
console.log("主题\t卡片\t会话\t主类型\t正文/参考\t预算\t状态");
for (const r of rows) {
  const status = r.ready ? "✅" : `⛔ ${r.blockers[0] ?? ""}`;
  console.log(`${r.skillName}\t${r.atoms}\t${r.sessions}\t${r.primaryDocType ?? "?"}\t${r.picked}/${r.overflow}\t${r.bodyBudget}\t${status}`);
  for (const b of r.blockers.slice(1)) console.log(`\t\t\t\t\t\t  └ ${b}`);
  for (const w of r.warnings) console.log(`\t\t\t\t\t\t  ⚠ ${w}`);
  if (r.briefPath) console.log(`\t\t\t\t\t\t  → ${r.briefPath}`);
}
if (ready > 0) {
  console.log(`\n下一步：把简报交给 create-skill 产出 SKILL.md，然后`);
  console.log(`  node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> --validate <SKILL.md>`);
  console.log(`  通过后 --apply <SKILL.md> --skills-dir ${skillsDir ?? "<宿主 skills 目录>"}`);
}
if (domains.length > pickedDomains.length) {
  console.log(`\n（--limit 只处理了前 ${pickedDomains.length}/${domains.length} 个主题）`);
}
process.exit(0);
