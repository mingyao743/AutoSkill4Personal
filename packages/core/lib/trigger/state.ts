/**
 * 水位线：`.qdoc/.ow/state.json` 读写。
 *
 * **存 vault，不存进程**。内嵌后同一项目有两个 agent 进程（dsh 插件、pi extension），
 * 水位线若各存各的，同一个会话会被两边重复编译。
 *
 * 记录的是「已编译到第几轮」（compiled_to_turn），不是「哪些消息被抽取过」——
 * 后者是旧实现的 bug（见方案 §5.8 bug 2）：抽取与编译是两个阶段，混在一个计数器里，
 * 压缩后会对不上。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SessionState {
  compiled_to_turn: number;
  compiled_to_seq?: number;
  last_run?: string;
  /** 该会话累计编译出多少页，用于观察 */
  pages?: number;
}

export interface VaultState {
  schema: 1;
  sessions: Record<string, SessionState>;
}

const EMPTY: VaultState = { schema: 1, sessions: {} };

export function statePath(vaultDir: string): string {
  return join(vaultDir, ".ow", "state.json");
}

/** 会话键：`<agent>:<sessionId>`，两套宿主可能撞 id（都是 uuid），必须带前缀 */
export function sessionKey(agent: "dsh" | "pi", sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export function readState(vaultDir: string): VaultState {
  const p = statePath(vaultDir);
  if (!existsSync(p)) return { ...EMPTY, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<VaultState>;
    return { schema: 1, sessions: raw.sessions ?? {} };
  } catch {
    // 损坏的 state 不能静默重置成空——那会重编译所有历史会话。
    // 挪走留证，返回空（调用方会从 0 开始，但至少现场还在）。
    try {
      renameSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      /* 挪不动就算了 */
    }
    return { ...EMPTY, sessions: {} };
  }
}

export function getSessionState(vaultDir: string, key: string): SessionState {
  return readState(vaultDir).sessions[key] ?? { compiled_to_turn: 0 };
}

/** 编译成功后推进水位（原子写：先写临时文件再 rename） */
export function advanceState(
  vaultDir: string,
  key: string,
  patch: { compiled_to_turn: number; compiled_to_seq?: number; pages?: number },
): void {
  const st = readState(vaultDir);
  const prev = st.sessions[key] ?? { compiled_to_turn: 0 };
  st.sessions[key] = {
    ...prev,
    compiled_to_turn: Math.max(prev.compiled_to_turn, patch.compiled_to_turn),
    compiled_to_seq: patch.compiled_to_seq ?? prev.compiled_to_seq,
    pages: (prev.pages ?? 0) + (patch.pages ?? 0),
    last_run: new Date().toISOString(),
  };
  writeState(vaultDir, st);
}

export function writeState(vaultDir: string, st: VaultState): void {
  const p = statePath(vaultDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), "utf8");
  renameSync(tmp, p);
}
