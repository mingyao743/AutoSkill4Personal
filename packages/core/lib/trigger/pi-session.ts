/**
 * pi 会话读取（手动 `ow capture` 用）。
 *
 * pi 落盘：`~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`，明文。
 * 文件是 `id/parentId` 树——这里按最后一条消息回溯 parent 链，取活跃分支。
 *
 * 自动触发不经过本文件（extension 的 `sessionManager.getEntries()` 已经给活跃分支）；
 * 这里只服务 CLI 手动入口，避免 pi 里说「小q 沉淀」却只能找 dsh 会话。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { hostContext } from "../base/context.ts";
import type { MessageEntry } from "../base/types.ts";

export interface PiSessionHeader {
  id: string;
  cwd?: string;
  version?: number;
}

export interface PiSessionData {
  header: PiSessionHeader;
  /** 活跃分支上的消息（带 seq） */
  entries: Array<MessageEntry & { seq: number }>;
  /** 原始事件（只含 message，给 indexTurns 用） */
  events: Array<Record<string, unknown>>;
}

export function piSessionsRoot(): string {
  const home = hostContext()?.homeDir ?? join(homedir(), ".pi", "agent");
  return join(home, "sessions");
}

/** 与 dsh 同一 slug 规则：非字母数字压成 -，两端 -- */
export function piCwdSlug(cwd: string): string {
  return `--${cwd.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}--`;
}

function listSessions(dir: string): Array<{ file: string; mtimeMs: number }> {
  const out: Array<{ file: string; mtimeMs: number }> = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    try {
      out.push({ file: p, mtimeMs: statSync(p).mtimeMs });
    } catch {
      /* 忽略 */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** pi 的最新会话；给了 cwd 就只看该项目的 slug，否则全机找 */
export function latestPiSessionFile(cwd?: string): string | undefined {
  const root = piSessionsRoot();
  if (cwd) return listSessions(join(root, piCwdSlug(cwd)))[0]?.file;
  let best: { file: string; mtimeMs: number } | undefined;
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const slug of slugs) {
    const hit = listSessions(join(root, slug))[0];
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  return best?.file;
}

/** 读 pi 会话 + 线性化活跃分支 */
export function readPiSession(file: string): PiSessionData {
  const raw = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of raw) {
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 损坏行跳过 */
    }
  }

  const sessionLine = parsed.find((e) => e.type === "session");
  const id = typeof sessionLine?.id === "string"
    ? sessionLine.id
    : basename(file).replace(/\.jsonl$/, "").split("_").pop() ?? basename(file);
  const header: PiSessionHeader = {
    id,
    cwd: typeof sessionLine?.cwd === "string" ? sessionLine.cwd : undefined,
    version: typeof sessionLine?.version === "number" ? sessionLine.version : undefined,
  };

  const all = parsed.filter(
    (e): e is Record<string, unknown> & { type: "message"; id: string; parentId?: string | null; message: Record<string, unknown> } =>
      e.type === "message" && typeof e.id === "string" && !!e.message && typeof e.message === "object",
  );

  // 从最后一条消息回溯到根，取活跃分支；parent 断掉/只有一个节点时退回文件顺序
  let branch: typeof all = [];
  if (all.length > 0) {
    const byId = new Map(all.map((e) => [e.id, e]));
    const seen = new Set<string>();
    let cur: (typeof all)[number] | undefined = all[all.length - 1];
    const chain: typeof all = [];
    while (cur && !seen.has(cur.id)) {
      chain.push(cur);
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined;
    }
    chain.reverse();
    branch = chain.length > 1 ? chain : all;
  }

  const entries = branch.map((e, i) => ({
    type: "message" as const,
    id: e.id,
    parentId: typeof e.parentId === "string" ? e.parentId : null,
    timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
    message: e.message as MessageEntry["message"],
    seq: i,
  }));
  const events = branch.map((e, i) => ({
    type: "message",
    seq: i,
    id: e.id,
    message: e.message,
    timestamp: e.timestamp,
  }));

  return { header, entries, events };
}

export function isPiSessionFile(file: string): boolean {
  return existsSync(file) && /\/\.pi\/agent\/sessions\//.test(file) && file.endsWith(".jsonl");
}
