/**
 * 会话文件读取：zstd 解压 + 事件解析。
 *
 * 内置 `zlib.zstdDecompressSync`（Node 22.15+）优先，外部 `zstd -dc` 兜底。
 *
 * 为什么不能静态 named import：Node 22.14 没有 `zstdDecompressSync`，静态
 * `import { zstdDecompressSync }` 会让**整个模块加载失败**——连带 `ow status/sync`
 * 都起不来。改成 `import * as zlib` 运行时判空，22.14 上只有 capture 需要外部 zstd。
 *
 * 同时供三个地方用：
 *  - adapter-dsh 的定时器（原 tools.ts 里的 readSessionLines）
 *  - `ow capture --session <file>`
 *  - `ow status` 的诊断
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as zlib from "node:zlib";

/** zstd 帧魔数（RFC 8878） */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 多帧 zstd 解压。
 *
 * **为什么不能直接 `zstdDecompressSync(buf)`**：dsh 是**追加写**会话文件的，每次
 * flush 产生一个独立 zstd 帧。Node 的同步解压只解**第一帧**就停——实测一个 9872
 * 字节、6 帧、18 行的会话，只解出 202 字节 1 行。外部 `zstd -dc` 能解全部。
 *
 * 做法：按魔数找候选帧边界，逐段尝试解压；解不动的段说明魔数是压缩数据里的巧合，
 * 与下一段合并再试。
 */
type ZstdFn = (buf: Buffer) => Buffer;

/** Node 22.15+ 的内置 zstd；没有返回 null（22.14 等） */
export function builtinZstd(): ZstdFn | null {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdFn }).zstdDecompressSync;
  return typeof fn === "function" ? fn : null;
}

/** 内置/外部 zstd 可用性（doctor / 报错用） */
export function zstdStatus(): { builtin: boolean; external: boolean } {
  let external = false;
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    external = true;
  } catch {
    /* 没装 */
  }
  return { builtin: builtinZstd() !== null, external };
}

export function decompressZstdMultiFrame(buf: Buffer, zstd: ZstdFn | null = builtinZstd()): Buffer {
  if (!zstd) throw new Error("当前 Node 没有内置 zstdDecompressSync（需要 ≥22.15）");
  // 单帧快路径：能一次解完且长度合理就不折腾
  const candidates: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      candidates.push(i);
    }
  }
  if (candidates.length <= 1) return zstd(buf);

  const parts: Buffer[] = [];
  let start = 0;
  for (const at of candidates) {
    if (at <= start) continue;
    const piece = tryDecompress(buf.subarray(start, at), zstd);
    // `piece === null` 说明这段解不动：魔数只是压缩数据里的巧合，与下一段合并再试。
    // 注意**不能用 try/catch 判断**——截断的帧会返回 0 字节而不抛错（实测），
    // 那样会把假边界当真边界，静默吞掉中间那帧。
    if (piece === null) continue;
    parts.push(piece);
    start = at;
  }
  if (start < buf.length) {
    const tail = tryDecompress(buf.subarray(start), zstd);
    if (tail) parts.push(tail);
  }
  return Buffer.concat(parts);
}

/**
 * 解一段 zstd 数据；解不动或解出空内容返回 null。
 *
 * **为什么必须判空**：`zstdDecompressSync` 对截断帧返回 0 字节且**不抛错**。
 * 只靠 try/catch 会把「被截断的末帧」当成正常解完，读出来少一截还浑然不觉。
 * 返回 null 让调用方合并到下一段重试，末帧则直接丢弃（下次读会补上）。
 */
function tryDecompress(buf: Buffer, zstd: ZstdFn): Buffer | null {
  if (buf.length === 0) return null;
  try {
    const out = zstd(buf);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 读会话文件为行数组（自动识别 zstd） */
export function readSessionLines(input: string): string[] {
  const path = resolveSessionFile(input);
  if (path.endsWith(".zstd")) {
    const buf = readFileSync(path);
    try {
      if (process.env.OW_FORCE_EXTERNAL_ZSTD === "1") throw new Error("OW_FORCE_EXTERNAL_ZSTD=1");
      return decompressZstdMultiFrame(buf).toString("utf8").split("\n");
    } catch (e) {
      // 内置解压不可用/失败（Node <22.15 或非标准帧）：退回外部命令
      try {
        return execFileSync("zstd", ["-d", "-c", path], { maxBuffer: 512 * 1024 * 1024 })
          .toString("utf8")
          .split("\n");
      } catch {
        const st = zstdStatus();
        throw new Error(
          `无法解压 ${path}：内置 zstd ${st.builtin ? "失败" : "不可用"}（${String(e)}），外部 zstd ${st.external ? "也失败" : "未安装"}。\n` +
          "请升级 Node 到 22.15+ 或安装 zstd（例如 brew install zstd / apt install zstd）。",
        );
      }
    }
  }
  return readFileSync(path, "utf8").split("\n");
}

/**
 * 把「会话目录」解析成真正的数据文件。
 *
 * dsh v4 落盘是 `<session-id>/session.v4.jsonl.zstd` —— 一个**目录**。
 * 调用方（用户手敲 `ow capture --session <path>`、或复制 Finder 里看到的路径）
 * 很容易给到目录，之前直接 `readFileSync` 就 EISDIR 崩了。
 */
export function resolveSessionFile(path: string): string {
  try {
    if (!statSync(path).isDirectory()) return path;
  } catch {
    return path;
  }
  for (const f of ["session.v4.jsonl.zstd", "session.v4.jsonl", "session.jsonl.zstd", "session.jsonl"]) {
    const p = join(path, f);
    if (existsSync(p)) return p;
  }
  // 目录里没有标准命名 → 取唯一的 .jsonl* 文件
  try {
    const cands = readdirSync(path).filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.zstd"));
    if (cands.length === 1) return join(path, cands[0]);
  } catch {
    /* 忽略 */
  }
  throw new Error(
    `会话目录里找不到数据文件：${path}\n` +
      "期望 session.v4.jsonl.zstd 或 session.v4.jsonl。",
  );
}

/** 解析为原始事件数组（跳过损坏行） */
export function readSessionEvents(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of readSessionLines(path)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out;
}

/** 会话头信息（id / cwd / 是否子代理） */
export interface SessionHeader {
  id: string;
  cwd?: string;
  version?: number;
  isSeeded?: boolean;
  delegationDepth?: number;
  origin?: string;
}

/**
 * 读会话头。
 *
 * **子代理会话必须按头过滤**：实测 subagent 会话第一行 `session` 事件带
 * `origin: "subagent"` 且 `delegationDepth >= 1`。按目录名猜不可靠（目录名是 uuid）。
 */
export function readSessionHeader(path: string): SessionHeader | null {
  for (const e of readSessionEvents(path)) {
    if (e.type !== "session") continue;
    const id = typeof e.id === "string" ? e.id : sessionIdFromPath(path);
    return {
      id,
      cwd: typeof e.cwd === "string" ? e.cwd : undefined,
      version: typeof e.version === "number" ? e.version : undefined,
      isSeeded: e.isSeeded === true,
      delegationDepth: typeof e.delegationDepth === "number" ? e.delegationDepth : 0,
      origin: typeof e.origin === "string" ? e.origin : undefined,
    };
  }
  return null;
}

/** 是否子代理会话（不该触发知识编译） */
export function isSubagentSession(path: string): boolean {
  const h = readSessionHeader(path);
  if (!h) return false;
  return h.origin === "subagent" || (h.delegationDepth ?? 0) >= 1;
}

/**
 * 会话 id 的兜底。
 *
 * dsh 的文件名恒为 `session.v4.jsonl(.zstd)`，id 在**父目录名**里。
 * 旧兜底对 dsh 一律返回 `session.v4`，同机所有会话撞成同一个 id（水位串账）。
 */
export function sessionIdFromPath(path: string): string {
  const base = basename(path).replace(/\.jsonl(\.zstd)?$/, "");
  if (/^session(\.v\d+)?$/.test(base)) return basename(dirname(path));
  return base;
}
