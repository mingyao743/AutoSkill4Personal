# 当前抽取引擎逻辑梳理（skill 化基底）

> 通读 `packages/core/lib/*` 与 `packages/core/scripts/*` 真实代码后产出。引用格式 `文件:行号`。
> 目的：为"抽取逻辑 skill 化"做基底——明确哪些步骤是 LLM prompt 驱动（将来变成 SKILL.md 让 agent 执行）、哪些是确定性代码（留在 core）。

> **⚠️ 2026-11-13 更新**：本文产出后，旧两段式（`trigger-scan.ts` + `knowledge-extract.ts`）、旧整窗引擎 `extractWindow`（`extract-core.ts`）、`serialize.ts`、以及 `scripts/knowledge-extract.ts` + `scripts/trigger-scan-calibrate.ts` **已全部删除**，`runPipeline` 的 `twoStage` 开关一并移除。**当前唯一抽取引擎 = one-stage**（§2.1 + §3.1 + §4#1）。下文 §3.2 / §3.3 / §4#2-#4 / §6.4 描述的旧引擎为**删除前快照**，保留作 skill 化决策的对照语境；`extract-core.ts` 瘦身后仅留 `isMechanicalG4`（one-stage 准入闸复用）+ `normalizeAtom`（smoke 测试用）。

> **📍 路径迁移（2026-11-13）**：`packages/core/lib/` 已扁平→模块化，三子文件夹。本文里的 `文件.ts` 路径按下表加前缀（行号不变）：
> - `base/`：`types` `context` `atom-store` `admission` `llm`
> - `extract/`：`pipeline` `one-stage` `compress` `extract-core` `window` `validate` `coverage` `review-log` `drop-log` `prompt`
> - `skill/`：`compile-skill` `generate-skill` `skill-contract` `route-test` `apply-patches` `skill-state` `usage-store` `compile-state`
> - `capture-orchestration.ts` 留 `lib/` 根（顶层触发编排，跨 extract+skill）
> - 注：`scripts/pipeline.ts`（CLI）不在 lib，路径不变；本文 §1.1 表里的 `pipeline.ts` 简称指该 CLI。

---

## 1. 入口与触发

### 1.1 调用方（四个入口，共用同一份 `runPipeline`）

| 调用方 | 文件:行号 | harness | 触发方式 | 批次/预算 |
|---|---|---|---|---|
| `capture-orchestration.runScheduledExtraction` | `capture-orchestration.ts:117` | `"pi"` | pi `before_agent_start(user)` → `maybeRunPipeline`（`adapter-pi/knowledge-capture.ts:48`）→ `shouldExtractOnTurn` 闸（未审 user 轮 ≥ 30）→ 命中后多批清 | `maxBatches = min(8, ceil(N/10))`、`budgetTokens = min(240k, maxBatches×40k)`（`capture-orchestration.ts:121`） |
| `adapter-dsh dispatchPipeline` | `adapter-dsh/src/tools.ts:111` | `"dsh"` | dsh 无 per-turn 钩子，`index.ts` 定时器（默认 120s）轮询会话文件 mtime → `dispatchPipeline` → 同一份 `shouldExtractOnTurn` 闸 → standalone 凭据可用则 detached `spawnPipelineDsh`，否则 `runPipelineInProcess`（`tools.ts:75`，行 94 调 `runPipeline`） | 同 N-scaled 口径（`tools.ts:124`） |
| CLI `pipeline.ts` | `scripts/pipeline.ts:99` | `"cli"` | 手动 / 离线 harvest：读 `<session>.jsonl[.zstd]` → `parseSession` → `runPipeline` | `--max-batches` / `--budget` / `--batch-chars` 显式传 |
| CLI `extract-calibrate.ts` | `scripts/extract-calibrate.ts:104` | `"cli"` | 校准 CLI，也走 `runPipeline`（非主线，验收用） | 显式传 |

**统一闸**：`shouldExtractOnTurn`（`capture-orchestration.ts:108`）—— stateless 数未审 user 轮，`EXTRACT_EVERY_N_TURNS` 默认 30（`capture-orchestration.ts:44`，可被 env 覆盖）。不到 N 轮返回 `skip`，不烧 token。

### 1.2 `runPipeline` 签名与入参

`runPipeline(opts: PipelineOptions): Promise<PipelineReport>` — `pipeline.ts:536`

`PipelineOptions`（`pipeline.ts:38-69`）：
- `sessionId: string`、`entries: MessageEntry[]`、`harness: "pi" | "dsh" | "cli"`
- `mode?: "incremental" | "backfill"`（backfill 忽略覆盖，重扫全量）
- `model?`、`batchChars?`（默认 12000）、`maxBatches?`、`budgetTokens?`
- `domainOptions?: string[]`（已有主题清单，防主题拆碎）、`domainHint?`（兜底名）
- `knownAtomIds?: Set<string>`、`signal?`、`dryRun?`（只报告不落库）
- ~~`twoStage?: boolean`~~（**已删除** 2026-11-13：旧两段式开关移除，runPipeline 现仅一段式）
- `overlap?: boolean`（默认 true，每批带上一批最后 1 轮只读上下文）
- `knownCards?: string[]`（判重用已知卡片摘要）、`onProgress?`

### 1.3 `PipelineReport` 结构（`pipeline.ts:86-130`）

核心计数字段：`covered` / `unreviewed` / `batches` / `processedBatches` / `candidates`（=卡片数）/ `atoms` / `dropped` / `rejected` / `tokensIn` / `tokensOut` / `elapsedMs` / `stopped?` / `newAtoms`。

一段式专属观测字段：`compressFallback` / `compressNoGain` / `compressRatio`（压缩统计）、`noValueBatches`（模型行使否决权）、`retriedBatches`（格式不合格重跑）、`needContext`（申请回读）、`dropRows` / `autoDropped`（兜底补账）、`unaccounted`（既没进卡也没进 drop）、`pendingFieldCards`（缺特化字段）、`quoteUnverified`（quote 非逐字）、`orphanedByReject`（被拒卡片的 user 消息孤儿补账）、`rejectReasons` / `rejectSamples`（拒绝原因归一化计数 + 样本）。

---

## 2. 主流程（`runPipeline` 逐步骤）

### 2.0 前置（`pipeline.ts:536-592`）— 全部【确定性代码】

1. `t0 = Date.now()`；`dryRun = opts.dryRun === true`；`mode = opts.mode ?? "incremental"`（`:538-539`）
2. `known = opts.knownAtomIds ?? existingAtomIds()`（`atom-store.ts:103`，读 atoms.jsonl 派生幂等集合）
3. `atomsPool = loadAtoms()`（`atom-store.ts:79`）
4. `coveredSet = coveredIds(entries, sessionId, atomsPool)`（`coverage.ts:39`——从 atoms.sources[].msg_range + reviewedRanges 反推覆盖）
5. `unreviewedEntries` = 过滤 `role ∈ {user, assistant, toolResult}`；`pending` = backfill ? 全量 : `!coveredSet.has(e.id)`（`:545-551`）
6. 初始化 `report`（`:553-581`）；`pending.length === 0` → 直接返回（`:583`）
7. `if (!dryRun && !acquireLock(sessionId))` → 返回 `stopped: "locked"`（`:588`，进程内 Set + 文件锁双保险，`pipeline.ts:147`）
8. `stage = "one-stage"`（旧 `twoStage ? "two-stage" : "one-stage"` 分支已删除 2026-11-13）
9. `try { await runOneStageBatches(...) } finally { releaseLock; writeRun(runs.jsonl) }`（旧 `twoStage ? runTwoStageBatches : runOneStageBatches` 分支已删除，现仅一段式）

### 2.1 一段式批次循环 `runOneStageBatches`（`pipeline.ts:212-447`）

#### 步骤 A：序列化压缩 — 【确定性代码】

- `batchChars = opts.batchChars ?? 12000`（`:220`）
- `lines = serializeForExtract(pending)`（`compress.ts:285`）— **分级压缩**，见 §2.2
- `stats = compressStats(lines)` → 写入 `report.compressFallback/noGain/ratio`（`compress.ts:416`，`:223-225`）

#### 步骤 B：分批 — 【确定性代码】

- `batches = batchByTurn(lines, batchChars)`（`compress.ts:381`）— **按轮次对齐**，一轮对话（一个 user 到下一个 user 之前）绝不切开；单轮超限自成一批
- `maxBatches = min(opts.maxBatches, batches.length)`（`:229`）
- `knownCards = opts.knownCards ?? recentCardTitles(atomsPool, 40)`（`:230`，`pipeline.ts:200`——非 data 层卡片首行 ≤60 字）

#### 步骤 C：逐批处理（`:233-446`）

每批：
1. signal / budget 检查（`:234-238`）—【确定性代码】
2. `batch = batches[i]`；`ov = overlap && i>0 ? overlapTurn(batches[i-1]) : []`（`compress.ts:409`，上一批最后 1 轮只读上下文）—【确定性代码】
3. **【LLM 调用】** `res = await runOneStageBatch(batch, { model, signal, overlap: ov, domainOptions, knownCards, domainHint })`（`one-stage.ts:455`）— 一次调用做完 检测+成卡+定性+drop记账，见 §2.3
4. `report.tokensIn/Out += ...`；`res.attempts > 1 → retriedBatches++`（`:256-258`）—【确定性代码】
5. **格式闸**：`if (!res.output.formatOk) → stopped = "format invalid: ..."; break`（`:261-264`）— 不推进水位，下次重扫这段。【确定性代码】
6. 构造 quote 逐字校验比对对象：`userIdSet` / `lineText` / `lineIdx` / `textsInRange(msgIds)`（`:269-276`）—【确定性代码】。比对对象 = 模型实际看到的压缩文本（不是原始会话日志），因为原始日志 tool-call arguments 是 JSON 字符串（换行被转义），拿它做子串匹配会误判（`:266-268` 注释）
7. **逐卡后处理**（`:311-351`）— 见 §2.4，全部【确定性代码 + 混合（LLM 输出已定）】
8. **收口不变式**：批内每条 user 消息最终必须有归属（`:352-397`）—【确定性代码】，见 §2.5
9. 报告计数累加（`:399-404`）—【确定性代码】
10. **drop 账落盘**：`if (!dryRun) appendDrops(...)`（`:407-412`）—【确定性代码】
11. **落库**：`if (batchNew.length > 0 && !dryRun) appendAtoms(batchNew)`（`:414-422`）—【确定性代码】
12. **推进水位**：`if (!dryRun) appendReviewed({ start, end, kind: "extract" })`（`:425-432`）— 整批成功（含 no_value 否决权）才推进。【确定性代码】
13. `onProgress?.(...)`（`:435`）

### 2.2 压缩（`compress.ts`）— 【确定性代码，全量】

**压什么**：逐条消息 → `ExtractLine`（带 id / role / turn / text / rawChars / fallback / noGain / droppedChars）。`serializeForExtract`（`:285`）。

**分级策略**（`:285-374`）：
- **user**：全文 ≤ `userChars`（默认 4000）；harness 元数据噪声（时间戳块等）整条丢弃（`isHarnessNoise`，`:132`）——实测 64 条 user 有 22 条纯元数据
- **assistant**：text 块全收 + tool 调用按 `compressArgs` 压（`:313-330`）；中间消息 `headTail` 首尾各 500 字（`assistantChars`）
- **tool 参数**（`compressArgs`，`:181`）：命令行 / 代码块完整保留 ≤ `commandChars`（默认 2000）；结构化大参数只留键名 + 前 `argsChars`（80）字；**命令行被截断 → 触发 fail-safe 整条透传**（`truncated && kind === "command"`，`:321`）
- **toolResult**：有报错行 → stderr/报错行全文 ≤ `stderrChars`（800）+ 首行；无报错 → 仅首行 + 长度 + 凭证（`:334-372`）

**fail-safe 断言**：`assertErrorLinesKept`（`:78`）——原文每条报错行（`ERROR_LINE` 正则，`:55`）必须在压缩结果里逐字存在，不过 → 整条原样透传（`fallback: true`）。

**取回凭证**：`placeholder`（`:89`）——压掉的大块留 `📦 [压掉 #id · 类型 · 原N字 · 保留] → 需要原文时报 need_context`。

**净收益检查**：`finalize`（`:264`）——压完不比原文小（`body.length >= raw.length`）就不压（`noGain: true`）。

**压缩比**：`compressStats.ratio = keptChars / rawChars`（`:432`）。

### 2.3 one-stage LLM 调用 `runOneStageBatch`（`one-stage.ts:455-495`）— 【LLM 调用】

- `validIds = batch.map(l => l.id)`；`userIds = batch.filter(role==="user").map(l=>l.id)`（`:460-462`）— 契约只对 user 消息强制交代
- `system = extractSystemPrompt()`（`:463`，`one-stage.ts:88`）— **字节级稳定**，不接受任何参数（吃 prompt cache）
- `user = buildUserPrompt({ overlap, batch, domainOptions, knownCards, domainHint })`（`:464`，`one-stage.ts:182`）— 所有变化内容在这
- `while (attempts <= retries=1)`：`chatComplete({ system, user, model, signal })`（`:484`）→ `parseOneStageOutput(res.text, validIds, { userIds })`（`:488`，`one-stage.ts:237`）
- `if (last.formatOk) break`——合格（含 no_value）立即返回，不追问（veto 边界）
- 重跑用尽仍不合格但 JSON 合法 → `autoFillDrops(last)`（`:493`，`one-stage.ts:350`）代码兜底补账

**prompt 全文要点**（`extractSystemPrompt`，`one-stage.ts:88-167`）：
1. 三条判定轴（稀缺性/验证性/复现性，任一为零进 drops）
2. 价值分级 P0(人→模型)/P1(世界→模型)/P2(文档→模型)/P3(模型自说自话，一律不许出卡，必进 drops)
3. **反摘要禁令**：不是总结对话，是筛选稀有高价值信号；0 张卡正常；不叙述流程、不概括助手解释长文、卡片去语境化
4. **§三bis 状态快照/已结案复盘一律进 drops**（复现性=0 最常漏网）：库存清单/当前缺口 TODO/已修 bug saga/被推翻旧口径
5. 8 类型枚举 + 各类型必填结构化字段（sop→step；spec→concept_name+definition；template→template_name+skeleton；case→case_name+solution；postmortem→problem+root_cause；convention/index→concept_name+definition+expires_when；rubric→concept_name+definition）
6. 逐字保留清单（文件路径带行号、函数签名、报错堆栈、精确值、决策带"因为"）
7. 引用与接地（source.msg_ids 真实 id；quote 逐字 ≤120 字；grounding G1/G2/G3，G4 不输出；历史写成历史不是祈使句）
8. 输出 JSON `{cards:[...], drops:[...], no_value:bool}`
9. 规则：cards 空则 drops 或 no_value 必有一个（缺账=不合格）；每条 user 消息必须有归属；value 只能 P0/P1/P2；need_context 只填被压缩消息缺信息的

**输出 schema**（`OneStageOutput`，`one-stage.ts:62-77`）：
```
{ cards: OneStageCard[], drops: OneStageDrop[], noValue: bool,
  formatOk: bool, formatError?: string, jsonOk: bool,
  unaccounted: string[], userUnaccounted: string[], autoDropped: number }
```
`OneStageCard`（`:41-54`）：`type / title? / body / why_lose / expires_when? / domain / source{msg_ids,quote} / grounding? / value? / need_context? / [特化字段]`

**transience flag**：不是 one-stage 输出字段——是 `admission.ts:transienceFlag`（`admission.ts:196`）的代码判定，且 `checkTransience` **默认关**（`admission.ts:237`），prompt §三bis 才是主防线。当前 pipeline 调 `admissionGate` 时**没传 checkTransience**（`pipeline.ts:323-333`），所以 transienceFlag 实际不触发硬拒，只靠 prompt 约束。

**copy ratio 怎么算**（`one-stage.ts:217-230`）：
- 方向：`copyRatio(source=原文, body=卡片正文)`——正文 16 字碎片有多大比例逐字出现在原文里
- 正文 ≤ 16 字 → `s.includes(b) ? 1 : 0`
- 否则按 shingle=16 滑动窗口统计 `hit/total`
- 比对对象 = `textsInRange(card.source.msg_ids)` 全部原文（不是模型自己挑的 quote），见 `pipeline.ts:329-332`

### 2.4 成卡后处理（`pipeline.ts:311-351` + `one-stage.ts` 各函数）— 【确定性代码】

逐卡（`for (const card of res.output.cards)`）：

1. **`cardToAtom`**（`one-stage.ts:379`）：卡片 → `KnowledgeAtom`。
   - `isDocType(card.type)` 校验，否则返回 `{error}`（`:387`）
   - `rangeFromIds(entries, card.source.msg_ids)` → `[start, end]` 区间（`one-stage.ts:370`，按 entries 顺序取 min/max id）
   - `requiresExpiry(docType) && !card.expires_when` → error（`:390`，convention/index 必填失效条件）
   - 构造 `AtomSource{session_id, window_id: sig_..., msg_range}`、`atom_id = atomId(content, [source])`（sha1 前 12 位）
   - `category/atom_type/keep_as/why/expires_when/origin` 全查表推导（`admission.ts` DOC_TYPE_SPEC）
   - 结构化字段透传（只接受标量/标量数组，`:426-430`）
   - `extracted_by = "signal-distill"`、`status = "draft"`、`origin = "signal"`

2. **build 失败 → `reject("build", error)`**（`:313-316`）

3. **幂等**：`if (known.has(built.atom_id)) continue`（`:317`）

4. **`quoteIsVerbatim`**（`one-stage.ts:507`）：quote 是否逐字出自压缩文本（忽略空白差异）。**只打标记 `quote_verified`，不做硬闸门**（`:318-322`，2026-11-12 决议：实测 1/38 违规是"注释与代码不一致"的高价值卡，硬闸会误杀）

5. **`admissionGate`**（`pipeline.ts:323`，`admission.ts:249`）— 见 §2.6。失败 → `reject("admission")`

6. **`fillMissingSpecialized`**（`one-stage.ts:531`）：名字类字段（concept_name/template_name/case_name）用 title 代填；内容类字段不填只记 `pending_fields`。返回待补清单，`> 0 → pendingFieldCards++`（`:341`）

7. **`validateAtom`**（`pipeline.ts:342`，`validate.ts:59`）— `requireSpecialized: false`（抽取路径不强制特化字段）。失败 → `reject("validate")`

8. `seq++`；`known.add`；`batchNew.push(built)`；`needContext += card.need_context.length`（`:347-350`）

### 2.5 收口不变式（`pipeline.ts:352-397`）— 【确定性代码】

**契约**：批内每条 user 消息最终必须有归属（卡片区间 / drop 行）。
- `coveredByLanded`：落库卡片的 msg_range 覆盖的 id（`:356-367`）
- `droppedIds`：drops 的 msg_ids（`:368-370`）
- `orphanReason`：被拒卡片引用的 user 消息，若既不在 coveredByLanded 也不在 droppedIds → 孤儿（`:371-377`）
- `orphanReason.size > 0` → `orphanedByReject += size`；按拒因分组补记 drop 行（`:378-397`）

### 2.6 准入闸 `admissionGate`（`admission.ts:249-289`）— 【确定性代码】

规则（只回答"合不合法"，不回答"值不值得"）：
- `sources` 非空（`:252`）
- **secret + PII**：`checkSensitive`（`:136`）—— `SECRET_RE`（sk- 前缀）任何类型都拦；PII（手机号/邮箱/身份证）只对 `keep_as === "data"` 或 `doc_type === "case"` 硬拦（`:256`）
- **requireWhy**：`why` ≥ 8 字（`:261-263`）
- **hasGrounding**：`=== false` → 拒（区间内既无 user 也无 toolResult = G4 纯生成）。由 `isMechanicalG4`（`extract-core.ts:115`）算
- **copy ratio**：`copyRatio > copyMax`（默认 `COPY_RATIO_MAX = 0.6`）且 `bodyLen >= OVERLAP_MIN_BODY_CHARS`（100）→ 拒"摘抄不是提炼"（`:266-275`）
- **checkImperative**（默认关）：历史写成祈使句（`:278`）
- **checkTransience**（默认关）：状态快照/已结案复盘（`:283`）

> pipeline 调用时传 `{ requireWhy: true, hasGrounding: !isMechanicalG4(...), copyRatio: copyRatio(...) }`，**未传 checkImperative / checkTransience**——这两条靠 prompt §三bis 约束 + 人工抽检，不做硬闸。

### 2.7 校验 `validateAtom`（`validate.ts:59`）— 【确定性代码】

- 基础字段：`atom_id` 格式、`category ∈ {01-05}`、`atom_type ≥ 2字`、`content` 非空、`domain ≥ 2字`、`confidence ∈ [0,1]`、`version ≥ 1`、`status ∈ {draft,reviewed,published,deprecated}`、`extracted_by ∈ 枚举`、`extracted_at` 可解析
- `sources` 结构 + `window_id` 格式（`win_`/`decl_`/`sig_` 前缀）+ `msg_range` 长度 2
- **类型化准入**（带 doc_type）：`category` 与 doc_type 匹配；`requireSpecialized !== false` 时校验 `DOC_TYPE_SPEC[doc_type].required`；`why ≥ 8 字`；`requiresExpiry` 时 `expires_when` 非空
- `keep_as` 合法性 + 与 doc_type 匹配（case 例外：可在 reference/data 间选）
- `grounding ∈ {G1-G4}`
- 敏感信息复查

抽取路径传 `{ requireSpecialized: false }`（`pipeline.ts:342`）——特化字段不强制，缺了由 `fillMissingSpecialized` 记 `pending_fields` 供观测。

### 2.8 覆盖记账 — 【确定性代码】

- `coveredIds`（`coverage.ts:39`）：从 `atoms.sources[].msg_range` 反推（会话 id 按去连字符前 8 位匹配，`shortSessionId`，`coverage.ts:23`）+ `reviewedRanges`（已审但没产出卡片的区间，防无限重扫，`:67`）
- `coverageReport`（`coverage.ts:87`）：`{ total, covered, unreviewed }`
- 水位推进：`appendReviewed({ session_id, start, end, kind: "extract" })`（`pipeline.ts:426`）——整批成功才写

### 2.9 落库 — 【确定性代码】

- `appendAtoms(batchNew)`（`pipeline.ts:416`，`atom-store.ts:121`）——追加写 `atoms.jsonl`（单文件池，唯一事实源）
- `atom_id = sha1(content + sources)` 前 12 位 hex（`atom-store.ts:70`）——幂等去重

---

## 3. 两套引擎对比

### 3.1 one-stage（§三bis，`pipeline.ts` 在用）vs extractWindow（`extract-core.ts`，旧）

| 维度 | one-stage（当前主线） | extractWindow（旧，已死） |
|---|---|---|
| 文件 | `one-stage.ts` | `extract-core.ts:142` |
| 调用方 | `runPipeline`（`pipeline.ts:244`）默认路径 | **无**——`extractWindow` 全仓库无调用方（旧 `scripts/extract.ts` 已删，见 `design/TRIGGER_PLAN.md:306`） |
| 设计 | 一次 LLM 调用做完 检测+成卡+定性+drop记账 | 整窗 → 卡片（不知道哪里重要） |
| prompt 来源 | `extractSystemPrompt()`（`one-stage.ts:88`，字节级稳定常量）+ `buildUserPrompt`（拼装 overlap/batch/domainOptions/knownCards） | `buildSystemPrompt()`（`prompt.ts:50`，常量含 TYPE_TABLE）+ `buildUserPrompt(windowText)`（`prompt.ts:86`，仅窗口文本） |
| 输出 schema | `{cards:[...], drops:[...], no_value}` | `{atoms:[...]}` |
| 调 LLM 次数/批 | 1 次（格式不合格重跑 1 次，最多 2） | 1 次/窗 |
| 压缩 | `serializeForExtract`（`compress.ts`，分级 + fail-safe + 轮次对齐） | `serializeEntries`（`serialize.ts`，旧截断） |
| 分批 | `batchByTurn`（按轮次对齐，不切开一轮） | `buildWindows`（`window.ts:106`，user 对齐，50 条/窗 40000 字符） |
| drop 记账 | 有（cards/drops/no_value 三选一，缺账重跑 + 兜底补账） | 无（只产 atoms，rejected 不留 drop 账） |
| user 消息归属契约 | 有（强制每条 user 进卡或进 drop） | 无 |
| 准入 | `admissionGate` + `copyRatio` + `isMechanicalG4` | `admissionGate` + `isMechanicalG4`（无 copyRatio） |
| 校验 | `validateAtom(requireSpecialized: false)` | `validateAtom(catalog)`（旧 catalog 枚举） |

### 3.2 旧两段式（trigger-scan → knowledge-extract，`twoStage: true` 后面）

仍在 `pipeline.ts:450-534`（`runTwoStageBatches`），仅对比期验收用（`pipeline.ts:12-13` 注释）：
- 第一段：`scanBatch`（`trigger-scan.ts:210`）→ 候选 `{msg_id, kind, reason}`
- 第二段：`extractCandidates`（`knowledge-extract.ts:219`）→ 卡片 `{atoms, dropped}`
- 两段各调 1 次 LLM/批（候选多时第二段按 batchSize=12 分批，多调）
- CLI `scripts/knowledge-extract.ts`（`scripts/knowledge-extract.ts:123`）单独跑第二段，但已标"已过时"（`scripts/knowledge-extract.ts:5`）

### 3.3 extractWindow 现在还有谁在用？

**无人调用**。`extract-core.ts` 全仓库仅 `isMechanicalG4` 被复用（`pipeline.ts:30`、`knowledge-extract.ts:20`）；`extractWindow` / `parseAtoms` / `normalizeAtom` / `acceptedOnly` 中，`normalizeAtom` + `isMechanicalG4` 仅被 `scripts/smoke-extract-principles.ts` 测试用，`extractWindow`/`parseAtoms`/`acceptedOnly` 本身已死代码。

---

## 4. LLM 调用点清单（skill 化的关键）

| # | 文件:行号 | 函数 | 用途 | 调几次 | prompt 来源 | 期望输出格式 | 解析方式 |
|---|---|---|---|---|---|---|---|
| 1 | `one-stage.ts:484` | `runOneStageBatch` → `chatComplete` | 一段式：检测+成卡+定性+drop记账（一次做完） | 每批 1 次，格式不合格重跑 1 次（最多 2） | system = `extractSystemPrompt()`（常量，字节级稳定，`one-stage.ts:88`）；user = `buildUserPrompt`（拼装 overlap/batch/domainOptions/knownCards/domainHint，`one-stage.ts:182`） | JSON `{cards:[OneStageCard], drops:[OneStageDrop], no_value:bool}` | `extractJsonFromText` + `JSON.parse` → `parseOneStageOutput`（`one-stage.ts:237`） |
| 2 | `trigger-scan.ts:217` | `scanBatch` → `chatComplete` | 旧两段式第一段：发现候选（不产卡片） | 每批 1 次 | system = `scanSystemPrompt()`（常量，`trigger-scan.ts:141`）；user = `buildScanUserPrompt(batchText)`（`trigger-scan.ts:162`，仅批文本 + "请标出信号"） | JSON `{candidates:[{msg_id,kind,reason}]}` | `parseScanOutput`（`trigger-scan.ts:167`），按 validIds 过滤幻觉 id |
| 3 | `knowledge-extract.ts:252` | `extractCandidates` → `chatComplete` | 旧两段式第二段：候选→卡片 | 每批（batchSize=12 候选）1 次 | system = `extractSystemPrompt(domainHint, domainOptions)`（**拼装**，`knowledge-extract.ts:93`，含主题清单）；user = `buildExtractUserPrompt(blocks)`（`knowledge-extract.ts:124`，候选锚点+扫描提示+上下文） | JSON `{atoms:[...], dropped:[...]}` | `parseExtractOutput`（`knowledge-extract.ts:140`） |
| 4 | `extract-core.ts:152` | `extractWindow` → `chatComplete` | 旧整窗引擎 | 每窗 1 次 | system = `buildSystemPrompt()`（常量，`prompt.ts:50`）；user = `buildUserPrompt(windowText)`（`prompt.ts:86`） | JSON `{atoms:[...]}` | `parseAtoms`（`extract-core.ts:29`） |

> **关键**：#1 是当前**唯一**的 LLM 调用点（`runPipeline` 默认路径，一段式）。**#2/#3/#4 已于 2026-11-13 删除**（旧两段式 + 旧整窗引擎退场）。skill 化的核心就是 #1 的 `extractSystemPrompt()` + `buildUserPrompt()`。

---

## 5. 确定性 vs LLM 拆分

| 引擎步骤 | 类型 | 归属 | 说明 |
|---|---|---|---|
| 触发闸（`shouldExtractOnTurn`） | 确定性 | **留 core** | stateless 数未审 user 轮 |
| 锁（`acquireLock`/`releaseLock`） | 确定性 | **留 core** | 进程内 + 文件锁，幂等保证 |
| 覆盖派生（`coveredIds`） | 确定性 | **留 core** | 从 atoms.sources 反推，无状态文件 |
| 窗口切分（`batchByTurn`） | 确定性 | **留 core** | 轮次对齐，绝不切开一轮 |
| 序列化压缩（`serializeForExtract`） | 确定性 | **留 core** | 分级压缩 + fail-safe + 取回凭证 |
| 压缩统计（`compressStats`） | 确定性 | **留 core** | 验收指标 |
| **检测 + 成卡 + 定性 + drop 记账** | **LLM prompt** | **skill 化候选** | `runOneStageBatch` 一次调用四件事，prompt = `extractSystemPrompt` + `buildUserPrompt` |
| JSON 解析（`parseOneStageOutput`） | 确定性 | **留 core** | extractJson + 归属核算 + formatOk 判定 |
| 格式不合格重跑控制 | 确定性 | **留 core** | veto 边界（no_value 不重跑） |
| `cardToAtom`（卡片→atom） | 确定性 | **留 core** | 类型查表、atom_id 计算、区间推导 |
| `quoteIsVerbatim` | 确定性 | **留 core** | 逐字校验（只打标记） |
| `copyRatio` | 确定性 | **留 core** | 16 字碎片滑动窗口，阈值 0.6 |
| `isMechanicalG4` | 确定性 | **留 core** | 区间内有无 user/toolResult |
| `admissionGate` | 确定性 | **留 core** | requireWhy / copy ratio / secret+PII / grounding |
| `fillMissingSpecialized` | 确定性 | **留 core** | 名字代填 + pending_fields 登记 |
| `validateAtom` | 确定性 | **留 core** | schema 约束 + 类型化准入 |
| 收口不变式（orphan 补账） | 确定性 | **留 core** | 被拒卡片 user 消息兜底 |
| `autoFillDrops` | 确定性 | **留 core** | 重跑后仍缺账的代码兜底 |
| 水位推进（`appendReviewed`） | 确定性 | **留 core** | 整批成功才写，断点续跑 |
| 落库（`appendAtoms`） | 确定性 | **留 core** | 追加写 atoms.jsonl |
| drop 账落盘（`appendDrops`） | 确定性 | **留 core** | |
| 运行账本（`writeRun` runs.jsonl） | 确定性 | **留 core** | |
| 旧两段式扫描 prompt（`scanBatch`） | LLM prompt | skill 化候选（若保留两段式） | 已边缘化 |
| 旧两段式成卡 prompt（`extractCandidates`） | LLM prompt | skill 化候选（若保留两段式） | 已边缘化 |

**必须留代码**（确定性保证，移到 agent 会失去）：窗口切分、压缩、覆盖记账、落库、水位推进、幂等（atom_id）、锁、准入闸（copy ratio 阈值 / secret+PII / grounding）、校验、收口不变式、autoFillDrops。

**可 skill 化**（LLM prompt 驱动）：检测、成卡、定性（类型/失效/损失）、drop 决策——即 `extractSystemPrompt()` 的全部内容 + `buildUserPrompt` 的拼装逻辑。

---

## 6. 数据结构

### 6.1 `MessageEntry`（`types.ts:25`）
```
{ type: "message", id: string, parentId: string|null, timestamp: string,
  message: AgentMessage { role, content?: string|ContentBlock[], toolCallId?, toolName? } }
```
与抽取有关的：`id`（水位/区间/幂等全靠它）、`message.role`（user/assistant/toolResult）、`message.content`（text 块 + toolCall 块；thinking 跳过）。

### 6.2 `KnowledgeAtom`（`atom-store.ts:22`）
关键字段（与抽取流程有关）：
- `atom_id`（sha1 前 12 位，幂等）、`content`、`domain`、`sources: AtomSource[]`
- `category`（01-05）、`atom_type`（细标签）、`doc_type?`（8 枚举）、`keep_as?`（instruction/reference/data）
- `why?`（价值理由 ≥ 8 字）、`expires_when?`（convention/index 必填）
- `status`、`extracted_at`、`extracted_by`、`origin?`（signal/harvest/rescue/backfill）
- `confidence`、`version`、`superseded_by`、`refs`
- `[k: string]: unknown`（各类型特化字段透传）

`AtomSource`（`atom-store.ts:16`）：`{ session_id, window_id, msg_range: [start, end] }`

### 6.3 `OneStageCard`（one-stage 输出，`one-stage.ts:41`）
```
{ type: string, title?, body: string, why_lose: string, expires_when?: string|null,
  domain: string, source: { msg_ids: string[], quote: string },
  grounding?: "G1"|"G2"|"G3", value?: "P0"|"P1"|"P2", need_context?: string[],
  [特化字段: step/concept_name/definition/...] }
```

### 6.4 `TriggerCandidate` / `ScanCandidate`（`trigger-scan.ts:32`）
```
{ msg_id: string, kind: "correction"|"decision"|"verified"|"artifact"|"domain"|"other", reason: string }
```

### 6.5 枚举取值

- **doc_type 8 枚举**（`admission.ts:15-24`）：`sop / spec / template / case / postmortem / convention / index / rubric`
- **status**（`validate.ts:24`）：`draft / reviewed / published / deprecated`
- **keep_as**（`admission.ts:28`）：`instruction / reference / data`
- **extracted_by**（`validate.ts:25-28`）：`llm-haiku / llm-flash / llm-gemini-flash / agent-tool / agent-tool-dsh / offline-pipeline / compaction-rescue / signal-distill`（一段式固定 `signal-distill`）
- **value**（`one-stage.ts:31`）：`P0 / P1 / P2`（P3 不许出卡）
- **grounding**（`validate.ts:39`）：`G1 / G2 / G3 / G4`（G4 不输出）
- **drop axis**（`one-stage.ts:34`）：`稀缺性=0 / 验证性=0 / 复现性=0 / —`

---

## 7. 已知的 skill 化阻力

### 7.1 动态上下文注入（拼装 prompt）

- **`buildUserPrompt`**（`one-stage.ts:182`）拼装了 4 类动态内容：`overlap`（上一批最后 1 轮）、`batch`（本批压缩文本）、`domainOptions`（已有主题清单）、`knownCards`（判重用近期卡片标题）。skill 化后 SKILL.md 是静态的，这些动态上下文必须由 agent 在运行时从 core 拿到（core 仍负责压缩/分批/主题清单/knownCards 派生），作为"任务输入"喂给 agent，而不是写死在 SKILL.md 里。
- **`extractSystemPrompt`**（`one-stage.ts:88`）本身字节级稳定（故意如此吃 prompt cache）——这部分**天然适合直接变成 SKILL.md 正文**。
- 旧两段式 `extractSystemPrompt(domainHint, domainOptions)`（`knowledge-extract.ts:93`）把主题清单拼进 system prompt——skill 化时要把这种动态段拆到 user 输入 / 任务参数里。

### 7.2 确定性后处理若移到 agent 会失去保证

- **`copyRatio` 阈值 0.6**（`admission.ts:153`）：16 字碎片滑动窗口，方向敏感（写反过一次，`one-stage.ts:206-216` 注释）。移到 agent 执行会失去确定性的方向保证和阈值一致性。
- **`transienceFlag`**（`admission.ts:196`）：中文机械判定误杀率高，当前**默认关**靠 prompt §三bis。若 skill 化把 §三bis 写进 SKILL.md，prompt 约束还在；但代码兜底 `transienceFlag` 若也移走，prompt 漏判时无兜底。
- **`autoFillDrops`**（`one-stage.ts:350`）：重跑后仍缺账的代码兜底——`jsonOk` 时才允许（否则会把整批伪造成"已审"永久丢消息）。这是对 agent 输出的确定性补丁，移走会失去"不让整批白跑"的安全网。
- **`fillMissingSpecialized`**（`one-stage.ts:531`）：名字类用 title 代填——名字替代名字是合理的确定性代填，移到 agent 会变成"模型自己决定填什么"，失去一致性。
- **`cardToAtom`**（`one-stage.ts:379`）：atom_id 计算（sha1）、区间推导、类型查表——这些是幂等和溯源的根，必须留代码。

### 7.3 必须留代码的约束

- **幂等**：`atom_id = sha1(content + sources)` 前 12 位（`atom-store.ts:70`）+ `existingAtomIds()` 去重。agent 无法保证确定性哈希。
- **覆盖记账**：`coveredIds` 从 atoms.sources 反推 + `reviewedRanges`——无状态文件，全靠代码派生。
- **水位推进**：`appendReviewed` 整批成功才写（`pipeline.ts:426`），断点续跑的根。agent 无法保证"整批原子性"。
- **锁**：`acquireLock` 进程内 + 文件锁（`pipeline.ts:147`），防重复跑烧 token。
- **落库**：`appendAtoms` 追加写 atoms.jsonl（`atom-store.ts:121`），单文件池唯一事实源。
- **收口不变式**：批内每条 user 消息必须有归属（`pipeline.ts:352`）——这是对 agent 输出的事后审计，必须由代码强制。
- **格式闸 + 重跑控制**：`formatOk` 判定（缺账/user 未交代）+ veto 边界（no_value 不重跑）——这是对 agent 输出的契约执行，必须留代码。

---

## skill 化切入点建议（< 200 字）

**直接变成 SKILL.md**：`extractSystemPrompt()`（`one-stage.ts:88-167`）的全部内容——三条判定轴、价值分级 P0-P3、反摘要禁令、§三bis 状态快照/已结案复盘进 drops、8 类型枚举+必填字段、逐字保留清单、引用与接地规则、输出 JSON schema。它本就是字节级稳定的纯指令，天然是 skill 正文。

**需要拆**：`buildUserPrompt`（`one-stage.ts:182`）的动态段（overlap/batch/domainOptions/knownCards）不能写死进 SKILL.md，要变成 core 注入给 agent 的"任务输入"——core 仍负责压缩、分批、主题清单派生、knownCards 派生，agent 只消费。

**必须留 core**：`cardToAtom`/`copyRatio`/`admissionGate`/`validateAtom`/`autoFillDrops`/`parseOneStageOutput`/覆盖记账/落库/水位/锁/幂等——这些是确定性保证，agent 输出后由代码强制审计与落地。
