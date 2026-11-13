# 抽取 → 发布方案 v1.1（2026-11-13）

状态：**待 review**（不依赖工作区现有实现，按约束重新设计）

> **v1.1 变更（据 2026-11-13 review）**
> 1. 触发统一为 **30 个已完成轮次**，dsh/pi 同一口径，不再分 agent 配置。
> 2. vault 固定在**项目内 `.qdoc/`**，随项目走，不再默认 `~/ow-vault`。
> 3. 平台按 **9 个工具**设计（含 `read_document_content`），冲突从"只告警"升级为"读正文做三方合并"。
> 4. 新增 `.qdoc/.ow/` 运行态与 `.qdoc/.publish/` 发布态目录约定。
> 5. 文件清单单独见 [FILE_MANIFEST_2026-11-13.md](FILE_MANIFEST_2026-11-13.md)。

## 0. 约束与结论

| # | 约束 | 方案回应 |
|---|---|---|
| 1 | 直接复用 obsidian-wiki 的抽取逻辑 | 复制 4 个 SKILL.md + 复用其 CLI；只改 3 处（输入/预算/报告），不改它的代码 |
| 2 | 每 30 轮自动更新（统一口径） | 外置 watcher；dsh 与 pi 都按「30 个已完成轮次」切窗口 |
| 3 | 集成 pi 与 dsh | 两者都有本地 session 文件 + headless 模式；**不依赖钩子**，统一走文件 watcher |
| 4 | 平台无 draft | 发布前在本地做确定性门禁；高风险内容留在本地队列，不靠平台兜底 |
| 5 | 不支持 delete | 只做「墓碑」：改正文 + 改 status 标签，不删文档；合并只发生在本地 |
| 6 | qdoc 无 namespace | 用 **filename 前缀 + tags** 替代；`namespace_id` 一律省略 |
| 7 | 区分文档与技能 | 按「陈述性 vs 程序性」+「毕业门槛」二分，见 §6 |
| 8 | vault 位置 | **项目内 `.qdoc/`**（随项目走，不再默认 `~/ow-vault`） |

**核心判断**：抽取逻辑可以整段复用；真正要新建的只有 **Trigger（watcher）**、**Compiler 外壳**、**Publisher** 三个薄组件。预计 MVP 5–7 天可跑通 dsh 单链路。

---

## 1. 总体架构

```
┌─ dsh ──────────────┐      ┌─ pi ───────────────┐
│ ~/.dsh/sessions/   │      │ ~/.pi/agent/       │
│   <cwd>/<sid>/     │      │   sessions/<cwd>/  │
│   session.v4.jsonl │      │   *.jsonl          │
│   .zstd (turn/end) │      │ (message/role)     │
└─────────┬──────────┘      └─────────┬──────────┘
          │  tail 增量解析              │
          └──────────┬─────────────────┘
                     ▼
        ┌──────────────────────────────┐
        │ owd（常驻 watcher / 单实例）  │
        │ · 轮次计数 + 空闲判定         │
        │ · 水位线 watermark           │
        │ · 任务队列（同会话串行）      │
        └──────────────┬───────────────┘
                       │ window.json（已完成轮次）
                       ▼
        ┌──────────────────────────────┐
        │ Compiler（dsh headless）      │
        │ cwd = vault，加载 4 个技能    │
        │ 输出：页面 + compile-report   │
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────┐
        │ Vault  <project>/.qdoc/       │
        │ 唯一工作区 / 唯一事实源        │
        │ markdown + git（项目内）      │
        └──────────────┬───────────────┘
                       │ 变更页 + 门禁
                       ▼
        ┌──────────────────────────────┐
        │ Publisher（qdoc MCP）         │
        │ ledger: page→doc_id/version   │
        │ create / update / 冲突策略     │
        └──────────────┬───────────────┘
                       ▼
                 qdoc.chat（默认空间，tags 分组）
```

**为什么 vault 仍是唯一事实源**：编译需要 `Grep`/`Read` 现存页面做合并判断；qdoc 无正文批量读、无 wikilink 语义、无版本历史、无本地 diff。qdoc 只做「成品发布面」。

### 1.1 vault 布局（项目内 `.qdoc/`）

```
<project>/
├── .qdoc/                        # 知识 vault（本项目独有）
│   ├── index.md / log.md / hot.md
│   ├── .manifest.json            # obsidian-wiki 的源→页账本
│   ├── .publish/
│   │   ├── state.jsonl           # page → doc_id/version/sha
│   │   └── base/<doc_id>.md      # 上次发布正文，用于三方合并
│   ├── .ow/
│   │   ├── state.json            # 每会话水位线
│   │   ├── queue/                # 待编译任务
│   │   ├── logs/                 # 编译器 stdout/stderr
│   │   └── metrics.jsonl
│   ├── concepts/ entities/ skills/ references/ synthesis/ journal/
│   ├── projects/<name>/
│   ├── _raw/  _raw/_archived/    # 原始快照（不发布）
│   └── _staging/                 # 需要人确认的页面（不发布）
└── .gitignore                    # 由 ow init 追加：.qdoc/.ow/ .qdoc/_raw/
```

**发现规则**：会话 cwd 向上找最近的 `.qdoc/`；找不到则用 `git rev-parse --show-toplevel` 的根；仍找不到按 `auto_init=true` 初始化，否则跳过该会话。

**取舍**：
- `.qdoc` 是隐藏目录，Obsidian 默认不展示；需要可视化时执行 `ow link` 生成 `wiki -> .qdoc` 符号链接再指向 Obsidian。
- 每个项目一个 vault，跨项目知识默认不合并；全局知识要等 P4 的「hub vault」聚合，不在本期范围。

---

## 2. 组件与职责

| 组件 | 形态 | 职责 | 不做什么 |
|---|---|---|---|
| `owd` | 单实例 Python 常驻进程（launchd / systemd user） | 扫 session、数轮次、切窗口、排队、重试、限流、看门狗 | 不调模型、不写页面 |
| `adapter-dsh` | owd 内的解析器 | 解 zstd、按 `seq` 增量、识别 `turn/end`、过滤 system-reminder | 不判断知识价值 |
| `adapter-pi` | owd 内的解析器 | 读 JSONL、按 `message.role` 切轮、去重 system | 同上 |
| `compiler` | `dsh headless` + 技能包 | 抽取、合并、打标、写 vault、产出报告 | 不发布、不删页 |
| `publisher` | 独立 CLI（`ow-publish`） | 门禁、渲染、upsert、ledger、墓碑 | 不改页面内容 |
| `promoter` | 夜间任务 | 文档→技能毕业、打包、推 skill | 不代替人做最终批准 |

---

## 3. 数据契约

### 3.1 `window.json`（触发器 → 编译器）

```json
{
  "schema": 1,
  "agent": "dsh",
  "session_id": "session-7c31d379-...",
  "cwd": "/Users/.../AutoSkill4Personal",
  "from_seq": 305,
  "to_seq": 520,
  "from_turn": 3,
  "to_turn": 6,
  "turns": 4,
  "started_at": "2026-11-13T12:07:00+08:00",
  "ended_at": "2026-11-13T13:40:00+08:00",
  "messages": [
    {"seq": 308, "role": "user", "text": "..."},
    {"seq": 320, "role": "assistant", "text": "..."},
    {"seq": 326, "role": "tool", "name": "bash", "text": "..."}
  ],
  "hash": "sha256:..."
}
```

规则：**只含已结束轮次**；工具结果截断到 2k 字符；assistant 只保留文本块（丢 thinking）；总长硬上限 120k 字符，超出按「用户消息 + 结论段」抽取。

### 3.2 `compile-report.json`（编译器 → 发布器）

```json
{
  "window_hash": "sha256:...",
  "model": "dsh/…",
  "pages_created": ["concepts/x.md"],
  "pages_updated": ["skills/y.md"],
  "pages_skipped": [{"path": "concepts/z.md", "reason": "no_new_claim"}],
  "publish_candidates": ["concepts/x.md", "skills/y.md"],
  "cost": {"input_tokens": 0, "output_tokens": 0},
  "warnings": []
}
```

`publish_candidates` 由编译器给初判，发布器仍要过门禁。

### 3.3 `publish-state.jsonl`（发布器账本，追加写）

```json
{"page":"concepts/x.md","doc_id":123,"version":4,"content_sha":"…","published_at":"…","status":"active"}
{"page":"concepts/x.md","doc_id":123,"version":5,"content_sha":"…","published_at":"…","status":"active"}
{"page":"concepts/old.md","doc_id":88,"version":2,"content_sha":"…","status":"tombstone"}
```

按 page 取最后一行生效。**账本是 upsert 的唯一依据**，不靠 `search_documents`（模糊匹配）。

发布成功时同时把**实际发布的正文**落到 `.qdoc/.publish/base/<doc_id>.md`；它是冲突时三方合并的 base（本地有、平台也有，才谈得上合并）。

### 3.4 页面 frontmatter 增量

在 obsidian-wiki 原有字段（title/summary/tags/sources/provenance/base_confidence/lifecycle）上增加：

```yaml
publish_as: document        # document | skill | local
publish_status: pending     # pending | published | tombstone
source_agent: dsh           # dsh | pi
source_session: session-7c31d379-...
source_turns: "3-6"
```

`publish_as: local` 的页面永不发布（原始会话、草稿、冲突副本）。

---

## 4. 触发：外置 watcher

### 4.1 轮次定义（统一 30）

**两种 agent 统一为「30 个已完成轮次」，语义对齐到同一件事：一次用户诉求从发出到 agent 停止。**

| Agent | 轮次信号 | 窗口边界 |
|---|---|---|
| dsh | `turn/end` 事件（`data.turn` 递增） | 第 1 个未编译 `turn/end` 到第 30 个，`seq` 切片 |
| pi | 一条 `message.role == "user"` = 一轮的开始 | 第 N 个 user 消息到第 N+29 个 user 消息之后 |

规则：
- 只数**已完成**的轮次；dsh 的 `turn/end.reason.kind = aborted` 只要之后有工具动作仍计入，空轮不计。
- 窗口**不跨越会话**；会话结束即结算，水位线按 `session_id` 隔离。
- 30 是全局默认（`turns_per_window=30`），不再按 agent 分别配置；调试期可用 `--turns 2` 覆盖。

### 4.2 判定条件（全部满足才入队）

```
1. 本会话未在编译中（单会话串行）
2. 距离上次编译 >= 30 个已完成轮次（统一口径）
3. 会话空闲 >= 90s（文件 mtime 不再变化）
4. 窗口内“有可留存信号”：至少 1 条用户诉求 + 1 个工具/决策动作
5. 会话 cwd 的 vault（`.qdoc/`）不是编译器自己的 cwd（防自触发）
6. 今日预算未超（默认 200k tokens / 50 次编译）
```

第 4 条是降噪关键：纯问答、纯检索、纯闲聊的窗口直接跳过（复用 obsidian-wiki Stop 钩子的只读命令分类思路，但判断对象是**本窗口工具调用**）。

### 4.3 dsh 解析要点

- 文件：`~/.dsh/sessions/<slug(cwd)>/<session-id>/session.v4.jsonl.zstd`
- **追加式压缩流**：每轮重新 `zstd -dc` 全量解压，按 `seq` 去重追加（500KB 级开销可忽略；>20MB 再换增量帧解析）
- `user/message` 的 `data.source.kind` 必须为 `"user"`；`system-reminder`、`time-context`、`agent-instructions` 一律剔除
- 编译器自己产生的会话 cwd = `<project>/.qdoc/`，落在 vault 内 → 按「cwd 在 vault 内即跳过」排除

### 4.4 pi 解析要点

- 文件：`~/.pi/agent/sessions/<slug(cwd)>/<ts>_<uuid>.jsonl`
- 天然明文 JSONL，无需解压
- 编译器用 `pi -p --no-session --skill <compiler-skill>`，不落会话，避免自触发

### 4.5 会话结束结算（统一 30 的边界）

- 会话结束时，剩余窗口 ≥5 个已完成轮次 → 立即入队「尾部编译」。
- <5 轮 → 不进编译，记 `metrics.dropped_tail`，避免把半句话写成页面。
- 因为窗口不跨会话，下一会话从 0 重新计数；旧会话未编译的尾巴只保留指标，不补跑。

---

## 5. 抽取：怎么复用 obsidian-wiki

### 5.1 复制清单（thin fork，不改上游仓库）

| 上游文件 | 用途 | 本地落点与改动 |
|---|---|---|
| `skills/llm-wiki/SKILL.md` | 页面模板、provenance、置信度、关系类型、merge 规则 | → `skills/ow-compiler/references/llm-wiki.md`；删 QMD/PDF/多 vault/配置解析章节；vault 路径改为参数 |
| `skills/wiki-capture/SKILL.md` | 会话→陈述式知识（跳过寒暄、按主题聚类、`session_transcript` 桶） | → `…/references/wiki-capture.md`；输入改为 `window.json`；输出改为受限页面数 |
| `skills/wiki-ingest/SKILL.md` | 合并、`ingest-guard`、Sources/snapshots 规则、1MB 限制 | → `…/references/wiki-ingest.md`；删 URL/PDF/图片分支；保留 merge 与 frontmatter |
| `skills/cross-linker/SKILL.md` | 链接补齐与关系类型推断（可选，每周跑） | → `…/references/cross-linker.md`；改为只对「本窗口触及的页」做局部链接 |

CLI 直接 `pip install obsidian-wiki`，只用这几个命令（不跑 `setup`，不装 39 个技能）：

```
obsidian-wiki cache-update <vault> <source> --key agent:dsh/<session> --pages …
obsidian-wiki ingest-guard <vault> <page paths>
obsidian-wiki memory sync CAPTURE source_agent=dsh turns=30 pages_created=N
obsidian-wiki lint <vault> --json
obsidian-wiki snapshots set …（需要时）
```

### 5.2 必须改的三处

1. **输入**：从「读一个文件」改为「读 window.json + index 摘要 + hot takeaways」。
2. **预算**：`OBSIDIAN_MAX_PAGES_PER_INGEST` 降到 8；单窗口最多 8 页、单页 ≤200KB。
3. **输出**：除页面外，必须写 `compile-report.json`（否则发布器无法增量）。

### 5.3 编译器提示词骨架

```
角色：你是知识编译器，不是总结器。
输入：window.json（本轮增量）、vault/index.md、vault/hot.md
规则：遵循 llm-wiki 的模板/provenance/merge 规则；遵循 wiki-capture 的“陈述式改写”。
硬约束：
  - 先查 index/Grep，已存在则合并，禁止新建同义页
  - 每页必须写 summary、provenance、base_confidence、valid_from（源里有日期时）
  - 推断必须标 ^[inferred]；冲突标 ^[ambiguous] + relationships: contradicts
  - 最多 8 页；超过则按 tier 截断并在 report 里写 deferred
  - 不写代码清单、不贴原文、不写寒暄
输出：页面写入 vault + compile-report.json
```

### 5.4 抽什么、不抽什么

沿用 `wiki-update` 的启发式，并针对会话调整：

- **抽**：决策与理由、踩坑与根因、可复用步骤、环境约束、术语澄清、被否决的方案。
- **不抽**：一次性问答、文件清单、命令回显、流水账、没有结论的探索。
- **不确定**：标记 `^[inferred]`，宁可低置信也不删证据。

---

## 6. 产物分诊：文档 vs 技能

### 6.1 判据（三问，全部为「是」才可能进技能）

1. 是否包含**可执行步骤/命令/顺序**？
2. 是否有**触发条件**（何时用）与**成功判据**（怎么算做对）？
3. 是否会被 agent 在任务中**直接加载执行**（而不是被人阅读）？

任一为「否」→ **文档**。

### 6.2 映射表

| 知识形态 | 去向 | 理由 |
|---|---|---|
| 概念、实体、参考资料、综述、项目概览 | **文档** | 陈述性，供检索/阅读 |
| 决策记录、架构权衡、事故复盘 | **文档**（可带 `## Procedure` 段） | 结论 + 证据，先供人读 |
| SOP、操作步骤、命令配方、环境约定 | **技能候选** | 程序性，含触发与验证 |
| 编译器 schema/模板/合并规则 | **技能（常驻）** | 约束 agent 行为本身 |
| index/log/hot/manifest、原始会话、快照 | **仅本地** | 高噪声/大体量/含隐私 |
| redirect stub、墓碑、冲突副本 | **仅本地** | 平台无 delete，发布即污染 |

### 6.3 毕业门槛（防止把一次性经验固化成技能）

技能候选页必须同时满足：

- 来源 ≥2 条独立 lineage（不同会话或文档）
- 近 30 天被 ≥3 个页面/会话引用
- 有明确的「验证方法」小节（命令或检查清单）
- 人工在本地把 `publish_as` 从 `document` 改为 `skill`

未毕业的，先以文档发布；`promoter` 每周生成一次「候选清单」，不自动升级。

### 6.4 技能打包格式

qdoc 限制：≤50 文件、单文件 ≤1MB、总量 ≤2MB、必须含根 `SKILL.md`。

```
skills/<domain>/
├── SKILL.md            # name/description + 触发 + 步骤 + 验证 + 边界
└── references/
    ├── <page-slug>.md  # 从 vault 拷贝的支撑文档（只读副本）
    └── ...
```

`SKILL.md` 里不写绝对路径、不写 token、不引用 vault 内部 wikilink（改为纯文本标题）。

---

## 7. 发布：qdoc 适配

### 7.1 平台能力（2026-11-13 探测）

`https://qdoc.chat/mcp`（Streamable HTTP + SSE，Bearer token），设计按 **9 个工具**：

- 文档：`search_documents` / `read_document` / **`read_document_content`** / `create_document` / `update_document`
- 技能：`list_available_skills` / `get_skill` / `import_skill_from_files` / `update_skill`
- **无 delete、无 namespace 创建/列举、无 draft**

> 探测备注：当前 `tools/list` 仍返回 8 个，未出现 `read_document_content`。可能是版本/开关/权限差异；P0 用真实 token 复核。**若不可用，降级为 `read_document` 元信息 + 本地 `.publish/base/` 比对**，冲突时只做"服务端优先 + 本地告警"，不重复建 doc。

`create_document`：`filename`、`content_md`（≤1MB）、可选 `namespace_id`、`tags` → 返回 `{id, version}`
`update_document`：`doc_id`、`content_md`、`base_version`（乐观锁）→ 返回 `{id, version}`

### 7.2 无 namespace 的替代

全部写入默认空间，用命名与标签承担分组：

```
filename: ow-<project>-<category>-<slug>.md
tags:
  - ow:project=<project>        # 必填（每个项目一个 vault）
  - ow:cat=concepts
  - ow:status=active|tombstone
  - ow:type=doc|skill-ref
```

`search_documents` 按 filename/元数据匹配，前缀保证可检索；**精确匹配以账本为准**。

### 7.3 发布流程

```
for page in changed_pages:
    if publish_as == local: continue
    if not gate(page): quarantine; continue
    content = render(page)                  # 见 7.4
    sha = sha256(content)
    rec = ledger.last(page)
    if rec and rec.sha == sha: continue
    if not rec:
        r = create_document(filename, content, tags)     # → {id, version}
    else:
        r = update_document(rec.doc_id, content, rec.version)
        on 版本冲突:
            latest = read_document_content(rec.doc_id)   # 9 工具；不可用则跳过合并
            if sha256(latest) == sha: 只更新账本; continue
            merged = three_way(base=.publish/base/<doc_id>.md,
                               mine=content, theirs=latest)
            r = update_document(rec.doc_id, merged, current_version)
            if 仍冲突: 写本地 .publish/conflicts/<page>.<ts>.md 并告警
    ledger.append(page, r.id, r.version, sha)
    write .publish/base/<doc_id>.md = content
```

冲突策略定级：
1. 内容一致 → 只修账本；
2. 三方合并成功 → 用新版本提交，冲突段落标 `^[ambiguous]`；
3. 合并失败 → **不重复建 doc**（无 delete，重复即永久垃圾），本地留副本 + 告警，等人工处理。

### 7.4 渲染（发布前一次性转换）

- 剥掉仅本地字段：`snapshots`、`source_session`、`publish_*`
- `[[path|label]]` → `label`（qdoc 无 wikilink 语义）；在文末生成 `## Related` 纯文本清单
- 保留：`title`、`summary`、`tags`、`sources`、`provenance`、`base_confidence`、`valid_from`
- 正文加一行来源说明：`> Compiled from agent session dsh/<id>, turns 3–6.`

### 7.5 无 delete 的墓碑

| 场景 | 处理 |
|---|---|
| 页面被本地合并 | 原页 `publish_status: tombstone`；平台文档正文替换为 `# <title>\n\n> 已合并至 <new>.`，`tags` 加 `ow:status=tombstone` |
| 页面被删除 | 只改状态，不调用任何删除；本地保留原页 |
| 发布错了 | 覆盖为墓碑 + 告警；**不尝试删除** |
| 技能废弃 | `update_skill` 版本 +1，SKILL.md 顶部 `deprecated: true`，描述指向新技能 |

### 7.6 幂等与重试

- `window_hash` 作编译幂等键；`page+content_sha` 作发布幂等键
- MCP 失败：指数退避 3 次；401 停止并告警（不重试）；5xx 重试
- 单次发布上限 20 页，超出排队下一轮
- 所有写操作先写 `intent` 行再执行，崩溃后按账本对齐

---

## 8. 质量门（替代平台 draft）

发布前本地门禁，**任一失败即不发布**：

| 门 | 规则 |
|---|---|
| 结构 | 必需 frontmatter 齐全；`title/summary` 非空 |
| 体积 | 正文 ≤1MB；总文件 ≤1MB（平台硬限） |
| 隐私 | 命中 `visibility/pii` → 拒绝；`sk-`/`ghp_`/`AKIA`/私钥/`password=` 正则 → 拒绝 |
| 质量 | `base_confidence ≥ 0.45`；`^[inferred]` 占比 ≤0.7；`lifecycle ∉ {archived, disputed}` |
| 去重 | 同 slug 只能有一篇 active；账本冲突 → 拒绝并告警 |
| 完整性 | 渲染后无残留 `[[`；无绝对路径；无 `TODO` |
| 变更 | content_sha 与账本一致 → 跳过 |

未过门禁的页面进本地 `_publish/rejected/<date>/`，附拒绝原因；人工改完把 `publish_status` 置回 `pending` 即可重试。

---

## 9. 观测与成本

指标（本地 `metrics.jsonl` + 每日摘要）：

- 触发：会话数、窗口数、跳过原因分布
- 编译：页数/窗口、deferred 数、token、耗时、失败率
- 发布：成功/跳过/拒绝/冲突数、平台 doc 总数
- 质量：重复标题数（lint）、墓碑数、人工驳回数

预算默认：每窗口 ≤60k 输入 token、≤8 页；每日 ≤50 窗口、≤200k token；超限暂停并告警。

---

## 10. 里程碑与验收

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| P0 | 可行性探针：`dsh headless` 加载技能并改文件；zstd 增量解析；`pi -p --no-session`；`read_document_content` 是否在 9 工具中、`read_document` 是否带 version；`.qdoc/` 自动初始化 | 1 天 | 5 项全部有结论；不产生垃圾文档（用真实首篇验证） |
| P1 | `owd` + adapter-dsh + compiler 技能 + `.qdoc/`；`--turns 2` 复测 | 3–4 天 | 本会话触发 ≥2 次；页数 ≤8/窗口；0 重复 slug |
| P2 | publisher + 门禁 + 账本 + qdoc 发布 | 2–3 天 | 首篇文档发布成功；二次发布走 update；冲突可三方合并或安全告警 |
| P3 | adapter-pi；skill 毕业 + 推送；launchd 常驻 | 3–5 天 | pi 会话可触发；1 个技能上线；重启后水位线不丢 |
| P4 | 加固：脱敏、墓碑、预算、评测集、hub vault | 1 周 | 红队用例 0 泄漏；kill switch 生效 |

---

## 11. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| `dsh headless` 无法加载本地技能/无工作区 | 中 | P0 先验；退化方案：把技能文本内联进 prompt（≤20KB） |
| zstd 会话不是单纯追加（重写整帧） | 低 | 按 `seq` 去重而非字节偏移；全量解压后对比 |
| 每 30 轮产出噪声页 | 高 | 信号门 + 8 页上限 + 每周 dedup + 只发布 confidence≥0.45 |
| 平台无 `read_document_content` 或读不到 version | 中 | P0 复核；降级为 `.publish/base/` 比对 + 服务端优先；冲突只告警，绝不重复建 doc |
| 无 delete 导致垃圾文档累积 | 高 | 发布前门禁 + 墓碑约定 + 首篇用真实内容验证；不做试探性写入 |
| 多 agent 同时写同一 vault | 中 | 单实例 owd + vault 级文件锁；编译器串行 |
| 隐私泄漏 | 中 | 发布前正则 + `visibility/pii` 拒绝 + 默认不发布原始会话 |
| 成本失控 | 中 | 窗口/日预算 + 降级到 cheap model 只做候选抽取 |

---

## 12. 已定 / 待确认

**已定（本轮 review）**
1. 触发统一为 30 个已完成轮次（dsh/pi 同口径）。
2. vault 固定项目内 `.qdoc/`。
3. 平台按 9 工具设计，包含 `read_document_content`。
4. 发布不做平台 draft，本地门禁替代。
5. 不支持 delete，只做墓碑。

**待确认**
1. **实现语言**：本方案默认 **Python 3.11+**，理由是可直接 `import obsidian_wiki` 的 `cache` / `ingest_guard` / `memory` / `lint` / `snapshots`，省掉 1–2k 行重写；若你希望统一 TS，需要重写这些模块。
2. **首篇发布内容**：建议用本方案自身的一页真实知识（如 §6.1 判据）验证端到端，不用探针文档。
3. **技能范围**：默认只发「编译器技能 + 毕业后领域技能」，禁止单页 how-to 直接成 skill；是否放宽？
4. **人工介入点**：默认只在「技能毕业」和「门禁拒绝」两处；是否每次发布都本地确认？
5. **`.qdoc/` 与项目 git**：默认页面提交、`.ow/` 与 `_raw/` 忽略；是否整目录忽略？
6. **`read_document_content` 缺失**：若 P0 仍不可用，接受降级（base 比对 + 服务端优先），还是暂停 P2？
