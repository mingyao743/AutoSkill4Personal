# 知识提取方案 V2：对话记录 → 单点信息 → 知识（在线为主·精简版）

> 本文档取代 V1（KNOWLEDGE_EXTRACTION_PLAN.md，保留作存档）。
> V2 = V1 的骨架（atom-first + 窗口切分 + 5类切片）+ 本轮讨论确定的全部精简决策。
> 核心变化：**以在线采集为主、离线降级为手动工具；抽取引擎复用已配置主模型的一次性调用（不再依赖便宜模型）；存储压成单文件原子池。**
> 状态（2026-10-20）：P0/P1/P2 及增量整合层已全部实现并实测验证。存量：4 session → 987 原子 → 44 卡 → 10 skill；增量链路（无锁提案队列+自愈）端到端实测通过：新原子→提案→应用幂等、过期提案自愈、会话启动注入提示实测命中。并发采用方案 1（无锁队列），cards 保留。

---

## 一、方案总览

```
┌────────────────────────────────────────────────────────────────┐
│ 触发层（谁发起抽取）                                             │
│                                                                │
│  agent 可感知时机（system prompt + 工具）                        │
│  ├─ capture_knowledge   刚得出可复用结论，主动声明               │
│  └─ kb_harvest          用户告别/任务收尾，调用终采工具           │
│                                                                │
│  agent 感知不到的时机（extension 事件钩子，保确定性）             │
│  ├─ session_before_compact   compaction 抢救（不可逆，最高价值） │
│  └─ session_shutdown(quit)    spawn 独立进程跑终采 CLI           │
│                                                                │
│  没有宿主的场景                                                │
│  └─ 历史回填                  手动跑 extract.ts CLI             │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ 抽取引擎（与触发源解耦，所有入口共用）                            │
│                                                                │
│  session 消息 → 内存切窗(user msg对齐) → 注入SLICE_CATALOG的     │
│  抽取prompt → 独立一次性LLM调用(复用settings.json的主模型)       │
│  → ajv结构校验 + catalog枚举校验 + sources必填 → atoms.jsonl     │
└──────────────────────────────┬─────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────┐
│ 加工与消费                                                      │
│                                                                │
│  atoms.jsonl (status: draft→published)                          │
│    → review（/kb-review 打印 + 手动改 status）                  │
│    → P1 组装: LLM判重合并 → cards/<category>/<domain>/*.md      │
│    → P2 打包: domains → ~/.pi/agent/skills/<name>/SKILL.md      │
└────────────────────────────────────────────────────────────────┘
```

三层不变：**对话记录 → 原子（atom-first）→ 卡片/体系（可重建视图）**。

---

## 二、触发体系（V2 的核心重构）

### 2.1 触发矩阵

| 触发 | agent 能否感知 | 机制 | 产物 |
|---|---|---|---|
| 刚得出可复用结论 | ✅ | `capture_knowledge` 工具，promptGuidelines 引导 | draft, confidence 0.8 |
| 用户告别 / 任务收尾 | ✅ | `kb_harvest` 工具 + guideline 一句话 | draft, confidence 0.6 |
| compaction 发生前 | ❌（两轮之间的内核事件） | `session_before_compact` 钩子 | **published**, confidence 0.7 |
| 真正 quit 时 | ❌（退出不经过模型） | `session_shutdown(quit)` → detached spawn CLI | draft, confidence 0.6 |
| 历史老会话 | 无宿主 | 手动 `extract.ts <session文件>` | draft, confidence 0.6 |

**分工逻辑**：system prompt 管"agent 知道的时候主动做"（精准、即时），事件钩子管"agent 不知道的时候兜底做"（确定性、全覆盖）。两者互补，缺一则出现覆盖盲区：

- 只有 system prompt → 依赖 agent 自觉 + 用户碰巧说告别语，覆盖率是概率性的
- 只有事件钩子 → 会话进行中零捕获，agent 的富上下文被浪费

### 2.2 compaction 抢救（不可逆防线，P0 最高价值）

`session_before_compact` 给出 `preparation.messagesToSummarize`（压缩前的完整消息）。动作：

1. `messagesToSummarize` 直接当一个现成窗口（无需切窗）
2. 序列化（`serializeConversation(convertToLlm(...))`，工具结果自动截断 2000 字符）→ 喂抽取引擎
3. 抽到的原子 `status=published, confidence=0.7` 直接入池（上下文完整、质量高）
4. 自定义 compaction summary：`previousSummary + "\n\n## 已沉淀原子\n" + 原子索引`，`details` 存 atom ids——后续会话可从 summary 看到"这段对话已沉淀为什么"
5. 然后才放行 compaction

### 2.3 quit 终采

`session_shutdown(reason="quit")` → `spawn(node, [extract CLI, 当前session文件], {detached:true}).unref()`——抽取在 pi 退出后继续跑，进程退出杀不掉异步任务。`reason="reload"` 跳过。

### 2.4 kb_harvest 工具（agent 可感知的终采）

与 capture_knowledge 同构，区别是它触发**引擎跑全量未抽取区间**，而不是单条声明：

```
promptGuidelines: ["当用户表示会话结束或一个长任务收尾时，调用 kb_harvest 触发终采"]
```

工具内部起独立 LLM 调用（不占用当前对话轮次做大批量抽取），异步 fire-and-forget。

### 2.5 历史回填

手动 CLI：`extract.ts <session.jsonl>`。首次验证可以用"人肉对话模式"零代码起步（新开 pi 会话让 agent 读 jsonl 分窗抽取）验证 44 切片命中率，跑通后固化成 CLI。

---

## 三、抽取引擎（所有触发源共用）

### 3.1 窗口切分（内存中，不落盘）

- 窗口边界落在 `role=user` 的消息上（保证"user 问 + agent 答 + 工具结果"不被劈半）
- 攒约 500 条切一窗，窗口间不重叠；跨窗口重复原子靠事后判重兜底
- compaction 抢救例外：`messagesToSummarize` 本身就是窗口
- **`_windows/` 不落盘**：窗口是 session 的纯复制，防重不靠窗口文件

### 3.2 无状态防重

已抽取区间直接从 `atoms.jsonl` 的 `sources`（msg_range + window_id）派生。任何入口抽取前先查：本窗口范围内已有原子的区间跳过。**不建 marker 文件，atoms.jsonl 是唯一事实源。**

### 3.3 LLM 调用（V2 关键变更：复用用户环境的 API 配置，零额外配置面）

```
抽取调用 = 独立一次性 LLM 调用，配置来源分两种模式（分发化设计）：
  A. registry 模式（extension 在场：capture_knowledge / compaction 抢救）
     注入 pi 的 ModelRegistry，凭据解析与主对话完全同链
     （auth.json / models.json / 环境变量 / !command），默认模型跟随用户当前会话模型。
     用户装插件后什么都不用配。
  B. standalone 模式（进程级 CLI：quit 终采 spawn / 手动回填 / assemble / darwin judge）
     解析降级链：① AUTOSKILL_PROVIDER/AUTOSKILL_MODEL 显式指定
                → ② settings.json 默认 provider（apiKey 可解析时）
                → ③ 扫描 models.json 第一个可用 provider
                → ④ OPENAI_API_KEY/OPENAI_BASE_URL 直连
                都失败则明确报错指引（不静默降级）。
```

- **绝不在主对话内做批量抽取**：不占用对话轮次、不污染上下文、不影响用户任务
- 成本有界：输入经 serializeConversation 截断，输出是小 JSON
- 便宜模型降级为**可选优化**：`AUTOSKILL_MODEL` 一行切换；`extracted_by` 字段记录实际来源
- 异步静默失败：fire-and-forget，失败只 `console.error`，不打扰对话

### 3.4 抽取 prompt

注入 `design/SLICE_CATALOG.json`（5 类 × 44 切片）全文：

- `category + atom_type` 严格取自清单，不得发明新切片
- 结构化内容填入 atom.schema.json 对应特化字段（如"动作切片"带 `step`/`command`，"根因切片"带 `root_cause`）
- `content` 简洁、可独立复用、去会话噪音、去敏感信息（key/内部地址）
- `sources` 必填（session_id / window_id / msg_range 用真实 message id）
- `domain` 推断业务域；宁缺毋滥；多处命中同一切片分别输出（事后判重合并）

### 3.5 校验（三道关）

1. **ajv**（2020-12）按 `design/atom.schema.json` 校验结构，含 category 分支 required 特化字段
2. **catalog 枚举**：`atom_type` 合法且 `category↔切片` 匹配（"02 类不能出现根因切片"，防跨类幻觉）
3. **sources 非空**：无 source 拒绝入库

任一不过 → 丢弃 + 记 errors.log（静默）。

---

## 四、存储（V2：两目录单文件池）

```
knowledge/
├── atoms.jsonl        # 唯一事实源。一行一个原子，含全部 schema 字段。
│                      # status 字段区分 draft/published（不设 _drafts/ 目录）
│                      # 已抽区间从 sources 派生（不设 marker 文件）
├── cards/             # P1 组装视图（可随时从 atoms 重建）
│   └── <category>/<domain>/<id>.md
└── errors.log         # 校验失败与抽取异常（静默记录）
```

原子文件格式、生命周期、特化字段全部遵循 `design/atom.schema.json`（V2 未改动 schema）。schema 中的 `superseded_by / version / refs / tags` 字段**保留但 V2 不建维护机制**——去重合并 = 保留最新版 + 合并多 sources，历史靠 sources 的会话时间戳天然可查。

---

## 五、Review 与加工

### 5.1 review（极简形式）

- `/kb-review` 命令：列出 `atoms.jsonl` 中 `status=draft` 的原子（打印 category/atom_type/content 摘要，~20 行实现）
- 确认方式：手动编辑 status → published，或一个 10 行 approve 脚本
- 不建交互式 TUI 审阅流程
- 唯一免审入口：compaction 抢救（published 直入，理由：上下文完整质量高）

### 5.2 组装（P1）

`assemble.ts`：读 published 原子 → LLM 判重合并（近似重复合并为一个原子、保留多 sources、取最高 confidence——不建 embedding 基础设施）→ 按 5 类既定组装方式生成卡片：

| category | 组装方式 |
|---|---|
| 01 业务认知 | 相关切片打包成知识卡片 |
| 02 SOP | 时序+分支串联成流程清单 |
| 03 模板 | 文档层级排布成空白骨架 |
| 04 案例 | 完整成品打包保留上下文 |
| 05 复盘 | 问题→根因→预防全链路串联 |

组装只取 `superseded_by==null`（当前等价于全部）的最新版。**组装是视图，原子是事实**，可反复重建。

### 5.3 增量整合层（已实现，日常主路径）

并发方案：**无锁提案队列（方案 1）**。agent 不直接改 skill 文件，只往
`knowledge/intake/<patch_id>.patch.json` 写唯一名提案（零协调、崩溃安全），
应用器串行消费：
- 提案带 `base_skill_sha`；基于版本过期 → 丢弃提案，原子退回 pending，下次会话重做（冲突靠重做消化，不靠锁）
- 写文件与原子标记同事务（skill-state.json 原子写）；任何失败最坏=重做，不会丢知识
- 原子本身就是待办队列：pending = 池中未标记的（无额外 marker）

触发：extension 在 `session_start` 先跑应用器（纯文件操作，毫秒级），
`before_agent_start` 首个用户轮注入一次提示（≤25 条时引导增量整合，>25 建议跑批量）。
agent 整合方法论见 `design/INTEGRATE_GUIDE.md`（create-skill 蒸馏）。

**cards/ 保留**：assemble 批量工具继续产出，作 references 快照源。
批量打包器遇 SKILL.md 含 `agent-maintained` 标注时跳过（防覆盖精修，--force 强制）。
agent 精修过的 skill 成为手工资产，原子池降为事实日志+待办队列。

### 5.4 域与体系（P2）

`domain` 作为原子字段 + 卡片目录前缀已成立。MAP.md / links.json / 域升级规则**暂不建**，等打包 skill 有真实需求时从卡片目录顺手生成。

---

## 六、代码结构

```
AutoSkill/
├── lib/                          # 在线/手动回填共用核心
│   ├── window.ts                 # user msg 对齐切窗（纯内存）
│   ├── prompt.ts                 # 注入 SLICE_CATALOG 的抽取 prompt
│   └── atom-store.ts             # atoms.jsonl 读写 + sources 派生已抽区间
├── scripts/
│   ├── extract.ts                # CLI：session 文件 → 跳过已抽区间 → 逐窗抽取
│   │                             #      → 三道校验 → atoms.jsonl(draft)
│   │                             # 调用方：quit spawn / kb_harvest / 手动回填
│   └── assemble.ts               # P1：判重合并 + 组卡
├── extensions/knowledge-capture/
│   └── index.ts                  # 5 个注册（~200 行）：
│       ├─ pi.on("session_before_compact")   抢救
│       ├─ pi.on("session_shutdown")         spawn 终采
│       ├─ registerTool("capture_knowledge") 单条声明
│       ├─ registerTool("kb_harvest")        收尾终采
│       └─ registerCommand("kb-review")      打印 draft 清单
└── knowledge/                    # 运行时产物（atoms.jsonl / cards / errors.log）
```

---

## 七、落地步骤（V1 的 10 步 → 3 步）

| 步 | 产物 | 优先级 |
|---|---|---|
| 1 | `lib/` 三件套 + `scripts/extract.ts`，先手动对本机 session 跑通，验证 44 切片命中率与 glm-5.3 抽取质量 | **P0** |
| 2 | extension 五注册（compaction 抢救为重点） | **P0** |
| 3 | `assemble.ts` 判重组卡；（P2）skill 打包器 | P1 |

---

## 八、V1 → V2 精简决策记录

| # | V1 内容 | V2 处置 | 理由 |
|---|---|---|---|
| 1 | 离线周批处理（每周扫全 sessions） | 砍，降级为手动回填 CLI | 日常采集全由在线触发覆盖 |
| 2 | 在线层1（message_end 攒 500 条窗口抽取） | 砍 | 与层3/quit 终采覆盖相同内容；低延迟需求由 capture_knowledge/kb_harvest 更精准满足；连带砍掉 _events/ 缓冲、计数队列、marker 文件 |
| 3 | 反哺机制（steer 提醒/冲突 notify/skill 注入） | 砍 | 反哺未审 draft 有风险；触发源已随层1消失 |
| 4 | `_drafts/` 独立目录 + 双池迁移 | 砍，用 `status` 字段 | schema 已有 status，两目录是重复表达 |
| 5 | 演进链工具（version/superseded 维护） | 机制砍、schema 字段留 | 无消费者；去重合并已覆盖主场景 |
| 6 | embedding 去重 | 砍 | atom_id sha1 幂等 + 组装时 LLM 判重替代 |
| 7 | domains/ 体系层（MAP/links/升级规则） | 砍，P2 按需 | domain 字段+目录前缀已够用 |
| 8 | 一原子一文件 + index.jsonl | 砍，改 atoms.jsonl 单文件 | 只追加小对象，索引可派生 |
| 9 | kb-review 交互式 TUI | 砍，改打印清单 | 交互审阅是 P2 体验优化 |
| 10 | 抽取必须用便宜模型（haiku/flash） | 降级为可选优化 | 复用已配置主模型做独立一次性调用，零新增配置；glm-5.3 抽取质量待 P0 步骤 1 验证 |
| 11 | 窗口中间产物落盘 `_windows/` | 砍 | 窗口是 session 纯复制；防重从 atoms.jsonl sources 派生 |
| 12 | — | 新增 kb_harvest 工具 | 吸收"agent 可感知时机交给 system prompt"的思路：触发交 agent、引擎保持独立调用 |

**保留不动**：atom-first、SLICE_CATALOG 44 切片枚举校验、user msg 对齐窗口、sources 必填、compaction 抢救、独立调用防干扰红线、review 关卡、卡片可重建。

---

## 九、关键设计决策（V2 版 why）

1. **触发与引擎解耦**：四个触发源（工具×2 / 事件×2 / 手动×1）共用同一抽取引擎和校验管线，加触发源不碰引擎。
2. **agent 可感知时机交给 system prompt，感知不到的交给事件钩子**：模型只在 turn 中被调用——quit 和 compaction 是进程级/轮间事件，agent 物理上无法触发，必须事件兜底；反之 agent 在场时的富上下文，事件钩子用不上，工具主动声明最优。
3. **抽取绝不进对话轮次**：批量抽取一律独立一次性 LLM 调用（fire-and-forget）。用哪个模型不重要（glm-5.3 起步），重要的是隔离——成本有界、不污染上下文、不打扰用户任务。
4. **atoms.jsonl 单一事实源**：原子、草稿状态、已抽区间（sources 派生）全部一份数据，无第二表示。卡片是派生视图。
5. **compaction 抢救是唯一免审入口**：不可逆 + 上下文完整；其余全部 draft 待审，人是最后关卡。
6. **精简不删字段只删机制**：schema 原样保留，砍掉的是没有消费者的工具链；有真实需求时随时把机制加回来。

---

## 十、待确认项

| 项 | 建议默认 |
|---|---|
| `knowledge/` 位置 | repo 根目录（`AutoSkill/knowledge/`） |
| 首批测试 session | 本机现有 5 个（design 里引用的 01a0aef7 等不在本机） |
| glm-5.3 抽取质量 | P0 步骤 1 用真实 session 验证，不达标再引入便宜模型 |
