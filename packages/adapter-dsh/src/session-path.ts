/**
 * dsh 会话文件的定位规则（纯路径逻辑，不 import dsh 运行时，便于回归测试）。
 *
 * dsh v4 落盘形状：`<dshHome>/sessions/<cwd-slug>/<session-id>/session.v4.jsonl[.zstd]`
 * 旧实现把 `<dshHome>` 硬编码成 `~/.dsh`，自定义 DSH_HOME 的部署永远找不到会话文件。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** dsh 配置根：显式配置 > $DSH_HOME > ~/.dsh */
export function resolveDshHome(configured?: string): string {
  return configured ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function dshSessionsRoot(configured?: string): string {
  return join(resolveDshHome(configured), "sessions");
}

/** cwd → dsh 会话目录 slug（与宿主实测目录名一致） */
export function sessionCwdSlug(cwd: string): string {
  return `--${cwd.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-")}--`;
}

/** 同一会话可能落 zstd 或明文，优先 zstd（实测 v4 默认压缩） */
const SESSION_FILES = ["session.v4.jsonl.zstd", "session.v4.jsonl"] as const;

/**
 * 会话 id 的文件名兜底。
 * dsh 的文件名恒为 `session.v4.jsonl(.zstd)`，id 在父目录名里；pi 的 id 在文件名里。
 * 旧兜底对 dsh 会一律返回 "session.v4"，同机所有会话撞成同一个 id（覆盖水位串账）。
 */
export function sessionIdFromFile(sessionFile: string): string {
  const base = basename(sessionFile).replace(/\.jsonl(\.zstd)?$/, "");
  if (/^session(\.v\d+)?$/.test(base)) return basename(dirname(sessionFile));
  return base;
}

export function sessionFileFor(configured: string | undefined, cwd: string, sessionId: string): string | undefined {
  const dir = join(dshSessionsRoot(configured), sessionCwdSlug(cwd), sessionId);
  for (const f of SESSION_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 兜底：扫 cwd 对应目录，取 mtime 最新的会话文件 */
export function latestSessionFileIn(configured?: string, cwd = process.cwd()): string | undefined {
  try {
    const base = join(dshSessionsRoot(configured), sessionCwdSlug(cwd));
    if (!existsSync(base)) return undefined;
    let best: string | undefined;
    let bestM = 0;
    for (const d of readdirSync(base)) {
      const dir = join(base, d);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of SESSION_FILES) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        const m = statSync(p).mtimeMs;
        if (m > bestM) {
          bestM = m;
          best = p;
        }
      }
    }
    return best;
  } catch {
    return undefined;
  }
}
