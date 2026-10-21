/**
 * 原子存储：knowledge/atoms.jsonl 单文件池（唯一事实源）。
 * - status 字段区分 draft/published（不设 _drafts/ 目录）
 * - 已抽窗口从 sources.window_id 派生（不设 marker 文件）
 * - atom_id = sha1(content + sources) 前 12 位 hex，幂等去重
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  [k: string]: unknown; // 各 category 特化字段
}

export function kbDir(): string {
  return process.env.KB_DIR ?? join(REPO_ROOT, "knowledge");
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

/** 读全部原子（无文件返回空） */
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

export function appendAtoms(atoms: KnowledgeAtom[]): void {
  mkdirSync(kbDir(), { recursive: true });
  for (const a of atoms) appendFileSync(atomsPath(), JSON.stringify(a) + "\n");
}

export function logError(msg: string): void {
  mkdirSync(kbDir(), { recursive: true });
  appendFileSync(join(kbDir(), "errors.log"), `[${new Date().toISOString()}] ${msg}\n`);
}
