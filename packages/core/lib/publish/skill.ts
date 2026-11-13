/**
 * 技能同步：本地技能目录 → 平台技能。
 *
 * 三条方向里最难的一条（方案 §10.7 / §10.10）：
 *
 * | 方向 | 支持 | 说明 |
 * |---|---|---|
 * | 推文档 | ✅ | `create_document` / `update_document` |
 * | 拉文档 | ❌ | 只在线查（`search_documents` + `read_document_content`） |
 * | 推技能 | ✅ | `import_skill_from_files`（新建）/ `update_skill`（更新） |
 * | 拉技能 | ✅ 两级 | 30 分钟轻量扫 + 每日全量比 |
 *
 * **平台的两个硬限制**（实测 2026-11-13）：
 *  1. `import_skill_from_files` 落库后是「未启用」，而 `list_available_skills` 只返回
 *     已启用的 → **推完自己看不见**，必须人在平台上点一下启用。
 *  2. 导入限制：≤50 文件、单文件 ≤1MB、总 ≤2MB、必须含根 `SKILL.md`。
 *     所以 `motion-showreel`（114 文件 / 832KB）推不回去。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { QdocMcpClient, SkillFile, SkillSummary } from "./mcp.ts";
import { extractSkillFiles } from "../sync/pull-skill.ts";
import { hashSkillFiles } from "../sync/manifest.ts";

export const MAX_SKILL_FILES = 50;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface LocalSkill {
  name: string;
  dir: string;
  files: SkillFile[];
  totalBytes: number;
  /** 内容哈希（用于「变没变」判定） */
  hash: string;
}

export interface SkillEligibility {
  ok: boolean;
  reasons: string[];
  fileCount: number;
  totalBytes: number;
}

/**
 * 读本地技能目录。
 *
 * 只收 `SKILL.md` 与 `references/`、`scripts/`、`assets/` 下的文件——
 * 平台导入不接受任意目录结构，且这四类是技能的实际内容。
 */
export function readLocalSkill(dir: string): LocalSkill | null {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;

  const files: SkillFile[] = [];
  let totalBytes = 0;
  const add = (abs: string): void => {
    const rel = relative(dir, abs).split(sep).join("/");
    const buf = readFileSync(abs);
    totalBytes += buf.byteLength;
    files.push({ path: rel, content: buf.toString("utf8") });
  };

  // 读整棵目录树，不是只读三个子目录。
  // 平台允许根目录放文件（实测 beautiful-article 有 README.md / README.zh-CN.md /
  // manifest.json），只扫 references/scripts/assets 会让「拉下来再推上去」哈希不一致，
  // 于是每次同步都误报 updated 并白白抬高版本号。
  add(skillMd); // 根 SKILL.md 必须在，平台强制要求
  walk(dir, (abs) => {
    // 跳过二进制（平台要文本）；图片类技能推不了，由 eligibility 报
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    if (BINARY_EXT.has(ext)) return;
    if (abs === skillMd) return; // 上面已 add，别重复
    add(abs);
  });

  return {
    name: basename(dir),
    dir,
    files,
    totalBytes,
    hash: hashFiles(files),
  };
}

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".mp3", ".wav",
  ".zip", ".pdf", ".woff", ".woff2", ".ttf", ".otf",
]);

function walk(dir: string, visit: (abs: string) => void): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const full = join(dir, n);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

/** 内容哈希：路径 + 内容的稳定序列化 */
function hashFiles(files: SkillFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let h = 0;
  for (const f of sorted) {
    const s = `${f.path}\u0000${f.content}`;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return `h${(h >>> 0).toString(16)}`;
}

/** 能否推到平台（平台限制的确定性检查，发布前跑） */
export function checkEligibility(skill: LocalSkill): SkillEligibility {
  const reasons: string[] = [];
  if (!skill.files.some((f) => f.path === "SKILL.md")) {
    reasons.push("缺根 SKILL.md（平台强制要求）");
  }
  if (skill.files.length > MAX_SKILL_FILES) {
    reasons.push(`文件数 ${skill.files.length} > ${MAX_SKILL_FILES}（平台上限）`);
  }
  for (const f of skill.files) {
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      reasons.push(`${f.path} ${(bytes / 1024).toFixed(0)}KB > 1MB（平台上限）`);
    }
  }
  if (skill.totalBytes > MAX_TOTAL_BYTES) {
    reasons.push(`总大小 ${(skill.totalBytes / 1024 / 1024).toFixed(2)}MB > 2MB（平台上限）`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    fileCount: skill.files.length,
    totalBytes: skill.totalBytes,
  };
}

export interface SkillPushResult {
  name: string;
  action: "imported" | "updated" | "skipped" | "blocked" | "failed";
  skillId?: string;
  version?: number;
  message?: string;
  /** 新建后需要人工启用（平台限制） */
  needsEnable?: boolean;
}

/**
 * 推一个技能。
 *
 * @param platformSkills `list_available_skills` 的结果，用来判断是新建还是更新
 */
export async function pushSkill(
  opts: {
    client: QdocMcpClient;
    skill: LocalSkill;
    platformSkills: SkillSummary[];
    description: string;
    dryRun?: boolean;
  },
): Promise<SkillPushResult> {
  const { skill } = opts;
  const elig = checkEligibility(skill);
  if (!elig.ok) {
    return {
      name: skill.name,
      action: "blocked",
      message: elig.reasons.join("；"),
    };
  }

  const existing = opts.platformSkills.find((s) => s.name === skill.name);

  if (opts.dryRun) {
    return {
      name: skill.name,
      action: existing ? "updated" : "imported",
      skillId: existing?.id,
      message: "干跑：未实际调用平台",
    };
  }

  try {
    if (existing) {
      // 更新需要 base_version（乐观锁）：先 get_skill 拿当前版本
      const detail = await opts.client.getSkill(existing.id);
      const baseVersion = Number((detail as { version?: number }).version ?? 1);

      // 内容一字不差就别推：白白抬高版本号，还会让所有机器都以为「有更新」去拉一遍。
      // 刚从平台拉下来的技能再推上去，走的就是这条路。
      const remoteFiles = extractSkillFiles(detail);
      if (remoteFiles.length > 0 && hashSkillFiles(remoteFiles) === hashSkillFiles(skill.files)) {
        return {
          name: skill.name,
          action: "unchanged",
          skillId: existing.id,
          version: baseVersion,
          message: "内容与平台一致，未推",
        };
      }

      const res = await opts.client.updateSkill({
        skillId: existing.id,
        files: skill.files,
        baseVersion,
        description: opts.description,
      });
      return {
        name: skill.name,
        action: "updated",
        skillId: existing.id,
        version: res?.version,
      };
    }

    const res = await opts.client.importSkillFromFiles({
      name: skill.name,
      description: opts.description,
      files: skill.files,
    });
    return {
      name: skill.name,
      action: "imported",
      skillId: res?.skill_id ?? res?.id,
      version: res?.version,
      // 平台限制：导入后是「未启用」，list_available_skills 看不见
      needsEnable: true,
      message: "已导入，但平台默认「未启用」——需要到平台点一下启用才会出现在技能列表里",
    };
  } catch (e) {
    return { name: skill.name, action: "failed", message: String(e).slice(0, 300) };
  }
}

/** 扫一个目录下所有技能（每个子目录一个） */
export function scanSkillsDir(root: string): LocalSkill[] {
  if (!existsSync(root)) return [];
  const out: LocalSkill[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const s = readLocalSkill(dir);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
