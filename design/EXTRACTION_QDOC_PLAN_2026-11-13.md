# 抽取 → 发布方案 v3.0（2026-11-13）

状态：**待 review**　配套：[FILE_MANIFEST_2026-11-13.md](FILE_MANIFEST_2026-11-13.md)（文件级清单）
历史：[v1.1 存档](archive/EXTRACTION_QDOC_PLAN_2026-11-13.v1.1.md)

**一句话**：复用 obsidian-wiki 的抽取技能，做 **Trigger（各 agent 内嵌）→ Compiler（进程内，用该 agent 的模型）→ Publisher（qdoc MCP）** 三个薄组件；产物先落项目内 `.qdoc/` 做唯一事实源，过本地门禁后发布到 qdoc。

**两个入口，一条管线**：

```
自动：agent 内嵌数满 30 轮 ─┐
                            ├─→ 同一个 Compiler → 同一个 .qdoc → 同一个 Publisher
手动：用户说「记住这个」   ─┘
```

## 1. 约束 → 方案

| # | 约束 | 回应 |
|---|---|---|
| 1 | 复用 obsidian-wiki 抽取逻辑 | 复制 4 个 SKILL.md 做编译内核；手动入口再引 1 个（`wiki-capture`）。只改输入/预算/报告三处 |
| 2 | 每 30 轮自动更新 | **各 agent 内嵌**触发；dsh/pi 统一按「30 个已完成轮次」切窗口 |
| 3 | 集成 pi 与 dsh | dsh 装 cordis 插件、pi 装 extension；**编译复用各自 `ctx.llm` / `models.json`** |
| 4 | 平台无 draft | 发布前本地确定性门禁 |
| 5 | 不支持 delete | 只做墓碑：改正文 + 改 status 标签 |
| 6 | qdoc 无 namespace | filename 前缀 + tags 分组 |
| 7 | 区分文档与技能 | 陈述性 vs 程序性 + 毕业门槛，见 §8 |
| 8 | vault 位置 | 项目内 `.qdoc/`，随项目走 |
| 9 | **用户主动沉淀** | 一个唤醒词 `qdoc` / `小q` 做前门，路由到各动作；与自动共用同一 Compiler，见 §6 |
| 10 | 触发实现形态 | **内嵌**：dsh 插件 + pi extension。外置无法复用 dsh 的进程内凭据，见 §5.1 |
| 11 | 多 agent 同机 | 各自内嵌 + **vault 级文件锁**仲裁（没有单实例了），见 §5.6 |
| 12 | **平台做统一知识中心** | 文档**只推 + 在线查**（不落地）；技能**全量分批拉**；`list_documents` 可枚举，见 §10 |
| 13 | **后台不能弹窗问人** | 默认动作必须可回滚；不可回滚的只有「覆盖线上技能」，走 `ow review` + 前门技能播报，见 §11 |
| 14 | **自动触发会真实烧 token** | 编译在 agent 进程内用**该 agent 自己的模型**（dsh→`ctx.llm`，pi→`models.json`），不另配、不起新进程，见 §3.1 |

MVP 预计 5–7 天跑通 dsh 单链路（不含手动入口）。

## 2. 架构

```
┌──────────────────────┐        ┌──────────────────────┐
│ dsh                  │        │ pi                   │
│  cordis 插件          │        │  extension           │
│  inject:[skills,llm] │        │  before_agent_start  │
│                      │        │                      │
│  轮次计数(mtime 轮询) │        │  轮次计数(逐轮钩子)   │
│  空闲判定 / 水位线    │        │  空闲判定 / 水位线    │
└──────────┬───────────┘        └──────────┬───────────┘
           │     各自进程内，用各自模型      │
           │     dsh→ctx.llm  pi→models.json│
           └───────────────┬───────────────┘
                           │ 都写同一个项目 vault
                           │ 靠 .ow/lock 串行（§5.6）
        ┌──────────────────▼──────────────────┐
        │  Compiler（进程内，不起新进程）        │
        │  dsh: ctx.llm   pi: models.json      │
        │  机器级并发 = 1（~/.config/qdoc/lock）  │
        └──────────────────┬──────────────────┘
                           │ 页面 + compile-report.json
        ┌──────────────────▼──────────────────┐
        │  Vault  <project>/.qdoc/            │  每个项目一个
        │  唯一工作区 + 唯一事实源              │
        └──────────────────┬──────────────────┘
                           │ 变更页 + 门禁
        ┌──────────────────▼──────────────────┐
        │  qdoc MCP 客户端（CLI 进程，不调模型）│
        │  push 文档  create/update_document   │
        │  push 技能  import/update_skill      │
        │  查文档    list/search/read_content  │
        │  拉技能    list_skills + get_skill   │
        └──────────────────┬──────────────────┘
                           ▼
        qdoc.chat —— 检索 + 技能分发中心
        · 文档：只推不拉，查询时在线读（带 <!-- ow:meta -->）
        · 技能：全量分批落地到 ~/.dsh/skills 与 ~/.pi/agent/skills
```

**没有 `owd` 守护进程**。触发点在各自 agent 进程内——这是为了复用各自的模型凭据（§3.1、§5.1）。

**「查」不经过 vault**：`小q 查` 先 Grep 本地，不够就 `search_documents` 打平台，正文在线读，不落地成页。

**串行靠锁，不靠单实例**：内嵌后有两个独立进程（dsh 插件、pi extension），它们都可能判断「满 30 轮」。所以按 **vault 加锁**（`.qdoc/.ow/lock`），不是按会话——同项目不同 agent 必须排队（§5.6）。

**三处边界**：vault 是**项目级**事实源（编译只读它）；平台是**跨项目跨设备的查询与技能分发面**（不参与编译）；agent 会话是输入。

**为什么编译只认 vault**：编译要靠 `Grep`/`Read` 现存页面判断合并；qdoc 没有 wikilink 语义、没有本地 diff、正文只能逐篇读。平台文档因此**不参与编译**，只在查询时在线读。

### 2.1 vault 布局

```
<project>/
├── .qdoc/
│   ├── index.md / log.md / hot.md
│   ├── .manifest.json         # obsidian-wiki 源→页账本
│   ├── .publish/
│   │   ├── state.jsonl        # page → doc_id/version/sha
│   │   └── base/<doc_id>.md   # 上次发布正文，三方合并的 base
│   ├── .ow/                   # 运行态（两进程共享）
│   │   ├── state.json         # 水位线（按 session_id；存 vault 不存进程）
│   │   ├── lock/              # vault 级编译锁（pid/agent/过期时间）
│   │   ├── pending/           # 待确认队列（agent 只写，不等人）
│   │   ├── policy.json        # 「以后不再问」的放行策略
│   │   └── metrics.jsonl / logs/
│   ├── concepts/ entities/ skills/ references/ synthesis/ journal/
│   ├── projects/<name>/
│   ├── _raw/  _raw/_archived/ # 原始快照，不发布
│   └── _staging/              # 待人确认，不发布
└── .gitignore                 # ow init 追加 .qdoc/.ow/ .qdoc/_raw/

~/.config/qdoc/                # 机器级（跨项目共享，不属于任何 vault）
├── token                      # qdoc token（600）
├── machine.json               # 日预算总量 + 并发锁
└── machine.lock               # 机器级编译锁（跨 vault 排队）
```

- **发现规则**：从 cwd 向上找最近的 `.qdoc/`；没有则用 git 根；仍没有按 `auto_init=true` 初始化，否则跳过。
- `.qdoc` 是隐藏目录，Obsidian 默认不展示；要可视化用 `ow link` 生成 `wiki -> .qdoc` 软链。
- 一个项目一个 vault，跨项目默认不合并；全局知识留给 P4 的 hub vault。

## 3. 组件

| 组件 | 形态 | 做 | 不做 |
|---|---|---|---|
| `adapter-dsh` | **cordis 插件**（宿主内） | 定时器轮询会话 mtime、解 zstd、按 `seq` 增量、识别 `turn/end`、按 `source.kind` 过滤注入消息、剔 subagent、**调 `ctx.llm` 编译** | 不判断知识价值 |
| `adapter-pi` | **pi extension**（宿主内） | `before_agent_start` 逐轮钩子、读 JSONL 沿 `id/parentId` 活跃分支、按 `message.role` 切轮、**走 `models.json` 编译** | 同上 |
| `core` | 纯 TS 库（两份适配共用） | 轮次判定、窗口切片、信号门、编译内核、账本、门禁、发布、同步 | 不含宿主 API |
| `ow` CLI | Node 可执行 | `publish` / `query` / `sync` / `review` / `init` / `status` / `skill` / `link` | **不调模型**（除 `ow compile --manual` 走 agent） |
| `publisher` | `ow publish` 内 | 门禁、渲染、upsert、ledger、墓碑 | 不改页面内容 |
| `sync` | `ow sync` 内 | 技能 push/pull、文档 push、在线查 | 不拉文档、不做编译 |
| `review` | `ow review` 内 | 读 `.ow/pending/`，交互式确认不可回滚动作 | 不阻塞 agent |
| `promoter` | 夜间任务（由 agent 触发） | 技能毕业、打包、推 skill | 不代替人批准 |

**`core` 是关键**：两个适配器只做「宿主对接」，所有判定逻辑在 `core` 里一份。仓库现有结构已经是这样（`packages/core/lib/capture-orchestration.ts` 被 dsh 和 pi 同时调用），继续沿用。

**为什么没有 `owd`**：内嵌后触发点在 agent 进程内，没有独立守护进程。原先 `owd` 做的「单实例锁」由 vault 锁替代（§5.6），「队列」由锁的退避重试替代。

### 3.1 编译器用谁的模型

**一句话：用产生这段会话的那个 agent 自己的模型。不另配、不降级、不跨宿主。**

#### 两种宿主，两条闭环

| | dsh | pi |
|---|---|---|
| 模型配置在哪 | 会话里 `request/header` 的 `config.{provider, model}`；凭据在 `.credentials.yaml` + 进程内 `ctx.llm` | `~/.pi/agent/models.json` 的当前路由 |
| 编译怎么拿 | **调宿主服务 `ctx.llm`**（`inject = ["skills", "llm"]`） | 走 `models.json` 同一份配置 |
| 凭据是否离开宿主 | **不离开**——不复制、不猜路径，直接用 `ctx.llm` | 不外泄 |
| 是否新起进程 | **不起**（进程内调用） | **不起**（extension 进程内） |

**关键点：不 spawn 子进程，不读别人的凭据。** 这是仓库现有实现已经验证过的路（`llm-bridge.ts` 的 `installDshLlm`）。

#### 为什么不 spawn `dsh headless`

我上一版写的是「`owd` spawn 一个 `dsh --profile compiler headless`」。这条路**走不通**，实测原因：

```
dsh: cannot resolve profile bundle "dsh-autoskill"
Error: EPERM: operation not permitted, open '~/.dsh/profiles/headless/cordis.yml'
```

即使修好，也还有两个根本问题：

1. **新进程读不到会话的 `request/header`**。那个 provider/model 是**那次会话**的选择，不在任何 profile 文件里。
2. **`ctx.llm` 是进程内服务**，没有 CLI 能把它暴露出去。外部进程只能靠 `OPENAI_API_KEY` 这类环境变量——而 `errors.log` 证明这条路从来没成功过。

#### 模型跟着会话走，不跟着配置走

同一台机器上，用户可能这次用 `deepseek-flash`、下次用别的。会话文件里记着：

```json
{"type":"request/header","data":{"header":{"config":{
  "provider":"deepseek-official","model":"deepseek-flash",
  "maxTokens":256000,"reasoningEffort":"high"}}}}
```

**编译时读这条，用同一个 provider/model。** 不读 profile 默认值——那可能和用户当时选的不是一回事。

#### 代价：省不了钱，但行为一致

| 想省钱的思路 | 为什么不做 |
|---|---|
| 编译换便宜模型 | 模型不同，抽取质量不同——用户看到的页和当时对话的推理水平对不上 |
| 另配 `compiler` profile | 就是「第三方编译 agent」，用户已明确否掉 |
| 走 `OPENAI_API_KEY` | 实测从未成功（`errors.log`） |

**成本会记在各自 agent 的账上**：dsh 的编译消耗记在 dsh 的 DeepSeek 账号，pi 的记在 pi 的 provider 账号。平台侧分不出来，所以预算只能本地计数（§13）。

#### 配置项

```toml
[compiler]
# 不再有 profile / model —— 跟着会话走
max_tokens_per_window = 60000
timeout_seconds = 300
backend = "in-process"    # 只有这一种；"none" = 不自动编译，只排队
```

`backend = "none"` 时只写 `window.json` 到 `.qdoc/_raw/pending/`，用户下次喊 `小q 沉淀` 时在**自己的会话里**抽取。这是「零后台成本」模式。

## 4. 数据契约

**`window.json`**（触发器 → 编译器）：只含已结束轮次。

```json
{"schema":1,"agent":"dsh","session_id":"session-7c31d379-…","cwd":"/…/AutoSkill4Personal",
 "from_seq":305,"to_seq":520,"from_turn":3,"to_turn":6,"turns":4,
 "started_at":"…","ended_at":"…","hash":"sha256:…",
 "messages":[{"seq":308,"role":"user","text":"…"},{"seq":326,"role":"tool","name":"bash","text":"…"}]}
```

规则：工具结果截断 2k；assistant 只留文本块（丢 thinking）；总长上限 120k 字符，超出按「用户消息 + 结论段」抽。

**`compile-report.json`**：`window_hash` / `model` / `pages_created` / `pages_updated` / `pages_skipped[{path,reason}]` / `publish_candidates` / `cost` / `warnings`。候选由编译器初判，发布器仍要过门禁。

**`publish-state.jsonl`**（追加写，按 page 取最后一行生效）：

```json
{"page":"concepts/x.md","doc_id":123,"version":5,"content_sha":"…","published_at":"…","status":"active"}
{"page":"concepts/old.md","doc_id":88,"version":2,"content_sha":"…","status":"tombstone"}
```

账本是 upsert 的**唯一依据**，不用 `search_documents`（模糊匹配）。发布成功时把正文落到 `.publish/base/<doc_id>.md`，作为冲突时三方合并的 base。

**`.ow/state.json`**（水位线，**存 vault 不存进程**——两个 agent 进程共享同一份，否则会重复处理同一会话）：

```json
{"schema":1,
 "sessions":{"dsh:session-7c31d379-…":{"compiled_to_turn":30,"compiled_to_seq":520,
                                       "last_run":"2026-11-13T14:50:00+08:00",
                                       "pages":4},
             "pi:20261113_1421_ab12":{"compiled_to_turn":60,"last_run":"…"}}}
```

**`~/.config/qdoc/machine.json`**（机器级预算 + 并发锁；**不能放 vault 里**，否则管不到跨项目）：

```json
{"schema":1,
 "budget":{"date":"2026-11-13","compiles":7,"input_tokens":48210,"output_tokens":9104,
           "by_vault":{"/…/AutoSkill4Personal":5,"/…/bom-tree-vis":2}},
 "lock":{"pid":48213,"agent":"dsh","vault":"/…/AutoSkill4Personal",
         "acquired_at":"…","expires_at":"…"}}
```

两者分工：**水位线按 vault 存**（每个 `.qdoc/` 只关心自己的会话），**预算与并发锁按机器存**（整机一个总量）。

**`.ow/lock`**（vault 级编译锁；内嵌后没有单实例，靠它串行）：

```json
{"pid":48213,"agent":"dsh","session":"session-7c31d379-…","acquired_at":"…","expires_at":"…"}
```

拿不到锁就退避重试（1s/2s/4s，最多 3 次）；`expires_at` 过期（默认 30 分钟）视为死锁，强制回收并记 `metrics.lock_reclaimed`。

**`.ow/skill-manifest.json`**（技能同步清单；文档不拉，所以只有技能需要它）：

```json
{"device":"mbp-14",
 "skills":{"karpathy-guidelines":{"id":"98d8…","version":3,"sha":"…",
            "pulled_at":"…","targets":["~/.dsh/skills","~/.pi/agent/skills"]}}}
```

**`.ow/pending/<ts>-<kind>.json`**（待确认队列；agent 只写不等人，见 §11.4）：

```json
{"kind":"skill-overwrite","severity":"high","title":"技能推送会覆盖线上",
 "detail":{"skill":"qdoc","from":3,"to":4},
 "action":{"cli":"ow sync skill push qdoc --yes","reversible":false}}
```

**页面 frontmatter 增量**（在 title/summary/tags/sources/provenance/base_confidence/lifecycle 之上）：

```yaml
publish_as: document      # document | skill | local（local 永不发布）
publish_status: pending   # pending | published | tombstone
source_agent: dsh
source_session: session-7c31d379-…
source_turns: "3-6"
```

## 5. 自动触发（内嵌）

### 5.1 为什么必须内嵌：凭据在进程里

**结论先行**：要复用各 agent 自己的模型配置，就只能内嵌。因为 dsh 的凭据不在文件里，在**进程内的 `ctx.llm` 服务**里。

仓库现有代码已经把这条踩过了（`packages/adapter-dsh/src/llm-bridge.ts` 开头）：

> dsh 的凭据在宿主自己的 profile/.credentials.yaml 里，不存在 models.json；而 dsh 适配层 spawn 子进程时带 `--no-home`，于是 standalone 降级链在 dsh 里只剩 `OPENAI_API_KEY` 一条路。实测 `~/.dsh/data/autoskill/knowledge/errors.log` 里全是「未找到可用 LLM 配置」——compaction 抢救一次都没成功过。

两个宿主的凭据形态不同，这决定了能不能外置：

| | 凭据在哪 | 外部进程能读吗 | 能不能外置 |
|---|---|---|---|
| **dsh** | `~/.dsh/.credentials.yaml`（OAuth token）+ **进程内 `ctx.llm` 服务** | ❌ 服务在进程里，没有 CLI 暴露 | **不能** |
| **pi** | `~/.pi/agent/models.json` + `settings.json`（普通文件） | ✅ 能 | 能，但没必要 |

**所以不搞混合**：dsh 必须内嵌，pi 若外置就变成三条路径、两套理解。统一内嵌。

> **反转记录**：本方案 v2.x 曾定「多 agent 同机走外置（一个 `owd` 读会话文件）」。该结论**作废**，原因是它假设「编译可以另起进程」，而这个假设在 dsh 上不成立。用户要求复用各 agent 自身配置，外置无法满足。

### 5.2 两个宿主，两种钩子

| | dsh | pi |
|---|---|---|
| 形态 | cordis 插件（bundle） | extension |
| 注入什么 | `inject = ["llm"]`（provider 已随旧架构移除） | `ExtensionAPI` |
| 轮次钩子 | **没有 per-turn 钩子**（cordis 只暴露 `tools/skills/llm/effect`）→ 定时器轮询会话文件 mtime | `before_agent_start`，逐轮精确 |
| 触发精度 | 约 120s 滞后 | 逐轮 |
| 编译用谁的模型 | `ctx.llm`（宿主内闭环） | `models.json` 里的当前路由 |
| 装在哪 | `~/.dsh/profiles/<name>/` | `~/.pi/agent/settings.json` 的 `extensions` |

**dsh 没有 per-turn 钩子，所以 dsh 侧仍然是 mtime 轮询**——这点和外置方案一样，内嵌并没有换来精度。内嵌换来的是**凭据可用**。

### 5.3 轮次定义（统一 30）

一次用户诉求从发出到 agent 停止 = 一轮。

| Agent | 轮次信号 | 窗口边界 |
|---|---|---|
| dsh | `turn/end` 事件（`data.turn` 递增） | 第 1 个未编译 `turn/end` 到第 30 个，按 `seq` 切片 |
| pi | 一条 `message.role == "user"` 开启一轮 | 第 N 个 user 消息到第 N+29 个之后 |

- 只数**已完成**轮次；空轮不计，`aborted` 后仍有工具动作的计入。
- 窗口**不跨会话**，水位线按 `session_id` 隔离。
- 30 是全局默认，调试用 `--turns 2` 覆盖。

**两个实测陷阱**（本机 9 个真实会话验证）：

1. **`user/message` 不等于「用户说话」**。dsh 把 `runtime-context`、`time-context`、`skill-catalog`、`agent-instructions`、`model-selection` 也存成 `user/message`，`role` 全是 `user`。一个 17 条 `user/message` 的会话只有 6 条是真用户输入。**必须按 `data.source.kind == "user"` 过滤**，否则轮数虚高 3 倍。
2. **`turn/end` 数量 ≈ 真用户消息数**（实测 9/9、5/5、6/6、34/34、26/26，个别 37/38 差一）。所以 dsh 用 `turn/end` 计数是可靠的；但**空轮要剔**——实测有一个 `turn/end` 是 `aborted` 且该 turn 内 0 次 `assistant/message`、0 次 `tool/call`。

### 5.4 入队条件（全部满足）

```
1. 本 vault 未在编译中（按 vault 串行，不是按会话）
2. 该会话距上次编译 >= 30 个已完成轮次
3. 会话空闲 >= 90s（文件 mtime 不再变化）
4. 窗口内有留存信号：>=1 条用户诉求 + >=1 个工具/决策动作
5. 会话 cwd 的 vault 不是编译器自己的 cwd（防自触发）
6. 今日预算未超（默认 200k tokens / 50 次编译，按日总量不按 agent）
7. 机器级并发锁未占用（全局同时只跑 1 个编译器，跨项目也排队）
```

第 1 条在多 agent 同机时是关键：同一项目被 pi 和 dsh 都开过，两个会话各自满足「30 轮」，但**只能有一个先进编译器**，另一个排队。按会话加锁会漏。

第 7 条是机器级的，**不能靠 vault 锁实现**——不同项目是不同的 `.qdoc/`，锁互相看不见。所以锁文件放 `~/.config/qdoc/machine.lock`。

第 4 条是降噪关键：纯问答、纯检索、纯闲聊窗口直接跳过。

### 5.5 解析要点

- **dsh**：`~/.dsh/sessions/<slug(cwd)>/<session-id>/session.v4.jsonl.zstd`，追加式压缩流 → 每轮全量 `zstd -dc`，按 `seq` 去重（500KB 级可忽略，>20MB 再换增量帧）。只认 `user/message` 且 `data.source.kind == "user"`；`system-reminder`/`time-context`/`agent-instructions` 剔除。
- **必须过滤 subagent 会话**：同目录混有子会话（首行 `origin:"subagent"`、`delegationDepth≥1`），它们同样产生 `turn/end`，不过滤会重复计数。看首行 `session` 头，不看目录名。
- **pi**：`~/.pi/agent/sessions/<slug(cwd)>/<ts>_<uuid>.jsonl`，明文。文件是 `id/parentId` 树，**要沿活跃分支走**，不能按行顺序读。
- 防自触发：编译产生的会话 cwd 在 vault 内 → 跳过。

### 5.6 多 agent 同机的并发控制（内嵌后更重要）

内嵌后**没有单实例了**——dsh 插件和 pi extension 是两个独立进程，都可能判断「满 30 轮」。所以并发控制从「靠单实例」变成「靠文件锁」：

| 机制 | 做法 | 为什么还要 |
|---|---|---|
| **vault 级写锁** | 编译前拿 `.qdoc/.ow/lock`（含 pid + agent + 过期时间），拿不到就退避重试 | **按 vault 加锁，不是按会话**——同项目不同 agent 必须串行 |
| **机器级并发锁** | `~/.config/qdoc/machine.lock`，全局同时只跑 1 个编译（**跨项目也排队**） | vault 锁只管单项目；两个项目同时触发就是两个进程同时烧 token |
| **水位线存 vault 不存进程** | `.ow/state.json` 按 `session_id` 记已编译到第几轮 | 两个 agent 进程各存各的会重复处理同一会话 |
| **预算存机器级** | `~/.config/qdoc/machine.json` 记当日 token 累计（跨 vault 合并） | 「每日 ≤200k token」是**整机**预算，不是单 vault 预算 |
| **锁过期** | 30 分钟未释放视为死锁，强制回收并记 `metrics.lock_reclaimed` | 进程被杀会留死锁 |

**vault 数量**：一个**项目**一个 vault（`<project>/.qdoc/`）。同一台机器上 N 个项目就有 N 个 vault，但**同一项目的两个 agent 共用一个**——这正是要 vault 锁的原因。

**vault 锁不够用的地方**：它只保护「同一个 `.qdoc/`」。若 A 项目和 B 项目同时满 30 轮，两个进程会同时编译、同时烧 token。所以上面多了一条**机器级锁**，落在 `~/.config/qdoc/` 而不是项目内（项目内锁管不到别的项目）。

**本机实测**：pi 与 dsh 的 session 目录里，`bom-tree-vis`、`cmy-only-AutoSkill`、`dsh-workspace` 三个项目**两边都有**。内嵌方案下这就是两个写入者，**必须靠锁仲裁**。

### 5.7 会话结束结算

- 剩余 ≥5 个已完成轮次 → 立即入队尾部编译。
- <5 轮 → 不编译，记 `metrics.dropped_tail`（避免把半句话写成页面）。
- 窗口不跨会话，下一会话从 0 计数；旧会话尾巴只留指标，不补跑。

### 5.8 现有实现的两个 bug（内嵌后必须修）

翻回内嵌等于回到仓库现有形态（`packages/adapter-dsh` + `packages/adapter-pi`），但这两个 bug 必须先修，否则内嵌就是带着病上线：

1. **dsh 侧把注入消息也算成用户轮**。`normalizeDshEntry` 只判 `role === "user"`，而 `time-context` / `skill-catalog` / `agent-instructions` 的 `role` 也是 `user`。实测一个 6 轮会话被数成 17 轮 → **30 轮闸提前约 3 倍触发**。修法：判 `data.source.kind === "user"`。
2. **计的是「未审」不是「未编译」**。`unreviewedUserTurns` 用「该消息 id 是否被某张知识卡片的 `sources` 覆盖」判定，语义是「有没有被抽取过」，不是「有没有被编译成页」。两个阶段混在一个计数器里，压缩后会对不上。修法：水位线改记「已编译到的 `seq`」，不记「是否被 sources 覆盖」。

## 6. 手动触发（用户主动沉淀）

### 6.1 为什么不能另起一套

手动入口若自己写页、自己发平台，就会出现两套合并逻辑、两套门禁、两套账本。**手动只改变「编译哪一段」，不改变「怎么编译、怎么发布」**。

### 6.2 唤醒词：`qdoc` / `小q`

用户不该记九种说法。**只设一个前门技能，一个唤醒词，所有手动操作都从它进。**

| 用户说 | 行为 |
|---|---|
| `qdoc` / `小q` / `/qdoc`（后面没内容） | **报能力**：列出当前能做什么（见 §6.3） |
| `小q 记一下` / `小q 存个坑` | 快速记：写 `_raw/<date>-<slug>.md`，不建页、不改 index/log/hot |
| `小q 沉淀` / `小q 存进知识库` | 正式沉淀：走同一个 Compiler，窗口 = 当前会话或选中片段 |
| `小q 提升` / `小q 转正` | 把 `_raw/` 草稿提升成正式页 |
| `小q 查 <问题>` | 先查本地 vault，不够再在线查平台（§10.10）；只读带引用 |
| `小q 状态` | 还有多少没沉淀、哪些过时 |
| `小q 体检` | 坏链 / 孤儿 / 矛盾 |
| `小q 去重` | 合并重复页 |
| `小q 发` | 把待发布页推到 qdoc |
| `小q 同步` | `ow sync status`：待推、可拉技能、待确认 |
| `小q 确认` | `ow review`：处理待确认（只有不可回滚的动作需要） |
| `小q 装 <技能>` | `ow sync skill pull <name>` |
| `小q 检查技能更新` | `ow sync skill pull --check`：立即全量比对（3.7s，不用等到 03:00） |
| `小q 帮` | 同「报能力」 |

**误触发要防**：`qdoc` 也是平台名，用户正常说「qdoc 的 tags 怎么传」时不该被当成命令。判定规则：

```
是命令 ⟺ 唤醒词在句首或独立成词
       ∧ 后面跟「动词」或什么都不跟
不是命令 ⟺ 后面直接跟名词性内容（「qdoc 平台」「qdoc 的 API」）
```

拿不准就**不触发**，只在回答末尾附一句「需要的话可以说 小q 记一下」。

### 6.3 报能力（没有动词时的输出）

不能甩一份 40 项菜单。按当前 vault 状态给**最多 5 条**建议：

| vault 状态 | 建议 |
|---|---|
| 空库 / 刚初始化 | 记一下 · 沉淀 · 查 |
| 有未转正的 `_raw/` 草稿 | **提升 N 篇草稿** · 记一下 · 查 |
| 有 `publish_status: pending` 页 | **发布 N 篇待发页** · 记一下 · 查 |
| 有重复标题（lint 命中） | **去重 N 组** · 体检 · 查 |
| 有待确认项（`.ow/pending/`） | **确认 2 项** · 同步 · 查 |
| 一切干净 | 记一下 · 沉淀 · 查 · 状态 |

格式固定，一眼能看完：

```
小q 现在能做：
  · 记一下 —— 把刚才这段存成草稿（3 秒）
  · 提升   —— 2 篇草稿可转正
  · 确认   —— 2 项待确认（技能推送会覆盖线上）
  · 查     —— 本地 + 平台在线查
```

**不做**：不问就不长篇解释机制；不在每条回答后都塞菜单（只在用户主动喊、或首次进入项目时提一次）。

### 6.4 两种沉淀形态

| 形态 | 触发 | 做什么 | 何时用 |
|---|---|---|---|
| **快速记**（quick） | 「记一下」「存个坑」 | 写 `_raw/<date>-<slug>.md`，60 秒内完成；不建页、不改 index/log/hot | 还在探索、结论未稳 |
| **正式沉淀**（full） | 「沉淀」「存进知识库」 | 走同一个 Compiler，窗口 = 当前会话或用户选中的片段 | 结论已清楚，要进 vault |

快速记的草稿由下一次自动编译（或「提升」）走 `wiki-ingest` 转正——**草稿永远不会直接发布**。

### 6.4b `ow capture` 在 CLI 里的真实能力边界（2026-11-13 实测）

手动入口有两个，能力**不一样**，必须区分清楚：

| 入口 | 跑在哪 | 凭据 | 能编译吗 |
|---|---|---|---|
| agent 里说「小q 沉淀」 | 宿主进程内 | 宿主自己的（`ctx.llm` / `modelRegistry`） | **能** |
| `ow capture`（CLI） | 独立进程 | 只有 `OPENAI_API_KEY` / `AUTOSKILL_PROVIDER` | **通常不能** |

**为什么 CLI 拿不到宿主凭据**：dsh 的 `~/.dsh/.credentials.yaml` 存的是平台
refresh token（`R/…` 形式 + `issuer: platform.deepseek.com`），**不是 OpenAI 兼容
apiKey**，塞不进 `chatComplete` 的 standalone 链；pi 的 `auth.json` 同理只在 pi
进程内可见。所以 CLI 版 `ow capture` 走的是「切窗 + 信号门 + 落队列」：

```
ow capture --plan      → 只切窗，报每个窗口的信号判定，不烧 token
ow capture             → 有凭据就编译；没有就写 .ow/pending/capture.json 排队
```

排队不是失败——宿主下次会话启动时读队列补跑，用户不必重新说一遍。
**同会话只留最新一条**（重跑覆盖，不累积）。

**踩到的坑：zstd 多帧**。dsh 是追加写会话文件的，每次 flush 产生一个独立 zstd 帧。
Node 的 `zstdDecompressSync` **只解第一帧就停**——实测一个 9872 字节 / 6 帧 / 18 行的
会话，只解出 202 字节 1 行，而外部 `zstd -dc` 解出 18 行。若不做多帧处理，
`ow capture` 和 dsh 定时器在真实会话上都会**几乎什么都读不到**（且不报错，静默失效）。

处理：按魔数 `28 B5 2F FD` 找候选帧边界，逐段试解；解不动的段说明魔数是压缩数据里
的巧合，与下一段合并再试。已写成回归测试（断言「单帧解压只出 1 行」以防回退）。

### 6.5 手动窗口与自动窗口的差别

| | 自动 | 手动 |
|---|---|---|
| 触发 | 满 30 轮 + 空闲 90s | 用户一句话，立即 |
| 窗口 | 第 1–30 个未编译轮次 | 当前会话全文，或用户指定的片段 |
| 信号门 | 必须过（防噪声） | **跳过**（用户叫了就是要记） |
| 幂等键 | `window_hash` | `page + content_sha`（无窗口概念） |
| 产出 | 页面 + `compile-report.json` | 同左；`trigger: manual` 记进报告 |

### 6.6 前门怎么装

- **只装一个技能** `agent-skills/qdoc/`（目录名就是唤醒词），由 `scripts/install-skill.ts` 装到 `~/.dsh/skills` 与 `~/.pi/agent/skills`。
- 这个技能是**唯一入口**：识别唤醒词 → 路由到对应子动作 → **调 CLI**（`ow capture` / `ow compile --manual` / `ow query` / `ow publish` / `ow review` 等），而不是自己手写页面。
- 它同时是**后台任务的播报通道**：每次被唤醒先跑 `ow status --json`，有待确认项就一行带过（§11.5）。
- 子动作以 `references/` 形式挂在这个技能下，按需读取（`capture.md`、`query.md`、`maintain.md`），避免 9 个独立技能抢触发。
- 为什么绕一层 CLI：vault 发现、锁、账本、预算都在 CLI 里；技能只负责「判断记什么、怎么改写」。

**取舍**：一个前门更好用（用户只需记一个词），但 `SKILL.md` 会变大。折中：`SKILL.md` 只放唤醒词判定 + 路由表 + 报能力格式，10 个动作的实现细节全在 `references/`，按需读取。

### 6.7 必须统一的两处（否则手动会写坏库）

1. **配置解析**：上游技能靠 `.env` 向上找 `OBSIDIAN_VAULT_PATH`，我们靠向上找 `.qdoc/`。迁移时**替换成 `.qdoc` 规则**，否则手动技能会找不到 vault。
2. **index/log/hot 写入**：上游技能用散文步骤自己改这三个文件；我们必须统一走 `memory sync`（带文件锁），否则和自动编译并发写会把索引写坏。

## 7. 上游技能取舍

上游 40 个技能，按用途分三档。**默认只装「编译内核 + 手动入口」，其余按需装。**

### 7.1 编译内核（agent 不直接调用，由 Compiler 加载）

| 上游 | 本地落点 | 改动 |
|---|---|---|
| `llm-wiki` | `agent-skills/ow-compiler/references/llm-wiki.md` | 删 QMD/PDF/多 vault/配置解析；vault 路径改参数 |
| `wiki-capture` | `…/wiki-capture.md` | 输入改 `window.json`；输出限页 |
| `wiki-ingest` | `…/wiki-ingest.md` | 删 URL/PDF/图片分支；保留 merge 与 frontmatter |
| `cross-linker` | `…/cross-linker.md` | 只对本窗口触及的页补链 |

CLI 只用这几条（`pip install obsidian-wiki`，不跑 `setup`、不装 39 个技能）：

```
obsidian-wiki cache-update <vault> <source> --key agent:dsh/<session> --pages …
obsidian-wiki ingest-guard <vault> <page paths>
obsidian-wiki memory sync CAPTURE source_agent=dsh turns=30 pages_created=N
obsidian-wiki lint <vault> --json
obsidian-wiki snapshots set …（需要时）
```

### 7.2 前门技能 `qdoc`（一个入口，内部路由）

`agent-skills/qdoc/SKILL.md` 只写三样：唤醒词规则、动作路由表、能力自述格式。动作实现全部挂在 `references/`。

| 动作（用户说） | 上游来源 | 落到 `references/` |
|---|---|---|
| 记一下 / 存个坑 | `wiki-capture`（quick 模式） | `capture.md` |
| 沉淀 / 存进知识库 | `wiki-capture`（full）+ `wiki-ingest` | `capture.md` / `ingest.md` |
| 提升 / 转正 | `wiki-ingest` | `ingest.md` |
| 查 | `wiki-query` | `query.md` |
| 状态 | `wiki-status` | `maintain.md` |
| 体检 | `wiki-lint` | `maintain.md` |
| 去重 | `wiki-dedup` | `maintain.md` |
| 打包 / 毕业 | `vault-skill-factory` | `skill.md` |
| 上下文包 | `wiki-context-pack` | `query.md` |
| 打标 | `tag-taxonomy` | `tagging.md` |

按需再开：`wiki-digest`（周报）、`wiki-synthesize`（跨页综述）、`wiki-narrate`（主题简报）、`wiki-update`（项目整体同步）、`wiki-agent`（定向拉某 agent 的历史）。

**为什么不装 9 个独立技能**：9 个技能的 description 会互相抢触发，用户说一句「沉淀」可能命中 3 个；而且唤醒词无法统一。**一个前门 + 路由**是最小惊讶。

### 7.3 不要的（24 个）

`wiki-setup/switch/import/export/rebuild/stage-commit`（与固定 `.qdoc` 冲突）、`wiki-dashboard`/`graph-colorize`/`obsidian-layout-adjustment`（Obsidian 视觉层）、`session-brain`/`session-search`/`code-understand`（检索旧对话，不是沉淀知识）、6 个 `*-history-ingest` + `wiki-history-ingest` 路由（本期只接 dsh/pi，且自己解析）、`skill-creator`/`impl-validator`/`memory-bridge`/`daily-update`/`wiki-research`/`wiki-export`（与自动链路重叠或不需要）。

### 7.4 编译器的三处改动 + 提示词骨架

1. **输入**：从「读一个文件」改为「`window.json` + index 摘要 + hot takeaways」。
2. **预算**：`OBSIDIAN_MAX_PAGES_PER_INGEST` 降到 8；单窗口 ≤8 页、单页 ≤200KB。
3. **输出**：除页面外必须写 `compile-report.json`。

```
角色：你是知识编译器，不是总结器。
输入：window.json、vault/index.md、vault/hot.md
规则：遵循 llm-wiki 的模板/provenance/merge；遵循 wiki-capture 的陈述式改写。
硬约束：先查 index/Grep，已存在则合并，禁止新建同义页；每页写 summary/provenance/
  base_confidence/valid_from；推断标 ^[inferred]，冲突标 ^[ambiguous]+contradicts；
  最多 8 页，超出按 tier 截断并在 report 写 deferred；不写代码清单/原文/寒暄。
输出：页面写入 vault + compile-report.json
```

**抽什么**：决策与理由、踩坑与根因、可复用步骤、环境约束、术语澄清、被否决的方案。
**不抽**：一次性问答、文件清单、命令回显、流水账、无结论的探索。不确定就标 `^[inferred]`。

## 8. 产物分诊：文档 vs 技能

**三问全「是」才可能进技能**：① 有可执行步骤/命令/顺序？② 有触发条件与成功判据？③ 会被 agent 直接加载执行（而非人阅读）？任一为否 → 文档。

| 知识形态 | 去向 |
|---|---|
| 概念、实体、参考、综述、项目概览 | 文档 |
| 决策记录、架构权衡、事故复盘 | 文档（可带 `## Procedure`） |
| SOP、操作步骤、命令配方、环境约定 | 技能候选 |
| 编译器 schema/模板/合并规则 | 技能（常驻） |
| index/log/hot/manifest、原始会话、快照 | 仅本地 |
| redirect stub、墓碑、冲突副本 | 仅本地 |

**毕业门槛**：≥2 条独立 lineage ＋ 近 30 天被 ≥3 页/会话引用 ＋ 有「验证方法」小节 ＋ 人工把 `publish_as` 改为 `skill`。未毕业先以文档发布；`promoter` 每周出候选清单，不自动升级。

**技能包格式**（平台限 ≤50 文件、单文件 ≤1MB、总量 ≤2MB、必须含根 `SKILL.md`）：

```
skills/<domain>/
├── SKILL.md            # name/description + 触发 + 步骤 + 验证 + 边界
└── references/<slug>.md
```

`SKILL.md` 不写绝对路径、不写 token、不引用 vault wikilink（改纯文本标题）。

## 9. 发布：qdoc 适配

### 9.1 平台能力（2026-11-13 14:2x 复测，真实 token）

`https://qdoc.chat/mcp`（Streamable HTTP + SSE，Bearer token），server `offerlai/1.30.0`，`tools/list` 返回 **10 个工具**（`list_documents` 已于 14:4x 上线）：

| 工具 | 入参 | 返回 | 关键约束 |
|---|---|---|---|
| `list_documents` | `limit=20`(≤50), `offset=0` | `{documents:[{id, filename, file_type, namespace, source_type, vectorized, version, updated_at}]}` | **按 updated_at 倒序**；无需已知文件名即可发现；唯一可全量枚举文档的入口 |
| `search_documents` | `query`(必填), `limit=5` | `{documents:[{id, filename, …, version, updated_at}]}` | 空 query / `*` / `%` / `_` 都返回空——**是检索，不是枚举**；受「文档可用」总开关约束 |
| `read_document` | `doc_id` | `{id, filename, file_type, namespace, **version**, metadata}` | version 可直接当 `base_version` |
| `read_document_content` | `doc_id`, `max_chars=20000` | `{…, content, truncated, total_chars}` | max 100000，大文档要分批 |
| `create_document` | `filename`, `content_md`(≤1MB), `namespace_id?`, **`tags[]`** | `{id, filename, version, vectorizing}` | tags 只在此时能给 |
| `update_document` | `doc_id`, `content_md`, `base_version` | `{id, version, vectorizing}` | **不收 tags** |
| `list_available_skills` | — | `[{id, name, description, source, builtin}]` | 只返回**已启用**的；唯一可枚举的实体 |
| `get_skill` | `skill_id` | `{id, name, …, version, files:[{path, content}]}` | 全量返回；实测一个技能 114 文件 / 805k 字符 |
| `import_skill_from_files` | `name`, `description`, `files[]` | `{skill_id}` | ≤50 文件 / 单文件≤1MB / 总≤2MB；**落库为未启用** |
| `update_skill` | `skill_id`, `files[]`, `base_version` | `{skill_id, version}` | 全量替换；`source='MCP'` 直接生效，预置/自建走待审提案 |

**复测推翻了三次旧结论**（8 → 9 → 10 个工具）：

| 项 | 更早的结论 | 现在 |
|---|---|---|
| 枚举文档 | 不存在，只能靠本地清单 | **`list_documents`**，`{limit≤50, offset}`，按 `updated_at` 倒序 |
| `read_document_content` | 不存在 | **在**，`max_chars` ≤100000 |
| `read_document` 是否带 version | 不带 | **带**，可直接当 `base_version` |
| `create_document` 是否收 tags | 未确认 | **收**，schema 有 `tags[]` |
| `search_documents` 返回 | 未说明 | `{documents:[…]}`（**不是裸数组**），含 `version`、`vectorized`、`updated_at` |

**技能侧新事实**（这轮才测出来，直接影响 §10）：

- `list_available_skills` 是本账号**唯一能枚举的实体**，当前 6 个（1 个自建 + 5 个 GitHub 来源）。
- `get_skill` 全量返回 `files[]`，实测 `motion-showreel` 是 **114 文件 / 805k 字符**——**超过 import 的 50 文件上限，推不回去**。
- `update_skill` 有分流：`source='MCP'`（agent 自己推的）直接生效；预置/自建写入待审提案，用户审核前线上仍是旧版。

三处保留意见：
1. **正文内容没验证到**：探测账号下 0 篇文档（`read_document` 对 id 1/2/3/10/50/100 全返回「文档不存在」），`read_document_content` 只证明「工具存在」，没证明返回格式。首个真实发布后回读一次确认。
2. **`update_document` 不收 `tags`**：标签只能在 create 时给。**墓碑的 `ow:status=tombstone` 因此改不到**——墓碑只能改正文（`# <title>\n\n> 已合并至 X`），状态标签留在本地账本。这是平台限制，不是设计选择。
3. **不试探写入**：无 delete，验证 tags 只能靠首个真实发布，不做假数据试写。
4. **`search_documents` 匹配语义未验证**：本账号 0 篇文档，无法确认是文件名前缀匹配还是向量检索。**但这已不影响正确性**——发现走 `list_documents`，检索只用于「用户主动找」。

### 9.1b 首轮真实发布验证（2026-11-13 16:0x，已跑通端到端）

上一版留的「正文没验证到」已解决。用 `ow init` → `ow publish` 真发了两篇，回读确认：

| 项 | 结论 | 影响 |
|---|---|---|
| `<!-- ow:meta -->` 存活 | **原样保留**，`read_document_content` 能取回 | provenance 方案成立，不用另存 |
| frontmatter 存活 | 平台把 `content_md` 整段存储，不做二次解析 | 平台正文里会带 frontmatter（可接受） |
| `tags` 写入 | **成功** | `create_document` 的 `tags[]` 生效 |
| `tags` 读取 | **只有 `read_document` 返回**（`metadata.tags`），`list_documents` 不含 | 查标签必须逐个 `read_document` |
| `namespace` | 默认落「产品知识库」，`create_document` 有 `namespace_id` 参数 | 比预想的好：**有 namespace 概念**，只是没枚举接口 |
| 幂等 | 第二次 `ow publish` 正确 skip（body_hash 命中） | 账本方案有效 |

**三个新踩到的坑**（都已修进代码）：

1. **`list_available_skills` 把每个技能返回成独立的 `content` 项**，不是 `{skills:[...]}`。
   只取 `content[0]` 会得到「0 个技能」。`unwrapToolResult` 已改成：单项→对象，多项→数组。
2. **`search_documents` 是短语精确匹配**，不是语义检索：
   `qdoc` 命中 2 篇，`qdoc MCP` 命中 **0** 篇，`MCP` 命中 1 篇。
   所以 `ow query` 加了降级：整串无结果时按词长从长到短逐个重试。
3. **参数名与直觉不符**（`tools/list` 确认）：
   `doc_id`（非 `document_id`）、`content_md`（非 `content`）、
   `base_version`（非 `version`，且 `update_document` / `update_skill` **都必填**）。
   报错信息只说 `content_md Field required`，不提示「你传的 content 该改名」，极易误判为缺内容。

**token 轮换提醒**：发布时平台返回
`当前令牌已被轮换、处于宽限期（至 2026-11-13 21:22:07），到期后失效`。
说明 token 有轮换机制，代码里要把这条 `_notice` 透出给用户，不能静默吞掉。

### 9.2 无 namespace 的替代

全部写入默认空间，用命名与标签分组：

```
filename: ow-<project>-<category>-<slug>.md
tags: ow:project=<project>（必填）/ ow:cat=concepts / ow:type=doc|skill-ref
# ow:status 只在 create 时写；后续改不了（平台限制），状态以本地账本为准
```

`search_documents` 按 filename/元数据匹配，前缀保证可检索；**精确匹配以账本为准**。

### 9.3 发布流程

```
for page in changed_pages:
    if publish_as == local: continue
    if not gate(page): quarantine; continue
    content = render(page); sha = sha256(content)
    rec = ledger.last(page)
    if rec and rec.sha == sha: continue
    if not rec:
        r = create_document(filename, content, tags)           # → {id, version}
    else:
        r = update_document(rec.doc_id, content, rec.version)  # 乐观锁
        on 版本冲突:
            latest = read_document_content(rec.doc_id)
            if sha256(latest) == sha: 只更新账本; continue
            merged = three_way(base=.publish/base/<doc_id>.md, mine=content, theirs=latest)
            r = update_document(rec.doc_id, merged, latest_version)
            if 仍冲突: 写 .publish/conflicts/<page>.<ts>.md; 告警; continue
    ledger.append(page, r.id, r.version, sha)
    write .publish/base/<doc_id>.md = content
```

冲突三级：① 内容一致 → 只修账本；② 三方合并成功 → 提交新版本，冲突段标 `^[ambiguous]`；③ 合并失败 → **不重复建 doc**（无 delete，重复即永久垃圾），本地留副本 + 告警，等人工。

### 9.4 渲染

- 剥掉仅本地字段：`snapshots`、`source_session`、`publish_*`
- `[[path|label]]` → `label`，文末生成 `## Related` 纯文本清单
- 保留：`title`、`summary`、`tags`、`sources`、`provenance`、`base_confidence`、`valid_from`
- 正文加一行：`> Compiled from agent session dsh/<id>, turns 3–6.`
- 正文**末尾**加 HTML 注释块，把平台存不下的 provenance 带上（§10.9）：

```markdown
<!-- ow:meta
sources: dsh/session-7c31…, turns 3-6
provenance: extracted=0.70 inferred=0.25 ambiguous=0.05
base_confidence: 0.65
valid_from: 2026-11-13
updated_by: mbp-14
-->
```

### 9.5 无 delete 的墓碑

平台不能改 tags（§9.1），所以**墓碑只体现在正文，状态以本地账本为准**：

| 场景 | 处理 |
|---|---|
| 页面被本地合并 | 本地 `publish_status: tombstone`；平台正文换为 `# <title>\n\n> 已合并至 <new>.` |
| 页面被删除 | 只改状态，不调用删除；本地保留原页 |
| 发布错了 | 覆盖为墓碑正文 + 告警，不尝试删除 |
| 技能废弃 | `update_skill` 版本 +1，`SKILL.md` 顶部 `deprecated: true` |

平台侧看不到 `ow:status=tombstone` 标签，检索时仍可能命中——这是无 delete + 不能改 tags 的必然代价，只能靠正文里的「已合并」提示兜住。

### 9.6 幂等与重试

- `window_hash` 作编译幂等键；`page+content_sha` 作发布幂等键。
- MCP 失败：指数退避 3 次；401 停止并告警；5xx 重试。
- 单次发布 ≤20 页，超出排队下一轮。
- 所有写操作先写 `intent` 行再执行，崩溃后按账本对齐。

## 10. 平台作为统一知识中心

**先对齐理解**：平台不只是「发布终点」，而是**跨设备、跨 agent、跨项目的知识中心**。多台机器把文档和技能推上去；任何一端都能在线查文档、拉技能。

```
机器 A（笔记本）──┐                    ┌──→ ① 查文档（在线读，不落地）
机器 B（台式）  ──┼──→  qdoc.chat  ──→┤
机器 C（服务器）──┘     （统一中心）    └──→ ② 装技能（拉成本地文件）
```

### 10.0 通路核对：这条链完整吗

按上图逐段核对，**7 段里 5 段通、1 段半通、1 段要方案自己补**：

| 段 | 方向 | 状态 | 断在哪 |
|---|---|---|---|
| A→平台 推文档 | 写 | ✅ 通 | `create/update_document`，§9.3 |
| A→平台 推技能 | 写 | ⚠️ **半通** | 能推，但**推上去是「未启用」**，平台侧要人点一下才生效；且 `update_skill` 第二次起直接改线上（§10.5） |
| 平台→B 查文档 | 读 | ✅ 通 | `search/list/read_document_content` 在线读，§10.4 |
| 平台→B 装技能 | 读 | ✅ 通 | `list_available_skills` + `get_skill` 落地，§10.5 |
| **B 知道该装什么** | 元 | ⚠️ 可补 | 平台不记「谁装过」，差异靠本地 `skill-manifest.json` 算（§10.12②） |
| **B 的 token 从哪来** | 认证 | ⚠️ 可补 | 三级查找：env → 项目 `.ow/token` → `~/.config/qdoc/token`（§10.12①） |
| **B 知道有更新** | 通知 | ✅ **可补** | 无 webhook，但每天 03:00 全量 `get_skill` 只需 3.7s / 1.27MB，内容更新 ≤24 小时发现（§10.12③） |

后三条不是平台 API 的问题，是**方案原先没写**。§10.12 已补齐，但都有明确盲区：

| 盲区 | 后果 | 兜底 |
|---|---|---|
| 平台禁用技能后本机只标记不删 | 本地留旧副本 | 人工 `ow sync skill pull --prune` |
| 一个 token 通所有项目 | 无项目级隔离 | 平台现状，无解 |
| 推送后是「未启用」 | 平台侧要人点一下 | `ow sync status` 明确标「已推未启用」 |
| 平台更新技能最多晚一天 | 一天内用旧版 | 每天 03:00 全量；`小q 检查技能更新` 可立即触发 |
| 全量 check 随技能数增长 | 技能多了会变慢 | >20 个技能或 >10MB 自动降级；跳过 >5MB 单体；记 metrics |

**结论：通路能走通，只有一处必须人工**——首次推技能要在平台点「启用」。其余全部自动（内容更新最晚一天）。

### 10.1 角色重新划分

| 层 | 位置 | 职责 | 谁写 |
|---|---|---|---|
| 工作区 | `<project>/.qdoc/` | 编译、合并、wikilink、git diff、人工编辑 | adapter（进程内）|
| 知识中心 | qdoc.chat | 跨设备/跨 agent/跨项目的**检索 + 技能分发** | `ow publish` / `ow sync` |
| 消费端 | 各 agent 会话 | 查知识、装技能 | 用户 / agent |

**一条不能破的规则**：编译器只读本地 vault，**不直接读平台**。平台是查询面和技能分发面，不是编译输入。

### 10.2 三种同步（不是四种）

| 方向 | 内容 | 本期 |
|---|---|---|
| **push 文档** | vault 页 → `create/update_document` | 做（已有 §9.3） |
| **pull 文档** | 平台 doc → 本地页 | **不做**。文档只在**线查**，不落地 |
| **push 技能** | 毕业技能 → `import/update_skill` | 做 |
| **pull 技能** | 平台 skill → 本地技能目录 | 做，**30 分钟查增减 + 每天全量查更新** |

**为什么文档不拉**：

1. 平台正文**没有 provenance**（§10.9 会讲怎么补救，但终究是二手的）。
2. 拉回来会跟本地页抢同一个 slug，产生大量合并冲突——而这些冲突**没有价值**，因为两边本来就是同一篇的副本。
3. 文档是「查」的场景，不是「编辑」的场景。在线查一次 `read_document_content` 就够，不必进 vault。

**技能必须拉**：技能是给 agent 加载执行的，不能每次执行都去平台取。必须落地成文件。

### 10.3 平台能力边界（实测，2026-11-13）

| 能力 | 结果 | 用途 |
|---|---|---|
| 枚举文档 | ✅ `list_documents`，`limit≤50` + `offset`，按 `updated_at` 倒序 | **在线查的目录** |
| 检索文档 | ✅ `search_documents`（空 query 返回空，是检索不是枚举） | 在线查的入口 |
| 读文档正文 | ✅ `read_document_content`，`max_chars` 默认 2 万、最大 10 万 | 在线查的正文 |
| 枚举技能 | ✅ `list_available_skills`（只含已启用） | 技能同步的目录 |
| 读技能全部文件 | ✅ `get_skill` 返回 `files[]`；实测一个技能 **114 文件 / 805k 字符** | 技能 pull |
| 推文档 | ✅ `create/update_document` + `tags[]` + `base_version` | 已有 |
| 推技能 | ✅ `import/update_skill`，**≤50 文件、单文件≤1MB、总量≤2MB** | 技能 push |
| 删除 | ❌ | 只能墓碑 |

**`list_documents` 上线后，原先「靠本地清单猜平台有什么」的设计全部作废**——在线查直接翻页。

### 10.4 文档：只推 + 在线查

**推**：不变，见 §9.3（门禁 → 渲染 → create/update → 账本）。

**查**：三种入口，都不落地。

```
ow query "缓存方案"              # CLI
小q 查 缓存方案                   # 前门技能
```

```
1. 先查本地 vault（Grep + index.md）        ← 快，带 wikilink，有 provenance
2. 命中 < 2 条 → search_documents(问题)     ← 平台兜底，跨设备跨项目
3. 命中 doc_id → read_document_content      ← 取正文
4. 答案标来源：[local:proj-a/concepts/x.md] / [platform:doc 123]
```

**不落地的好处**：

- 不会跟本地页抢 slug，零合并冲突
- 平台侧更新立刻可见，不用等定时拉
- 省掉整套 `render_back`（平台 markdown → 本地页 + 还原 wikilink），这是最容易出错的一块

**代价**：查平台要网络；平台正文没有本地 frontmatter，引用时只能给 `filename + doc_id`。

### 10.5 技能：全量分批同步

技能是**唯一需要落地**的东西。

**pull（全量分批）**：

```
ow sync skill pull [--all | name...] [--check] [--dry-run]
  skills = list_available_skills()            # 已启用的全部；注意：不含 version

  # 模式 A：默认（便宜）——只装本机没有的
  for s in skills:
      if skill_manifest.has(s.id): continue             # 已装过就跳过，不查版本
      d = get_skill(s.id)                               # 全量 files[]
      if len(d.files) > 200 or total > 20MB: 告警并跳过   # 防单技能爆内存
      写 ~/.dsh/skills/<name>/ 与 ~/.pi/agent/skills/<name>/
      写 manifest（id, version, sha, pulled_at）
      限流：每个技能之间 sleep 200ms

  # 模式 B：--check（3.7s / 1.27MB）——发现内容更新；每天 03:00 自动跑一次
  for s in skills:
      d = get_skill(s.id)                               # 必须全拉才能看 version
      rec = skill_manifest.get(s.id)
      if rec and rec.version == d.version: continue
      if rec and rec.sha == hash(d.files): 只更新 version; continue
      落地；写 manifest
```

**为什么要分两种模式**：`list_available_skills` **不返回 `version`**（实测字段只有 `id/name/description/source/builtin`）。想知道版本只能 `get_skill`，而它把整个技能吐出来——6 个技能全查实测 **3.7s / 1.27MB**（详见 §10.12②）。

| 模式 | 调什么 | 能发现 | 成本 |
|---|---|---|---|
| 默认 | 只 `get_skill` 未装的 | 新增技能 | 小 |
| `--check` | 全部 `get_skill` | 新增 + **内容更新** | 3.7s / 1.27MB |

**分批的含义**：一次 `get_skill` 返回一个技能的**全部文件**（不按文件分批，因为 API 不支持）。「分批」指**按技能逐个拉**，中断可续——manifest 记到哪个就跳过哪个。

**单个技能很大怎么办**：实测 `motion-showreel` 是 114 文件 / 805k 字符，一次返回没问题。但设 20MB 上限，超过就跳过并告警，不硬拉。

**push（毕业技能 → 平台）**：

```
ow sync skill push <name> [--dry-run]
  files = 打包 agent-skills/<name>/**          # 必须含根 SKILL.md
  if len(files) > 50 or total > 2MB: 报错退出   # 不静默截断
  s = list_available_skills() 里按 name 找
  if not s: import_skill_from_files(name, desc, files)   # → 未启用，等人工开
  else:     update_skill(s.id, files, base_version=s.version)
```

**`update_skill` 的分流必须知道**（工具描述原文）：

| 技能来源 | 行为 |
|---|---|
| `source='MCP'`（agent 自己推的） | **直接生效**，version+1 |
| 预置 / 自建 | 写入**待审提案**，用户审核前线上仍是旧版 |

所以「毕业技能自动推送」第一次安全（import 后未启用），**第二次起会直接覆盖线上**。默认 `--dry-run`，人工确认后才真推（确认方式见 §11）。

**第一次推送有个必须知道的坑**：`import_skill_from_files` 落库是「未启用」，而 `list_available_skills` **只返回已启用的**。所以：

```
推完 → import 返回 {skill_id}         ← 有 id，但 list_available_skills 里查不到
     → 本机没法自证「推成功了」
     → 必须人去平台技能页点「启用」
     → 启用后才出现在 list_available_skills，其他机器才拉得到
```

这意味着**技能推送不是「推完就通」**，中间有一个人工点击。方案里的处理：

| 环节 | 处理 |
|---|---|
| 推完立刻 | `ow sync status` 显示「已推未启用（skill_id=…），去 qdoc.chat 技能页启用」 |
| 记在哪里 | `.ow/skill-manifest.json` 里 `"pending_enable": true` + `skill_id` |
| 怎么自愈 | 每轮 `list_available_skills`，发现 id 出现了就把 `pending_enable` 置 false |
| 如果一直没启用 | 7 天后进 `.ow/pending/`，`ow review` 提醒 |

**这是「A→平台 推技能」算「半通」的原因**——不是 API 不通，是中间断了一个人工动作，后台无法代劳。

**50 文件上限是单向的**：push 受限（`motion-showreel` 114 文件推不回去），pull 不受限。所以自产技能要控制文件数——`references/` 按主题合并，别一个子主题一个文件。

### 10.5b 实现后修正（2026-11-13 实测，6 个真实技能跑通）

上面 §10.5 是设计意图，真跑一遍后有三处必须改：

**① 「默认只装没装过的」不够——老用户会永远装不上**

按设计，本地已有且清单没记的技能一律跳过（怕覆盖用户自己的东西）。问题是：老用户
**之前手工同步过**的技能，清单里从来没记过，于是永远走「跳过」分支，永远同步不了。

实测本机 `~/.dsh/skills` 里有 12 个技能，其中 `karpathy-guidelines` 与平台内容
**完全一致**，`web-design-engineer` 只差一个本地多出的 `agents/openai.yaml`。
它们都卡在「跳过」上。

改成三态判定：

| 本地状态 | 内容与平台 | 动作 |
|---|---|---|
| 无 | — | `created` 拉下来 |
| 有、清单没记 | **一致** | `adopted` 自动登记接管（之后能正常同步） |
| 有、清单没记 | 不同 | `adoptable` **只报不动**，`--adopt` 才接管 |
| 有、清单记了、本地没改 | 变了 | `updated` 覆盖 |
| 有、清单记了、本地改了 | 没变 | `diverged` **提前预警**（见③） |
| 有、清单记了、本地改了 | 变了 | `conflict` 落现场，不覆盖 |

**② 只扫 `references/scripts/assets` 会让哈希永远对不上**

`readLocalSkill` 原来只读 `SKILL.md` + 三个子目录。但平台允许根目录放文件——
实测 `beautiful-article` 有 `README.md` / `README.zh-CN.md` / `manifest.json`，
`web-design-engineer` 也是。拉下来写盘了，推的时候却没读到，于是**哈希永远不一致**，
每次同步都误报 `updated` 并白白抬高版本号（还会让所有机器都以为有更新去拉一遍）。

改成读整棵目录树（跳过二进制与隐藏文件）。修完后 6 个技能里 5 个哈希一致。

**③ 本地改过、平台没变，不能报 `unchanged`**

这是最隐蔽的一个。原逻辑先判「清单 sha == 平台 sha」→ 直接 `unchanged` 早退，
**没检查本地文件是否已被改动**。后果：本地明明改过了，`ow sync` 却说同步正常；
等平台哪天真更新，突然报 `conflict`，用户一脸茫然——「我什么都没干啊」。

改成先算 `locallyModified`，分叉但平台未变时报 `diverged`，并明说「平台下次更新会冲突」。

**④ 推送要先比对内容**

`pushSkill` 原来见到平台已有同名技能就无条件 `update_skill`。刚从平台拉下来的技能
再推一遍，也会升版本。加了内容比对：哈希一致直接返回 `unchanged`，不调平台。

**实测数据**（6 个技能，真实平台）：

| 项 | 值 |
|---|---|
| 拉取总量 | 201 文件 / 2.0MB |
| 幂等 | 第二次全部 `unchanged`，0 次 API 写 |
| 单技能最大 | `motion-showreel` 114 文件 / 787KB |
| 推送跳过 | 内容一致的 4 个全部跳过，只推真正改过的 1 个 |
| 推不上去的 | `motion-showreel` 114 文件 > 50 上限 |

**新增：`--skills-root`**。默认位置按宿主推（`~/.dsh/skills` 或 `~/.pi/agent/skills`），
但多宿主、自定义目录、或者跑在沙箱里时需要指到别处。实测本机沙箱只允许写工作区，
`~/.dsh/skills` 是 EPERM，必须靠这个参数。

### 10.6 多设备冲突（只剩 push 侧）

文档不拉，冲突只发生在**两个设备都推同一篇**时：

| 场景 | 处理 |
|---|---|
| 平台版本 = 本地账本版本 | 正常 update |
| 平台版本 > 账本版本（别人推过） | `read_document_content` 取最新 → 三方合并（base = `.publish/base/<doc_id>.md`）→ 重试 update |
| 合并失败 | **不重复建 doc**（无 delete，重复即永久垃圾），本地留副本 `.publish/conflicts/`，告警等人工 |
| 内容 sha 相同但 version 不同 | 只更新账本，不推 |

**设备标识**：`create_document` 时写 `ow:origin=<device>` 标签；之后改不了。标签只记录「谁创建」，**「谁最后改」写在正文 frontmatter 的 `updated_by`**。

### 10.7 命令面

```
ow publish [--dry-run]          # 推文档
ow query "问题"                  # 在线查（本地优先 + 平台兜底）
ow sync skill pull [--all]      # 拉技能，全量分批
ow sync skill pull --check      # 立即全量比对版本（3.7s / 1.27MB）
ow sync skill push <name>       # 推技能，默认 dry-run
ow sync skill pull --prune      # 清理平台已禁用但本地还在的技能
ow sync status                  # 待推/可拉/待启用/待确认
```

`ow sync status` 输出：

```
同步状态  project=AutoSkill4Personal  device=mbp-14
  文档   本地 42 页 / 已发布 38 篇    ↑ 待推 4
  技能   本地 2 个 / 平台 6 个        ↓ 可拉 4（1 个已最新）
         ⏳ 已推未启用 1（qdoc, skill_id 896a…）
  待确认 2 项（见 ow review）
```

### 10.8 这改变了什么

| 原来 | 现在 |
|---|---|
| 平台只是发布终点 | 平台是检索 + 技能分发中心 |
| 文档双向同步 | 文档**只推不拉**，在线查 |
| 拉文档要做反向渲染 + 冲突合并 | 全砍掉，零冲突 |
| 技能同步是附加项 | 技能同步是**唯一必须落地**的同步 |
| 新机器要拉几百篇文档 | 新机器只拉技能，文档直接在线查 |

### 10.9 provenance 怎么活下来

**问题**：`create_document` 只收 `filename` + `content_md` + `tags`，没有任意 metadata 字段。那 `sources` / `provenance` / `base_confidence` 推上去就丢了。

**解法：塞进正文末尾的 HTML 注释**。渲染时不可见，`read_document_content` 读回来能解析。

```markdown
……正文……

<!-- ow:meta
sources: dsh/session-7c31…, turns 3-6
provenance: extracted=0.70 inferred=0.25 ambiguous=0.05
base_confidence: 0.65
valid_from: 2026-11-13
updated_by: mbp-14
-->
```

为什么是 HTML 注释而不是 YAML frontmatter：

| 形式 | 渲染效果 | 可解析 |
|---|---|---|
| YAML frontmatter 放正文顶部 | 多数渲染器显示成 `---` 分隔线 + 裸文本，**难看** | 是 |
| **HTML 注释放末尾** | **不可见** | 是（`<!-- ow:meta` 到 `-->` 之间） |
| 纯文本 `## 元数据` 小节 | 可见，占版面 | 是 |

**qdoc 是渲染 markdown 的**，所以 HTML 注释在页面上**不可见**——这正是选它的原因（YAML frontmatter 会被渲染成 `---` 加裸文本，难看）。剩两个未验证点（首个真实发布后回读确认）：

1. 渲染前的清洗会不会**剥掉**注释。剥了就只能退回可见的「## 元数据」小节。
2. 向量化会不会把注释文本索引进去（只影响检索噪声，不影响正确性）。

**在线查时也要用**：`read_document_content` 拿到正文后，解析 `<!-- ow:meta -->`，答案里就能标「这条是提取的（0.7）还是推断的（0.25）」。

### 10.10 跨项目检索 = 在线查

`小q 查` 默认查本地当前 vault。跨项目怎么办？**直接走平台**。

```
1. 当前 vault（Grep + index.md）              ← 快，带 wikilink
2. 命中 < 2 条 → search_documents(问题)        ← 平台，覆盖所有项目所有设备
3. read_document_content(doc_id)               ← 取正文
4. 解析 <!-- ow:meta --> 拿 provenance
5. 答案标来源：[local:…] / [platform:doc 123]
```

不需要 `.ow/vaults.json` 登记本机所有 vault——平台本来就是跨项目的全集，而且它还有别的机器的内容。

### 10.11 已知代价

1. **平台正文是二手的**：`<!-- ow:meta -->` 能救回 provenance，但救不回 `relationships`、`snapshots`、本地 wikilink 结构。在线查看到的是「平台版」，不是「本地版」。
2. **在线查要网络**：断网时只能查本地。
3. **技能推送会改线上**：`source='MCP'` 的技能第二次推送直接生效，没有待审缓冲（§10.5）。
4. **平台无删除**：推错了只能墓碑，平台侧留垃圾。
5. **平台没有「修改历史」**：`update_document` 只给 version 号，看不到 diff。多设备改同一篇时，三方合并只能靠本地 `.publish/base/` 那份快照。

### 10.12 补齐三段断链

#### ① token 怎么到每台机器

平台只给一个 Bearer token（`qdoc_…`，37 字节）。**不能进 git**。

```
优先级（从高到低）：
1. $QDOC_TOKEN 环境变量
2. <project>/.qdoc/.ow/token        （gitignore，权限 600）
3. ~/.config/qdoc/token             （机器级，多项目共用）
```

`ow init` 时交互式问一次并写第 3 项（机器级，多项目共用一份）。`ow doctor` 检查权限是否 600、是否被 git 跟踪。

**一个 token 覆盖所有项目**——平台没有 namespace，也没有 per-project token。所以「机器 A 能推项目 X」和「能推项目 Y」是同一权限，没有隔离。这是平台现状，写清楚比假装有隔离好。

**只读机器怎么办**：`ow init --read-only` 只装 `search/list/read_document_content/get_skill` 相关权限的用法约定（token 本身仍是全权），并在 `config.toml` 里 `allow_push = false`。这是**约定不是强制**——平台侧不区分 scope（`document:read` / `document:write` 是工具自带的注解，不是 token 的 scope）。

#### ② 平台怎么知道「这台机器装了什么」

平台**不存**这个信息。`list_available_skills` 只返回「平台有哪些已启用技能」，不返回「谁装过」。

**而且 `list_available_skills` 不返回 `version`**（实测，字段只有 `id/name/description/source/builtin`）。所以：

| 想知道 | 只能 | 成本 |
|---|---|---|
| 平台有哪些技能 | `list_available_skills` | ~3KB，一次拿全 |
| 某个技能是什么版本 | `get_skill(id)` | **整个技能正文**：karpathy 3KB / asd-ste100 22KB / **motion-showreel 832KB** |

**判断「要不要更新」必须调 `get_skill`**，而它会把 114 个文件全吐出来。所以 30 分钟轮询内容是不可行的（一天 61MB），但**一天一次完全可行**——实测 3.7 秒 / 1.27MB。

**没有便宜的粗筛手段**——`list_available_skills` 既不给 `version` 也不给 `updated_at`。唯一能看版本的只有 `get_skill`。

**实测全量 `--check` 的成本**（6 个已启用技能，2026-11-13）：

| 项 | 实测 |
|---|---|
| `initialize` | 211 ms |
| `list_available_skills` | 29 ms / **2.9 KB** |
| 6 × `get_skill` | 3.4 s / **1.27 MB** |
| **合计** | **3.7 s / 1.27 MB** |

各技能体积：`motion-showreel` 832KB（114 文件）、`web-design-engineer` 235KB（38）、`beautiful-article` 128KB（31）、`web-video-presentation` 110KB（15）、`asd-ste100` 22KB（2）、`karpathy-guidelines` 3KB（1）。

**一天 1.27 MB / 3.7 秒，完全负担得起**。所以默认**每天一次全量 `--check`**：

```
触发侧内置两个节奏：
  每 30 分钟   list_available_skills()      2.9KB   → 发现技能新增/移除（便宜，勤快）
  每天 03:00   全量 --check                 1.27MB  → 发现内容更新（贵，一天一次够）
```

**为什么两档而不是一档**：

| 只做 30 分钟增量 | 只做每天全量 | **两档（选这个）** |
|---|---|---|
| 内容更新永远发现不了 | 新技能要等一天 | 新技能 ≤30 分钟，内容更新 ≤1 天 |
| — | 每 30 分钟烧 1.27MB（一天 61MB） | 一天 1.27MB |

**上限保护**：技能数超过 20 个，或单轮总量超过 10MB 时，`--check` 自动降级为「只查 manifest 里有的 + 跳过 >5MB 的单技能」，并记一条 `metrics`。当前 6 个技能远未触及。

**配置**：

```toml
[sync]
skill_check_hour = 3        # 每天几点跑全量；-1 = 关掉，只留 30 分钟增量
skill_check_budget_mb = 10  # 单轮总量上限，超了降级
```

**每日全量的落地细节**：

```
每天 03:00（可配 check_hour）:
  for s in list_available_skills():
      rec = manifest.get(s.id)
      if not rec:                              # 新技能，直接拉
          get_skill → 落地 → manifest
          continue
      d = get_skill(s.id)                      # 1.27MB 里的主要部分
      if d.version == rec.version: continue    # 最常见，什么都不做
      if hash(d.files) == rec.sha:             # 版本变了内容没变
          rec.version = d.version; continue
      三方合并？不需要——技能是整体替换
      写 .ow/pending/<ts>-skill-update.json   # 不自动覆盖本地，等人确认
```

**为什么更新不自动落地**：本地技能可能被手改过（`rec.sha != hash(本地文件)`）。这种情况自动覆盖会丢改动，所以进 `ow review`（§11）——和「推送覆盖线上」同一类处理。

**manifest 记什么**：

```json
{"skills":{"98d8300dc7c54aeb":{"name":"karpathy-guidelines","version":1,
  "sha":"…","pulled_at":"…","pending_enable":false}}}
```

`sha` 是本地落地后的文件树哈希——用来判断「拉下来的东西被人手改过没有」，不是用来跟平台比的（平台不返回 sha）。

#### ③ 怎么知道有更新

没有 webhook、没有 push、没有 SSE 订阅。**只能轮询**，但轮询能力有限：

| 级别 | 频率 | 调什么 | 能发现 | 成本/天 |
|---|---|---|---|---|
| 增量 | 30 分钟 | `list_available_skills` | 技能**新增/移除** | 139 KB |
| 全量 | **每天 03:00** | 逐个 `get_skill` | 技能**内容更新** | 1.27 MB |

失败退避：30m → 1h → 2h → 4h（上限），连续 3 次失败进 `.ow/pending/` 告警。

**「自动知道」的边界**（重要，要写进 SKILL.md）：

| 情况 | 多久发现 |
|---|---|
| 平台新增技能 | ≤30 分钟 |
| 平台禁用/移除技能 | ≤30 分钟（但只标记，不删本地） |
| **平台更新技能内容** | **≤24 小时**（每天 03:00 全量） |
| 平台更新文档 | 不发现——文档在线查，没有「同步」概念 |

所以「本机不会自动知道」这句**要改成「最多晚一天」**。用户喊 `小q 检查技能更新` 可以立刻触发一次全量，不必等到 03:00。

**文档不轮询**——文档不落地，没有「同步」概念。用户查的时候才打平台。

## 11. 人怎么被告知

触发发生在 agent 进程内，但**编译是后台自动跑的，不能在对话中途插话**（dsh 无 per-turn 钩子，pi 的 `before_agent_start` 也不能反向插话）。所以仍有 7 处「本该问一下」的地方。

### 11.1 先分类：哪些真需要人

| 事项 | 有无副作用 | 处置 |
|---|---|---|
| 门禁拒绝 | 无（本来就不发布） | **静默**进 `_staging/rejected/` |
| 三方合并失败 | 无（本地留副本，不推） | 静默，计入待确认 |
| 技能毕业候选 | 无（不自动升级） | 每周清单 |
| **技能推送覆盖线上** | **有，不可回滚** | **必须确认** |
| **首次推技能后是「未启用」** | 无（不生效） | 进 pending，提示去平台点启用 |
| 首次全量拉技能 | 无（写本地，可回滚） | 默认放行 |
| 预算超限 | 无（暂停而已） | 通知一次 |

**核心原则**：后台流程不能「问」，只能「**告知 + 可撤销**」。所以：

1. 所有默认动作**必须可回滚**——不能回滚的，一律默认 dry-run。
2. 真正不可回滚的只有一条：**覆盖线上技能**。其余全部默认放行。

### 11.2 四个送达通道

| 通道 | 时机 | 侵入性 | 覆盖什么 |
|---|---|---|---|
| ① 文件可见 | 随时 | 无 | `_staging/`、`.ow/pending/` 在 Obsidian 和 `git status` 里看得见 |
| ② `ow review` | 用户主动跑 | 无 | 全部待确认，唯一交互入口 |
| ③ 前门技能播报 | 用户下次喊 `小q` | 低 | 一句话带过，不展开 |
| ④ 桌面通知 | 检测到高危 | 中 | 只报「覆盖线上技能」「预算超限」两类 |

**没有第五个通道**：不做 GUI，不往 agent 会话里注入消息（`dsh-schedule` 依赖 Web Session controller，headless 挂不上），不阻塞等待。

### 11.3 `ow review`：唯一交互入口

```
$ ow review

待确认 2 项

[1] 技能推送会覆盖线上
    agent-skills/qdoc  →  qdoc (skill 896a…, v3 → v4)
    [a] 应用   [d] 看 diff   [s] 跳过   [x] 以后不再问

[2] 3 篇页面未过门禁
    .qdoc/_staging/rejected/2026-11-13/
    [l] 看列表   [s] 跳过

> 
```

- 非交互环境（CI、无 tty）自动退化成 `ow review --list`，只打印不等待。
- `[x] 以后不再问` 写进 `.ow/policy.json`，同类事项以后直接放行（可撤销：`ow review --reset`）。

### 11.3b 实现后的三处修正（2026-11-13）

**① 队列文件不能用「毫秒时间戳 + kind」命名**

原设计 `.<ts>-<kind>.json`。实测批量入队时**同一毫秒内的同类条目会撞名**，
后写的静默覆盖先写的——队列里看着有 2 条，实际只剩 1 条。加了随机后缀：

```ts
const uniq = Math.random().toString(36).slice(2, 8);
return `${ts}-${safeKind}-${uniq}.json`;
```

**② 推技能的「防线」必须查策略，否则用户按了 `[x]` 也不生效**

原实现只在「会不会覆盖」上判断，没查 `.ow/policy.json`。用户按过
「以后不再问」，下次还是照样入队。补上 `isAllowed` 查询后：

```
⚠ karpathy-guidelines：会覆盖线上 v1，已入队待确认（ow review）   ← 首次
→ karpathy-guidelines：已放行（曾选「不再问」），直接覆盖          ← 放行后
```

**③ 无 `--yes` 时**根本不该推**，而不是「推完记一笔**

这是最重要的一条。原设计是「推送后进 pending 提示」，但**覆盖线上是不可回滚的**，
推完再提示等于已经晚了。改成：

| 情况 | 行为 |
|---|---|
| 平台没有同名技能 | 直接 `import_skill_from_files`（无副作用） |
| 平台有、内容一致 | `unchanged`，不调平台 |
| 平台有、内容不同、**无 `--yes`** | **不推**，入队等确认 |
| 平台有、内容不同、有 `--yes` | 真推 |
| 平台有、内容不同、已放行 | 真推 |

实测验证：改一行本地内容后 `ow sync --direction push`（无 `--yes`）→
输出 `⚠ 会覆盖线上 v1，已入队待确认`，`ow review --list` 能看到这条，
加 `--yes` 才真的推到 v2。

**另外补上了前门技能 `agent-skills/qdoc/`**（4 文件 / 7.5KB，可推送）：
唤醒词表、唤醒后先跑 `ow status --json` 的播报规则、四条硬性规则
（必须调 CLI / 不自动发布 / 不替用户确认 / 查不到就说查不到）、命令速查、
四个常见情况的解释。三个 references：`capture.md`（信号门与窗口）、
`query.md`（短语精确匹配与降级）、`maintain.md`（目录与冲突处理）。

### 11.3c 技能晋升与模板（2026-11-13 实现记录）

**`promoter/scan.ts` + `promoter/package.ts` + `ow promote`** 落地了 §3.10 的三道门槛：

| 门槛 | 判定 | 实测 |
|---|---|---|
| lineage ≥2 | `sources` 里不同会话 id 数 | 同会话多段只算一次 |
| 引用 ≥3 | 全库 wikilink 指向该标题的次数 | 先建计数表，O(n) |
| 可执行 | 有「怎么做/验证」标题或有序列表 | 中英文都认 |

**又抓到一个静默失效**：`vault/frontmatter.ts` 只支持行内列表 `tags: [a, b]`，
**不支持多行 `- item` 写法**。而多行写法是 `sources` 的自然形态：

```yaml
sources:
  - dsh/session-abc/第 1-30 轮
  - dsh/session-def/第 5-12 轮
```

结果 `sources` 被解析成空字符串 → lineage 永远是 0 → **晋升功能完全不工作且不报错**。
已改成两种写法都支持。这个 bug 影响面比晋升更广：任何用多行列表的 frontmatter
字段（`tags` / `sources` / 自定义字段）都读不到。

**技能名保留中文**：初版把纯中文标题转成 `skill-bn14b9`，在 `ow sync` 列表里认不出
是哪个。改成保留中文（平台允许 Unicode），只把非字母数字换连字符。

**模板外置**：`templates/vault/` 下 5 个文件（`index.md` / `log.md` / `hot.md` /
`AGENTS.md` / `gitignore`），`init.ts` 用 `{{UPDATED_AT}}` `{{PROJECT_ROOT}}`
占位符替换。占位符而不是写死日期，是为了让模板文件能干净地进 git。
`AGENTS.md` 从 8 行扩到 63 行——它是编译器唯一的风格约束入口，写细一点收益最大。

### 11.3d 接入验证记录（2026-11-13）

真机跑了一遍「装上去能不能用」，抓到 5 个只有实跑才会暴露的问题。

**① 插件根本没被加载（最严重）**

三条 profile 的 `package.json` 都写着：

```json
"dsh-autoskill": "link:/Users/chenmingyao/Documents/cmy-only/AutoSkill/packages/adapter-dsh"
```

仓库早就改名成 `AutoSkill4Personal`，旧路径不存在 → 软链全断 → **dsh 里根本
没有这个插件**，而 dsh 启动不报错，只是安静地少了功能。已修 3 处配置 + 3 条软链。

**② profile patch 引用不存在的 entry**

`cordis.patch.yml` 里有 `- id: autoskill-compaction`，但插件只提供
`autoskill` 和 `autoskill-assemble-timer`。dsh 会警告
`patch: entry "autoskill-compaction" not found`。这是旧架构（替换内置压缩引擎）
的残留，现在知识抢救走插件自己注册的 provider。已删。

**③ `readSessionLines` 传目录就崩**

dsh v4 落盘是**目录**：`<session-id>/session.v4.jsonl.zstd`。
`ow capture --session <path>` 传目录（从 Finder 复制的自然形态）直接
`EISDIR`。加了 `resolveSessionFile()`：目录 → 找内部标准命名文件 → 兜底取唯一
`.jsonl*` → 都没有就报清楚的错。

**④ `mkdirp` 只建父级，两级路径必崩**

```ts
function mkdirp(dir) {
  const parent = dirname(dir);
  if (existsSync(parent)) return;   // ← ~/.config 存在就直接返回
  ...
}
```

紧接着 `mkdirSync(dir)` 抢锁 → 对 `~/.config/qdoc` 抛 ENOENT。
**新机器第一次用必然崩**，而且报的是 `machine.lock` 的错，看不出是父目录问题。
改成 `mkdirSync(dirname(dir), { recursive: true })`。

**⑤ `turn/end` reason 是 `error` 的空轮被计入**

实测模型凭据缺失时：`{kind:"error", error:{code:"MISSING_CREDENTIAL"}}`，
这一轮只有用户消息、没有产出。原来只过滤 `aborted`，于是水位虚涨——
用户重试时发现「没聊几句却说编译过了」。改成判据是**有没有产出**
（`assistant/message` 或 `tool/call`），而不是 reason 种类。

**验证到的正向结论**

| 项 | 结果 |
|---|---|
| dsh 插件导入 | ✓ 导出 `apply` / `inject` / `name`，48ms |
| pi 扩展导入 | ✓ 38ms，全部 core 依赖链完整 |
| `--dump-config` 装配 | ✓ 无警告 |
| 32 轮会话触发链路 | ✓ 闸门全过 → 信号门过 → 走到 LLM 调用（只差凭据） |
| `source.kind` 过滤 | ✓ 19 事件里正确挑出 1 条真用户消息 |
| 模型跟随会话 | ✓ 读到 `svc/glm-5.3-flash` / `rootcloud` |

pi 侧的 `skills` 路径也从 `../../skills` 改成了 `../../agent-skills`（目录已改名）。

### 11.3e 首个真实端到端（2026-11-13 17:50）

**跑通了**：真实会话 → 编译 → 发布 → 查询。

```
$ ow capture --turns 1 --max-windows 1
编译完成：1 个窗口，产出 2 页（模型 svc/glm-5.3-flash）
  第 1–1 轮：新增 2、更新 0、跳过 2

$ ow publish
＋ references/qdoc-mcp-tool-surface.md → created (id=24)
＋ skills/mcp-streamable-http-probe.md → created (id=25)

$ ow query "Streamable"
命中 1 篇  →  来源：dsh / session-a3cea5a8… / 第 1-1 轮
```

期间又抓到一个**必然复发**的解析 bug：

**代码围栏把 JSON 从中间截断**

`extractJsonFromText` 用的是非贪婪匹配：

```ts
t.match(/```(?:json)?\s*([\s\S]*?)```/)
```

它停在**第一个**闭合围栏。而模型生成的页面正文里本来就可能含 ```js 代码块
（探针那页就有一大段 SSE 解析代码）——于是 JSON 被从中间截断，报
「不是合法 JSON」，看着像模型不会写 JSON，实际是提取器的问题。

改成 `extractJsonCandidates()` 返回**多个候选**，逐个试解析：

| 候选 | 来源 | 本次实测 |
|---|---|---|
| 0 | 整段原样 | ✗ 4953 字，含围栏 |
| 1 | 首个 `{` 到末个 `}` | **✓ 4941 字，可解析** |
| 2 | 首个围栏内容 | ✗ 3112 字，被内层围栏截断 |

JSON 由花括号定界，内层的反引号不影响它——所以候选 1 才是正解。

**另外两处加固**

- **`finish_reason` 检查**：原来完全不看，被 `max_tokens` 截断时把半截内容
  当完整结果返回，下游 JSON.parse 报「不是合法 JSON」，同样误导。现在
  `finish_reason=length` 直接报「输出被截断，调大 maxTokens」。
- **JSON 修复**：模型把 markdown 塞进 JSON 字符串时，常见两种破坏是裸换行和
  未转义引号。加了状态机扫描的 `repairJson()`，只做这两件确定性的事。

**dsh 凭据的真实写法**

`llm-pi-ai` 的 provider 只有 `apiKeyEnv`（schema 标 `credential-ref`），
**没有内联 `apiKey`**——pi 的 `models.json` 能内联，dsh 不行。
而 `apiKeyEnv` 指的是**进程环境变量**，不是 `~/.dsh/.credentials.yaml` 的
`refs` 段。所以：

```bash
export ROOTCLOUD_API_KEY=$(... ~/.dsh/.credentials.yaml 的 refs.ROOTCLOUD_API_KEY)
dsh --profile headless "..."
```

**技能安装**

`agent-skills/{qdoc,ow-compiler}` 复制到 `~/.dsh/skills/` 后，dsh 技能列表
从 53 增到 55，两个都在。pi 侧走 `packages/adapter-pi/package.json` 的
`pi.skills: ["../../agent-skills"]`。

### 11.3f 旧 autoskill 架构的清除（2026-11-13 18:05）

接入时发现 dsh 插件里还留着**旧架构的残留**，与它无关的新链路混在一起。清掉了：

| 残留 | 旧职责 | 处理 |
|---|---|---|
| `autoskillProvider` | 从 `atoms.jsonl` 派生「知识主题技能」，rank 50 | **删**。新方案技能来源是 `agent-skills/` + 平台同步，不需要进程内 provider |
| `assemble-timer.ts` | `atoms.jsonl` → `cards/` 定时组装 | **删**。整条 atoms 链路都不在新方案里 |
| `~/.dsh/data/autoskill/` | 282 条 atoms + errors.log（400K，11-09 起停更） | **删** |
| `~/.pi/agent/skills/{autoskill*,agent-knowledge-capture,knowledge-extraction}` | 6 个旧技能目录 | **删** |
| `skill-provider.ts` | provider 实现（280 行） | **删**（随 provider 一起） |

删除前已备份到 `.tmp-old-autoskill-bak/`（460K）。

**为什么这是必须做的**：不删的话 dsh 技能列表里有 55 个条目，其中 3 个是
`autoskill*` 旧主题技能，和 `qdoc` / `ow-compiler` 混在一起，用户根本分不清
哪个是新链路。清完是 14 个。

**连带修掉的三处**

1. `packages/adapter-dsh/package.json` 的 `exports` 还导出 `./assemble-timer`
2. `cordis.patch.yml` 还插入 `autoskill-assemble-timer`（profile patch 里也有一条）
3. `test/smoke-dsh.ts` 还 import 已删的 `skill-provider.ts`

smoke 测试重写为锁**新架构真正依赖**的三件事：插件形状（`inject` 只声明 `llm`）、
会话路径解析、`ctx.llm` 桥。30 条断言。

**装技能改用脚本**

原来靠手工 `cp -R`，问题是装完不知道装的是哪个版本，改完仓库忘了重装、宿主
跑的还是旧代码。新增 `scripts/install-skill.ts`：

```bash
npm run install-skill    # 装到 ~/.dsh/skills 与 ~/.pi/agent/skills
npm run check-skill      # 只比对，退出码 1 表示有漂移
```

它打印每个技能的内容哈希，两边一致才算装好。

### 11.3g 实现与方案的差异核对（2026-11-13 18:40）

逐节核对 §3–§16 与代码，结论分三类。

#### 一致（逐项验过）

| 契约/规则 | 位置 | 状态 |
|---|---|---|
| `window.json` 字段与 120k 字符 / 工具结果 2k 截断 | §4 | ✓ |
| `compile-report.json` | §4 | ✓（`cost` 改名 `usage`，语义同） |
| `.ow/state.json` 水位线按 `<agent>:<sessionId>` | §4 | ✓ |
| `machine.json` 预算 `by_vault` | §4 | ✓（锁独立成目录，实现更清晰） |
| `.ow/lock` + `~/.config/qdoc/machine.lock` 两级锁 | §5.6 | ✓ |
| 7 道门禁 + 阈值（1MB / 0.45 / 0.7 / 200 字） | §12 | ✓ |
| 入队 7 条件（含 90s 空闲、防自触发、机器级锁） | §5.4 | ✓ |
| 尾部结算 `TAIL_MIN_TURNS=5` | §5.7 | ✓ |
| `source.kind == "user"` 过滤（bug 1 的修法） | §5.8 | ✓ |
| 水位线记 `seq` 而非 sources 覆盖（bug 2 的修法） | §5.8 | ✓ |
| 唤醒词判定（句首 + 独立成词 + 跟动词） | §6.2 | ✓ |
| `ow capture` 无凭据落 `capture.json`、同会话覆盖 | §6.4b | ✓ |
| `ow:meta` HTML 注释保 provenance | §10.9 | ✓（字段比方案多 agent/session/turns/hash） |
| 四个送达通道（文件 / review / 播报 / 通知） | §11.2 | ✓ |
| `pending/<ts>-<kind>.json` 格式 | §11.4 | ✓（加随机后缀防同毫秒碰撞） |
| 10 个 CLI 命令 | §10.7 | ✓ |

#### 差异：代码缺（真缺口，按严重度排）

| # | 方案要求 | 现状 | 影响 |
|---|---|---|---|
| 1 | 版本冲突 → 三方合并（§9.3、§10.6） | `publish.ts` 直接 `updateDocument`，冲突即抛错；`conflict.ts` 只被 `status.ts` 用来「显示」 | **多设备推同一篇必失败**，且没有 `.publish/base/` 快照可合并 |
| 2 | `.publish/base/<doc_id>.md` 快照（§4、§10.6） | 未落盘 | 三方合并的前提没有，冲突时无 base |
| 3 | `metrics.jsonl` 埋点（§13） | 只有注释提到，无写入 | 触发/编译/发布/质量四类指标全无，调参靠猜 |
| 4 | 每窗口 ≤60k 输入 token（§13） | 只有 120k **字符**上限，无 token 估算 | 中文 120k 字符≈60–80k token，可能超；且中文/英文比例不同，字符数不能等价 |
| 5 | 设备标识 `ow:origin` 标签 + `updated_by`（§10.6） | 未实现 | 多设备时不知道谁改的 |
| 6 | `ow sync --prune`（§10.7） | 未实现 | 平台禁用后本地残留 |
| 7 | `ow doctor`（§10.12①） | 未实现 | token 权限 600 与被 git 跟踪无法自查 |
| 8 | `--read-only`（§10.12①） | 未实现 | 只读机器没有约定入口 |
| 9 | 拉技能限流 200ms/个 + 大小保护（>200 文件 / >20MB，§10.5） | 未实现 | `motion-showreel` 114 文件 / 787KB 已接近；无保护有爆内存风险 |
| 10 | 每天 03:00 全量 `--check` 调度（§16 已定⑮） | 只写在注释，无调度器 | 内容更新不会自动发现，得手动 `--check` |
| 11 | `pending_enable` **轮询**自愈（§16 已定⑭） | `healPendingEnable` 只在手动 `pull` 时调 | 不 pull 就一直显示「待启用」 |
| 12 | kill switch（P4） | 未实现 | 出问题无法一键停 |
| 13 | 评测集、hub vault（P4） | 未实现 | P4 尚未开始，属正常 |
| 14 | `ow query` **本地优先**再兜底平台（§10.10、§10.2） | **已修**：本地命中 ≥2 直接返回，<2 才查平台；加 `--platform` 强制两边都查 | — |
| 15 | 正文加一行 `> Compiled from agent session …`（§9.4） | 未实现 | 平台页面上看不出这段知识来自哪次会话（meta 注释不可见） |
| 16 | 文末生成 `## Related` 纯文本清单（§9.4） | `rewriteWikilinks` 只把 `[[x]]` 降级成纯文本，不生成清单 | 平台上页面之间的关联信息丢失 |
| 17 | 技能「30 分钟轻量检查」（§10.2） | 只写在注释，无调度器 | 新增/禁用技能不会自动发现 |
| 18 | `valid_from`、`updated_by` 进 meta 注释（§9.4、§10.9） | 未实现 | 多设备时不知道谁改的、何时改的 |
| 19 | 手动入口**跳过信号门**（§6.5） | **已修**：`planWindows` 加 `manual` 选项 → `forced` 标记；`signal` 仍记真实判定供 `--plan` 展示。`ow capture --auto` 可回到自动判定 | — |
| 20 | 报告记 `trigger: manual`（§6.5） | **已修**：`CompileReport.trigger` + `WritePagesOptions.trigger` | — |

#### 差异：代码多（实现比方案好，方案应更新）

| 实现 | 方案 | 说明 |
|---|---|---|
| `dsh inject = ["llm"]` | §5.2 写 `["skills","llm"]` | provider 已删，`skills` 不再需要。**已改方案** |
| 待确认队列文件名加随机后缀 | §11.4 只写 `<ts>-<kind>` | 同毫秒同 kind 会覆盖，加后缀修掉 |
| `compile-report` 用 `usage` 而非 `cost` | §4 写 `cost` | 与 `ChatUsage` 命名统一 |
| 门禁隐私扫描复用 `security/secrets.ts` | §12 列了规则但没说要共享 | 单一真相源，避免两套正则漂移 |
| `diverged` 动作（本地改 + 平台未改） | §10.5 没列这个状态 | 原实现误报 `unchanged`，是 bug |
| 唤醒词支持 `小Q`/`QDoc`/`QDOC` 变体 | §6.2 只写 `qdoc`/`小q` | 大小写不该影响识别 |

#### 差异：pi 与 dsh 不对称（需决策）

`packages/adapter-pi/knowledge-capture.ts:161` 仍调 `maybeRunPipeline`——**旧的 atoms 抽取管线**。dsh 侧已随旧架构删除，pi 侧还在跑。

后果：pi 会继续往 `~/.pi/agent/data/autoskill/knowledge/atoms.jsonl` 写旧格式数据，而 dsh 不写了。两条产物线一条活一条死，`kb-status` 之类的旧命令读到的数据会越来越偏。

**这是必须二选一的**：要么 pi 侧也删掉（与 dsh 一致），要么明确「pi 保留旧管线」的理由。按「旧 autoskill 完全摒弃」的决定，应当删。

#### 本次修掉的 3 项

**① 手动触发被信号门误拒（最违背直觉）**

用户说「小q 沉淀」，`planWindows` 却照样跑 `evaluateSignal`——纯检索、短闲聊
会被判 `keep: false`，用户明确要记的东西反而被拒。

修法：`CaptureOptions.manual` → `PlannedWindow.forced`。`signal` **仍然记真实判定**
（`--plan` 能看到「这段本来会被 short-chatter 拦下，因为你是手动触发才编的」），
只是决策改成 `keep || forced`。`ow capture --auto` 保留自动判定。

**② `ow query` 不查本地**

`query.ts` 直接打平台，本地明明有这一页也得走网络，断网就查不到。

修法：先 `scanPages` 在 title/summary/tags 里打分（title 权重 3、tag 2、summary 1），
命中 ≥2 篇直接返回，不花网络；<2 才 `search_documents` 兜底。`--platform` 强制两边都查。
输出标 `[local]` / 平台命中数，来源一眼可辨。

**③ 报告不记触发来源**

`compile-report.json` 没有 `trigger` 字段，事后分不清哪页是自动编的、哪页是用户点名要的。
补 `trigger: "auto" | "manual"`，由 `runCapture` 按 `manual` 传入。

新增 8 条断言（`capture.test.ts`）：自动/手动两条路径下 `keep` / `forced` 的组合，
以及「纯闲聊会话在手动触发时确实入队」。

### 11.4 pending 队列格式

agent 只写文件，不等人：

```json
// .ow/pending/<ts>-<kind>.json
{"kind":"skill-overwrite","created_at":"2026-11-13T14:50:00+08:00",
 "severity":"high","title":"技能推送会覆盖线上",
 "detail":{"skill":"qdoc","skill_id":"896a…","from":3,"to":4,
           "files":7,"diff_summary":"+2 段，-1 段"},
 "action":{"cli":"ow sync skill push qdoc --yes","reversible":false}}
```

`ow status` 读这个目录，把条数放进输出（§10.7 的「待确认 2 项」）。

### 11.5 前门技能怎么播报

`agent-skills/qdoc/SKILL.md` 里写死一条规则：

```
每次被唤醒（用户喊 小q / qdoc）时：
1. 先跑 ow status --json
2. 若 pending > 0，用一行带过：「另有 2 项待确认，说 小q 确认 可以处理」
3. 不展开、不主动追问——用户没问就不说细节
```

这样**「后台产生的问题」由「前门技能」送达**——技能就在 agent 里，这是唯一能自然触达用户的通道。

### 11.6 桌面通知（可选）

macOS 用 `terminal-notifier`，Linux 用 `notify-send`，默认关闭，`config.notify = true` 才开。

- **每天最多 3 条**，超出的合并成一条摘要。
- 只报 `severity: high`（覆盖线上技能、预算超限、连续 3 次编译失败）。
- 点通知不打开任何东西——只是提醒你去跑 `ow review`。

### 11.7 明确不做

| 不做 | 理由 |
|---|---|
| 阻塞等待用户确认 | 触发在 agent 进程内，阻塞就等于卡住对话 |
| 往 agent 会话注入消息 | 依赖 Web Session controller，headless 挂不上 |
| GUI / 托盘应用 | 维护成本远超收益 |
| 每条 agent 回答后弹提示 | 骚扰；只在用户主动喊时播报 |
| 自动重试失败项 | 失败通常要人改内容，重试只是重复失败 |

## 12. 质量门（替代平台 draft）

发布前本地门禁，**任一失败即不发布**：

| 门 | 规则 |
|---|---|
| 结构 | 必需 frontmatter 齐全；`title/summary` 非空 |
| 体积 | 正文 ≤1MB |
| 隐私 | `visibility/pii` 命中即拒；`sk-`/`ghp_`/`AKIA`/私钥/`password=` 即拒 |
| 质量 | `base_confidence ≥ 0.45`；`^[inferred]` 占比 ≤0.7；`lifecycle ∉ {archived, disputed}` |
| 去重 | 同 slug 只能有一篇 active；账本冲突 → 拒绝并告警 |
| 完整性 | 渲染后无残留 `[[`、无绝对路径、无 `TODO` |
| 变更 | content_sha 与账本一致 → 跳过 |

未过门禁的页面进 `.qdoc/_staging/rejected/<date>/` 并附原因；改完把 `publish_status` 置回 `pending` 重试。

## 13. 观测与成本

指标（`metrics.jsonl` + 每日摘要）：触发（会话数/窗口数/跳过原因）、编译（页数/窗口、deferred、token、耗时、失败率）、发布（成功/跳过/拒绝/冲突、doc 总数）、质量（重复标题、墓碑数、人工驳回数）。

预算：每窗口 ≤60k 输入 token、≤8 页；每日 ≤50 窗口、≤200k token；超限暂停并告警。

**成本归属**（§3.1）：编译烧的是**该 agent 自己凭据**下的钱，和用户手动聊混在同一张账单上，平台侧分不出来。所以预算只能是**本地计数**（`metrics.jsonl` 累计 `usage.input_tokens`/`output_tokens`），不是账单核对。

**两条链路两套账单**：dsh 的编译记 DeepSeek 账号，pi 的记 pi 的 provider。`.ow/state.json` 的 `budget` 是**按 vault 合并计**的——同一个 `.qdoc/` 被两个 agent 写，预算也该合在一起算。

## 14. 里程碑

| 阶段 | 内容 | 工期 | 验收 |
|---|---|---|---|
| P0 | 探针：**cordis 插件能调 `ctx.llm` 并写文件**（`~/.dsh/profiles/headless` 的 bundle 路径要先修好）；zstd 增量解析；pi extension 能走 `models.json`；`.qdoc/` 自动初始化。平台侧已实测（10 工具、可枚举文档、正文可读、tags 可传） | 1 天 | 4 项有结论；不产生垃圾文档 |
| P1 | adapter-dsh（cordis 插件）+ 编译内核 + `.qdoc/` + **vault 级文件锁**；`--turns 2` 复测 | 3–4 天 | 本会话触发 ≥2 次；轮数与真用户消息数一致（不被注入消息虚高）；≤8 页/窗口；两进程并发时锁生效 |
| P2 | publisher + 门禁 + 账本 + qdoc 发布 | 2–3 天 | 首篇发布成功；二次走 update；冲突可三方合并 |
| P2.5 | **前门**：`ow capture` + `qdoc` 前门技能（唤醒词 + 路由 + 报能力） | 2 天 | 喊 `小q` 能报能力；`小q 记一下` 落草稿；`小q 沉淀` 出页并发布 |
| P3 | adapter-pi（extension）；技能毕业 + 推送 | 3–5 天 | pi 可触发（逐轮，无滞后）；1 个技能上线；重启后水位线不丢（存 vault 不存进程） |
| P3.5 | **知识中心**：`ow query`（本地+平台）、技能 push/pull 全量分批、`ow review` + pending 队列 | 2–3 天 | 新机器拉全部技能即用；跨项目查能命中平台；覆盖线上技能必须先过 `ow review` |
| P4 | 加固：脱敏、墓碑、预算、评测集、hub vault | 1 周 | 红队 0 泄漏；kill switch 生效 |

## 15. 风险

| 风险 | 概率 | 对策 |
|---|---|---|
| 同项目多 agent 会话抢写同一 vault | 高 | **vault 级文件锁**（§5.6）；编译器全局并发 1；锁 30 分钟过期回收 |
| 宿主 API 变动要重装适配 | 中 | 两份适配（cordis / pi extension）各自跟；`core` 不变 |
| 装插件后要重启 agent 才生效 | 中 | 安装文档写明；升级检查放 `ow status` |
| cordis 插件拿不到 `ctx.llm` | 中 | P0 先验；退化：技能文本内联进 prompt（≤20KB）+ 报错进 `errors.log` |
| 两个 agent 进程同时编译 | 高 | vault 级文件锁 + 30 分钟死锁回收（§5.6） |
| zstd 会话非纯追加 | 低 | 按 `seq` 去重而非字节偏移 |
| 每 30 轮产出噪声页 | 高 | 信号门 + 8 页上限 + 每周 dedup + confidence≥0.45 |
| 手动入口与自动编译并发写坏 index | 中 | 统一走 `memory sync` + vault 级文件锁 |
| 无 delete 导致垃圾累积 | 高 | 门禁 + 墓碑约定 + 首篇真实内容验证；不做试探写入 |
| 隐私泄漏 | 中 | 正则 + `visibility/pii` 拒绝 + 默认不发原始会话 |
| 成本失控 | 中 | 窗口/日预算（本地计数）+ `max_tokens_per_window` 硬限；模型跟着 agent 走，省不了（§3.1） |
| 编译与用户会话抢同一账号额度 | 中 | 同进程同凭据，无法区分；只能本地计数 + `max_tokens_per_window` |
| 技能覆盖线上无人知 | 中 | 只有这一类不可回滚；默认 `--dry-run` + `.ow/pending/` + `ow review`（§11） |
| 待确认项没人看 | 中 | 前门技能每次被唤醒播报一行；`ow status` 常显条数 |
| **技能推送直接改线上** | 中 | `source='MCP'` 的技能第二次 update 直接生效；默认 `--dry-run`，人工确认 |
| **50 文件/2MB 上限** | 中 | 自产技能控制文件数（`references/` 按主题合并）；超限报错不静默截断 |
| 平台正文丢 provenance | 高 | 塞进正文 `<!-- ow:meta -->` 注释（§10.9）；未验证 qdoc 渲染器是否剥掉注释 |
| 在线查依赖网络 | 中 | 断网只查本地；`ow query` 明确标「仅本地结果」 |
| token 泄漏 | 中 | 三级查找 + 文件 600 + `.gitignore` + `ow doctor` 检查；不进仓库 |
| 推完技能卡在「未启用」 | 高 | `pending_enable` 标记 + `ow sync status` 常显 + 7 天进 pending（§10.5） |
| 平台禁用技能后本机不知道 | 中 | `list_available_skills` 只含已启用；人工 `--prune`，无自动发现 |
| 一个 token 通所有项目 | 中 | 平台无 namespace；`allow_push=false` 只是约定，不是强制 |

## 16. 已定 / 待确认

**已定**：① 30 个已完成轮次；② vault 固定 `.qdoc/`；③ 平台按 **10 工具**（`list_documents` 可枚举、正文可读、tags 可传）；④ 无 draft，本地门禁；⑤ 无 delete，只做墓碑；⑥ 仓库侧技能目录 `agent-skills/`；⑦ **手动入口并入同一 Compiler**；⑧ 手动入口用**单一唤醒词前门**（`qdoc`/`小q`），不装 9 个独立技能；⑨ **多 agent 同机各自内嵌**，串行靠 **vault 级文件锁**（没有单实例了）；⑩ **平台是统一知识中心**：文档只推不拉、在线查；技能全量分批双向（§10）；⑪ **provenance 塞进正文 `<!-- ow:meta -->` 注释**（§10.9）；⑫ **后台流程不弹窗**，不可回滚动作走 `ow review` + 前门技能播报（§11）；⑬ **token 三级查找**（env → 项目 → `~/.config/qdoc/token`），一 token 通所有项目（§10.12①）；⑭ **技能首次推送后需人工启用**，本机靠 `pending_enable` + 轮询自愈（§10.5）；⑮ **每天 03:00 全量 `--check`**（实测 3.7s / 1.27MB），内容更新 ≤24 小时发现（§10.12③）；⑯ **Compiler 在 agent 进程内**，用该 agent 自己的模型（dsh→`ctx.llm`，pi→`models.json`），不另配、不起新进程（§3.1）；⑰ **触发形态翻回内嵌**（dsh cordis 插件 + pi extension），外置结论作废（§5.1）。

**待确认**
1. **首篇发布内容**：建议用本方案自身一页真实知识验证端到端，不用探针文档。
2. **唤醒词定哪个**：`qdoc` 精确但和平台同名、易误触发；`小q` 不容易误触发但中文输入成本略高。默认两者都认，句首判定（§6.2）。
3. **前门先开几个动作**：默认开「记/沉淀/提升/查/状态」5 个，体检/去重/打包按需——还是一上来就全开？
4. **`.qdoc/` 与项目 git**：默认页面提交、`.ow/` 与 `_raw/` 忽略；是否整目录忽略？
5. **`<!-- ow:meta -->` 会不会被渲染器剥掉**：首个真实发布后回读确认；剥了就退回可见的「元数据」小节。
6. **待确认项要不要主动推送**：默认只在 `小q` 被唤醒时播报一行。要不要加桌面通知（默认关）？
7. **每日全量 check 的时间**：默认 03:00。要不要跟用户活跃时段错开（比如 04:00）？技能多了以后是否改回每周？
8. **要不要 `backend = "none"`**：完全不自动编译，只排队等用户喊 `小q 沉淀`。省 token，但自动沉淀就没了。
9. **要不要多 token 分权**：平台目前一个 token 全权。若以后支持 scope，`allow_push=false` 可以变成真的只读。
10. **上游 Python 脚本怎么处理**：重写成 TS（推荐，可控）还是留子进程（快，但多一个运行时依赖）？

### 16.1 连带影响：语言必须翻回 TS

内嵌的决定会连带推翻「实现语言 = Python」这条：

| | Python（原定） | **TS（现在必须）** |
|---|---|---|
| 能装进 cordis 插件 | ❌ | ✅ |
| 能装进 pi extension | ❌ | ✅ |
| 能调 `ctx.llm` | ❌ 跨进程拿不到 | ✅ 同进程 |
| 复用上游 obsidian-wiki Python 模块 | ✅ 直接 import | ⚠️ 要么重写，要么调子进程 |

仓库现在就是 TS monorepo（`packages/core` + `packages/adapter-*`，`"type": "module"`，无任何 `.py`）。所以内嵌 = **回到仓库原生形态**，不是额外负担。

代价：上游 `obsidian-wiki` 的确定性脚本（`scripts/manifest.py` 等）不能直接 import。两条路：

1. **重写成 TS**（推荐）——那些脚本逻辑不复杂（frontmatter 解析、manifest 读写、wikilink 生成），重写可控。
2. **调子进程**——保留 Python 脚本，TS 侧 `execFileSync` 调。缺点是多一个运行时依赖，且 `--no-home` 那类坑会重现。

`design/FILE_MANIFEST_2026-11-13.md` 已重排为 **v2.0（TS 版）**，路径全部改为 `packages/**/*.ts`。

## 附录 A. agent 接入方式（dsh / pi）

**统一形态：各 agent 内嵌，编译用各自的模型闭环。** 三个接触点：

| | dsh | pi |
|---|---|---|
| ① 读会话 | `~/.dsh/sessions/<cwd>/<sid>/session.v4.jsonl.zstd`，zstd 追加流，数 `turn/end` | `~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl`，明文，数 `user` 消息 |
| ② 跑编译 | **进程内调 `ctx.llm`**，不 spawn（§3.1） | **进程内走 `models.json`** |
| ③ 装技能 | `~/.dsh/skills/` | `~/.pi/agent/skills/` |
| ④ 触发 | 定时器轮询 mtime（约 120s） | `before_agent_start` 逐轮 |

实测补充：
- dsh 同目录混有 subagent 会话（`origin:"subagent"`, `delegationDepth:1`），也产生 `turn/end`，**必须过滤**。
- dsh 首行是 `session` 头（含 `cwd`/`parentSession`/`agentPreset`），据此判定 cwd 与是否子会话，不必解析目录名。
- 防自触发：编译器会话 cwd 在 `.qdoc/` 内 → 按「cwd 在 vault 内即跳过」排除。

上游 40 个技能哪些用、哪些不用，见 §7。
