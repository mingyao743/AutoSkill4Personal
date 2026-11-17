/** MCP 文档能力：敏感策略归一 + 上传大小保护（不联网） */
import { ok, eq, section, summary } from "./_harness.ts";
import { MAX_UPLOAD_BYTES, QdocMcpClient, normalizeSensitivePolicy } from "../lib/publish/mcp.ts";

section("敏感策略归一");
{
  eq(normalizeSensitivePolicy("block"), "block", "block");
  eq(normalizeSensitivePolicy("warn"), "warn", "warn");
  eq(normalizeSensitivePolicy("allow"), "allow", "allow");
  eq(normalizeSensitivePolicy("nope"), "block", "未知值回退 block");
  eq(normalizeSensitivePolicy(undefined), "block", "缺省 block");
}

section("上传大小保护");
{
  const client = new QdocMcpClient({ token: "test-token", url: "http://127.0.0.1:1/mcp", retries: 0 });
  let msg = "";
  try {
    await client.uploadDocument({ filename: "big.pdf", content: Buffer.alloc(MAX_UPLOAD_BYTES + 1) });
  } catch (e) {
    msg = String(e);
  }
  ok(msg.includes("20MB"), "超 20MB 直接拒绝，不发网络请求", msg);
  ok(true, "MAX_UPLOAD_BYTES 导出", String(MAX_UPLOAD_BYTES));
}

section("客户端参数映射：sensitive_policy / upload");
{
  const client = new QdocMcpClient({ token: "test-token" });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  (client as unknown as { callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }).callTool =
    async (name, args) => { calls.push({ name, args }); return { id: "d1", version: 1 }; };

  await client.createDocument({ filename: "a.md", content: "x", sensitivePolicy: "warn" });
  eq(calls[0].name, "create_document", "create 工具名");
  eq(calls[0].args.sensitive_policy, "warn", "create 传 sensitive_policy");

  await client.updateDocument({ documentId: "d1", content: "y", baseVersion: 1, sensitivePolicy: "allow" });
  eq(calls[1].args.sensitive_policy, "allow", "update 有正文时传策略");

  await client.updateDocument({ documentId: "d1", baseVersion: 1, filename: "b.md" });
  eq("sensitive_policy" in calls[2].args, false, "update 只改名字不传策略");

  await client.uploadDocument({
    filename: "a.pdf",
    content: Buffer.from("%PDF"),
    tags: ["p:x"],
    isSafe: true,
    sensitivePolicy: "warn",
  });
  eq(calls[3].name, "upload_document", "upload 工具名");
  eq(calls[3].args.is_safe, true, "is_safe 映射");
  eq(calls[3].args.sensitive_policy, "warn", "upload 策略");
  eq(typeof calls[3].args.content_base64, "string", "base64 编码");
}

section("正文/原件读取映射");
{
  const client = new QdocMcpClient({ token: "test-token" });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  (client as unknown as { callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }).callTool =
    async (name, args) => {
      calls.push({ name, args });
      if (name === "read_document_content") {
        return { content: "# 解析正文", format: "markdown", truncated: true, total_chars: 123 };
      }
      return { filename: "a.pdf", size: 4, mime: "application/pdf", content_base64: "JVBERg==", truncated: false };
    };
  const d = await client.readDocumentContentDetail("d1", { format: "markdown", maxChars: 999 });
  eq(calls[0].name, "read_document_content", "读正文工具名");
  eq(calls[0].args.format, "markdown", "format 透传");
  eq(calls[0].args.max_chars, 999, "max_chars 透传");
  eq(d.content, "# 解析正文", "正文");
  eq(d.format, "markdown", "返回 format");
  eq(d.truncated, true, "返回 truncated");
  eq(d.totalChars, 123, "返回 total_chars");
  eq(await client.readDocumentContent("d1"), "# 解析正文", "旧方法仍返回 string");

  const src = await client.readDocumentSource("d1", 1024);
  const sourceCall = calls.find((c) => c.name === "read_document_source");
  eq(sourceCall?.name, "read_document_source", "读原件工具名");
  eq(sourceCall?.args.max_bytes, 1024, "max_bytes 透传");
  eq(src.mime, "application/pdf", "原件 mime");
}

process.exit(summary());
