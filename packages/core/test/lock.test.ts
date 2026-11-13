/** 两级锁：原子抢占、死锁回收、级别隔离 */
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import {
  acquireLock, releaseLock, readOwner, machineLockDir, vaultLockDir, inspectLock,
} from "../lib/trigger/lock.ts";

const noSleep = async () => {};

section("vault 锁：独占");
{
  const vault = mkdtempSync(join(tmpdir(), "qdoc-lock-"));
  const a = await acquireLock({ level: "vault", agent: "dsh", vault, sleep: noSleep });
  ok(a !== null, "第一次抢到");

  const b = await acquireLock({ level: "vault", agent: "pi", vault, sleep: noSleep, wait: false });
  eq(b, null, "第二次抢不到（同 vault 互斥）");

  ok(existsSync(join(vaultLockDir(vault), "owner.json")), "owner.json 已写");
  const owner = readOwner(vaultLockDir(vault));
  eq(owner?.agent, "dsh", "owner 记录持有者");

  releaseLock(a);
  ok(!existsSync(vaultLockDir(vault)), "释放后锁目录消失");

  const c = await acquireLock({ level: "vault", agent: "pi", vault, sleep: noSleep });
  ok(c !== null, "释放后可再抢");
  releaseLock(c);
  rmSync(vault, { recursive: true, force: true });
}

section("不同 vault 互不影响");
{
  const v1 = mkdtempSync(join(tmpdir(), "qdoc-l1-"));
  const v2 = mkdtempSync(join(tmpdir(), "qdoc-l2-"));
  const a = await acquireLock({ level: "vault", agent: "dsh", vault: v1, sleep: noSleep });
  const b = await acquireLock({ level: "vault", agent: "pi", vault: v2, sleep: noSleep });
  ok(a !== null && b !== null, "两个不同 vault 可同时持锁");
  releaseLock(a);
  releaseLock(b);
  rmSync(v1, { recursive: true, force: true });
  rmSync(v2, { recursive: true, force: true });
}

section("机器锁：跨项目互斥");
{
  process.env.QDOC_MACHINE_DIR = mkdtempSync(join(tmpdir(), "qdoc-m-"));
  const a = await acquireLock({ level: "machine", agent: "dsh", sleep: noSleep });
  ok(a !== null, "抢到机器锁");
  const b = await acquireLock({ level: "machine", agent: "pi", sleep: noSleep, wait: false });
  eq(b, null, "第二个进程抢不到（跨项目全局互斥）");
  releaseLock(a);
  ok(!existsSync(machineLockDir()), "释放后消失");
  rmSync(process.env.QDOC_MACHINE_DIR ?? process.env.QDOC_MACHINE_DIR, { recursive: true, force: true });
}

section("死锁回收：TTL 过期后可抢");
{
  const vault = mkdtempSync(join(tmpdir(), "qdoc-ttl-"));
  const dir = vaultLockDir(vault);
  mkdirSync(dir, { recursive: true });
  // 造一个已过期的锁（pid 指向不存在的进程）
  writeFileSync(join(dir, "owner.json"), JSON.stringify({
    pid: 999999,
    agent: "dead",
    acquired_at: "2020-01-01T00:00:00Z",
    expires_at: "2020-01-01T00:30:00Z",
  }));
  const got = await acquireLock({ level: "vault", agent: "dsh", vault, sleep: noSleep });
  ok(got !== null, "过期锁被回收并抢到");
  eq(readOwner(dir)?.agent, "dsh", "owner 换成新持有者");
  releaseLock(got);
  rmSync(vault, { recursive: true, force: true });
}

section("释放别人的锁：不动");
{
  const vault = mkdtempSync(join(tmpdir(), "qdoc-other-"));
  const dir = vaultLockDir(vault);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({
    pid: 999998,
    agent: "other",
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }));
  // 伪造一个句柄指向该目录
  releaseLock({ dir, level: "vault", owner: { pid: 999998, agent: "other", acquired_at: "", expires_at: "" } });
  ok(existsSync(dir), "pid 不匹配时不删别人的锁");
  rmSync(vault, { recursive: true, force: true });
}

section("inspectLock：诊断");
{
  const vault = mkdtempSync(join(tmpdir(), "qdoc-insp-"));
  eq(inspectLock("vault", vault), null, "无锁时返回 null");
  const h = await acquireLock({ level: "vault", agent: "dsh", vault, sleep: noSleep });
  const o = inspectLock("vault", vault);
  eq(o?.pid, process.pid, "能查到持有者 pid");
  releaseLock(h);
  rmSync(vault, { recursive: true, force: true });
}


section("首次使用：机器目录不存在时能自建（真实崩溃点）");
{
  // 复现真实场景：~/.config 存在但 ~/.config/qdoc 不存在（两级路径）
  const root = mkdtempSync(join(tmpdir(), "qdoc-lk-"));
  const machineDir = join(root, ".config", "qdoc");
  const old = process.env.QDOC_MACHINE_DIR;
  process.env.QDOC_MACHINE_DIR = machineDir;

  ok(!existsSync(machineDir), "前置：目录确实不存在");
  const h = await acquireLock({ level: "machine", agent: "dsh", session: "s1", vault: "/p", wait: false });
  ok(h != null, "两级目录不存在也能抢到锁");
  ok(existsSync(machineLockDir()), "锁目录已建");
  releaseLock(h!);

  if (old === undefined) delete process.env.QDOC_MACHINE_DIR; else process.env.QDOC_MACHINE_DIR = old;
  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
