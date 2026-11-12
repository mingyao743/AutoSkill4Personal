/**
 * 知识卡片存储：knowledge/atoms.jsonl 单文件池（唯一事实源）。
 * - status 字段区分 draft/published（不设 _drafts/ 目录）
 * - 已抽窗口从 sources.window_id 派生（不设 marker 文件）
 * - atom_id = sha1(content + sources) 前 12 位 hex，幂等去重
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostContext } from "./context.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface AtomSource {
  session_id: string;
  window_id: string;
  msg_range: [string, string];
}

export interface KnowledgeAtom {
  atom_id: string;
  category: string;
  atom_type: string;
  content: string;
  domain: string;
  sources: AtomSource[];
  confidence: number;
  version: number;
  superseded_by: string | null;
  refs: string[];
  tags?: string[];
  status: string;
  extracted_at: string;
  extracted_by: string;
  // ---- 存的分流字段（新知识卡片强制，存量知识卡片缺省按 instruction 处理）----
  /** 文档类型（8 枚举，见 admission.ts）；缺失 = 旧知识卡片 */
  doc_type?: string;
  /** 去向：instruction 进技能正文 / reference 进依据区 / data 进资料层 */
  keep_as?: string;
  /** 价值理由："不存会损失什么"（准入规则要求 ≥8 字） */
  why?: string;
  /** 失效条件（convention / index 必填；可空字符串） */
  expires_when?: string | null;
  /** 与已有知识卡片的关系（v2 关系判定落地前恒为 new） */
  relation?: { kind: string; target?: string } | null;
  /** 来源通道：signal（触发扫描 + 知识抽取）/ harvest / rescue / backfill；旧知识卡片缺省 */
  origin?: string;
  [k: string]: unknown; // 各 category 特化字段
}

export function kbDir(): string {
  // 解析顺序：HostContext 注入（适配层/CLI 显式指定）→ AUTOSKILL_DATA_DIR（宿主 spawn 时传递）
  // → KB_DIR（旧名兼容）→ pi 默认路径（未注入形态的兼容回退；v2 终态由适配层入口注入）。
  // 数据绝不放包内：宿主 update 对 git 包执行 git clean -fdx（-x 连 gitignored 文件一起删），
  // 包内任何运行时数据都会在每次更新时被清空。默认落用户级数据目录。
  return (
    hostContext()?.dataDir ??
    process.env.AUTOSKILL_DATA_DIR ??
    process.env.KB_DIR ??
    join(homedir(), ".pi", "agent", "data", "autoskill", "knowledge")
  );
}

export function atomsPath(): string {
  return join(kbDir(), "atoms.jsonl");
}

export function atomId(content: string, sources: AtomSource[]): string {
  const h = createHash("sha1")
    .update(content)
    .update(JSON.stringify(sources))
    .digest("hex");
  return `atom_${h.slice(0, 12)}`;
}

/** 读全部知识卡片（无文件返回空） */
export function loadAtoms(): KnowledgeAtom[] {
  if (!existsSync(atomsPath())) return [];
  const out: KnowledgeAtom[] = [];
  for (const line of readFileSync(atomsPath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as KnowledgeAtom);
    } catch {
      // 损坏行跳过
    }
  }
  return out;
}

/** 已抽取过的窗口 id 集合（无状态防重） */
export function extractedWindowIds(): Set<string> {
  const ids = new Set<string>();
  for (const a of loadAtoms()) {
    for (const s of a.sources ?? []) ids.add(s.window_id);
  }
  return ids;
}

/** 已存在的 atom_id 集合（幂等跳过） */
export function existingAtomIds(): Set<string> {
  return new Set(loadAtoms().map((a) => a.atom_id));
}

/**
 * 是否进技能管线（instruction）。
 * 存量知识卡片没有 keep_as 字段 → 一律视为 instruction，行为与改造前一致。
 * reference / data 不参与组装与打包，只保留在知识卡片池里（data 层另走资料检索）。
 */
export function isInstructionAtom(a: KnowledgeAtom): boolean {
  const k = a.keep_as ?? "instruction";
  return k === "instruction";
}

export function instructionAtoms(): KnowledgeAtom[] {
  return loadAtoms().filter(isInstructionAtom);
}

export function appendAtoms(atoms: KnowledgeAtom[]): void {
  mkdirSync(kbDir(), { recursive: true });
  for (const a of atoms) appendFileSync(atomsPath(), JSON.stringify(a) + "\n");
}

export function logError(msg: string): void {
  mkdirSync(kbDir(), { recursive: true });
  appendFileSync(join(kbDir(), "errors.log"), `[${new Date().toISOString()}] ${msg}\n`);
}
