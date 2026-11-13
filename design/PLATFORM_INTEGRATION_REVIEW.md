# AutoSkill ↔ qdoc.chat/mcp 平台接入 · 修改项 Review

> 基线：平台端接入说明（2026-11-12，见会话）+ AutoSkill4Personal 当前代码。
> 目的：把 9 项需求 + 宿主适配落成具体文件/函数修改项，供 review；review 通过后再实现。
> 原则：开发不依赖真实平台（mock 可测）；真实平台只用于最后统一验收。

---

## 一、现状盘点（改什么、不改什么）

### 已有可复用件（改/扩，不重写）

| 件 | 位置 | 复用点 |
|---|---|---|
| `usage-store` | `core/lib/usage-store.ts` | 已有 loaded/accepted/rejected/edited + `window_id` 幂等 → 直接转平台 audit 事件 |
| `apply-patches` | `core/lib/apply-patches.ts` | `base_skill_sha` 冲突检测 = 平台 `base_version` 概念；intake 提案 = push 源 |
| `skill-provider` | `adapter-dsh/src/skill-provider.ts` | `list()`/`get()` 读路径 → 扩展为合并「远程候选 + 本地 atoms 候选」 |
| `skill-contract` | `core/lib/skill-contract.ts` | SKILL.md frontmatter(name/description) + references/ → 平台 `files[]`（SKILL.md 必含根） |
| `HostContext` | `core/lib/context.ts` | host/dataDir/skillsDir/homeDir 注入点 → 加 `platform` 凭据字段 |
| `package-skill` | `core/scripts/package-skill.ts` | pi 侧 cards → `~/.pi/agent/skills/<domain>/SKILL.md`，已幂等覆盖 |
| **atoms（文档沉淀源）** | `core/lib/atom-store.ts` | `KnowledgeAtom` 已有 `doc_type`(8类)、`status:draft/published`(确认留存闸)、`keep_as:instruction/reference/data`(去向分流)；`assemble.ts --published-only` 已按 published 过滤 → 平台 document 直接映射 published atoms / cards |

### 全新件（零远程能力，新建）

当前 `grep -rliE "qdoc|mcp|audit|bearer"` 命中的都是 LLM base URL 里的 http，**无任何平台/MCP/audit/token 代码**。需新建平台层 `core/lib/platform/`：

- `client.ts` — MCP(Streamable HTTP) + FS(ETag) + audit 三合一客户端
- `token-store.ts` — 凭据存储（按宿主降级链）
- `materializer.ts` — 技能物化（临时目录 + 原子 rename）
- `sync.ts` — 推/拉编排
- `confirm.ts` — 二次确认门（端侧本地 diff + 下游引用，见 §三-C）
- `document-sync.ts` — published atoms / cards → 平台 document 的映射（**复用现有沉淀，不新建 store**，见 §三-F）

### 不改 / 边界

- **`atoms.jsonl` 永不传输**（原子知识 = 含 msg_range/sources/provenance 的原始事实源，本地唯一）。上行的是它的**确认视图**：published atoms 组装的 `cards/*.md`（→ 平台 document）+ 编译后的 skill（SKILL.md + references/ → 平台 skill）。
- AutoSkill **已有文档沉淀机制**（见 §一"已有可复用件" atoms 行）：`doc_type`+`status:published`+`keep_as` 三字段 + `cards/` 组装视图。**不新建 doc-store**。
- `intake/*.patch.json` 本地提案队列不动；push 是它的事后副作用。
- core 仍零宿主依赖——平台层放 `core/lib/platform/`，宿主差异由 adapter 注入凭据/路径（不重新耦合 core）。

---

## 一-bis. 实测平台状态（2026-11-12，真实 token 只读探查）

用提供的 `qdoc_...` token 对 live `qdoc.chat` 做只读探查（未做任何写操作；audit 探查发了一条幂等 probe 事件，window_id=`probe-2026-11-12-001`，重发已 dedupe）。**实测推翻 doc 的"MCP 是全量通道"假设**：

| 通道 | 实测 | 结论 |
|---|---|---|
| **FS 读 skill** | `GET /api/fs/skills/index.json`→200（**6 skill**：asd-ste100/beautiful-article/karpathy-guidelines/motion-showreel/web-design-engineer/+1）；`/{slug}`→文件清单 `[{path,size,hash}]`；`/{slug}/{path}`→内容 + `etag`=sha256 | ✅ **§三-D pull 设计完全验证**（index hash 对比→逐文件 If-None-Match→304/ETag→materializer） |
| **audit 上报** | `POST /api/fs/audit`→200 `{"accepted":N,"deduped":M}`，window_id 幂等 dedupe 实测生效 | ✅ **§三-E report 设计完全验证** |
| **MCP** | `POST /mcp`→200 `text/event-stream` + `mcp-session-id`；`tools/list`→**8 工具**；`tools/call list_available_skills`→6 skill（**每 skill 一个 content 块**，非单块数组）；`search_documents`(空 query)→0 文档 | ✅ **MCP 已起**（offerlai/1.30.0，Streamable HTTP+SSE）。**纯 `fetch` 验证通过**（§六-2 选型②定）。缺 `read_document_content`（8 非 9），doc 正文读待补 |

**对可建性的影响（MCP 已起，全通道可真实验收）**：
- **三个通道全活**：FS 读 skill、audit 上报、MCP（8 工具：skill 读/写 + doc 读/写）。**推/拉/报 + doc 读写全部可立即真实验收**（token 已就位）。
- **client.ts 用纯 `fetch`**（§六-2 选型②定，实测 Streamable HTTP+SSE 纯 fetch 可搞定，无需 MCP SDK）：MCP 走 POST+SSE 解析 + `mcp-session-id`；FS 走 GET+ETag；audit 走 POST。
- **unwrap 注意点**：本平台 MCP 的 `tools/call` 结果是**多 content 块**（每块一个 JSON 对象，如 list_available_skills 的 6 skill = 6 块），非标准单块数组——`unwrap()` 须按块解析再聚合（兼容 structuredContent / 单块 / 多块三态）。
- **已知小 gap**：MCP 仅 8 工具，缺 `read_document_content`——doc 正文读暂只能靠 `read_document`（doc 说只回元信息）；等平台补 content 工具再切。不影响 push/doc 写。
- **onboarding**：首装 `list_available_skills`→报"远程 N skill"，`search_documents`→报"M 文档"（实测当前 M=0，空库属正常）。

> 注：探查仅读 + 一条幂等 probe audit；未触发任何 skill/doc 写入、未改动平台数据。

---

## 二、修改项总览表（9 点 + 宿主适配）

| # | 需求 | 修改项 | 复用/新建 | 宿主差异 |
|---|---|---|---|---|
| 0 | 安装步骤 | onboarding：connect → tools/list → list_available_skills → 报"远程 N skill / M 文档"→ 问是否同步本地文档 | 新 `platform-cli.ts` + adapter hook | pi/dsh 各一入口 |
| 1 | 推拉报 | 三模式编排 `sync.ts` | 新建，接 usage-store/apply-patches/skill-provider | — |
| 2 | 原子不传输 | push 源 = skillsDir 产物 + published atoms(cards)，**不读 raw atom-store**（不带 msg_range/sources/provenance） | 约束（边界测试） | — |
| 3 | 改/建 doc·skill 二次确认 | `confirm.ts`：本地 apply 后、push 前，**端侧本地算 diff**（base vs new）+ 列已知下游引用作影响面 → 用户确认 → 带 base_version push | 新建 | — |
| 4 | token 更新 | `token-store.ts` + grace 检测（`_notice`/`X-Grant-Status`）→ 提示换证；401 清证重接入 | 新建 | 凭据降级链按宿主 |
| 5 | skill 变化端侧更新 | FS `index.json` hash 对比 → 增量 materialize | 新 `materializer.ts` | 写入 skillsDir(pi)/provider(dsh) |
| 6 | 调用统计 | usage-store → audit 队列 → `POST /api/fs/audit`（批量、window_id 幂等、失败静默） | 扩 usage-store | — |
| 7 | 宿主适配 | adapter-pi / adapter-dsh / skill-provider / cordis.patch / 凭据降级链 | 各扩 | 见 §五矩阵 |

---

## 三、逐项详述

### A. 平台客户端层（新建 `core/lib/platform/client.ts`）

- **MCP**：Streamable HTTP `https://qdoc.chat/mcp`，每请求 `Authorization: Bearer`。TS 客户端两条路（**待定，见 §六-2**）：① `@modelcontextprotocol/sdk` 官方 TS；② 自写 JSON-RPC over `fetch`（依赖更少，符合"无 lockfile、靠宿主依赖"现状）。
- **FS**：`GET /api/fs/skills/index.json` + `/{slug}/{path}` 带 `If-None-Match`，处理 `304`/`ETag`。
- **audit**：`POST /api/fs/audit`，批量 events。
- 9 个 MCP 工具薄封装：`listAvailableSkills`/`getSkill`/`importSkillFromFiles`/`updateSkill`/`searchDocuments`/`readDocument`/`readDocumentContent`/`createDocument`/`updateDocument`。
- `unwrap(result)`：兼容 `structuredContent` 与 `content[0].text`（SDK 版本差异）。
- **mock**：`setPlatformClient(mock)` 注入测试，与 `setChatCompleter` 同模式。所有 9 工具 + FS + audit 用 mock 覆盖。

### B. 安装 / onboarding（需求 0）

新 CLI（或 adapter activate hook）`platform-connect`：
1. 读 token（降级链：`--token` > keychain > env `AUTOSKILL_PLATFORM_TOKEN` > homeDir 配置）。
2. `initialize` + `tools/list`（动态拿工具 schema，不硬编码）。
3. `list_available_skills` → 远程 skill 数；`search_documents`（limit 1 取 total 或分页估）→ 远程文档数。
4. **提示**：「已连接平台；远程 N 个 skill 可用、M 篇文档可访问。是否将本端已有文档同步到平台？」
5. 用户 yes → 走 push 流程（§C，带二次确认）。
6. 调 `list_available_skills` 顺带刷新接入页 `last_used_at`（任意一次 MCP/FS 调用即刷新）。

### C. 推 push（需求 1、2、3）

- **源**：`apply-patches` 落地后的 `skillsDir/<domain>/`（SKILL.md + references/，→ 平台 skill）+ **published atoms 的 `keep_as ∈ {reference,data}` 子集**（→ 平台 document）。**绝不读 raw atom-store**——边界单测断言 push payload 不含 `msg_range`/`sources`/`atom_id` 等原子溯源字段（只传 clean content + name + namespace）。
- **skill push**：
  - create → `import_skill_from_files({name,description,files[]})`（files 含根 SKILL.md；≤50 文件、单 1MB、总 2MB——超限拆分或截断 references）。
  - update → `update_skill({skill_id,files[],base_version})`，`base_version` 来自上次 `get_skill` 的 `version`（**对齐本地 `base_skill_sha` 语义**：失配=冲突，重拉重做，不强写）。
  - `applied=pending`（预置/自建技能）→ 提示用户去平台审核，不假装生效。
- **doc push**：published reference/data atoms（或其组装的 `cards/<cat>/<domain>.md`）→ `create_document` / `update_document`，`base_version` 来自 `read_document*`/`search_documents` 的 `version`；`namespace`=domain、`tags`=[doc_type, category]。
- **二次确认门 `confirm.ts`（需求 3，端侧本地降级方案）**：
  1. 本地 apply 成功后，**不立即 push**。
  2. **端侧本地算 diff**：base_version 对应的旧内容 vs 新内容（skill 比 SKILL.md sha、doc 比 content），产出"新增/修改/删除了哪些段"的摘要。
  3. **端侧列已知下游引用作影响面**：扫本地已编译 skills 的 references/ + cards/ + published atoms 里对该 slug/doc_id 的引用（grep），列"哪些 skill/doc 依赖它"。
  4. 展示 diff + 下游依赖给用户确认 → 才执行 push。
  - 不依赖平台"影响识别"工具（平台 9 工具无此能力）；后续平台若补 `preview_change` 再切到平台侧识别。

### D. 拉 pull（需求 1、5）

- **触发**：启动同步 + on-demand `platform-sync`。
- **流程**（平台 §4.1）：
  1. `GET /api/fs/skills/index.json` → `[{slug,name,description,hash,updated_at}]`。
  2. 本地 manifest（`skillsDir/.platform-manifest.json`）对比 `hash`；未变跳过。
  3. 变化的 → `/{slug}` 得文件清单 → 逐文件 `If-None-Match:<hash>`，304 跳过。
  4. `materializer`：写临时目录 `.<slug>.tmp/`，全成功后原子 rename 到 `skillsDir/<slug>/`（避免半套技能）。
- **dsh 形态**（无落盘）：materialize 到 provider 缓存目录，`skill-provider.list()` 合并远程候选。
- **403 总开关**：区分 scope 不足 vs `skills_enabled=0`，不一律当 token 失效。

### E. 报 report（需求 1、6）

- **源**：`usage-store` 的 `usage.jsonl`（已记 loaded/accepted/rejected/edited，带 window_id）。
- **映射**：本地 `loaded/accepted/rejected/edited` → 平台 audit 同名事件；`asset`=skill 用 slug / doc 用 doc_id。**新增 doc 事件**（当前 usage-store 只 keyed by skill——扩 `asset_type` 字段，skill/doc 二分）。
- **队列**：`audit-queue.ts`，批量、异步、`window_id+asset_type+asset+event` 幂等 dedupe、失败静默（审计不阻塞主流程，对齐 usage-store "append-and-forget"）。
- **client/User-Agent**：设置 `autoskill/<host>/<ver>`，便于接入页指纹。

### F. token 轮换（需求 4）

- `token-store.ts`：明文只签发时返回一次；本地存 SHA-256 校验用、明文存 keychain。
- **grace 检测**：MCP 结果 `_notice` / FS 响应头 `X-Grant-Status: grace` + `X-Grant-Grace-Until` → 提示用户去接入页换证（旧证 24h 宽限仍可用）。
- **401**：停止重试，清本地 token，提示重新 `platform-connect`（不无限重试）。
- **重新生成**：旧证 24h 宽限——端侧在宽限期内用旧证继续工作 + 提示，到期自动失效切到"需重接入"。

### G. skill 变化同步（需求 5）

= §D pull。补充：
- 本地新建/编译的 skill 若**未 push**，pull 不会覆盖（pull 只动 manifest 里已知的远程 slug）。
- 远程 skill 被删 → index.json 无该 slug → 端侧删本地缓存（404 处理：删本地缓存，对齐平台 §7）。

### H. 调用统计 which doc/skill（需求 6）

- `usage-store` 已按 skill 记账；扩 `asset_type` 后 doc 也记。
- 新查询 `usageByAsset()`：按 skill/doc 聚合 loaded/accepted/rejected/edited 计数 → `platform-stats` CLI 输出"哪些 skill/doc 被用、各多少次"。
- 上行 = §E audit；本地查询 = usage-store 直读。

---

## 四、安装步骤（端侧首次，需求 0 落地）

```
1. 用户在平台「仪表盘→接入设置」复制 qdoc_... 通行证（默认 30 天全量）
2. 端侧首次启动（或 autoskill platform connect）：
   a. 提示粘贴 token（写入 keychain，不进日志/URL）
   b. initialize + tools/list（确认平台工具版本）
   c. list_available_skills → 远程 skill 数 N
   d. search_documents → 远程文档数 M
   e. 提示：「已连接平台，远程 N skill / M 文档可访问。是否同步本端文档到平台？」
   f. yes → 对每个确认留存文档走 §C push（带二次确认）
   g. 增量 pull 远程 skill → materialize 到 skillsDir
   h. 后台 audit 队列启动
3. 接入页轮询 last_used_at → 显示「已连接 / 客户端 autoskill」
```

最小 scope 建议：只读端侧只申请 `skill:read`+`document:read`，不申请 write/update（§2.3 最小权限）。

---

## 五、宿主适配矩阵（需求 7）

| 宿主件 | skill 落点 | token 来源（降级链） | 平台接入 hook | 改动 |
|---|---|---|---|---|
| **adapter-pi** | `~/.pi/agent/skills/<domain>/`（文件） | `--token` > keychain > `AUTOSKILL_PLATFORM_TOKEN` > `~/.pi/agent/autoskill.json` | knowledge-capture.ts 启动时 connect+pull | materializer 写 pi skillsDir；token 读 pi 配置 |
| **adapter-dsh** | skill-provider registry（可不落盘） | `--token` > keychain > env > cordis.patch.yml 内 `platform.token` | index.ts activate 时 connect+pull | provider 合并远程候选；token 从 cordis 配置 |
| **skill-provider** | — | — | `list()`/`get()` 合并远程 | 扩：远程 slug 作候选（source=`platform`，rank 高于 atoms）；get 远程走 FS/MCP |
| **cordis.patch** | — | cordis.patch.yml 携 `platform.{url,token,scopes}` | 插件生命周期挂 connect/sync/audit | patch.yml 加 platform 配置块；index.ts 注册 platform hooks |
| **凭据降级链** | — | 显式 `--token` > keychain > env > homeDir 配置 > （无则降级为离线） | 统一在 `token-store.ts` | 每宿主只改"homeDir 配置"那一档的路径 |

**降级链语义**：高优先级档有值就用它；全空→平台功能离线降级（本地 skill/atom 仍可用，只是不推拉报）。绝不因缺平台凭据阻塞宿主主流程。

---

## 六、风险与未决（需 review 定夺）

> **已决议**：① 文档沉淀复用现有 atoms(published + keep_as) / cards，**不新建 doc-store**；② 二次确认用**端侧本地算 diff + 列下游引用**降级方案，不依赖平台影响识别工具。

1. **`keep_as` 未填充（doc/skill 分流的真 gap）**：`keep_as: instruction/reference/data` 字段已声明，但 one-stage 抽取器没 set（admission 只用它做 PII 检查）；现有 kb 453 条全缺。要让 doc push 准确取 `reference/data` 子集、不与已进 skill 正文的 `instruction` 重复，需补 keep_as 赋值。两条路：
   - (a) 在 admission/抽取器里按 doc_type 推断：sop/spec/convention/rubric→instruction（进 skill 正文）；case/template→reference（进文档）；data 类→data。
   - (b) 先不补 keep_as，doc push 用 doc_type fallback（case/template→doc），等 keep_as 落地再切精确分流。
   - **建议 (a)**：一次补到位，避免"先 fallback 再迁移"的脏数据。**待你定 a/b**。

2. **MCP TS 客户端选型 — 已定②自写**：实测 MCP 起来后，纯 `fetch`（POST+SSE 解析 + `mcp-session-id`）走通 initialize/tools/list/tools/call 全流程，**无需 `@modelcontextprotocol/sdk`**。理由同 `setChatCompleter` 轻依赖哲学。unwrap 须兼容三态（structuredContent / 单块 / **多块每块一对象**，后者是本平台实测形状）。

3. **references 超 2MB 总量**：apply-patches 可能产出 >2MB 的 references/。平台限 50 文件/单 1MB/总 2MB。需 push 前做**截断/分册策略**（SKILL.md 保留总览，references 按优先级截断或拆多个 skill）。**待定策略**（属 Phase 2 push）。

4. **dsh provider 合并远程候选的 rank**：远程 skill 与本地 atoms 候选同 domain 时谁优先？建议远程 rank 高于本地 atoms（远程是用户审核过的），但本地刚编译未 push 的应高于远程（最新）。**待定 rank 规则**。

5. **audit 事件 `edited` 无 window_id**：usage-store 注释说 edited 靠 appliedPatches 账本防重、不带 window_id；但平台 audit 幂等键 = `window_id+asset_type+asset+event`。需给 edited 补一个稳定 window_id（如 patch_id）。**小改 usage-store**（属 Phase 1 report，实测 audit 已验幂等生效）。

6. **真实平台验收口径**：token 已提供（存 `.tmp-qdoc/`，gitignored）；MCP 起来后**三通道全活**——FS/audit/MCP 均实测通过。**全链路（推/拉/报 + doc 读写）可真实验收**。开发仍全 mock，每步补一组 mock smoke；真实联调用 token 做最后验收（push 类操作需你显式确认再写真数据）。

---

## 七、实现顺序建议（MCP 已起，全通道可真实验收；开发仍 mock 驱动）

1. `core/lib/platform/client.ts`（纯 `fetch`：MCP Streamable HTTP+SSE + `mcp-session-id`；FS GET+ETag；audit POST）+ mock（`setPlatformClient`）+ **unwrap 三态**（structuredContent / 单块 / 多块每块一对象）
2. `token-store.ts` + 降级链（单测各宿主路径）
3. `materializer.ts` + **pull**（FS index hash 对比→逐文件 If-None-Match→304/ETag→临时目录+原子 rename）→ 真实验收拉 6 skill
4. `audit-queue.ts` + usage-store 扩 `asset_type`/`edited` 补 window_id（§六-5）→ **report** 真实验收看 accepted/deduped
5. **补 `keep_as` 赋值**（§六-1，按 doc_type 推断）+ `document-sync.ts`（published reference/data atoms → doc 映射，边界单测不含原子溯源字段）
6. **push**：MCP `import_skill_from_files`/`update_skill`（带 base_version）+ `create/update_document`；`confirm.ts`（端侧本地 diff + 下游引用扫描，§三-C）→ 真实验收（push 写操作需你显式确认）
7. doc 读：MCP `search_documents`/`read_document`（缺 `read_document_content`，正文读待平台补）
8. adapter-pi / adapter-dsh / skill-provider 接 pull+push / cordis.patch 接 platform 配置
9. onboarding CLI（connect→list_skills→报 N skill / M 文档→问是否同步本地文档→pull+push+audit）+ smoke（全 mock 闭环）
10. 真实平台全链路验收（推拉报闭环）

每步配 mock smoke 纳入 `npm run smoke`；真实联调每完成一段用 token 验（读类自动验，写类 push 需你确认）。

---

## 八、成果保存 + 用户触发词（新增需求 2、3）

### 8.1 平台方法实测（需求 1：使用方式有无变化）

实测 MCP `tools/list` 拿到 `import_skill_from_files` / `create_document` 完整 inputSchema，**与平台 doc 一致、无变化**：

| 方法 | 实测 schema | 与 doc |
|---|---|---|
| `import_skill_from_files` | `{name, description, files:[{path,content}]}`，必含根 SKILL.md；≤50 文件/单≤1MB/总≤2MB；导入后"未启用"，返 `{skill_id}` | 一致 |
| `create_document` | `{filename(.md), content_md(≤1MB), namespace_id?, tags?}` | 一致 |

→ client.ts 薄封装按此 schema 落地，无需适配变更。

### 8.2 成果保存（需求 2：对话产出物也存为有效文档）

**现状缺口**：当前 pipeline 只做"分析对话→抽知识 atoms"（去语境提炼），**不存产出物本身**。`trigger-scan` 虽有 `artifact` kind 候选，但只喂给 atom 抽取（变成"关于产出物的知识卡片"），产出物（agent 写的整篇 doc/总结/skill）没作为成品保存。

**成果（deliverable）三类**：

| 类型 | 例子 | 保存通道 | 现状 |
|---|---|---|---|
| ① 已编译 skill | `skillsDir/<domain>/SKILL.md`（apply-patches 产出） | `import_skill_from_files` | 已有产物，接 push 即可 |
| ② agent 撰写的独立文档 | 训练流程总结、设计稿、复盘报告、计划 | `create_document` | **新：无捕获路径** |
| ③ 对话里的"成果消息" | agent 最终实质产出（整段总结/方案） | `create_document` | **新：由 artifact 候选定位** |

**新增 `deliverable-capture.ts`**：
- 输入：trigger-scan 的 `artifact` kind 候选（msg_id + reason）+ 会话 entries。
- 定位成果消息（artifact 候选指向的 assistant 消息，取完整正文而非 headTail 截断版）。
- 组装 `content_md`：成果消息正文 → 清洗（去工具调用残留、补标题 = reason 摘要）。
- 输出 deliverable：`{filename, content_md, namespace=domain, tags=[deliverable, doc_type]}` → 走 `create_document`（带二次确认 §三-C）。

**边界**：成果文档（agent 完整成品，整篇存）≠ 原子知识（去语境提炼，atom 存）。两者都上行但通道分开——skill/document 走平台 skill/doc，atom 永不传。一条对话可同时产出 atoms（知识）+ deliverable（成品），互不替代。

### 8.3 用户触发词（需求 3：主动触发编译+保存，带二次确认）

**新增 `save_intent` 正则预筛层**（在 trigger-scan 的 LLM scan **之前**，快且确定；触发词来自 user 消息）：

- **唤醒词前缀**（可选，前缀任一命令）：`小q[，,]?\s*` —— 例 "小q，帮我总结成skill并保存远端"、"小q，你给我建议"、"小q，保存远端"。命中唤醒词即进入 save_intent 解析，后续命令同下两类。
- **直接保存型**：`总结成skill` / `总结成文档` / `保存远端` / `保存到平台` / `沉淀成` / `上传到平台`（含 `帮我…` 前缀：`帮我把…总结成skill` / `帮我保存…`）
- **建议模式型**：`你给我建议` / `有什么可以沉淀` / `能存什么` / `帮我看看能保存什么`

**正则结构**（`detectSaveIntent`）：
```
^(小q[，,]?\s*)?(帮我(把|把.*?)*?)?(总结成(skill|文档)|保存(远端|到平台)|沉淀成|上传到平台|你给我建议|有什么可以沉淀|能存什么|帮我看看能保存什么)
```
唤醒词 + 命令两部分：有唤醒词就走解析（即便命令词不全也进入建议模式兜底）；无唤醒词则按命令词精确匹配。

**命中 → 走"主动编译+保存"分支**（不进常规 atom 抽取，或并行）：

- **建议模式**（"你给我建议"）：端侧基于本会话的 `artifact` 候选 + 已编译 skills + published atoms，列出"可沉淀成果/skill 清单"（每条标类型 ①②③ + 预估内容），问用户选哪些 → 选中项走编译+确认+push。
- **直接保存模式**（"帮我把训练流程总结成skill并保存远端"）：
  1. **解析意图**：skill 还是 document？范围（哪个主题/哪段对话/哪个 artifact）？
  2. **编译**：skill → `generate-skill`(③) + `route-test`(⑤)；document → `deliverable-capture` 组装 content_md。
  3. **二次确认**（§三-C `confirm.ts`）：端侧算 diff（base vs new）+ 列下游引用 → 展示 → 用户确认。
  4. **push**：skill → `import_skill_from_files`；document → `create_document`。`applied=pending` / `pending_enable` → 提示用户去平台审核启用，不假装生效。

**所有触发词引发的保存都强制走二次确认**——不因用户说了触发词就自动写远端，必须 confirm.ts 放行。

### 8.4 衔接与实现（扩 §七）

- `trigger-scan.ts`：加 `detectSaveIntent(userMsg): SaveIntent | null`（正则导出，纯函数，单测覆盖各类触发词 + 负样本）。命中 save_intent 的消息走保存分支，不阻塞常规 scan。
- `deliverable-capture.ts`（新）：artifact 候选 → 成果消息定位 → content_md 组装 → deliverable 对象。
- `suggest.ts`（新）：建议模式——聚合 artifact 候选 + compiled skills + published atoms → 可沉淀清单。
- `confirm.ts`（§三-C）复用：触发词保存与常规 push 同走二次确认门。
- onboarding/CLI：加 `suggest` 命令（手动触发建议模式）+ adapter 监听 user 消息里的 save_intent 触发词。
- smoke：触发词正则（正/负样本）+ 建议清单生成 + 直接保存全 mock（编译→confirm→push）+ 二次确认拦截。

实现时序并入 §七 第 6 步之后（push 能力就绪后接 deliverable-capture + save_intent + suggest），属同一 Phase。

---

## 九、分层原则与重构（已完成）

**原则**：adapter 只含"和各 agent 运行时对接"的逻辑（注册钩子/工具、解析宿主 ctx、spawn 进程、桥接 LLM、落盘路径）；**具体如何抽取/编排，全在 core**。换宿主只改 adapter，不动 core。

**重构前的问题**：adapter-pi `knowledge-capture.ts`（482 行）和 adapter-dsh `tools.ts` 里混着 host 无关的编排——capture_knowledge 的入卡逻辑（建 atom+准入+校验+去重）在两个 adapter 各抄一份（仅 `extracted_by` 不同）；`kbStats`/`pendingNotice`/`maybeRunPipeline` 阈值/`spawnPipeline` 参数拼装也都散在 adapter。

**重构后（commit 已提交）**：

| 层 | 文件 | 职责 |
|---|---|---|
| **core** | `core/lib/capture-orchestration.ts` | host 无关编排：`kbStatusText` / `pendingNoticeText` / `shouldRunIncremental`+`runIncrementalPipeline`（待审≥5）/ `spawnPipeline`+`pipelineSpawnArgs` |
| **adapter-pi** | `knowledge-capture.ts` | 只留 setHostContext + pi 钩子/工具注册（session_start/before_agent_start/tool_call/kb_harvest/kb/kb_doctor）+ ctx 取 entries + spawn + 响应格式化 |
| **adapter-dsh** | `tools.ts` | kb_harvest 工具 + dispatch（spawn/in-process）+ session-read + credential-routing；kbStats 用 core |

**capture_knowledge 工具已去掉**（"agent 主动声明"不成立——实测无系统提示驱动 agent 自发调，实际是用户指认→agent 执行；和 §八 save_intent 用户主动保存同模式，且只存 atom 不存 skill/doc，职责重叠）。删：两 adapter 的 capture_knowledge 工具注册 + core `captureDeclaredAtom`/`CaptureDeclaration`/`CaptureContext`/`CaptureResult` + admission 死函数 `labelForType`/`ensureTypeFields`。`declaredSource` 保留（smoke 用 + 未来 save_intent 复用）。

**compaction 抢救 + quit 终采 + 手动 extract.ts 三条通道已去掉**（入口 5→2）：

- **compaction 抢救**（`session_before_compact`→`rescueAtoms` published floor 0.7）：唯一免审入口 + 最脆宿主耦合（dsh compaction 引擎 ×3 形状约束）。删 core `compaction-rescue.ts`、adapter-dsh `compaction.ts`、adapter-pi hook、cordis.patch `autoskill-compaction`、`@deepseek-ai/dsh-compaction-basic` 依赖。
- **quit 终采**（pi `session_shutdown(quit)`→`spawnPipeline`）：pi 专属，dsh 本无；去掉让 pi 对齐 dsh（都靠增量 + kb_harvest）。最后一轮的覆盖由增量阈值兜（见下）。
- **手动 extract.ts**（旧 `extractWindow` 引擎）：和 `pipeline.ts <session> --mode backfill`（one-stage）重复且引擎落后，删。离线 harvest 交给 pipeline.ts CLI。

补偿：增量阈值 `PIPELINE_MIN_PENDING` 30→5，让管线每轮及时覆盖（1 批/40k），闭合 compaction/quit 去掉后的覆盖缺口。保留 `validate.ts` 枚举 + `compile-skill.ts` rescueRatio 对历史 atom 向后兼容（优雅降级）。

**现余一入口 + 自动增量**：① kb_harvest 工具（detached spawn，用户/agent 调，大批量收尾扫）+ before_agent_start 每轮自动增量（待审≥5，1 批/40k，唯一真自动通道）。全部 draft + admission，无免审特例、无旧引擎分叉、无"agent 主动"理想化入口。

**验证**：smoke 31 PASS / 0 FAIL；`extractedBy` 实测 pi=`agent-tool` / dsh=`agent-tool-dsh`；两 adapter 导入只剩宿主依赖 + core 调用。

**对平台集成的约束**：平台层（client/sync/confirm/materializer/audit/token）全放 **core/lib/platform/**（逻辑，可 smoke）；adapter 只加"宿主钩子触发平台同步"的对接（如 pi `session_start` 调 core 的 pull、dsh `activate` 调 core 的 connect、两宿主监听 save_intent 触发词→调 core 编译+确认+push）。**平台逻辑零宿主耦合**，新宿主接入只写 adapter。
