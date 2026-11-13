/**
 * qdoc MCP 客户端。
 *
 * 协议：Streamable HTTP + SSE（`POST /mcp`，`Accept: application/json, text/event-stream`）。
 * 只用 Node 内置 `fetch` + `ReadableStream`，不引第三方依赖。
 *
 * 平台能力边界（实测 2026-11-13，server `offerlai/1.30.0`，10 个工具）：
 *  - 没有 namespace：靠 filename 前缀 + tags 分组（§9.2）
 *  - 没有 delete：只能墓碑（改正文 + 改 status 标签）（§9.5）
 *  - 没有 draft：发布前本地确定性门禁（§12）
 *  - `update_document` **不接受 tags**，tags 只在 create 时给
 *  - `import_skill_from_files` 落库后是「未启用」，`list_available_skills` 只返回已启用
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MCP_URL = "https://qdoc.chat/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "qdoc-wiki";
const CLIENT_VERSION = "1.0.0";

/** 平台工具名（10 个） */
export type ToolName =
  | "list_available_skills"
  | "get_skill"
  | "import_skill_from_files"
  | "update_skill"
  | "search_documents"
  | "list_documents"
  | "read_document"
  | "read_document_content"
  | "create_document"
  | "update_document";

export interface DocSummary {
  id: number | string;
  filename: string;
  file_type?: string;
  namespace?: string;
  source_type?: string;
  vectorized?: boolean;
  version?: number;
  updated_at?: string;
  /** 仅 read_document 返回；list_documents 不含 */
  metadata?: { tags?: string[]; agent_user?: string; [k: string]: unknown };
}

/** 技能文件项（import/update 的 files 数组元素；字段名以平台 schema 为准） */
export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description?: string;
  source?: string;
  builtin?: boolean;
}

export interface McpClientOptions {
  url?: string;
  token?: string;
  /** 单次请求超时（默认 60s） */
  timeoutMs?: number;
  /** 重试次数（默认 2，即最多 3 次尝试） */
  retries?: number;
}

/**
 * Token 三级查找（方案 §10.12①）：
 *   ① `$QDOC_TOKEN`
 *   ② `<project>/.qdoc/.ow/token`（600）
 *   ③ `~/.config/qdoc/token`（600）
 *
 * 一个 token 通所有项目——平台没有 namespace，隔离靠 filename 前缀，不是靠 token。
 */
export function resolveToken(opts: { vaultDir?: string } = {}): { token: string | null; source: string } {
  const env = process.env.QDOC_TOKEN?.trim();
  if (env) return { token: env, source: "env:QDOC_TOKEN" };

  if (opts.vaultDir) {
    const p = join(opts.vaultDir, ".ow", "token");
    const t = tryReadToken(p);
    if (t) return { token: t, source: p };
  }

  const global = join(homedir(), ".config", "qdoc", "token");
  const t = tryReadToken(global);
  if (t) return { token: t, source: global };

  return { token: null, source: "none" };
}

function tryReadToken(path: string): string | null {
  try {
    const t = readFileSync(path, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export class QdocMcpError extends Error {
  readonly code?: number;
  readonly tool?: string;

  constructor(message: string, code?: number, tool?: string) {
    super(message);
    this.name = "QdocMcpError";
    this.code = code;
    this.tool = tool;
  }
}

export class QdocMcpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;
  /** 平台在结果里夹带的提示（如 token 轮换宽限期），最后一次非空值 */
  private lastNotice: string | null = null;

  constructor(opts: McpClientOptions = {}) {
    const token = opts.token ?? resolveToken().token;
    if (!token) {
      throw new QdocMcpError(
        "找不到 qdoc token。三级查找全失败：$QDOC_TOKEN / <vault>/.ow/token / ~/.config/qdoc/token",
      );
    }
    this.url = opts.url ?? process.env.QDOC_MCP_URL ?? DEFAULT_MCP_URL;
    this.token = token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
  }

  /** 建立 MCP 会话（initialize + notifications/initialized） */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    // 通知类请求没有 id、不等响应
    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  /** 调工具，返回解析后的结果（平台把 JSON 塞在 content[0].text 里） */
  async callTool<T = unknown>(name: ToolName, args: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();
    const res = await this.rpc("tools/call", { name, arguments: args });
    this.captureNotice(res);
    return unwrapToolResult<T>(res, name);
  }

  /**
   * 平台会在任何工具结果里夹带 `_notice`（实测：token 轮换宽限期提醒）。
   * 这类提示必须透出——静默吞掉会导致 token 到期后全线失败且没人知道原因。
   */
  private captureNotice(res: any): void {
    const n = res?._notice ?? res?.content?.[0]?._notice;
    if (typeof n === "string" && n.trim()) this.lastNotice = n.trim();
  }

  /** 取走最近一次平台提示（取后清空，避免重复打印） */
  takeNotice(): string | null {
    const n = this.lastNotice;
    this.lastNotice = null;
    return n;
  }

  // ---------------- 文档 ----------------

  async listDocuments(opts: { limit?: number; offset?: number } = {}): Promise<DocSummary[]> {
    const res = await this.callTool<{ documents?: DocSummary[] }>("list_documents", {
      limit: Math.min(opts.limit ?? 20, 50),
      offset: opts.offset ?? 0,
    });
    return res?.documents ?? [];
  }

  async searchDocuments(query: string, opts: { limit?: number } = {}): Promise<DocSummary[]> {
    const res = await this.callTool<{ documents?: DocSummary[] }>("search_documents", {
      query,
      limit: opts.limit ?? 10,
    });
    return res?.documents ?? [];
  }

  /**
   * 文档元数据（含 tags）。**tags 只能从这里读**——
   * `list_documents` 返回的字段里没有 tags（实测）。
   */
  async readDocument(id: number): Promise<DocSummary> {
    return this.callTool<DocSummary>("read_document", { doc_id: id });
  }

  /** 参数名是 `doc_id`（整数），不是 document_id */
  async readDocumentContent(id: number, maxChars?: number): Promise<string> {
    const res = await this.callTool<{ content?: string; text?: string; content_md?: string } | string>(
      "read_document_content",
      { doc_id: id, ...(maxChars != null ? { max_chars: maxChars } : {}) },
    );
    if (typeof res === "string") return res;
    return res?.content_md ?? res?.content ?? res?.text ?? "";
  }

  /** 参数名是 `content_md`；`tags` 只在 create 时能传（update 不收） */
  async createDocument(input: {
    filename: string;
    content: string;
    tags?: string[];
    namespaceId?: number;
  }): Promise<{ id?: number; doc_id?: number; version?: number }> {
    return this.callTool("create_document", {
      filename: input.filename,
      content_md: input.content,
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.namespaceId != null ? { namespace_id: input.namespaceId } : {}),
    });
  }

  /** `base_version` 必填（乐观锁）；不传平台会拒 */
  async updateDocument(input: {
    documentId: number;
    content: string;
    baseVersion: number;
  }): Promise<{ id?: number; doc_id?: number; version?: number }> {
    return this.callTool("update_document", {
      doc_id: input.documentId,
      content_md: input.content,
      base_version: input.baseVersion,
    });
  }

  // ---------------- 技能 ----------------

  /** 平台把每个技能返回成一个 content 项 → 解包后是数组 */
  async listAvailableSkills(): Promise<SkillSummary[]> {
    const res = await this.callTool<{ skills?: SkillSummary[] } | SkillSummary[]>(
      "list_available_skills", {},
    );
    if (Array.isArray(res)) return res;
    return (res as { skills?: SkillSummary[] })?.skills ?? [];
  }

  async getSkill(id: string): Promise<Record<string, unknown>> {
    return this.callTool("get_skill", { skill_id: id });
  }

  /** `description` 也必填 */
  async importSkillFromFiles(input: {
    name: string;
    description: string;
    files: SkillFile[];
  }): Promise<{ skill_id?: string; id?: string; version?: number }> {
    return this.callTool("import_skill_from_files", {
      name: input.name,
      description: input.description,
      files: input.files,
    });
  }

  /** `base_version` 必填（乐观锁） */
  async updateSkill(input: {
    skillId: string;
    files: SkillFile[];
    baseVersion: number;
    name?: string;
    description?: string;
  }): Promise<{ skill_id?: string; version?: number }> {
    return this.callTool("update_skill", {
      skill_id: input.skillId,
      files: input.files,
      base_version: input.baseVersion,
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
  }

  // ---------------- 传输层 ----------------

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    const res = await this.post(body);

    if (res.error) {
      throw new QdocMcpError(
        `MCP ${method} 失败：${res.error.message ?? JSON.stringify(res.error)}`,
        res.error.code,
        method,
      );
    }
    return res.result;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, true);
  }

  private async post(body: unknown, noResponse = false): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.postOnce(body, noResponse);
      } catch (e) {
        lastErr = e;
        // 4xx（除 429）不重试——参数错了重试也没用
        if (e instanceof QdocMcpError && e.code && e.code >= 400 && e.code < 500 && e.code !== 429) throw e;
        if (attempt < this.retries) await sleep(800 * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new QdocMcpError(String(lastErr));
  }

  private async postOnce(body: unknown, noResponse: boolean): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      // 服务端可能下发会话 id
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new QdocMcpError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }
      if (noResponse) return null;

      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("text/event-stream")) return parseSse(await res.text());
      const text = await res.text();
      if (!text.trim()) return null;
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 解析 SSE 响应体，取最后一个 `data:` 里的 JSON-RPC 结果 */
export function parseSse(raw: string): any {
  let last: any = null;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {
      /* 忽略无法解析的块（keep-alive 等） */
    }
  }
  return last;
}

/**
 * 解包工具结果。平台两种形态（实测 2026-11-13）：
 *
 *  a) 单个 JSON 在 content[0]：`{content:[{type:"text",text:"{\"documents\":[...]}"}]}`
 *  b) **每个元素一个 content 项**：`list_available_skills` 返回 N 个
 *     `{type:"text",text:"{\"id\":...}"}`，每项一个技能
 *
 * 只取 content[0] 会把 (b) 变成「0 个技能」——这个坑实测踩过。
 */
export function unwrapToolResult<T>(res: any, tool: string): T {
  if (!res) return {} as T;
  if (res.isError) {
    const msg = res.content?.[0]?.text ?? "工具返回错误";
    throw new QdocMcpError(`工具 ${tool} 报错：${msg}`, undefined, tool);
  }

  const items: any[] = Array.isArray(res.content) ? res.content : [];
  const texts = items
    .filter((i) => i?.type === "text" && typeof i.text === "string")
    .map((i) => i.text as string);

  if (texts.length === 0) return res as T;

  // 每项都是 JSON → 返回数组（多元素形态）
  const parsed = texts.map((t) => {
    const s = t.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return { ok: false as const, raw: s };
    try {
      return { ok: true as const, value: JSON.parse(s) };
    } catch {
      return { ok: false as const, raw: s };
    }
  });

  if (texts.length === 1) {
    const p = parsed[0];
    return (p.ok ? p.value : p.raw) as T;
  }

  // 多项：全是 JSON 对象 → 数组；否则拼成文本
  if (parsed.every((p) => p.ok)) {
    return parsed.map((p) => (p as { value: unknown }).value) as T;
  }
  return texts.join("\n") as unknown as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 便捷：一次性建连并跑回调 */
export async function withClient<T>(
  opts: McpClientOptions,
  fn: (c: QdocMcpClient) => Promise<T>,
): Promise<T> {
  const c = new QdocMcpClient(opts);
  await c.initialize();
  return fn(c);
}
