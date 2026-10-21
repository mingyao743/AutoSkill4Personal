# 从 session 提取知识体系方案：对话记录 → 单点信息 → 知识

> 目标：把 pi 对话记录（session.jsonl）按既定 5 类知识分类，拆成原子切片，再组装成知识卡片与业务域知识体系。
> 设计原则：**atom-first（原子优先）**——先抽原子入库，卡片/体系是原子之上的视图，可重组、可跨域复用、可演进。
> 切分策略：**窗口滑动（user msg 对齐）**，不做信号预筛，全量覆盖喂 LLM。简单优先。
> 输入契约：用户既定的 5 类 × 切片清单 × 组装方式（不改 schema，作为 LLM 抽取输出契约）。
> 涵盖：离线批处理 + 在线触发（含 compaction 抢救），两者共享同一套窗口策略、原子 schema、抽取 prompt。

---

## 一、三层管道总览

```
第1层 对话记录                第2层 单点信息（原子）           第3层 知识（卡片/体系）
┌─────────────────┐         ┌──────────────────────┐       ┌────────────────────────┐
│ session.jsonl   │ 窗口切分 │ atoms/  (扁平池)      │ 组装  │ cards/  (5类卡片)        │
│ message树+工具调用│ ──────► │ category 01-05       │ ────► │ domains/ (业务域知识体系) │
│                 │ user对齐 │ atom_type 切片类型    │ LLM   │   按域分库，5类齐全       │
└─────────────────┘ ~500条/窗 │ content + source ref │ 去重  │   域间引用               │
                            │ confidence/version   │ 聚合  └────────────────────────┘
                            └──────────────────────┘
                            ↑ compaction抢救层复用同策略(把messagesToSummarize当窗口)
```

**为什么 atom-first**：原子是最小、扁平、可溯源单元，卡片和体系是它之上的视图，可重组、可跨域复用、可随会话演进。

**为什么窗口滑动而非事件切分**：简单优先，无信号词典维护，无漏检，覆盖全。事件完整性靠"user msg 对齐窗口边界"保证，不靠规则预筛事件。成本用便宜模型（haiku/flash）压住。

---

## 二、第 1 层：对话记录 → 窗口切分（user msg 对齐）

session.jsonl 是扁平消息流，直接切成窗口喂 LLM。**窗口边界落在 user message 上**，保证一个事件的"user 问 + agent 答 + 工具调用结果"不被劈成两半。

### 切分规则

1. 遍历 entries，收集所有 `role=user` 的 message 作为候选锚点
2. 从第一个 user msg 开始，累积消息（含 assistant/toolCall/toolResult）直到约 500 条或达到下一个窗口起点
3. 窗口边界 = user msg 位置（保证窗口以 user 开头，事件完整）
4. 高密度会话（如 `01a0aef7` 452 条）≈1 个窗口；低密度长会话切成多窗
5. 窗口之间不重叠（靠事后去重处理跨窗口重复原子）

### 窗口输出（中间产物，不入库）

```json
{
  "window_id": "win_01a0aef7_001",
  "session_id": "01a0aef7",
  "msg_range": ["m00001", "m00452"],
  "entry_count": 452,
  "messages": [ /* 原始 AgentMessage 流，含工具调用和结果 */ ]
}
```

直接把窗口内的原始消息流序列化成 `[User]:.../[Assistant]:.../[Tool result]:...` 文本喂 LLM。**不做 tool_skeleton 压缩，不做信号预筛，全量覆盖**——简单优先，靠 LLM 在窗口内自己判断哪些片段含知识。

### 为什么不做信号预筛

- 冷启动即可用，无需维护信号词典
- 无漏检（不依赖关键词，隐性信号 LLM 也能识别）
- 覆盖全（"看起来没信号但实际有知识"的片段也抽到）
- 成本用便宜模型（haiku/flash）压住，全量喂也承受得起

权衡：会抽到大量无知识片段（闲聊、简单问答），但简单性优先；高密度会话成本可通过"窗口内 LLM 自行跳过无知识片段"缓解。

---

## 三、第 2 层：窗口 → 原子切片（LLM，按 5 类 schema 抽取）

### 原子统一 schema（入库契约）

```json
{
  "atom_id": "atom_<hash>",
  "category": "02",                      // 01业务认知 02SOP 03模板 04案例 05复盘
  "atom_type": "动作切片",               // 用户切片清单中的某一项（原样保留中文名）
  "content": "nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv 查GPU占用",
  "domain": "fault-diag-rl",             // 业务域（见第四节）
  "sources": [                           // ★可溯源，允许多源
    {"session_id":"01a0aef7","window_id":"win_01a0aef7_001","msg_range":["m00340","m00390"]}
  ],
  "confidence": 0.85,
  "version": 2,                          // 同原子的内容演进
  "superseded_by": null,                 // 被哪个 atom 取代（演进管理）
  "refs": ["atom_xxx", "atom_yyy"],      // 引用其他原子（组装关系）
  "extracted_at": "2026-10-20T12:00:00Z",
  "status": "draft"                      // draft / reviewed / published / deprecated
}
```

**强约束**：
- `atom_type` 必须是用户切片清单里的合法项（枚举校验，拒绝幻觉切片）
- `sources` 必填，无 source 的 atom 不入库（可溯源是质量基石，pi message 有 `id` 字段正好用）
- `content` 去会话噪音、可独立复用、不含敏感信息（key/内部地址）

### 抽取 prompt 设计（把用户的 5 类表当 schema 喂给 LLM）

```
你是知识抽取器。输入一个对话窗口（约500条 user/assistant/tool 消息序列）。
按以下 5 类知识分类的切片清单，逐项判断本窗口是否包含该切片：
  [贴入用户给的完整 5 类 × 切片清单表]

对每个命中的切片，输出一个 atom：
  - category/atom_type: 从上表严格取值，不得发明新切片
  - content: 简洁、可独立复用、去会话噪音、去敏感信息
  - domain: 推断业务域（fault-diag-rl / trans-term-retrieve / pi-ops / xeno-agent / 评测方法论 / 其他）
  - confidence: 0-1
  - msg_range: 本 atom 来自窗口内哪段消息（尽量精确到子范围，便于回溯）
  - refs: 本 atom 引用了哪些其他已有切片（如有）

只输出 JSON: {"atoms":[...]}。没有命中则输出空数组。
宁缺毋滥。长窗口里可能有多处命中同一切片，分别输出（事后去重合并）。
```

### 抽取示例（`01a0aef7` 的一个窗口 → atoms）

| category | atom_type | content | domain |
|---|---|---|---|
| 02 SOP | 动作切片 | `nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv` 查各卡占用与利用率 | fault-diag-rl |
| 02 SOP | 动作切片 | `docker ps` → `docker inspect -f '{{.State.Pid}}' <name>` → `docker stop` 按卡释放容器 | fault-diag-rl |
| 02 SOP | 异常现象切片 | RL 训练启动~2分钟 OOM，因他人进程占 GPU2 48G | fault-diag-rl |
| 02 SOP | 异常处置切片 | 写看门狗 `/tmp/gpu2_watch.sh`：显存<10G 视为释放，自动拉起 pilot500，防抖+失败重试3次 | fault-diag-rl |
| 02 SOP | 核查点切片 | 训练存活判定：`ps -p <pid> -o etime` + `tmux capture-pane -t watch_train \| tail` + `wc -l trajectories` | fault-diag-rl |
| 02 SOP | 输出物切片 | `docs/grpo_debug_history.md` 追加事件记录（`cat >> ... << EOF`） | fault-diag-rl |
| 05 复盘 | 根因切片 | GPU 资源多用户争用，非配置问题 | fault-diag-rl |
| 05 复盘 | 永久预防切片 | 看门狗自动拉起 + 错峰 + 记录 debug history | fault-diag-rl |

一个窗口抽 N 个原子，分属多类。原子扁平入池，**不强求一次性成卡片**。

---

## 四、第 3 层：原子 → 知识卡片与业务域知识体系

### 4.1 卡片组装（按用户的"组装方式"）

| category | 组装方式 | 卡片产物 | 组装规则 |
|---|---|---|---|
| 01 业务认知 | 相关切片打包成知识卡片 | `cards/business/<id>.md` | 同一概念/口径的 atoms 聚成一张卡（概念名+释义+口径+规则+边界+价值）|
| 02 SOP | 时序+分支串联 | `cards/sop/<id>.md` | 按 步骤编号+前置+输入输出+核查点+分支+异常 顺序排成流程清单/流程图 |
| 03 模板 | 文档层级排布 | `cards/template/<id>.md` | 按模块标题+字段+类型+必填+说明+示例+格式 排成空白骨架 |
| 04 案例 | 完整成品打包 | `cards/case/<id>.md` | 保留完整上下文：基础信息+方案+过程+结果+亮点+局限+适用条件 |
| 05 复盘 | 全链路串联 | `cards/retro/<id>.md` | 问题→场景→影响→根因→临时对策→永久预防→改进项 |

组装由 LLM 完成（输入=某 domain 某类的全部 atoms，输出=按格式的卡片 md）。组装是**视图**，原子是**事实**，可反复重组。

### 4.2 业务域知识体系（"一个个知识体系"）

**一个知识体系 = 某业务域下 5 类齐全 + 卡片间关联图。** 域内 5 类不全则只是"素材库"，不算体系。

```
domains/
├── fault-diag-rl/
│   ├── MAP.md            # 该域 5 类卡片索引 + 卡片关系图 + 域概况
│   ├── atoms.jsonl       # 该域全部原子（从 atoms/ 按域筛选的视图）
│   └── links.json        # 域内引用 + 域间引用
├── trans-term-retrieve/
├── pi-ops/               # pi 配置/session/插件 等
├── gpu-train-ops/        # 可从 fault-diag-rl 抽出独立成域（GPU 运维跨项目复用）
└── eval-methodology/     # 评测方法论（跨多个项目共享）
```

**域的划分原则**：按"可复用的最小自治工作域"，不严格等于项目目录。如 `gpu-train-ops` 从 fault-diag-rl 抽离独立成域——因为它在多个项目都会用到，跨域引用比塞进单一项目更有价值。

### 4.3 合并机制（你说的"未来合并成一个个知识体系"）

| 合并场景 | 机制 | 触发 |
|---|---|---|
| **原子去重** | 同 `category+atom_type` 且 content embedding 相似度>阈值 → 合并，保留多 sources，取最高 confidence 版本 | 抽取后批处理 |
| **跨窗口聚合** | 多个窗口抽到同概念（如"reward 设计"在 win_001/win_005）→ 合并成一个卡片，记录演进链 | 域内 atom 数 ≥3 |
| **演进管理** | 同原子内容随会话变化（reward 从 NDCG→llm judge 根因）→ 新建 version，旧版 `superseded_by` 指向新版，保留历史 | LLM 检测到同 atom_type 内容冲突 |
| **跨域引用** | 一原子被多域引用（如"llm judge 根因"在 fault-diag-rl 和 eval-methodology 都用）→ 原子归属主域，他域 `refs` 引用，不复制 | 组装卡片时 LLM 标注 refs |
| **域升级为体系** | 某 domain 的 5 类卡片都齐全 → 从"素材库"升级为"知识体系"，生成 MAP.md | 域内 5 类均有 ≥1 卡片 |

### 4.4 演进管理（关键，避免知识腐化）

同一原子的内容会随会话演进。用 `version + superseded_by` 保留历史，**不直接覆盖**：

```
atom_A (v1): reward 用 NDCG            [superseded_by: atom_B]   # 01a0d25d 时期
atom_B (v2): reward 用 llm judge 根因   [superseded_by: null]    # 01a0e5de 时期
```

组装卡片时只取 `superseded_by==null` 的最新版，但保留演进链供追溯。这避免"新会话覆盖旧知识后丢失决策理由"。

---

## 五、存储结构

```
knowledge/
├── atoms/                          # 第2层：原子池（全域扁平共享，单一真相源）
│   ├── atom_<hash>.json            # 一个原子一个文件
│   └── index.jsonl                 # 原子索引（id/category/atom_type/domain/confidence/sources/window_id）
├── cards/                          # 第3层：卡片（组装视图，可重建）
│   ├── business/  sop/  template/  case/  retro/
├── domains/                        # 知识体系（按业务域）
│   ├── <domain>/MAP.md + atoms.jsonl + links.json
├── _drafts/                        # 待 review 的原子和卡片
├── _windows/                       # 窗口切分中间产物（可清，便于重跑）
└── _events/                        # 在线攒的窗口缓冲（<session_id>/）
```

- `atoms/` 是唯一事实源，卡片和体系都可从它重建
- pi skill 是知识体系的**消费出口**之一（见第八节），不是存储本身

---

## 六、运行模式

三种模式互补：离线批处理（全量回填）、在线触发（增量+compaction 抢救）、review 面板（人工把关）。

### 6.1 离线批处理

每周扫 `~/.pi/agent/sessions/` 新增会话，跑完整管道：窗口切分 → LLM 抽取 → 去重聚合 → 更新卡片 → 更新域 MAP。纯脚本+LLM，实现难度低。**建议起步用这个**，跑通管道攒出第一批原子后再上在线触发。

### 6.2 在线触发（pi extension 承载）

#### 为什么需要在线触发（离线管道的三个缺口）

| 缺口 | 离线管道的问题 | 在线触发如何补 |
|---|---|---|
| **compaction 丢细节** | pi 自动 compaction 把旧消息压成 summary，工具调用细节、命令、错误文本被丢弃——离线再扫 session.jsonl 时被压缩部分只剩 summary 文本，抽不到精确 content | 在 `session_before_compact` 抢救：压缩前对 `messagesToSummarize` 当窗口喂 LLM 抽，原子入库后再让 compaction 发生 |
| **延迟复用** | 知识要等会话结束甚至周末批处理才入库，当前会话用不上 | 攒满窗口即抽，抽取结果可即时反哺 |
| **上下文丢失** | 离线扫时 LLM 只看 jsonl 文本，看不到当前任务的活上下文 | 在线抽取时 agent 正在工作，可读 `ctx.sessionManager` 拿活上下文，命中率和准确率更高 |

**核心创新：compaction 抢救**——compaction 不可逆，丢的细节离线永远补不回。这是在线触发最有价值的一层。

#### 三层触发设计

```
对话进行中
  │
  ├─层1 窗口攒满抽取（message_end 计数）    ──攒约500条触发一次LLM抽取入_drafts
  ├─层2 compaction抢救（session_before_compact）──压缩前抢救，最重要
  └─层3 会话终态沉淀（session_shutdown）      ──quit时全量补抽
```

不做 turn_end 信号词检测——与离线一致，纯窗口方案，不预筛片段。

**层 1：窗口攒满抽取（message_end 计数）**

在 `message_end` 事件里计数累积消息数，攒满约 500 条触发一次抽取（user msg 对齐边界，与离线同策略）。抽取动作：取本窗口范围消息序列化喂便宜模型 → 按 5 类 schema 抽原子 → 写 `_drafts/atoms/` → 记 `extracted.marker` 防重。异步不阻塞，失败静默。

**层 2：compaction 抢救（最重要）**

`session_before_compact` 事件给出 `preparation.messagesToSummarize`（完整未压缩）+ `firstKeptEntryId` + `tokensBefore` + `previousSummary` + `signal`。动作（与离线完全一致的窗口直抽，不套事件切分）：

1. 把 `messagesToSummarize` 直接当一个窗口，序列化喂便宜模型
2. 按 5 类 schema 抽原子
3. 原子入 `knowledge/atoms/`（**直接入正式池，不经 _drafts**——因为这是有完整上下文的连续片段，质量高；可设 confidence=0.7 待 review 提升）
4. 生成"已抽取原子索引"摘要，**拼进自定义 compaction summary**：
   ```typescript
   return { compaction: {
     summary: previousSummary + "\n\n## 已沉淀原子\n" + atomIndex,
     firstKeptEntryId, tokensBefore,
     details: { extractedAtomIds: [...] }  // 自定义 details 存原子id
   }};
   ```
   后续会话从 compaction summary 就能看到"这部分对话已沉淀为哪些原子"，可回溯。
5. 用 `details` 字段存 extracted atom ids，`session_compact` 事件后追加入 `atoms/index.jsonl`

**层 3：会话终态沉淀（session_shutdown）**

`session_shutdown` 事件 reason 含 `"quit"|"reload"|"new"|"resume"|"fork"`：
- `reason="quit"`：对整个 session 跑离线管道（窗口切分+抽取+去重+卡片组装），补抽层1/2 漏掉的片段
- `reason="new"|"resume"|"fork"`：对旧 session 做轻量抽取（只抽未抽过的窗口），不跑全量
- `reason="reload"`：跳过（会话未真结束）

用 `extracted.marker` 记录已抽到的 entry id，避免层1/2 抽过的重复抽。

#### 主动触发：让 agent 自己调用工具声明知识

被动窗口攒满抽取有盲区——agent 自己最清楚哪些值得沉淀。给 LLM 注册一个工具让它主动调用：

```typescript
pi.registerTool({
  name: "capture_knowledge",
  label: "Capture Knowledge",
  description: "把当前对话中刚产生的一条知识沉淀到知识库。当你意识到刚做的事/刚得出的结论值得复用时主动调用。",
  promptSnippet: "把刚产生的知识沉淀到知识库原子池",
  promptGuidelines: ["用 capture_knowledge 当你刚得出可复用的SOP步骤/业务口径/模板/案例亮点/复盘教训时"],
  parameters: Type.Object({
    category: StringEnum(["01","02","03","04","05"]),
    atom_type: Type.String({description: "用户切片清单中的某项中文名"}),
    content: Type.String({description: "简洁可复用，去会话噪音去敏感信息"}),
    domain: Type.String({description: "业务域推断"}),
    refs: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const atom = { ...params, sources:[{session_id: ctx.sessionManager.getSessionFile(), ...}],
                   status:"draft", extracted_at: new Date().toISOString() };
    await appendAtom("knowledge/_drafts/atoms/active.jsonl", atom);
    return { content:[{type:"text",text:`已沉淀到_drafts，category=${params.category}`}], details:{atom} };
  }
});
```

**主动+被动双触发**：agent 主动调用（精准，但依赖 agent 自觉）+ 窗口攒满抽取（兜底，覆盖全）。两者抽到的原子都进 `_drafts`，去重时合并。

#### 抽取结果反哺当前对话

| 反哺场景 | 机制 | 实现 |
|---|---|---|
| 抽到"05 改进项"（如"agent 不应 sleep 等待"）| 当轮注入提醒 | `pi.sendMessage({customType:"kb-reminder", content:"提醒：刚抽到改进项..."}, {deliverAs:"steer", triggerTurn:true})` |
| 抽到"02 SOP"且该域已有 skill | 下次加载该 skill | `resources_discover` 事件贡献 `skillPaths` |
| 抽到"01 业务认知"与既有规则冲突 | 提示用户 review | `ctx.ui.notify("⚠️ 新认知与既有atom_X冲突，review?","warn")` |
| 用户主动查沉淀队列 | 命令 | `pi.registerCommand("kb-review", ...)` 列出 `_drafts` |

反哺克制——默认只写 `_drafts` 不自动入正式 `atoms/`。反哺提醒用 `deliverAs:"steer"`（不打断当前工具执行）。

#### 防干扰原则（在线触发的红线）

1. **抽取用独立 LLM 调用**：用便宜模型（haiku/flash/gemini-flash），绝不用主对话模型（成本+延迟）
2. **异步非阻塞**：所有抽取 fire-and-forget，不 await 在 turn 处理里
3. **失败静默**：只 `console.error` + 写 `knowledge/_drafts/errors.log`，不 notify 打扰
4. **默认只写 _drafts**：在线抽出的原子不自动入正式 `atoms/`，需 review（除 compaction 抢救层，因上下文完整质量高）
5. **去重优先**：抽取前查 `atoms/index.jsonl`，content 相似的跳过（embedding 阈值）
6. **不修改主对话消息**：只用 `tool_result`/`message_end` 读，不返回修改（除 compaction 自定义 summary，那是 pi 设计允许的）

#### extension 骨架

```
~/.pi/agent/extensions/knowledge-capture/
├── index.ts            # 入口，注册事件和工具
├── window.ts           # user msg 对齐窗口构建（与离线 window_split.py 同逻辑）
├── extractor.ts        # LLM 抽取（调便宜模型，复用离线 5 类 schema prompt）
├── atom-store.ts        # 原子读写（atoms/ + _drafts/）
└── package.json         # 依赖（可选 embedding 库）
```

`index.ts` 骨架：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { buildWindow } from "./window";
import { extractAtoms } from "./extractor";
import { appendAtom, appendDraft, loadExtractedMarker, saveExtractedMarker } from "./atom-store";

const KB_DIR = process.env.KB_DIR ?? `${process.env.HOME}/pi-cwd-20260901/knowledge`;

export default function (pi: ExtensionAPI) {
  let msgCount = 0;
  let windowStart: string | null = null;

  // 层1: message_end 计数攒窗口
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "user" && windowStart === null) {
      windowStart = event.message.id;
    }
    msgCount++;
    if (msgCount >= 500 && windowStart) {
      const window = await buildWindow(ctx.sessionManager, windowStart, event.message.id);
      extractAtomsAsync(window, ctx).catch(e => console.error("[kb]", e));
      msgCount = 0;
      windowStart = null;
    }
  });

  async function extractAtomsAsync(window, ctx) {
    const atoms = await extractAtoms(window, ctx);  // 调便宜模型, 复用离线5类schema prompt
    await Promise.all(atoms.map(a => appendDraft(`${KB_DIR}/_drafts/atoms/`, a)));
  }

  // 层2: compaction 抢救（最重要）
  pi.on("session_before_compact", async (event, ctx) => {
    const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary, signal } = event.preparation;
    const window = toWindow(messagesToSummarize);  // 直接当窗口
    const atoms = await extractAtoms(window, ctx, signal);  // 调便宜模型
    await Promise.all(atoms.map(a => appendAtom(`${KB_DIR}/atoms/`, a)));  // 直接入正式池
    const atomIndex = atoms.map(a => `- [${a.category}/${a.atom_type}] ${a.content.slice(0,80)}`).join("\n");
    return { compaction: {
      summary: previousSummary + "\n\n## 已沉淀原子\n" + atomIndex,
      firstKeptEntryId, tokensBefore,
      details: { extractedAtomIds: atoms.map(a=>a.atom_id) }
    }};
  });

  // 层3: 会话终态沉淀
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    const full = event.reason === "quit";
    await runOfflinePipeline(ctx, full);  // 跑离线窗口切分+补抽
  });

  // 主动触发工具
  pi.registerTool({
    name: "capture_knowledge",
    label: "Capture Knowledge",
    description: "把当前对话中刚产生的一条知识沉淀到知识库原子池_drafts。",
    promptSnippet: "把刚产生的知识沉淀到知识库",
    promptGuidelines: ["用 capture_knowledge 当你刚得出可复用的SOP步骤/业务口径/模板/案例亮点/复盘教训时"],
    parameters: Type.Object({
      category: StringEnum(["01","02","03","04","05"] as const),
      atom_type: Type.String(),
      content: Type.String(),
      domain: Type.String(),
      refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _s, _u, ctx) {
      const atom = { ...params, status:"draft",
        sources:[{session_id: ctx.sessionManager.getSessionFile()??""}],
        extracted_at: new Date().toISOString() };
      await appendAtom(`${KB_DIR}/_drafts/atoms/active.jsonl`, atom);
      return { content:[{type:"text",text:`已沉淀到_drafts (${params.category}/${params.atom_type})`}], details:{atom} };
    },
  });

  // review 命令
  pi.registerCommand("kb-review", {
    description: "查看知识库 _drafts 待审原子",
    handler: async (_args, ctx) => {
      const drafts = await listDrafts(`${KB_DIR}/_drafts/`);
      const choice = await ctx.ui.select("待审原子:", drafts.map(d=>`${d.category}/${d.atom_type}: ${d.content.slice(0,60)}`));
      if (choice) await reviewAtom(drafts[choice], ctx);
    },
  });
}
```

### 6.3 在线与离线的协同

| 场景 | 在线触发做什么 | 离线管道做什么 |
|---|---|---|
| 对话进行中 | 层1 窗口攒满抽 + 层2 compaction 抢救 | 不参与 |
| 会话 quit | 层3 跑全量补抽 | 不参与（已被层3覆盖）|
| 历史老 session | 不参与（未运行 extension） | 全量回填（窗口切分+抽取）|
| compaction 发生 | 层2 抢救入 atoms/ | 无需再扫这部分 |
| 周末批处理 | 不参与 | 对 `_drafts` 做 review、去重、组装卡片、生成 domain MAP |

**分工**：在线触发负责"不丢"（尤其 compaction 抢救），离线管道负责"理清"（去重/组装/成体系）。两者写同一套 `atoms/` 池，原子 schema、窗口策略、抽取 prompt 完全一致。

### 6.4 review 面板

人工把关，列出 `_drafts` 新原子和待组装卡片，确认/修改/废弃。实现简单（一个 markdown 清单 + 手动，或 `kb-review` 命令交互）。默认所有在线抽出的原子（除 compaction 抢救层）都进 `_drafts` 待审，避免脏数据污染正式 `atoms/` 池。

---

## 七、与 pi skill 的关系（出口）

知识体系是底层资产，pi skill 是它的一个消费出口：

```
knowledge/domains/<domain>/  ──打包──►  ~/.pi/agent/skills/<name>/SKILL.md + scripts/ + references/
```

- 一个域可生成多个 skill：`fault-diag-rl` 域 → `fault-diag-rl-context`(项目地图) + `rl-reward-design`(决策清单)
- skill 的 `description` 从该域的"业务认知/边界"切片生成，决定加载时机
- 知识体系不依赖 skill 也可用（喂 RAG、出报告、人工查阅）
- **反方向**：已存在的 skill（如 `NLP系统版本对比评测`）可作为"03 模板 + 04 案例"切片的来源，反向回灌原子池

---

## 八、端到端示例：`01a0aef7` 走完整管道

```
session 01a0aef7 (RL 运维, 452条)
  │
  ├─窗口切分（user msg 对齐）
  │   └─ win_001: m00001-m00452 (整个session约1个窗口)
  │
  ├─原子抽取（LLM, 按5类schema, 全量喂）
  │   win_001 → 20+ atoms (含第三节示例的8个+其他)
  │   每个atom标 sources.window_id + msg_range
  │
  ├─去重聚合
  │   "nvidia-smi查询" atom 在多个会话窗口都抽到 → 合并, sources保留多个window_id
  │   "reward用llm judge根因" 与 01a0d25d 旧版"NDCG" → 演进链 atom_A→atom_B
  │
  ├─组装卡片
  │   02 SOP atoms → cards/sop/rl-train-ops.md (流程清单+异常处置)
  │   05 复盘 atoms → cards/retro/gpu-preemption.md
  │
  └─合并成体系
      domains/fault-diag-rl/MAP.md (含 5类卡片索引+关系图)
      domains/gpu-train-ops/  (从 fault-diag-rl 抽离独立成域,跨项目复用)
      domains/pi-ops/agent-behavior-rules.md (吸收"不要sleep"等跨域反模式)
```

最终这个体系可打包成 `gpu-train-ops` skill 给 agent 用，也可喂 RAG 检索。

---

## 九、落地步骤与优先级

| 步 | 产物 | 优先级 | 模式 |
|---|---|---|---|
| 1. `window_split.py` | user msg 对齐切窗口，输出 `_windows/` | P0 | 离线 |
| 2. 抽取 prompt + LLM 跑批 | `atoms/` 原子池 + `index.jsonl` | P0 | 离线 |
| 3. compaction 抢救 extension | compaction 前抽原子入 atoms/ | **P0（不可逆，最高价值）** | 在线 |
| 4. 去重/演进脚本 | embedding 去重 + superseded 链 | P1 | 离线 |
| 5. 组装 prompt + 生成卡片 | `cards/` 五类卡片 | P1 | 离线 |
| 6. 域划分 + MAP 生成 | `domains/*/MAP.md` | P1 | 离线 |
| 7. 窗口攒满抽取（层1）+ 主动工具 | `_drafts` 攒原子 + agent 主动声明 | P1 | 在线 |
| 8. review 面板（`kb-review` 命令）| 人工确认 `_drafts` | P2 | 在线 |
| 9. 知识体系 → pi skill 打包器 | `~/.pi/agent/skills/` | P2 | 离线 |
| 10. 会话终态沉淀（层3）+ 反哺 | quit 时补抽 + 知识回流对话 | P2 | 在线 |

**最小闭环**：
- 离线侧：步骤 1-2 即可出第一批原子。先在 `01a0aef7`、`01a0e5de`、`01a12f12` 三个高密度会话跑通，验证 5 类切片命中率。
- 在线侧：步骤 3 单独可跑——只要 compaction 抢救 extension 装上，就能保住后续所有会话的 compaction 细节，不依赖离线管道跑通。

---

## 十、关键设计决策（why）

1. **atom-first 而非 card-first**：你要"合并成一个个知识体系"，意味着原子要能跨域重组。若直接生成卡片/skill，会锁死成一次性产物，无法合并演进。
2. **窗口滑动而非事件切分**：简单优先，无信号词典维护，无漏检，覆盖全。事件切分那层中间抽象在冷启动期不值它的复杂度。
3. **窗口边界对齐 user msg（而非硬切500条）**：避免把一个事件（user问+agent答+工具结果）劈成两半导致两边抽不出完整原子。零成本修正，消除硬切硬伤。
4. **不做信号预筛全量喂 LLM**：冷启动即可用，无漏检。成本用便宜模型（haiku/flash）压住。权衡是会抽到无知识片段，但简单性优先。
5. **在线与离线同一套窗口策略**：在线 compaction 抢救、窗口攒满抽取，与离线批处理用完全相同的 user msg 对齐窗口、原子 schema、抽取 prompt。原子可互通、可复现、去重一致。
6. **compaction 抢救是在线触发最高价值**：compaction 不可逆，丢的细节离线永远补不回。优先级高于离线 P0。
7. **主动+被动双触发**：agent 主动调 `capture_knowledge`（精准）+ 窗口攒满抽取（兜底覆盖全）。
8. **抽取用便宜模型**：在线触发跑在主对话进程，绝不能用主对话模型（成本+延迟+干扰）。haiku/flash 足够抽 5 类切片。
9. **默认写 _drafts 不入正式 atoms**（除 compaction 抢救）：在线抽取上下文可能不完整需 review；但 compaction 抢救的片段是完整连续消息，质量高直接入池。
10. **自定义 compaction summary 带原子索引**：让后续会话能从 summary 看到已沉淀原子，可回溯，不丢失"这部分对话被抽过什么"的信息。
11. **source 强制可溯源**：pi message 有 `id` 字段，天然支持。无 source 的 atom 拒绝入库——去重、演进、回溯、信任的基石。
12. **atom_type 枚举锁死**：只允许用户给的切片清单内的值，LLM 不得发明新切片。保证跨窗口跨域原子可比较、可聚合。
13. **演进用 superseded 链而非覆盖**：保留历史决策理由（"为什么从 NDCG 改 llm judge"），避免新会话覆盖旧知识后丢失 rationale。
14. **域按"可复用最小自治工作域"而非项目目录**：如 gpu-train-ops 跨项目复用，独立成域比塞进 fault-diag-rl 更有价值。
15. **反哺克制**：在线触发是"捕获"不是"干预"，反哺只做提醒（steer）不强行改对话。用户始终有 review 关卡。
16. **离线批处理优先于在线即时（除 compaction 抢救）**：管道未跑通前不碰在线层1/层3；但 compaction 抢救（层2）独立可用，不依赖离线跑通。

---

## 附：与之前 SKILL_EXTRACTION_ANALYSIS.md 的关系

那份报告的"五层分类"（how-to/know-how/project/anti-pattern/methodology）是面向"生成 skill"的粗粒度分类。本方案的"5 类业务知识"（业务认知/SOP/模板/案例/复盘）是面向"知识体系"的细粒度分类。映射关系：

| 本方案 5 类 | 对应前报告的层 | 说明 |
|---|---|---|
| 02 SOP | 1 how-to + 部分 4 anti-pattern | SOP 含异常处置切片，吸收反模式 |
| 01 业务认知 | 2 know-how + 3 project | 口径/规则/背景覆盖决策经验和项目背景 |
| 03 模板 | （新增维度） | 前报告未覆盖，本方案补齐 |
| 04 案例 | 部分 2 know-how 的实证 | 案例是决策的"成品范本" |
| 05 复盘 | 4 anti-pattern + 5 methodology 的踩坑部分 | 复盘切片更细（根因/对策/改进项）|

本方案是前报告的细化与业务化，前报告的 skill 清单可作为本方案第 9 步"打包成 skill"的输入。
