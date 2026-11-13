/** 会话文件读取：zstd 内置解压、会话头、子代理过滤 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  readSessionLines, readSessionEvents, readSessionHeader, resolveSessionFile,
  isSubagentSession, sessionIdFromPath,
} from "../lib/trigger/session-file.ts";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const makeZstd = (raw: string): Buffer => zstdCompressSync(Buffer.from(raw, "utf8"));

section("明文 jsonl");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sf-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, [line({ type: "session", id: "abc", cwd: "/proj" }), line({ type: "user/message", seq: 1 })].join("\n"), "utf8");
  eq(readSessionLines(p).filter(Boolean).length, 2, "两行");
  eq(readSessionEvents(p).length, 2, "两事件");
  rmSync(dir, { recursive: true, force: true });
}

section("zstd 压缩（内置解压，不依赖外部命令）");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sfz-"));
  const p = join(dir, "session.v4.jsonl.zstd");
  const raw = [line({ type: "session", id: "z1", cwd: "/p" }), line({ type: "turn/start", seq: 2 })].join("\n");
  writeFileSync(p, zstdCompressSync(Buffer.from(raw, "utf8")));
  const lines = readSessionLines(p).filter(Boolean);
  eq(lines.length, 2, "解压出两行");
  ok(lines[0].includes('"z1"'), "内容正确");
  rmSync(dir, { recursive: true, force: true });
}

section("多帧 zstd（dsh 追加写的真实形状）");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-mf-"));
  const p = join(dir, "session.v4.jsonl.zstd");
  // 三帧拼接：模拟 dsh 每次 flush 追加一帧
  const frames = [
    line({ type: "session", id: "mf", cwd: "/p" }),
    line({ type: "user/message", seq: 2 }),
    line({ type: "turn/end", seq: 3 }),
  ].map((l) => zstdCompressSync(Buffer.from(`${l}\n`, "utf8")));
  writeFileSync(p, Buffer.concat(frames));

  // 单帧解压只能拿到第一帧 —— 这是踩过的坑，写成断言防止回退
  eq(zstdDecompressSync(readFileSync(p)).toString("utf8").trim().split("\n").filter(Boolean).length, 1,
    "单帧解压只出 1 行（证明多帧确实存在）");

  const lines = readSessionLines(p).filter(Boolean);
  eq(lines.length, 3, "多帧解压出全部 3 行");
  ok(lines[2].includes("turn/end"), "末帧内容正确");
  rmSync(dir, { recursive: true, force: true });
}

section("截断帧：0 字节不抛错，不能当真边界");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-tr-"));
  const p = join(dir, "session.v4.jsonl.zstd");
  const good1 = zstdCompressSync(Buffer.from('{"type":"session","id":"t"}\n'));
  const good2 = zstdCompressSync(Buffer.from('{"type":"turn/start","seq":2}\n'));
  // 帧要够大：小帧截断后可能仍解出残片，大帧才会解出 0 字节
  const good3 = zstdCompressSync(Buffer.from('{"type":"turn/end","seq":3,"pad":"' + "z".repeat(400) + '"}\n'));
  // 第三帧写到一半（模拟 dsh 正在 flush 时被读）
  const half = good3.subarray(0, Math.floor(good3.length / 2));
  writeFileSync(p, Buffer.concat([good1, good2, half]));

  // 前提确认：截断帧解出 0 字节且不抛错 —— 这正是坑
  eq(zstdDecompressSync(half).length, 0, "截断帧解出 0 字节（不抛错）");

  const lines = readSessionLines(p).filter(Boolean);
  eq(lines.length, 2, "完整的两帧读到，截断的末帧丢弃");
  ok(lines[0].includes('"t"'), "首帧正确");
  ok(lines[1].includes("turn/start"), "次帧正确");
  rmSync(dir, { recursive: true, force: true });
}

section("边写边读：逐帧追加都能读到");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-live-"));
  const p = join(dir, "session.v4.jsonl.zstd");
  const fd = openSync(p, "w");
  const counts: number[] = [];
  for (let i = 0; i < 12; i++) {
    writeSync(fd, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "turn/end", seq: i })}\n`)));
    counts.push(readSessionLines(p).filter(Boolean).length);
  }
  closeSync(fd);
  eq(counts, [1,2,3,4,5,6,7,8,9,10,11,12], "每追加一帧就多读到一行");
  rmSync(dir, { recursive: true, force: true });
}

section("损坏行静默跳过");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sfb-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, `${line({ type: "session", id: "x" })}\n{坏行\n${line({ type: "turn/start" })}\n`, "utf8");
  eq(readSessionEvents(p).length, 2, "坏行被跳过，好行保留");
  rmSync(dir, { recursive: true, force: true });
}

section("会话头");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sfh-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, line({ type: "session", version: 4, id: "h1", cwd: "/my/proj", isSeeded: false, delegationDepth: 0 }), "utf8");
  const h = readSessionHeader(p);
  eq(h?.id, "h1", "id");
  eq(h?.cwd, "/my/proj", "cwd");
  eq(h?.version, 4, "version");
  rmSync(dir, { recursive: true, force: true });
}

section("子代理识别");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sfs-"));
  const main = join(dir, "main.jsonl");
  writeFileSync(main, line({ type: "session", id: "m", delegationDepth: 0 }), "utf8");
  ok(!isSubagentSession(main), "主会话不是子代理");

  const sub = join(dir, "sub.jsonl");
  writeFileSync(sub, line({ type: "session", id: "s", delegationDepth: 1 }), "utf8");
  ok(isSubagentSession(sub), "delegationDepth>=1 → 子代理");

  const sub2 = join(dir, "sub2.jsonl");
  writeFileSync(sub2, line({ type: "session", id: "s2", origin: "subagent" }), "utf8");
  ok(isSubagentSession(sub2), "origin=subagent → 子代理");
  rmSync(dir, { recursive: true, force: true });
}

section("会话 id 兜底：dsh 取父目录名");
{
  eq(sessionIdFromPath("/x/sessions/--slug--/session-abc/session.v4.jsonl.zstd"), "session-abc", "dsh 取父目录");
  eq(sessionIdFromPath("/x/sessions/--slug--/session-abc/session.v4.jsonl"), "session-abc", "明文同样");
  eq(sessionIdFromPath("/x/pi/2026-01-01T00-00-00.jsonl"), "2026-01-01T00-00-00", "pi 取文件名");
  ok(sessionIdFromPath("/a/s1/session.v4.jsonl") !== sessionIdFromPath("/b/s2/session.v4.jsonl"),
    "不同会话不撞 id");
}


section("会话目录 → 数据文件（真实 dsh v4 形状）");
{
  const dir = mkdtempSync(join(tmpdir(), "qdoc-sd-"));
  // 模拟真实形状：<session-id>/session.v4.jsonl.zstd
  const sdir = join(dir, "session-abc");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, "session.v4.jsonl"), '{"type":"a"}\n{"type":"b"}\n');

  eq(resolveSessionFile(sdir), join(sdir, "session.v4.jsonl"), "目录解析到内部文件");
  eq(readSessionLines(sdir).filter((l) => l.trim()).length, 2, "传目录也能读");

  // 只有 zstd 时优先 zstd
  const sdir2 = join(dir, "session-def");
  mkdirSync(sdir2, { recursive: true });
  writeFileSync(join(sdir2, "session.v4.jsonl.zstd"), makeZstd('{"type":"z"}\n'));
  eq(resolveSessionFile(sdir2), join(sdir2, "session.v4.jsonl.zstd"), "优先 zstd");

  // 非标准命名但只有一个文件
  const sdir3 = join(dir, "session-ghi");
  mkdirSync(sdir3, { recursive: true });
  writeFileSync(join(sdir3, "whatever.jsonl"), '{"type":"c"}\n');
  ok(resolveSessionFile(sdir3).endsWith("whatever.jsonl"), "兜底取唯一文件");

  // 空目录报清楚的错
  const sdir4 = join(dir, "session-jkl");
  mkdirSync(sdir4, { recursive: true });
  let threw = false;
  try { resolveSessionFile(sdir4); } catch (e) { threw = String(e).includes("找不到数据文件"); }
  ok(threw, "空目录给出明确错误");

  rmSync(dir, { recursive: true, force: true });
}

process.exit(summary());
