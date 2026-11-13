# 目标文件清单 v2.0（2026-11-13，TS 版）

配套方案：[EXTRACTION_QDOC_PLAN_2026-11-13.md](EXTRACTION_QDOC_PLAN_2026-11-13.md)（v3.0）

本文回答三件事：**改了什么、要建哪些文件、每个文件是迁移还是新写**。

> **v1.1 → v2.0 的三处反转**
>
> | | v1.1 | v2.0 | 原因 |
> |---|---|---|---|
> | 语言 | Python 3.11+ | **TS（Node 22.15+）** | 内嵌后必须跑在 agent 进程里（§3.1） |
> | 触发 | 外置常驻 `owd` | **各 agent 内嵌** | 复用 `ctx.llm` / `models.json` 的凭据（§5.1） |
> | 常驻 | launchd / systemd | **无守护进程** | 触发在 agent 进程内，不需要常驻 |
>
> 仓库本来就是 TS monorepo（`packages/core` + `packages/adapter-*`，零 `.py`），所以这是**回到原生形态**。

---

## 一、清单格式

每条记录六个字段：

| 字段 | 取值 | 说明 |
|---|---|---|
| `path` | 相对仓库根 | 目标文件的最终位置 |
| `type` | `迁移` / `重写` / `新写` / `改造` / `模板` / `测试` / `配置` | **迁移**=复制上游 markdown 技能并改；**重写**=上游有实现但语言不同，逻辑照搬用 TS 写；**新写**=上游没有；**改造**=仓库已有，改它 |
| `phase` | P0–P4 | 哪个里程碑落地 |
| `purpose` | 一句话 | 它负责什么、不负责什么 |
| `io` | `输入 → 输出` | 主要数据流 |
| `size` | S(<100) / M(100–300) / L(300+) | 预估代码量，用于排期 |

机器可读示例：

```json
{
  "path": "packages/core/lib/trigger/turns.ts",
  "type": "新写",
  "phase": "P1",
  "purpose": "数已完成轮次：dsh 按 turn/end，pi 按 user 消息；剔注入消息与空轮",
  "io": "SessionEntry[] → TurnIndex",
  "size": "M",
  "depends": []
}
```

---

## 二、目标目录树

```
AutoSkill4Personal/
├── package.json                       # 已有，改 scripts + workspaces
├── README.md                          # 改写（安装 + 使用）
├── .env.example                       # 新写
│
├── packages/
│   ├── core/
│   │   ├── lib/
│   │   │   ├── base/                  # 已有：context/llm/types/atom-store/admission
│   │   │   ├── extract/               # 已有：窗口切分、抽取、压缩
│   │   │   ├── skill/                 # 已有：技能编译、补丁、用量
│   │   │   ├── capture-orchestration.ts   # 已有，改造
│   │   │   ├── trigger/               # 新：轮次/窗口/信号/水位线/锁/预算/cycle
│   │   │   ├── compiler/              # 新：prompt / run / report（唯一烧 token）
│   │   │   ├── vault/                 # 新：init / index / render / guard / link / frontmatter
│   │   │   ├── publish/               # 新：mcp / gate / ledger / publish / conflict / tombstone / skill
│   │   │   ├── sync/                  # 新：manifest / push-doc / push-skill / pull-skill / query / merge / status
│   │   │   ├── review/                # 新：pending / review / notify / status
│   │   │   ├── promoter/              # 新：scan / package
│   │   │   └── security/              # 新：secrets / redact
│   │   └── scripts/                   # 已有 + 新增 CLI 入口
│   │
│   ├── adapter-dsh/                   # 已有，改造（cordis 插件）
│   │   ├── src/{index,tools,llm-bridge,session-path,skill-provider,assemble-timer}.ts
│   │   └── test/smoke-dsh.ts
│   │
│   ├── adapter-pi/                    # 已有，改造（extension）
│   │   └── knowledge-capture.ts
│   │
│   └── cli/                           # 新：`ow` 可执行
│       ├── package.json
│       └── src/{main.ts,commands/*.ts}
│
├── agent-skills/
│   ├── ow-compiler/                   # 编译器内核（自动调用）
│   │   ├── SKILL.md
│   │   └── references/{llm-wiki,wiki-capture,wiki-ingest,cross-linker}.md
│   └── qdoc/                          # 前门（唤醒词）
│       ├── SKILL.md
│       └── references/{capture,ingest,query,maintain,tagging,skill}.md
│
├── schemas/{window,compile-report,publish-record}.schema.json
├── templates/vault/{index.md,log.md,hot.md,AGENTS.md,gitignore}
├── scripts/install-skill.ts
├── test/{fixtures,*.test.ts}
└── .gitignore                         # 已有，改
```

**关键差异**：没有 `ow/` 顶层包、没有 `pyproject.toml`、没有 `launchd`/`systemd`、没有 `conftest.py`。

---

## 三、文件明细

### 3.1 根与配置

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `package.json` | 改造 | P0 | 加 workspaces `packages/cli`；加 `ow` / `test` / `smoke` 脚本；`engines.node >= 22.15`（要 `zlib.zstdDecompressSync`） | — | S |
| `README.md` | 改写 | P1 | 安装（插件 + extension）、`ow init`、`ow publish`、故障排查；删掉旧五入口描述 | — | S |
| `.env.example` | 配置 | P1 | `QDOC_TOKEN`、`OW_TURNS=30`、`OW_PUBLISH_MODE`、预算 | — | S |
| `.gitignore` | 改造 | P1 | 追加 `.qdoc/.ow/`、`.qdoc/_raw/`、`.qdoc/_staging/` | — | S |

### 3.2 core 基础（已有，少量改造）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/base/llm.ts` | 改造 | P0 | 加 `usage` 透出（预算计数要 `inputTokens`/`outputTokens`）；现有 `chatComplete`/`setChatCompleter` 不动 | ChatOptions → ChatResult | S |
| `packages/core/lib/base/types.ts` | 改造 | P0 | 加 `CompileReport` / `PageMeta` / `PublishRecord` / `TurnIndex` 类型 | — | S |
| `packages/core/lib/base/context.ts` | 改造 | P1 | `HostContext` 加 `vaultDir`、`machineDir`（`~/.config/qdoc`） | — | S |
| `packages/core/lib/capture-orchestration.ts` | 改造 | P1 | **修 bug 2**：`unreviewedUserTurns` 改为「已编译到第几轮」，不再用 `sources` 覆盖判定 | entries → 是否该编译 | M |

### 3.3 触发层（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/trigger/turns.ts` | 新写 | P1 | **修 bug 1**：数已完成轮次。dsh 用 `turn/end` 且剔空轮；pi 用 `message.role=user`；dsh 侧按 `data.source.kind==="user"` 过滤注入消息 | `SessionEntry[]` → `TurnIndex` | M |
| `packages/core/lib/trigger/window.ts` | 新写 | P1 | 切 30 轮窗口、工具结果截断 2k、总长 120k 字符、算 `hash` | `TurnIndex` → `WindowPayload` | M |
| `packages/core/lib/trigger/signal.ts` | 新写 | P1 | 「可留存信号」判定：≥1 用户诉求 + ≥1 工具/决策动作；返回原因供 metrics | `WindowPayload` → `{keep,reason}` | S |
| `packages/core/lib/trigger/state.ts` | 新写 | P1 | `.qdoc/.ow/state.json` 读写：按 `session_id` 记 `compiled_to_turn`/`compiled_to_seq`；**存 vault 不存进程** | — → 水位线 | S |
| `packages/core/lib/trigger/lock.ts` | 新写 | P1 | 两级锁：vault 级 `.ow/lock`（同项目串行）+ 机器级 `~/.config/qdoc/machine.lock`（跨项目并发 1）；退避重试 + 30 分钟死锁回收 | vault/machine → 锁句柄 | M |
| `packages/core/lib/trigger/budget.ts` | 新写 | P1 | `~/.config/qdoc/machine.json` 日预算（跨 vault 合并）+ `by_vault` 分摊 | tokens → 是否放行 | S |
| `packages/core/lib/trigger/manual.ts` | 新写 | P2.5 | 手动窗口：当前会话/选中片段 → `WindowPayload`（跳过信号门） | 会话或片段 → Window | M |
| `packages/core/lib/trigger/cycle.ts` | 新写 | P1 | **两个适配器唯一入口**：`maybeCompile(ctx)` = 数轮 → 拿锁 → 切窗 → 编译 → 发布 → 释锁。宿主无关 | hostCtx → 结果 | M |

### 3.4 宿主适配（已有，改造）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/adapter-dsh/src/index.ts` | 改造 | P1 | 定时器（默认 120s）改调 `cycle.maybeCompile`；`inject` 保持 `["skills","llm"]`；删掉自己那套 N 轮闸 | — | M |
| `packages/adapter-dsh/src/tools.ts` | 改造 | P1 | `dispatchPipeline` 改为走 `cycle`；`normalizeDshEntry` 加 `source.kind` 过滤 | 会话文件 → 结果 | M |
| `packages/adapter-dsh/src/llm-bridge.ts` | 已有 | P1 | `ctx.llm` 桥不动（这就是「复用 agent 模型」的实现） | — | — |
| `packages/adapter-dsh/src/session-path.ts` | 已有 | P1 | 会话文件定位 + subagent 判定（首行 `session` 头） | — | — |
| `packages/adapter-dsh/src/skill-provider.ts` | 已有 | P1 | 技能 provider 不动 | — | — |
| `packages/adapter-pi/knowledge-capture.ts` | 改造 | P3 | `before_agent_start` 改调 `cycle.maybeCompile`；删掉自己的阈值逻辑 | — | M |
| `packages/adapter-dsh/test/smoke-dsh.ts` | 改造 | P1 | 加用例：注入消息不算轮、空轮剔除、锁互斥 | — | M |

### 3.5 编译器（新，唯一烧 token）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/compiler/prompt.ts` | 新写 | P1 | 组装 prompt：技能正文 + 窗口 + `index.md` 摘要 + `hot.md`；超预算按「用户消息 + 结论段」抽 | 上下文 → prompt | M |
| `packages/core/lib/compiler/run.ts` | 新写 | P1 | **进程内**调 `chatComplete`（走适配器注入的 `ctx.llm` / `models.json`）；超时、重试、usage 回传。**不起子进程** | prompt → 文本 + usage | M |
| `packages/core/lib/compiler/report.ts` | 新写 | P1 | 解析并校验 `compile-report.json`；更新 `.manifest.json`；页数上限 8 | 报告 → 账本 | M |

### 3.6 vault（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/vault/init.ts` | 新写 | P1 | 建 `.qdoc/` 骨架、写模板、追加 `.gitignore`；`~/.config/qdoc/token`（600） | 项目根 → vault | M |
| `packages/core/lib/vault/index.ts` | 新写 | P1 | 扫描页面、重建 `index.md`、维护 `log.md`/`hot.md`；**必须带锁**（手动与自动都会写） | vault → PageInfo[] | M |
| `packages/core/lib/vault/render.ts` | 新写 | P1 | 发布渲染：剥本地字段、wikilink→纯文本、加来源行、追加 `<!-- ow:meta -->` | 页面 → 平台正文 | M |
| `packages/core/lib/vault/guard.ts` | 重写 | P2 | 「一源一主页」判定（上游 `ingest_guard` 的 TS 版） | 源列表 → create/update/blocked | S |
| `packages/core/lib/vault/link.ts` | 新写 | P3 | `ow link`：生成 `wiki -> .qdoc` 软链便于 Obsidian 打开 | vault → symlink | S |
| `packages/core/lib/vault/frontmatter.ts` | 新写 | P1 | YAML frontmatter 解析/序列化（含 `publish_as`/`publish_status`/`source_*`） | 文本 ↔ 对象 | M |

### 3.7 发布（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/publish/mcp.ts` | 新写 | P2 | qdoc MCP 客户端：10 工具、Streamable HTTP + SSE（手写解析）、Bearer、重试、分页。用全局 `fetch`，无第三方依赖 | 方法调用 → JSON | L |
| `packages/core/lib/publish/gate.ts` | 新写 | P2 | 7 道发布门（结构/体积/隐私/质量/去重/完整性/变更） | 页面 → pass/quarantine | M |
| `packages/core/lib/publish/ledger.ts` | 新写 | P2 | `.publish/state.jsonl` 追加账本 + `.publish/base/<doc_id>.md` | 记录 → 当前状态 | S |
| `packages/core/lib/publish/conflict.ts` | 新写 | P2 | 版本冲突：读正文 → 三方合并 → 失败留档 | 冲突 → 合并正文/告警 | M |
| `packages/core/lib/publish/publish.ts` | 新写 | P2 | create/update、乐观锁、冲突升级、墓碑判定 | 页面 → doc_id/version | L |
| `packages/core/lib/publish/tombstone.ts` | 新写 | P3 | 合并/删除的墓碑正文与状态标签 | 页面 → 墓碑内容 | S |
| `packages/core/lib/publish/skill.ts` | 新写 | P3 | 技能打包（≤50 文件/2MB）、`import_skill_from_files` / `update_skill` | 技能目录 → skill_id/version | M |

### 3.8 知识中心同步（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/sync/manifest.ts` | 新写 | P3.5 | `.ow/skill-manifest.json`：skill_id→version/sha/落地目标/`pending_enable`；**「本机装了什么」的唯一真相** | — → 清单 | S |
| `packages/core/lib/sync/push-doc.ts` | 新写 | P3.5 | 批量推待发布页；`--dry-run` 默认 | vault 页 → doc_id/version | M |
| `packages/core/lib/sync/query.ts` | 新写 | P3.5 | 在线查：本地 Grep → `search_documents` → `read_document_content`；解析 `<!-- ow:meta -->` | 问题 → 带来源答案 | L |
| `packages/core/lib/sync/push-skill.ts` | 新写 | P3.5 | 打包 → import/update；超限报错不截断；不可回滚走 review；首次推后记 `pending_enable` | 技能目录 → skill_id/version | M |
| `packages/core/lib/sync/pull-skill.ts` | 新写 | P3.5 | 两档：每 30 分钟 `list_available_skills`（2.9KB）；每天 03:00 全量比版本（3.7s/1.27MB）；`--prune` 清已禁用 | skill_id → 本地技能 | M |
| `packages/core/lib/sync/merge.ts` | 新写 | P3.5 | push 侧三方合并：sha 相同视为无冲突；重叠留 `.publish/conflicts/` | 三份正文 → 合并/冲突 | M |
| `packages/core/lib/sync/status.ts` | 新写 | P3.5 | 待推页 / 可拉技能 / 待确认条数 | vault + 清单 → 报告 | S |

### 3.9 人机确认（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/review/pending.ts` | 新写 | P3.5 | `.ow/pending/<ts>-<kind>.json` 读写、去重、7 天升级 | 事件 → 队列 | S |
| `packages/core/lib/review/review.ts` | 新写 | P3.5 | 交互式确认（`[a]应用 [d]diff [s]跳过 [x]不再问`）；非 tty 退化 `--list` | pending → 决策 | M |
| `packages/core/lib/review/notify.ts` | 新写 | P3.5 | 桌面通知（`terminal-notifier`/`notify-send`），默认关，日限 3 条，只报 high | 事件 → 系统通知 | S |
| `packages/core/lib/review/status.ts` | 新写 | P3.5 | `ow status --json`：vault 状态 + pending 条数，供前门技能播报 | — → JSON | S |

### 3.10 技能毕业 / 安全（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/core/lib/promoter/scan.ts` | 新写 | P3 | 找技能候选：≥2 lineage、≥3 引用、有验证段 | vault → 候选列表 | M |
| `packages/core/lib/promoter/package.ts` | 新写 | P3 | 生成 `SKILL.md` + references 副本（去路径/去 wikilink） | 候选页 → 技能包 | M |
| `packages/core/lib/security/secrets.ts` | 新写 | P2 | 正则扫描：`sk-`/`ghp_`/`AKIA`/私钥/`password=` | 正文 → 命中列表 | S |
| `packages/core/lib/security/redact.ts` | 新写 | P3 | 发布前脱敏（命中即拒或替换，按策略） | 正文 → 正文 | S |

### 3.11 CLI（新包）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `packages/cli/package.json` | 配置 | P1 | `bin: {"ow": "src/main.ts"}`；`engines.node >= 22.15` | — | S |
| `packages/cli/src/main.ts` | 新写 | P1 | 参数解析、子命令分发、`--help`；不调模型 | argv → exit code | M |
| `packages/cli/src/commands/vault.ts` | 新写 | P1 | `ow init` / `ow link` / `ow doctor` | — | S |
| `packages/cli/src/commands/publish.ts` | 新写 | P2 | `ow publish`（含 `--dry-run` / `--all`） | — | M |
| `packages/cli/src/commands/query.ts` | 新写 | P3.5 | `ow query`（本地 + 平台） | — | S |
| `packages/cli/src/commands/sync.ts` | 新写 | P3.5 | `ow sync {doc,skill,status}` 子命令 | — | M |
| `packages/cli/src/commands/review.ts` | 新写 | P3.5 | `ow review`（含 `--list`） | — | S |
| `packages/cli/src/commands/capture.ts` | 新写 | P2.5 | `ow capture --quick`：写 `_raw/<date>-<slug>.md`，不动 index/log/hot | 文本 → 草稿 | M |
| `packages/cli/src/commands/status.ts` | 新写 | P3.5 | `ow status --json` | — | S |
| `packages/cli/src/commands/skill.ts` | 新写 | P3 | `ow skill {list,push,pull,check}` | — | S |

### 3.12 技能包（迁移重点，markdown 不受语言影响）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `agent-skills/ow-compiler/SKILL.md` | 新写 | P1 | 编译器总控：输入契约、8 页上限、必须产出 report | prompt → 页面 + 报告 | M |
| `agent-skills/ow-compiler/references/llm-wiki.md` | 迁移 | P1 | 页面模板/provenance/置信度/关系类型/merge 规则 | — | L |
| `agent-skills/ow-compiler/references/wiki-capture.md` | 迁移 | P1 | 会话→陈述式知识：跳寒暄、按主题聚类、session_transcript 桶 | — | L |
| `agent-skills/ow-compiler/references/wiki-ingest.md` | 迁移 | P1 | 合并规则、Sources/snapshots、1MB 限制 | — | L |
| `agent-skills/ow-compiler/references/cross-linker.md` | 迁移 | P3 | 局部补链与关系类型推断 | — | M |
| `agent-skills/qdoc/SKILL.md` | 新写 | P2.5 | 前门：唤醒词判定（`qdoc`/`小q`，句首）+ 动作路由表 + 报能力格式；只调 CLI 不手写页 | 用户请求 → CLI 调用 | M |
| `agent-skills/qdoc/references/capture.md` | 迁移 | P2.5 | 记/沉淀/提升三动作，源自 `wiki-capture` + `wiki-ingest` | — | L |
| `agent-skills/qdoc/references/query.md` | 迁移 | P2.5 | 查 + 上下文包，源自 `wiki-query` + `wiki-context-pack` | — | L |
| `agent-skills/qdoc/references/maintain.md` | 迁移 | P2.5 | 状态/体检/去重，源自 `wiki-status` + `wiki-lint` + `wiki-dedup` | — | L |
| `agent-skills/qdoc/references/tagging.md` | 迁移 | P2.5 | 标签词表，源自 `tag-taxonomy` | — | M |
| `agent-skills/qdoc/references/skill.md` | 迁移 | P3 | 打包/毕业，源自 `vault-skill-factory` | — | M |

迁移改动（三处）：
1. 输入从「源文件」改为 `window.json` + `index.md` + `hot.md`；
2. 页数上限从 15 降到 8，单页 ≤200KB；
3. 输出必须附 `compile-report.json`。

### 3.13 Schema / 模板（新）

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `schemas/window.schema.json` | 新写 | P1 | 校验窗口结构 | — | S |
| `schemas/compile-report.schema.json` | 新写 | P1 | 校验编译器报告 | — | S |
| `schemas/publish-record.schema.json` | 新写 | P2 | 校验账本行 | — | S |
| `templates/vault/index.md` | 模板 | P1 | 初始索引（带 `timezone:`） | — | S |
| `templates/vault/log.md` | 模板 | P1 | 日志头 | — | S |
| `templates/vault/hot.md` | 模板 | P1 | 热缓存骨架 | — | S |
| `templates/vault/AGENTS.md` | 模板 | P1 | 项目级写作约定 | — | S |
| `templates/vault/gitignore` | 模板 | P1 | 忽略 `.ow/`、`_raw/`、`.publish/` | — | S |

### 3.14 安装

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `scripts/install-skill.ts` | 新写 | P1 | 把 `agent-skills/{ow-compiler,qdoc}` 装到 `~/.dsh/skills` 与 `~/.pi/agent/skills`；`--only` 选装 | 仓库 → 宿主目录 | S |

> **不再需要** `launchd/com.owd.plist`、`systemd/owd.service`——没有常驻进程。

### 3.15 测试（新）

沿用仓库现有风格：`node --experimental-strip-types` + 手写 `ok()` 断言，**不引入 vitest/jest**。

| 路径 | 类型 | 阶段 | 职责 | 输入 → 输出 | 规模 |
|---|---|---|---|---|---|
| `test/fixtures/dsh/*.jsonl.zstd` | 测试 | P0 | 脱敏会话样本（含注入消息、空轮、subagent） | — | — |
| `test/fixtures/pi/*.jsonl` | 测试 | P0 | 脱敏会话样本（含 `id/parentId` 分支） | — | — |
| `test/fixtures/vault/` | 测试 | P1 | 3 页小 vault | — | — |
| `test/turns.test.ts` | 测试 | P1 | 注入消息不算轮（6 轮 ≠ 17 轮）、空轮剔除、subagent 剔除 | fixture → TurnIndex | M |
| `test/window.test.ts` | 测试 | P1 | 30 轮边界、截断、hash 稳定 | — | S |
| `test/signal.test.ts` | 测试 | P1 | 噪声窗口被跳过 | — | S |
| `test/lock.test.ts` | 测试 | P1 | vault 锁互斥、机器锁跨项目互斥、死锁回收 | — | M |
| `test/manual.test.ts` | 测试 | P2.5 | 手动窗口切分、跳过信号门、quick capture 落 `_raw/` | — | M |
| `test/gate.test.ts` | 测试 | P2 | 7 道门逐条命中 | — | M |
| `test/render.test.ts` | 测试 | P2 | wikilink/本地字段处理、`<!-- ow:meta -->` 追加 | — | S |
| `test/mcp.test.ts` | 测试 | P2 | SSE 解析、10 工具、`list_documents` 分页、401/5xx | mock → 调用 | M |
| `test/publish.test.ts` | 测试 | P2 | create/update/冲突/墓碑 | — | L |
| `test/e2e.test.ts` | 测试 | P2 | 会话→窗口→编译→发布（假模型 + 假 MCP） | — | L |

---

## 四、外部依赖（全部是 Node 内置或已有）

| 依赖 | 用途 | 说明 |
|---|---|---|
| `node:zlib` 的 `zstdDecompressSync` | dsh 会话解压 | **Node 22.15+ 内置**（实测 v22.23.3 可用），不需要 `zstandard` |
| 全局 `fetch` + `ReadableStream` | qdoc MCP（Streamable HTTP + SSE） | Node 18+ 内置，不需要 `httpx` |
| 手写 `ok()` 断言 | 测试 | 仓库现有风格，保持 |
| `@deepseek-ai/cordis` 等 | dsh 插件 | 已有 peerDependencies |
| `@earendil-works/pi-coding-agent` | pi extension | 已有 |

> **不再需要**：`obsidian-wiki`（Python 包，只能重写）、`zstandard`、`httpx`、`pytest`。

**统计**：迁移 9（全是 markdown）｜重写 1（`vault/guard.ts`）｜新写 ~48｜改造 10｜模板/配置 10｜测试 13。

---

## 五、修改项（相对 v1.1）

| # | 修改 | 影响文件 | 说明 |
|---|---|---|---|
| M1 | 轮次统一 30 | `trigger/turns.ts`、`trigger/window.ts`、`trigger/state.ts` | 删掉按 agent 配置；窗口不跨会话 |
| M2 | vault 改 `.qdoc/` | `vault/init.ts`、`publish/*`、`vault/link.ts` | 项目内发现规则 + gitignore + Obsidian 链接 |
| M3 | 工具集 / 正文读 | `publish/mcp.ts`、`publish.ts`、`ledger.ts` | 冲突三方合并；base 正文落 `.publish/base/` |
| M4 | 运行态目录 | `trigger/state.ts`、`review/pending.ts` | `.qdoc/.ow/` 存水位线/待确认/日志/指标 |
| M5 | 发布态目录 | `publish/ledger.ts` | `.qdoc/.publish/` 存账本与 base |
| M6 | 尾窗结算规则 | `trigger/cycle.ts` | 会话结束 ≥5 轮才补跑，否则记 `dropped_tail` |
| M7 | 编译器防自触发 | `trigger/cycle.ts` | cwd 落在 vault 内的会话一律跳过 |
| **M8** | **语言改 TS** | **全仓** | 内嵌后必须跑在 agent 进程内；上游 Python 模块按需重写（§16.1） |
| M9 | 技能包结构 | `agent-skills/ow-compiler/*` | 1 个总控 SKILL.md + 4 个迁移参考 |
| M10 | P0 验收项 | `README`、测试 | `.qdoc/` 自动初始化；平台探针已结案（10 工具） |
| M11 | 过滤 subagent 会话 | `trigger/turns.ts`、`adapter-dsh/session-path.ts` | 按首行 `session` 头的 `origin`/`delegationDepth` 排除 |
| M12 | 平台工具升级 | `publish/mcp.ts`、`publish.ts` | `read_document_content`、`read_document` 带 `version`、`create_document` 支持 `tags` |
| M13 | 手动入口 + 前门 | `trigger/manual.ts`、`cli/commands/capture.ts`、`agent-skills/qdoc/` | 单一唤醒词，内部路由 10 个动作；与自动共用同一 Compiler/门禁/账本 |
| M14 | 拆分冲突模块 | `publish/conflict.ts` | 独立便于单测 |
| **M15** | **触发改内嵌** | **`adapter-dsh`、`adapter-pi`、删 `owd`** | 不再有常驻进程；两个适配器都调 `trigger/cycle.ts`（宿主无关） |
| **M16** | **并发控制改两级锁** | **`trigger/lock.ts`、`trigger/budget.ts`** | vault 锁（同项目串行）+ 机器锁（跨项目并发 1）；预算存 `~/.config/qdoc/machine.json` |
| M17 | 知识中心同步 | `sync/*`、`cli/commands/sync.ts` | 平台从「发布终点」升级为「检索 + 技能分发中心」；文档只推不拉 |
| M18 | `list_documents` 上线 | `publish/mcp.ts`、`sync/query.ts` | 文档可在线枚举与检索，**不再落地** |
| M19 | 文档只查不拉 | `sync/query.ts`（无 `pull-doc`） | 零合并冲突；平台更新即时可见；新机器只需拉技能 |
| M20 | 人机确认 | `review/*` | 后台不能弹窗；不可回滚动作进 pending 队列，`ow review` 处理，前门技能播报 |
| M21 | token 与启用闭环 | `vault/init.ts`、`sync/push-skill.ts`、`sync/manifest.ts` | token 三级查找；首次推技能记 `pending_enable`，轮询到启用后自愈 |
| M22 | 每日全量 check | `sync/pull-skill.ts` | 30 分钟查增减（2.9KB）+ 每天 03:00 全量比版本（3.7s/1.27MB） |
| **M23** | **修两个轮次 bug** | **`trigger/turns.ts`、`capture-orchestration.ts`** | ①注入消息不算用户轮 ②计「未编译」不记「未审」（§5.8） |
| **M24** | **预算移到机器级** | **`trigger/budget.ts`** | 「每日 ≤200k token」是整机总量，不是单 vault |

---

## 六、文件级问题（已结案）

1. ~~`read_document_content`~~：**已复测确认上线**。server `offerlai/1.30.0` 共 **10 工具**（含 `list_documents` 分页枚举）；`read_document` 返回 `version`，`create_document` 接受 `tags[]`。`publish/mcp.ts` 按 10 工具实现，三方合并为主路径，本地账本仍作 id/version 权威来源（§9.1–9.3、§10.3）。
2. ~~`skills/` 目录名~~：**已定** —— 仓库侧 `agent-skills/ow-compiler/`，vault 内保持 `.qdoc/skills/`（知识页）。三者区分：上游仓库 `skills/`（只读来源）｜本仓库 `agent-skills/`（技能包）｜vault `.qdoc/skills/`（知识页）。
3. ~~zstd 依赖~~：**已结案** —— Node 22.15+ 内置 `zlib.zstdDecompressSync`（本机 v22.23.3 实测可用），不引入 `zstandard`。
4. ~~`dsh headless` 不可用~~：**不再是问题** —— 编译改为进程内调 `ctx.llm`，不 spawn 子进程（§3.1）。原 `~/.dsh/profiles/headless` 的 bundle 路径失效仍需修（那是别的用途），但**不阻塞本方案**。
