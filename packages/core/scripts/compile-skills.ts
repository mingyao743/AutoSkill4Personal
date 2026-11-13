#!/usr/bin/env node
/**
 * 技能编译 CLI（就绪门 → 选材 → ③ 正文生成 → ⑤ 路由自测 → 契约校验 + 提案）。
 *
 * 用法：
 *   # 1) 生成编译简报（确定性，不调 LLM）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --all
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain gpu-train-ops --force
 *
 *   # 1.5) ③ 正文生成（调 LLM）：简报 + 选中卡片完整正文 + create-skill 写法指引 → draft
 *   #       validate 不过回喂 errors 重写（最多 2 次）；仍不过保留 draft、不生成提案
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --generate path/to/<skill>.brief.json
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain X --generate
 *
 *   # 2) 校验产出的 SKILL.md（M1/M2/M4/M5/M6；M3 路由自测见 1.7）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain X --validate path/to/SKILL.md
 *
 *   # 1.7) ⑤ 路由自测（调 LLM）：扫 skillsDir 各技能构成竞争集合，5 正+3 负探针，
 *   #       正 ≥4/5、负 ≥2/3 才过；失败回喂重写 description（最多 2 次）；产物 <briefDir>/<skill>.route.json
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --route-test path/to/SKILL.md --skills-dir ~/.pi/agent/skills
 *
 *   # 3) 校验通过后写 intake 提案（--apply 读到失败的路由报告会拒绝；单一写入者 apply-patches 落盘）
 *   node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain X --apply path/to/SKILL.md --skills-dir ~/.pi/agent/skills
 *
 * 参数：
 *   --domain X          只处理一个主题
 *   --all               处理全部主题（默认行为；与 --domain 二选一）
 *   --generate [BRIEF]  ③ 正文生成：给 brief.json 路径，或配 --domain 现造简报；输出 <briefDir>/<skill>.draft.md
 *   --route-test PATH   ⑤ 路由自测：对 PATH 的 SKILL.md 跑正负探针判定；需 --skills-dir；输出 <briefDir>/<skill>.route.json
 *   --force             跳过“内容无变化”与短效知识阻断（不跳过卡片数/会话数门槛）
 *   --limit N           最多处理 N 个主题
 *   --dry               只算不写（简报/状态都不落盘）
 *   --json              机器可读输出
 *   --brief-dir DIR     简报目录（默认 <dataDir>/compile）
 *   --data-dir DIR      知识数据目录（默认 AUTOSKILL_DATA_DIR → ~/.pi/agent/data/autoskill/knowledge）
 *   --skills-dir DIR    skills 输出目录（--apply/--route-test 必填；默认 AUTOSKILL_SKILLS_DIR）
 *   --home DIR          凭据定位基准（默认 ~/.pi/agent；--generate/--route-test 独立模式据此读 models.json）
 *   --no-home           不读 ~/.pi/agent 的模型配置（dsh 等非 pi 宿主走环境变量直连）
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setHostContext } from "../lib/base/context.ts";
import { isInstructionAtom, loadAtoms, type KnowledgeAtom } from "../lib/base/atom-store.ts";
import { intakeDir } from "../lib/skill/apply-patches.ts";
import { loadCompileState, saveCompileState } from "../lib/skill/compile-state.ts";
import {
  buildCompileBrief, checkReadiness, effectiveDocType, instructionAtomsOf, sanitizeDomainName, selectMaterials,
  type CompileBrief,
} from "../lib/skill/compile-skill.ts";
import {
  bodyBudgetFor, formatValidation, parseSkillMd, referencePaths, validateSkillMd, type SkillValidationReport,
} from "../lib/skill/skill-contract.ts";
import {
  cardsForBrief, docTypesForValidation, generateSkill,
} from "../lib/skill/generate-skill.ts";
import {
  buildRouteReport, NEGATIVE_PASS, NEGATIVE_PROBES, POSITIVE_PASS, POSITIVE_PROBES,
  routeReportBlocksApply, routeReportPath, routeTestSkill, type RouteCandidate,
} from "../lib/skill/route-test.ts";

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

// 凭据定位基准：--generate 需要调 LLM，独立模式按 ~/.pi/agent 的 models.json 解析（与
// pipeline/extract-calibrate 同链）；非 pi 宿主用 --no-home 改走环境变量直连。
const noHome = has("--no-home");
const home = one("--home") ?? join(homedir(), ".pi", "agent");
const defaultPiData = join(home, "data", "autoskill", "knowledge");
const dataDir = one("--data-dir") ?? process.env.AUTOSKILL_DATA_DIR ?? defaultPiData;
const skillsDir = one("--skills-dir") ?? process.env.AUTOSKILL_SKILLS_DIR;
setHostContext({ host: "cli", dataDir, skillsDir, homeDir: !noHome && existsSync(home) ? home : undefined });

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

/** 扫描 <skillsDir> 下各技能目录的 SKILL.md frontmatter（name+description），构成路由竞争集合。
 *  exceptName：目标自身用 draft 版本的 description，不重复扫入。 */
function scanSkillCandidates(dir: string, exceptName?: string): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const md = join(dir, e.name, "SKILL.md");
    if (!existsSync(md)) continue;
    const parsed = parseSkillMd(readText(md));
    if ("error" in parsed) continue;
    if (!parsed.frontmatter.name || !parsed.frontmatter.description.trim()) continue;
    if (exceptName && parsed.frontmatter.name === exceptName) continue;
    out.push({ name: parsed.frontmatter.name, description: parsed.frontmatter.description });
  }
  return out;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------- 写法指引（③ 正文生成用） ----------------
// packages/core/skills/create-skill/SKILL.md：通用技能写法（SDO 描述规则、章节结构、形式匹配失败类型）。
// 脚本在 packages/core/scripts/，repo 根在往上三级。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const writingGuidePath = join(repoRoot, "packages", "core", "skills", "create-skill", "SKILL.md");

const FALLBACK_WRITING_GUIDE = [
  "# 写法指引（精简）",
  "- frontmatter：name（kebab-case）+ description（60–300 字，含 ≥3 个触发短语，写“何时用”不写“做什么”）。",
  "- 章节：何时用 / 判断（表）/ 步骤（编号）/ 失败与回退 / 边界 / 验证 / 何时读 references。",
  "- 正文是“以后照着做”的指令，不是“当时发生了什么”的记录。",
  "- 禁止元数据（atom_、置信度、status、来源）、短效表述（已实现/本次/今天/M0–M3）、模板句式。",
  "- 分诊表每行都要有“你现在的处境 → 读这个”，不能只写文件名。",
].join("\n");

function loadWritingGuide(): string {
  if (existsSync(writingGuidePath)) return readText(writingGuidePath);
  return FALLBACK_WRITING_GUIDE;
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
    // 路由门：读到**失败**的路由自测报告必须拒绝（SKILL_COMPILER §八 M3）。
    // 无报告（没做过 --route-test）或通过报告都不拦——--apply 不强制要求做过路由自测。
    const gate = routeReportBlocksApply(briefDir, skillName);
    if (gate.blocked) {
      const r = gate.report!;
      console.error(`\n⛔ 拒绝 --apply：路由自测报告失败（正 ${r.positiveHits}/${POSITIVE_PROBES} 需 ≥${POSITIVE_PASS}；负 ${r.negativePass}/${NEGATIVE_PROBES} 需 ≥${NEGATIVE_PASS}）。`);
      for (const f of r.failures ?? []) console.error(`  - ${f}`);
      console.error(`  重跑 --route-test ${file} --skills-dir ${skillsDir}，通过后再 --apply。`);
      console.error(`  （确信是误判？删 ${routeReportPath(briefDir, skillName)} 后 --apply，但发布前必须补路由测试。）`);
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

// ---------------- 模式 1.5：③ 正文生成（--generate，需要 LLM） ----------------
// 输入：编译简报 + 选中卡片完整正文（从 atoms.jsonl 按 atom_id 取）+ create-skill 写法指引。
// 输出：<briefDir>/<skill>.draft.md（绝不直接落技能文件；--apply 是独立显式步骤）。
// 质量环：validateSkillMd 不过 → 回喂 errors 重写（最多 2 次）；仍不过 → 保留 draft、不生成提案。
const genPath = one("--generate");
if (has("--generate")) {
  let brief: CompileBrief;
  if (genPath && genPath !== "true" && existsSync(genPath)) {
    // --generate <brief.json>：直接用现成简报（简报里 content 截断到 400 字，下面按 atom_id 取全量）
    try {
      brief = JSON.parse(readText(genPath)) as CompileBrief;
    } catch (e) {
      console.error(`简报解析失败：${genPath}：${String(e)}`);
      process.exit(1);
    }
    if (!brief.skillName || !brief.selection?.picked) {
      console.error(`${genPath} 不是有效的编译简报（缺 skillName / selection.picked）`);
      process.exit(1);
    }
  } else if (domainArg) {
    // --domain X --generate：现造简报再生成（force 跳过“内容未变/短效”阻断，因为目标是出 draft）
    const allAtoms = loadAtoms();
    const readiness = checkReadiness(domainArg, allAtoms, { force });
    if (!readiness.ready) {
      console.error(`主题 ${domainArg} 未就绪，无法生成：`);
      for (const b of readiness.blockers) console.error(`  ⛔ ${b}`);
      process.exit(1);
    }
    const pool = instructionAtomsOf(domainArg, allAtoms);
    brief = buildCompileBrief(domainArg, readiness, selectMaterials(pool)).json;
  } else {
    console.error("--generate 需要一个简报路径或主题：");
    console.error("  compile-skills.ts --generate path/to/<skill>.brief.json");
    console.error("  compile-skills.ts --domain <主题> --generate");
    process.exit(1);
  }

  const cards = cardsForBrief(brief, loadAtoms());
  if (cards.length === 0) {
    console.error("简报里的选中卡片在 atoms.jsonl 中找不到（atom_id 不匹配）：无法生成。");
    console.error("  可能 atoms.jsonl 被清理过，或简报来自另一台机器。重新 --domain <主题> 造简报再试。");
    process.exit(1);
  }

  const availableRefs = listSkillFiles(brief.domain);
  const validateOpts = {
    domain: brief.skillName,
    docTypes: docTypesForValidation(brief),
    bodyBudget: brief.bodyBudget,
    availableRefs,
  };

  let result;
  try {
    result = await generateSkill({
      brief,
      cards,
      writingGuide: loadWritingGuide(),
      validateOpts,
    });
  } catch (e) {
    console.error(`生成失败（LLM 调用）：${String(e)}`);
    console.error("  CLI/独立模式需要凭据：AUTOSKILL_PROVIDER / models.json / OPENAI_API_KEY；宿主内走 ctx.llm 注入。");
    process.exit(1);
  }

  // 始终写 draft：通过则待 --apply；未过也保留供人工修（不生成提案）
  mkdirSync(briefDir, { recursive: true });
  const draftPath = join(briefDir, `${brief.skillName}.draft.md`);
  writeFileSync(draftPath, result.draft + (result.draft.endsWith("\n") ? "" : "\n"));

  if (jsonOut) {
    console.log(JSON.stringify({
      domain: brief.skillName,
      draftPath,
      ok: result.ok,
      attempts: result.attempts,
      report: result.report,
      history: result.history,
    }, null, 2));
  } else {
    console.log(`生成 ${draftPath}（${result.attempts} 次调用，${result.ok ? "校验通过" : "校验未过"}）\n`);
    console.log(formatValidation(result.report));
  }

  if (result.ok) {
    console.log(`\n下一步：人工复核 draft，再`);
    console.log(`  node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain ${brief.domain} --validate ${draftPath}`);
    console.log(`  通过后 --apply ${draftPath} --skills-dir ${skillsDir ?? "<宿主 skills 目录>"}`);
    process.exit(0);
  }
  console.error(`\n⛔ 校验未过（重写 ${result.attempts - 1} 次仍失败）：draft 已保留在 ${draftPath}，未生成提案。`);
  console.error("  可人工修正后 --validate；或调整卡片/简报后重跑 --generate。");
  process.exit(1);
}

// ---------------- 模式 1.6：⑤ 路由自测（--route-test，需要 LLM） ----------------
// 扫描 <skillsDir> 下各技能的 description 构成竞争集合；对目标生成 5 正 + 3 负探针，
// 逐条判"这条请求加载哪个技能"；正 ≥4/5、负 ≥2/3 才过；失败回喂重写 description（最多 2 次）。
// 产物 <briefDir>/<skill>.route.json；--apply 读到失败报告必须拒绝。
const routeTestPath = one("--route-test");
if (routeTestPath) {
  if (!existsSync(routeTestPath)) { console.error(`文件不存在: ${routeTestPath}`); process.exit(1); }
  const md = readText(routeTestPath);
  const parsed = parseSkillMd(md);
  if ("error" in parsed) { console.error(`解析失败：${parsed.error}`); process.exit(1); }
  if (!parsed.frontmatter.description.trim()) { console.error("目标 SKILL.md 的 description 为空，无法做路由自测。"); process.exit(1); }
  const targetName = parsed.frontmatter.name;
  const target: RouteCandidate = { name: targetName, description: parsed.frontmatter.description };
  if (!skillsDir) {
    console.error("--route-test 需要 --skills-dir：扫描 <skillsDir>/*/SKILL.md 构成竞争集合。");
    process.exit(1);
  }
  const others = scanSkillCandidates(skillsDir, targetName);
  const candidates = [target, ...others];
  if (others.length === 0) {
    console.error(`⚠ ${skillsDir} 下没有别的技能：负样本无对照（负样本要求"该加载别的技能"），自测意义有限。`);
  }
  const cachePath = join(briefDir, "route-cache.json");
  let result;
  try {
    result = await routeTestSkill({ target, candidates, cachePath });
  } catch (e) {
    console.error(`路由自测失败（LLM 调用）：${String(e)}`);
    console.error("  CLI/独立模式需要凭据：--home ~/.pi/agent / AUTOSKILL_PROVIDER / OPENAI_API_KEY；宿主内走 ctx.llm。");
    process.exit(1);
  }
  const report = buildRouteReport(result);
  mkdirSync(briefDir, { recursive: true });
  const reportPath = routeReportPath(briefDir, targetName);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

  if (jsonOut) {
    console.log(JSON.stringify({
      ...report, reportPath,
      candidates: candidates.length,
      attempts: result.attempts, probes: result.probes, judgments: result.judgments,
    }, null, 2));
  } else {
    console.log(`路由自测 ${routeTestPath}（目标 ${targetName}，竞争 ${candidates.length} 个技能）\n`);
    console.log(`正样本 ${result.positiveHits}/${POSITIVE_PROBES}（需 ≥${POSITIVE_PASS}）｜负样本 ${result.negativePass}/${NEGATIVE_PROBES}（需 ≥${NEGATIVE_PASS}）｜重写 ${result.rewrites} 次`);
    for (const a of result.attempts) {
      console.log(`  第${a.attempt}次：正 ${a.positiveHits}/${POSITIVE_PROBES} 负 ${a.negativePass}/${NEGATIVE_PROBES} ${a.ok ? "✅" : "⛔"}`);
      for (const f of a.failures) console.log(`     - ${f}`);
    }
    if (result.rewrites > 0 && result.finalDescription !== result.originalDescription) {
      console.log(`\n重写后的 description（写入报告；需人工确认是否回写 SKILL.md）：`);
      console.log(`  ${result.finalDescription}`);
    }
    console.log(`\n报告：${reportPath}`);
    if (result.ok) console.log("✅ 路由自测通过：--apply 路由门放行");
    else console.error("⛔ 路由自测未通过：--apply 将拒绝（路由报告失败）");
  }
  process.exit(result.ok ? 0 : 1);
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
