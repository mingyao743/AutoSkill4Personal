/** 发布：平台敏感策略与 warnings */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, section, summary } from "./_harness.ts";
import { publishPage } from "../lib/publish/publish.ts";
import { readLedger } from "../lib/publish/ledger.ts";
import { initVault } from "../lib/vault/init.ts";
import type { QdocMcpClient } from "../lib/publish/mcp.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "qdoc-pub-"));

function makePage(root: string): { vault: string; page: string } {
  const vault = initVault(root).dir;
  const page = "concepts/sensitive-test.md";
  mkdirSync(join(vault, "concepts"), { recursive: true });
  writeFileSync(join(vault, page), `---
title: 测试页
summary: 测试敏感告警
tags: [test]
sources: [session:x]
base_confidence: 0.8
lifecycle: active
publish_as: document
publish_status: pending
---

${"这是一段足够长的正文，用来通过完整性门禁。".repeat(20)}
`, "utf8");
  return { vault, page };
}

function fakeClient(opts: { warnings?: string[]; throwMsg?: string }): { client: QdocMcpClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async listDocuments() { return []; },
    async readDocument() { throw new Error("not found"); },
    async createDocument(input: Record<string, unknown>) {
      calls.push(input);
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      return { id: "doc-1", version: 1, sensitive_warnings: opts.warnings ?? [] };
    },
    async updateDocument(input: Record<string, unknown>) { calls.push(input); return { id: "doc-1", version: 2 }; },
  } as unknown as QdocMcpClient;
  return { client, calls };
}

section("warn：传策略并记录 warnings");
{
  const root = tmp();
  const { vault, page } = makePage(root);
  const { client, calls } = fakeClient({ warnings: ["疑似手机号 138****"] });
  const r = await publishPage({ client, vaultDir: vault, projectRoot: root, pagePath: page, sensitivePolicy: "warn" });
  eq(r.action, "created", "创建成功");
  eq(r.sensitiveWarnings, ["疑似手机号 138****"], "结果带 warnings");
  eq(calls[0].sensitivePolicy, "warn", "publish 透传 sensitivePolicy");
  eq(readLedger(vault).pages[page].sensitive_warnings, ["疑似手机号 138****"], "账本记 warnings");
  rmSync(root, { recursive: true, force: true });
}

section("block：平台拒绝 → blocked + sensitiveBlocked");
{
  const root = tmp();
  const { vault, page } = makePage(root);
  const { client } = fakeClient({ throwMsg: "平台敏感检测：发现手机号" });
  const r = await publishPage({ client, vaultDir: vault, projectRoot: root, pagePath: page, sensitivePolicy: "block" });
  eq(r.action, "blocked", "标记 blocked");
  eq(r.sensitiveBlocked, true, "sensitiveBlocked");
  ok((r.message ?? "").includes("平台敏感检测"), "保留原因", r.message);
  rmSync(root, { recursive: true, force: true });
}

section("同一正文敏感拦截不重试；改正文后允许");
{
  const root = tmp();
  const { vault, page } = makePage(root);
  const { client, calls } = fakeClient({ throwMsg: "平台敏感检测：发现手机号" });
  const r1 = await publishPage({ client, vaultDir: vault, projectRoot: root, pagePath: page });
  eq(r1.action, "blocked", "第一次拦截");
  eq(calls.length, 1, "调用一次平台");
  const r2 = await publishPage({ client, vaultDir: vault, projectRoot: root, pagePath: page });
  eq(r2.action, "failed", "同一正文第二次不再调平台");
  eq(calls.length, 1, "没有重复调用");
  ok((r2.message ?? "").includes("同一正文"), "提示改正文/--force", r2.message);

  // 改正文 → 允许重新尝试
  const abs = join(vault, page);
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(abs, readFileSync(abs, "utf8") + "\n补充内容。", "utf8");
  const r3 = await publishPage({ client, vaultDir: vault, projectRoot: root, pagePath: page });
  eq(r3.action, "blocked", "改正文后重新调用（仍被拦截）");
  eq(calls.length, 2, "第二次平台调用发生");
  rmSync(root, { recursive: true, force: true });
}

process.exit(summary());
