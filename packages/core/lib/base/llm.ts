/**
 * LLM 一次性调用（知识抽取/判重/打包共用引擎）。
 *
 * 两种配置来源（分发化设计，复用用户环境的 API 配置）：
 *   A. registry 模式：extension 在场时注入 ModelRegistry——凭据解析与 pi 主对话
 *      完全同链（auth.json / models.json / 环境变量 / !command），用户零额外配置。
 *   B. 独立模式：进程级 CLI（quit spawn / 手动回填 / darwin judge）没有 registry，
 *      走解析降级链 resolveStandaloneConfig()：
 *      ① AUTOSKILL_PROVIDER/AUTOSKILL_MODEL 显式指定（读 models.json 该 provider）
 *      ② settings.json 默认 provider（apiKey 可解析时，含 $ENV / !command 形式）
 *      ③ 扫描 models.json 第一个 apiKey 可解析的 provider
 *      ④ 环境变量直连 OPENAI_BASE_URL/OPENAI_API_KEY
 *      都失败 → 明确报错指引，不静默降级。
 *
 * 显式环境变量永远最高优先级；默认模型跟随"用户当前会话模型"（registry 模式）
 * 或 settings.json 的 defaultModel（独立模式）。
 *
 * 绝不在主对话轮次内调用——独立 fire-and-forget 使用。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostContext } from "./context.ts";

export interface ChatOptions {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal; // 外部取消（如 compaction 被用户取消）
}

/** token 用量（预算控制用；部分网关不返回，字段可缺） */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  text: string;
  model: string;
  usage?: ChatUsage;
}

/** registry 模式注入的调用器抽象（extension 用 ModelRegistry 实现，测试可 mock） */
export interface ChatCompleter {
  (opts: ChatOptions): Promise<ChatResult>;
}

// ---------------- 配置解析 ----------------

export interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ProviderEntry {
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id: string }>;
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

/** 展开 models.json 的 apiKey 形式：字面量 / $ENV / ${ENV} / !command */
function resolveApiKey(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    if (raw.startsWith("!")) {
      // 同步子进程取 key（models.json 的 !command 形式；CLI 启动期一次性调用，可接受）
      const out = execSync(raw.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.trim() || null;
    }
    const m = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (m) return process.env[m[1]] || null;
    return raw || null;
  } catch {
    return null;
  }
}

/** 独立模式降级链。返回 null 时附 human 可读原因。 */
export function resolveStandaloneConfig(): { config: ChatConfig | null; reason?: string } {
  // 凭据定位基准由 HostContext 注入（适配层启动时指定，宿主内闭环）：
  //   pi 形态 → homeDir = ~/.pi/agent，读 models.json + settings.json（现状行为）
  //   dsh/CLI 形态 → 不注 homeDir，models/settings 为空，直接走环境变量直连④
  const h = hostContext();
  const agentDir = h?.homeDir ?? null;
  const modelsPath = h?.modelsPath ?? (agentDir ? join(agentDir, "models.json") : null);
  const models = modelsPath ? readJson(modelsPath) as { providers?: Record<string, ProviderEntry> } | null : null;

  // ① 显式指定（AUTOSKILL_*，读 models.json 对应 provider）
  const envProvider = process.env.AUTOSKILL_PROVIDER;
  if (envProvider && models?.providers?.[envProvider]) {
    const p = models.providers[envProvider];
    const key = resolveApiKey(p.apiKey);
    const model = process.env.AUTOSKILL_MODEL ?? p.models?.[0]?.id;
    if (!key) return { config: null, reason: `AUTOSKILL_PROVIDER=${envProvider} 但 apiKey 无法解析` };
    if (!p.baseUrl) return { config: null, reason: `AUTOSKILL_PROVIDER=${envProvider} 缺 baseUrl` };
    return { config: { baseUrl: p.baseUrl, apiKey: key, model: model ?? "default" } };
  }

  // ② settings 指向的默认 provider（跟随宿主单点配置），凭据可解析则用之
  const settingsPath = h?.settingsPath ?? (agentDir ? join(agentDir, "settings.json") : null);
  const settings = settingsPath ? readJson(settingsPath) as { defaultProvider?: string; defaultModel?: string } | null : null;
  const preferred = settings?.defaultProvider;
  if (preferred && models?.providers?.[preferred]) {
    const p = models.providers[preferred];
    const key = resolveApiKey(p.apiKey);
    if (key && p.baseUrl) {
      const model = process.env.AUTOSKILL_MODEL ?? settings?.defaultModel ?? p.models?.[0]?.id ?? "default";
      return { config: { baseUrl: p.baseUrl, apiKey: key, model } };
    }
  }

  // ③ 扫描 models.json：第一个 apiKey 可解析的 provider
  if (models?.providers) {
    for (const [name, p] of Object.entries(models.providers)) {
      const key = resolveApiKey(p.apiKey);
      if (key && p.baseUrl) {
        const model = process.env.AUTOSKILL_MODEL ?? settings?.defaultModel ?? p.models?.[0]?.id ?? "default";
        // settings.defaultModel 可能属于其他 provider，仅当该 provider 含此模型时用
        const belongs = p.models?.some((m) => m.id === model);
        return { config: { baseUrl: p.baseUrl, apiKey: key, model: belongs ? model : (p.models?.[0]?.id ?? "default") } };
      }
    }
  }

  // ④ 环境变量直连
  if (process.env.OPENAI_API_KEY) {
    return {
      config: {
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.AUTOSKILL_MODEL ?? "gpt-4o-mini",
      },
    };
  }

  return {
    config: null,
    reason:
      "未找到可用 LLM 配置。解决方式任选其一：\n" +
      (hostContext()?.host === "pi"
        ? "  a) 在 pi 里跑一次 /login（auth.json 凭据仅 pi 进程内可见，CLI 需改用 b/c）\n"
        : "") +
      (hostContext()?.homeDir
        ? `  b) ${hostContext()?.homeDir}/models.json 里给 provider 配 apiKey（支持 $ENV / !command 形式）\n`
        : "") +
      "  c) 设置 AUTOSKILL_PROVIDER=<凭据定位基准中的 provider 名>（可选 AUTOSKILL_MODEL=...）\n" +
      "  d) 设置 OPENAI_API_KEY（可选 OPENAI_BASE_URL）",
  };
}

// ---------------- 通用 completer 注入点（宿主自带 LLM 服务） ----------------
// dsh 适配层用 ctx.llm（provider 无关的流式模型服务）实现本接口：dsh 的凭据不存在
// models.json 里，而是宿主自己的 profile/credentials，standalone 降级链在 dsh 里只剩
// OPENAI_API_KEY 一条路。注入后 core 的调用走宿主服务，凭据解析留在宿主内部闭环。

let injectedCompleter: ChatCompleter | null = null;

/** 注入宿主侧调用器；优先级高于 registry 与 standalone */
export function setChatCompleter(fn: ChatCompleter): void {
  injectedCompleter = fn;
}

/** 宿主卸载时撤掉注入（Cordis disposal） */
export function clearChatCompleter(): void {
  injectedCompleter = null;
}

// ---------------- registry 模式注入点 ----------------

type RegistryLike = {
  getAvailable(): Array<{ provider: string; id: string; name?: string }>;
  find(provider: string, modelId: string): unknown;
  streamSimple(model: unknown, context: unknown, options?: unknown): AsyncIterable<any> & { [k: string]: unknown };
};

let registry: RegistryLike | null = null;
let registryModelId: string | null = null; // registry 模式下选定的 model id（含 provider 前缀解析结果）

/**
 * extension 启动时注入 ModelRegistry（jiti 环境下用结构类型，不 import pi 内部模块）。
 * preferredModel 形如 "provider/model-id"；缺省取 available 第一个。
 */
export function setModelRegistry(reg: RegistryLike, preferredModel?: string): void {
  registry = reg;
  registryModelId = preferredModel ?? null;
}

export function clearModelRegistry(): void {
  registry = null;
  registryModelId = null;
}

/** 当前生效配置描述（日志/诊断用） */
export function activeConfigDescription(): string {
  if (injectedCompleter) return "宿主注入 completer 模式（dsh ctx.llm）";
  if (registry) return `registry 模式（model=${registryModelId ?? "跟随会话"})`;
  return "standalone 模式（models.json/env 解析）";
}

async function chatViaRegistry(opts: ChatOptions): Promise<ChatResult> {
  if (!registry) throw new Error("registry 未注入");
  // 选模型：显式 opts.model > 注入时指定的 preferred > available 第一个
  let found: { provider: string; id: string } | undefined;
  const avail = registry.getAvailable();
  if (opts.model) {
    const [prov, id] = opts.model.includes("/") ? [opts.model.slice(0, opts.model.indexOf("/")), opts.model.slice(opts.model.indexOf("/") + 1)] : [undefined, opts.model];
    found = avail.find((m) => m.id === id && (prov ? m.provider === prov : true)) as { provider: string; id: string } | undefined;
    if (!found && prov) found = avail.find((m) => m.id === opts.model) as { provider: string; id: string } | undefined;
  } else if (registryModelId) {
    const rid = registryModelId.includes("/") ? registryModelId.slice(registryModelId.indexOf("/") + 1) : registryModelId;
    found = avail.find((m) => m.id === rid) as { provider: string; id: string } | undefined;
  }
  found = found ?? (avail[0] as { provider: string; id: string } | undefined);
  if (!found) throw new Error("registry 中无可用模型（用户未登录任何 provider）");

  const modelObj = registry.find(found.provider, found.id);
  if (!modelObj) throw new Error(`model ${found.provider}/${found.id} 不在 registry`);

  // Context 组装：system prompt + 单条 user message（pi-ai 类型，无需 tools）
  const context = {
    systemPrompt: opts.system,
    messages: [{ role: "user", content: opts.user, timestamp: Date.now() }],
    tools: [],
  };

  // pi-ai 内建重试/退避（StreamOptions.maxRetryDelayMs），外层不叠加重试
  const eventStream = registry.streamSimple(modelObj, context, { signal: opts.signal });
  let text = "";
  let reasoning = "";
  for await (const ev of eventStream as AsyncIterable<{ type: string; delta?: string; error?: { errorMessage?: string } }>) {
    if (opts.signal?.aborted) break;
    if (ev.type === "text_delta") text += ev.delta ?? "";
    else if (ev.type === "thinking_delta") reasoning += ev.delta ?? "";
    else if (ev.type === "error") throw new Error(ev.error?.errorMessage ?? "LLM 流错误");
  }
  // 兼容 deepseek 风格：正文为空时从 reasoning 中抢救 JSON
  const out = text.trim() || extractJsonFromText(reasoning) || "";
  if (!out) throw new Error("LLM 返回空 content");
  return { text: out, model: `${found.provider}/${found.id}` };
}

// ---------------- 主入口 ----------------

export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
  // A0. 宿主注入的 completer：dsh 等自带 LLM 服务的宿主，凭据在宿主内闭环
  if (injectedCompleter) return injectedCompleter(opts);

  // A. registry 模式：extension 在场（pi before_agent_start / dsh 定时器等在线抽取入口）
  if (registry) return chatViaRegistry(opts);

  // B. 独立模式：CLI 进程（quit spawn / 手动回填 / assemble / darwin judge）
  const { config, reason } = resolveStandaloneConfig();
  if (!config) throw new Error(reason ?? "无可用 LLM 配置");
  const model = opts.model ?? config.model;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  // 让网关在流末尾回传 usage（不支持的网关会忽略，不影响调用）
  body.stream_options = { include_usage: true };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let onAbort: (() => void) | undefined;
    try {
      const ctrl = new AbortController();
      // 超时放宽到 30 分钟：思考型模型对密集知识窗口单窗可超 10 分钟
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1_800_000);
      if (opts.signal) {
        if (opts.signal.aborted) { clearTimeout(timer); throw new Error("调用前已取消"); }
        onAbort = () => ctrl.abort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      // 流式调用：非流式长请求（推理 5-10 分钟无流量）会被网关掐断
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }
      const { text, usage } = await consumeStream(res);
      clearTimeout(timer);
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (!text.trim()) throw new Error("LLM 返回空 content");
      return { text, model, usage };
    } catch (e) {
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      lastErr = e;
      const aborted = opts.signal?.aborted; // 用户取消不重试
      if (!aborted && attempt < 3) await sleep(5000 * attempt);
      if (aborted) break;
    }
  }
  throw new Error(`LLM 调用失败（重试3次）: ${String(lastErr)}`);
}

/** 消费 SSE 流，拼接 content（思考型模型的 reasoning_content 不入正文，但空 content 时回退取它） */
async function consumeStream(res: Response): Promise<{ text: string; usage?: ChatUsage }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage: ChatUsage | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
        if (d?.reasoning_content) reasoning += d.reasoning_content;
        // 部分网关在最后一个 chunk 回传 usage（choices 为空）
        if (j.usage) {
          usage = {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            totalTokens: j.usage.total_tokens ?? 0,
          };
        }
      } catch {
        // 忽略无法解析的行（如 keep-alive 注释）
      }
    }
  }
  // 兼容 deepseek 风格：正文为空时从 reasoning 中抢救 JSON
  if (!content.trim() && reasoning) {
    return { text: extractJsonFromText(reasoning) ?? reasoning, usage };
  }
  return { text: content, usage };
}

/** 从文本中抢救 JSON（剥代码围栏、取首个 { 到末个 }） */
export function extractJsonFromText(text: string): string | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return t.slice(first, last + 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
