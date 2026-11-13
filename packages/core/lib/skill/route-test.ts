/**
 * ⑤ 路由自测（SKILL_COMPILER §五、§八 M3）。
 *
 * 这是"技能会不会被加载"的唯一可测手段——发布前的质量门，不是一次性脚本。
 *
 * 流程（对一个目标技能）：
 *   1. 生成探针：5 条正样本（应命中它）+ 3 条负样本（邻近但不该命中它）；LLM 产出，
 *      按 sha1(description + 竞争集合指纹) 缓存到 route-cache.json。
 *   2. 判定：把全部候选 description 放进一次 prompt，逐条问"这条请求会加载哪个技能"，
 *      取排第 1 的技能名。正样本要求目标排第 1（≥4/5），负样本要求目标不排第 1（≥2/3）。
 *   3. 失败处理：把失败样例回喂重写 description（最多 2 次），重判；仍失败 → ok=false。
 *
 * 与契约校验的关系：validateSkillMd 继续只返回 needsRoutingTest；路由报告是独立产物
 * （<briefDir>/<skill>.route.json），--apply 读到失败报告必须拒绝（见 routeReportBlocksApply）。
 *
 * 依赖注入：只调 chatComplete（llm.ts），测试用 setChatCompleter 注入 mock。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chatComplete, extractJsonFromText } from "../base/llm.ts";

/** 探针数量与通过阈值（SKILL_COMPILER §五） */
export const POSITIVE_PROBES = 5;
export const NEGATIVE_PROBES = 3;
export const POSITIVE_PASS = 4; // 正样本 ≥4/5 命中目标
export const NEGATIVE_PASS = 2; // 负样本 ≥2/3 不命中目标
export const DEFAULT_MAX_REWRITES = 2;

export interface RouteCandidate {
  name: string; // kebab-case 技能名
  description: string;
}

export interface RouteProbes {
  positive: string[];
  negative: string[];
}

export interface RouteJudgment {
  probe: string;
  kind: "positive" | "negative";
  /** 判定排第 1 的技能名（无法解析/不存在时为 "none"） */
  rankedFirst: string;
}

export interface RouteAttempt {
  /** 1 起：1=初始判定，2/3=重写 description 后重判 */
  attempt: number;
  /** 本次判定用的 description（可能被重写过） */
  description: string;
  ok: boolean;
  positiveHits: number; // /5
  negativePass: number; // /3
  /** 人类可读的失败样例（回喂重写用） */
  failures: string[];
}

export interface RouteTestResult {
  ok: boolean;
  target: string;
  /** 最终 description（若重写过，与原始不同） */
  finalDescription: string;
  originalDescription: string;
  probes: RouteProbes;
  judgments: RouteJudgment[];
  positiveHits: number;
  negativePass: number;
  attempts: RouteAttempt[];
  /** description 重写次数（0/1/2） */
  rewrites: number;
}

export interface RouteTestInput {
  target: RouteCandidate;
  /** 竞争集合（必须含 target）；target 的 description 会随重写更新 */
  candidates: RouteCandidate[];
  /** route-cache.json 路径；不传则不落盘缓存（纯内存） */
  cachePath?: string;
  maxRewrites?: number;
  model?: string;
}

// ---------------- 缓存 ----------------

export interface RouteCache {
  version: 1;
  /** cacheKey → 探针 */
  entries: Record<string, { target: string; probes: RouteProbes; cachedAt: string }>;
}

export function emptyRouteCache(): RouteCache {
  return { version: 1, entries: {} };
}

export function loadRouteCache(cachePath: string): RouteCache {
  if (!existsSync(cachePath)) return emptyRouteCache();
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<RouteCache>;
    return {
      version: 1,
      entries: raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries) ? raw.entries : {},
    };
  } catch {
    return emptyRouteCache(); // 损坏视为空 → 重新生成探针（安全方向）
  }
}

export function saveRouteCache(cachePath: string, cache: RouteCache): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = cachePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, cachePath);
}

/** 竞争集合指纹：全部候选 name+description 排序后 sha1（不含 target 的"当前"描述，含原始） */
export function competitionFingerprint(candidates: readonly RouteCandidate[]): string {
  const sig = candidates
    .map((c) => `${c.name}\t${c.description}`)
    .sort()
    .join("\n");
  return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

/** 探针缓存键：sha1(target.description + 竞争集合指纹) */
export function probeCacheKey(target: RouteCandidate, candidates: readonly RouteCandidate[]): string {
  return createHash("sha1")
    .update(`${target.description}\n${competitionFingerprint(candidates)}`)
    .digest("hex")
    .slice(0, 24);
}

// ---------------- LLM 调用 ----------------

async function generateProbes(
  target: RouteCandidate,
  candidates: readonly RouteCandidate[],
  opts: { model?: string },
): Promise<RouteProbes> {
  const competitors = candidates.filter((c) => c.name !== target.name);
  const system = [
    "你为技能路由测试生成探针请求。目标技能有 5 条正样本（用户提了这类请求应当加载它）+ 3 条负样本",
    "（邻近话题、应当加载**别的**技能而非目标，用来抓误命中）。正样本要像真实用户提问（含症状/报错/工具名），",
    "负样本要长得像但属于另一个技能。只输出 JSON：{\"positive\":[5 条],\"negative\":[3 条]}。",
  ].join("");
  const user = [
    "# 目标技能",
    `name: ${target.name}`,
    `description: ${target.description}`,
    "",
    "# 同场竞争的别的技能（负样本应路由到这些，而非目标）",
    ...competitors.map((c) => `- ${c.name}: ${c.description}`),
    "",
    `生成 ${POSITIVE_PROBES} 条正样本 + ${NEGATIVE_PROBES} 条负样本，输出 JSON。`,
  ].join("\n");
  const res = await chatComplete({ system, user, model: opts.model, temperature: 0.4 });
  const json = extractJsonFromText(res.text);
  if (!json) throw new Error("探针生成未返回 JSON");
  const parsed = JSON.parse(json) as Partial<RouteProbes>;
  const positive = Array.isArray(parsed.positive) ? parsed.positive.map(String) : [];
  const negative = Array.isArray(parsed.negative) ? parsed.negative.map(String) : [];
  return { positive, negative };
}

async function judgeProbes(
  probes: RouteProbes,
  candidates: readonly RouteCandidate[],
  opts: { model?: string },
): Promise<RouteJudgment[]> {
  const all = [...probes.positive.map((p) => ({ p, k: "positive" as const })), ...probes.negative.map((p) => ({ p, k: "negative" as const }))];
  const system = [
    "你是技能路由器。给定一组技能（name + description）和一批用户请求，为每条请求选**最该加载**的那一个技能。",
    "如果没有任何技能匹配，返回 \"none\"。只输出一个 JSON 字符串数组，按请求顺序、每项一个技能 name（或 \"none\"），不要解释。",
  ].join("");
  const user = [
    "# 技能",
    ...candidates.map((c) => `- ${c.name}: ${c.description}`),
    "",
    "# 请求（按顺序）",
    ...all.map((r, i) => `${i + 1}. ${r.p}`),
    "",
    `输出 ${all.length} 项的 JSON 字符串数组，第 i 项是第 i 条请求最该加载的技能 name。`,
  ].join("\n");
  const res = await chatComplete({ system, user, model: opts.model, temperature: 0.0 });
  const names = parseJsonStringArray(res.text, all.length);
  return all.map((r, i) => ({ probe: r.p, kind: r.k, rankedFirst: names[i] ?? "none" }));
}

async function rewriteDescription(
  target: RouteCandidate,
  failures: readonly string[],
  candidates: readonly RouteCandidate[],
  opts: { model?: string },
): Promise<string> {
  const system = [
    "你重写技能的 frontmatter.description 来修路由失败。description 只写「何时用」（触发条件+症状+工具名+同义词），",
    "不写「做什么」；60–300 字、≥3 个触发短语；禁止「领域知识库/由 AutoSkill/涉及…时加载」等模板句。",
    "只输出新的 description 正文，不要 frontmatter、不要代码围栏、不要解释。",
  ].join("");
  const user = [
    "# 目标技能",
    `name: ${target.name}`,
    `当前 description: ${target.description}`,
    "",
    "# 同场竞争技能（不要让目标抢它们的请求）",
    ...candidates.filter((c) => c.name !== target.name).map((c) => `- ${c.name}: ${c.description}`),
    "",
    "# 路由失败样例（这些请求被误判了）",
    ...failures.map((f) => `- ${f}`),
    "",
    "针对这些失败重写 description，使正样本命中目标、负样本不再误命中目标。只输出新 description。",
  ].join("\n");
  const res = await chatComplete({ system, user, model: opts.model, temperature: 0.3 });
  return cleanDescription(res.text);
}

// ---------------- 主入口 ----------------

export async function routeTestSkill(input: RouteTestInput): Promise<RouteTestResult> {
  const maxRewrites = input.maxRewrites ?? DEFAULT_MAX_REWRITES;
  const cache = input.cachePath ? loadRouteCache(input.cachePath) : emptyRouteCache();
  const key = probeCacheKey(input.target, input.candidates);

  // 1. 探针（缓存命中则不调 LLM）
  let probes = cache.entries[key]?.probes;
  if (!probes) {
    probes = await generateProbes(input.target, input.candidates, { model: input.model });
    cache.entries[key] = { target: input.target.name, probes, cachedAt: new Date().toISOString() };
    if (input.cachePath) saveRouteCache(input.cachePath, cache);
  }

  // 2. 判定 + 重写环（最多 1 + maxRewrites 次判定）
  const attempts: RouteAttempt[] = [];
  let description = input.target.description;
  let judgments: RouteJudgment[] = [];
  let positiveHits = 0;
  let negativePass = 0;

  for (let attempt = 1; attempt <= 1 + maxRewrites; attempt++) {
    // 用当前 description 更新竞争集合里的 target
    const curCandidates = input.candidates.map((c) =>
      c.name === input.target.name ? { name: c.name, description } : c,
    );
    judgments = await judgeProbes(probes, curCandidates, { model: input.model });
    const r = scoreJudgments(judgments, input.target.name);
    positiveHits = r.positiveHits;
    negativePass = r.negativePass;
    const ok = r.positiveHits >= POSITIVE_PASS && r.negativePass >= NEGATIVE_PASS;
    const rec: RouteAttempt = { attempt, description, ok, positiveHits, negativePass, failures: r.failures };
    attempts.push(rec);
    if (ok) break;
    if (attempt <= maxRewrites) {
      // 回喂失败样例重写 description（不重新生成探针——探针是关于技能意图的，描述措辞改了仍成立）
      description = await rewriteDescription(
        { name: input.target.name, description },
        rec.failures,
        curCandidates,
        { model: input.model },
      );
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: last.ok,
    target: input.target.name,
    finalDescription: description,
    originalDescription: input.target.description,
    probes,
    judgments,
    positiveHits,
    negativePass,
    attempts,
    rewrites: attempts.length - 1,
  };
}

// ---------------- 判分（纯函数，可单测） ----------------

export interface JudgmentScore {
  positiveHits: number; // 正样本里目标排第 1 的条数（/5）
  negativePass: number; // 负样本里目标**不**排第 1 的条数（/3）
  ok: boolean;
  failures: string[];
}

export function scoreJudgments(judgments: readonly RouteJudgment[], target: string): JudgmentScore {
  let positiveHits = 0;
  let negativePass = 0;
  const failures: string[] = [];
  for (const j of judgments) {
    const hit = j.rankedFirst === target;
    if (j.kind === "positive") {
      if (hit) positiveHits++;
      else failures.push(`正样本应命中 ${target}，实际判给 "${j.rankedFirst}"：${j.probe}`);
    } else {
      if (!hit) negativePass++;
      else failures.push(`负样本不该命中 ${target}，实际判给了它：${j.probe}`);
    }
  }
  return {
    positiveHits,
    negativePass,
    ok: positiveHits >= POSITIVE_PASS && negativePass >= NEGATIVE_PASS,
    failures,
  };
}

// ---------------- 路由报告（--apply 读它决定是否拒绝） ----------------

export interface RouteReport {
  target: string;
  ok: boolean;
  positiveHits: number;
  negativePass: number;
  rewrites: number;
  finalDescription: string;
  generatedAt: string;
  failures: string[];
}

export function routeReportPath(briefDir: string, skillName: string): string {
  return join(briefDir, `${skillName}.route.json`);
}

export function buildRouteReport(result: RouteTestResult): RouteReport {
  const last = result.attempts[result.attempts.length - 1];
  return {
    target: result.target,
    ok: result.ok,
    positiveHits: result.positiveHits,
    negativePass: result.negativePass,
    rewrites: result.rewrites,
    finalDescription: result.finalDescription,
    generatedAt: new Date().toISOString(),
    failures: last.failures,
  };
}

export function loadRouteReport(path: string): RouteReport | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RouteReport;
  } catch {
    return null;
  }
}

/**
 * --apply 的路由门：读到**失败**报告必须拒绝；无报告或通过报告都不拦
 * （--apply 不强制要求做过路由自测，但只要做过且失败就拦——SKILL_COMPILER §八 M3）。
 */
export function routeReportBlocksApply(briefDir: string, skillName: string): { blocked: boolean; report?: RouteReport } {
  const report = loadRouteReport(routeReportPath(briefDir, skillName));
  if (report && !report.ok) return { blocked: true, report };
  return { blocked: false };
}

// ---------------- 工具：解析 LLM 输出 ----------------

/** 解析 JSON 字符串数组（judge 的输出）；剥代码围栏，取首个 [ 到末个 ] */
export function parseJsonStringArray(text: string, expectLen: number): string[] {
  let t = String(text ?? "").trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  if (first < 0 || last <= first) return [];
  try {
    const arr = JSON.parse(t.slice(first, last + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    const out = arr.slice(0, expectLen).map((x) => (typeof x === "string" ? x : String(x ?? "none")));
    while (out.length < expectLen) out.push("none");
    return out;
  } catch {
    return [];
  }
}

/** 剥代码围栏/引号/前后空白，得到 description 正文 */
export function cleanDescription(text: string): string {
  let t = String(text ?? "").trim();
  const fence = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  // 去掉可能的前后引号
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  // 去掉多余的 frontmatter 残行（如 "description:" 前缀）
  const m = t.match(/^description:\s*(.*)$/s);
  if (m) t = m[1].trim();
  return t.trim();
}
