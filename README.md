# AutoSkill

把 pi 对话中**正在流失的经验**沉淀为可路由的 skill：对话记录 → 知识卡片 → 整合 → skill。安装一次 extension，之后全自动。

```
对话(五入口) ──抽取──▶ 知识卡片池 atoms.jsonl ──整合──▶ skills/*.md ──体检──▶ 持续优化
                       （待办队列）      （agent 提案队列）     （darwin-skill）
```

## 什么时候抽取（五入口）

| 入口 | 触发时机 | 产物状态 |
|---|---|---|
| `capture_knowledge` 工具 | agent 刚得出结论/踩坑/方法时**单条声明** | draft · conf 0.8 |
| `kb_harvest` 工具 | 任务收尾、会话积累大量知识时，后台全量终采 | draft · conf 0.6 |
| compaction 抢救 | 长对话压缩前，自动抢救被压缩区（唯一免审入口） | **published** · conf≥0.7 |
| quit 终采 | `pi` 退出时 detached spawn 全量回扫 | draft · conf 0.6 |
| 手动回填 | 对历史 session 跑 `packages/core/scripts/extract.ts` 补抽 | 同上 |

所有入口共用一个引擎，已抽窗口自动跳过（幂等），绝不占用主对话轮次。

## 抽取什么（准入标准）

**三问定生死**，任一答"否"不入池（详见 [STORE_PLAN.md](design/STORE_PLAN.md)）：

| 问题 | 判据 | 反例 |
|---|---|---|
| **可再生吗** | 不存它，未来能否低成本重新得到 | 模型本来就会的通用问答 |
| **会改变动作吗** | 未来会不会影响某个做法或判断 | 只提供背景、不影响怎么做 |
| **说得出损失吗** | 能写出一句"不存会导致什么" | 写不出具体后果 |

**8 个文档类型**（模型只判类型，分类与去向由查表推导）：

| 类型 | 回答什么 | 去向 |
|---|---|---|
| `sop` | 按什么顺序做 | 技能正文 |
| `spec` | 什么算对 / 必须遵守（须有排他性） | 技能正文 |
| `template` | 填空就能用 | 技能正文 |
| `case` | 照着它做（含客户资料） | 依据区或资料层 |
| `postmortem` | 上次为什么炸（根因需证据） | 技能正文 + 依据 |
| `convention` | 这环境的规矩（须写失效条件） | 技能正文 |
| `index` | 东西在哪（须写失效条件） | **资料层** |
| `rubric` | 怎么打分 | 技能正文 + 依据 |

三条去向物理分离：**instruction**（技能正文）/ **reference**（技能依据区）/ **data**（资料层，不进正文）。只有 instruction 会进入组装与打包。

> 旧的三轴与 44 切片清单保留为历史设计（[EXTRACTION_PRINCIPLES.md](design/EXTRACTION_PRINCIPLES.md)、[SLICE_CATALOG.json](design/SLICE_CATALOG.json)）；新知识卡片按 8 类型分诊。

## 如何抽取

1. 会话按 **100 条消息 / 80k 字符**切窗，序列化后交 LLM（流式调用，思考 token 不限预算）
2. 单窗产出"最小单元"数组：`doc_type` + `why` + 落地证据；准入规则（来源/接地/敏感/价值理由）先筛，再按类型校验必填字段
3. `atom_id = sha1(content+sources)` 幂等，重复内容不重入库
4. LLM 配置**零额外配置**（见下文"配置"节）

## 知识卡片 → skill（整合）

**数据目录（重要）**：所有运行时知识数据（`atoms.jsonl`、`cards/`、`intake/`、`usage.jsonl`、`skill-state.json` 等）存放在 `~/.pi/agent/data/autoskill/knowledge/`，**不在包 checkout 内**——pi update 对 git 包执行 `git reset --hard` + `git clean -fdx`（`-x` 连 gitignored 文件一起删），包内数据会被无条件清空。`KB_DIR` 环境变量可覆盖此路径。迁移旧数据：把旧 `knowledge/` 内容拷入新目录即可。

- **增量整合（日常主路径）**：知识卡片即待办队列。pi 会话注入提示，agent 按 [INTEGRATE_GUIDE.md](design/INTEGRATE_GUIDE.md) 写提案到数据目录的 `intake/`；应用器 session_start 时串行消费（`base_skill_sha` 失配→丢弃→知识卡片退队列下轮重做——无锁并发，冲突只重做不丢失）
- **批量工具**：积压 >25 条或 bootstrap 时跑 `assemble.ts`（LLM 判重合并 → 5 类确定性组卡）+ `package-skill.ts`（生成路由 description，<15k 内联单文件否则拆 references）。agent 精修过的 skill 标注 `agent-maintained` 保护，批量不覆盖
- **编译主路径（确定性部分 + ③ 正文生成 + ⑤ 路由自测已实现）**：`compile-skills.ts` 先过**就绪门**（≥5 张卡、≥2 个会话、内容有变化、非短效知识）→ **选材器**打分排序并按 doc_type 正文预算分档 → 产出**编译简报** → `--generate` 调 LLM（简报 + 选中卡片完整正文 + create-skill 写法指引）生成 SKILL.md draft，validate 不过回喂重写最多 2 次 → 对 draft 跑 **M1/M2/M4/M5/M6 规则校验** → `--route-test` 路由自测（5 正+3 负探针，正 ≥4/5、负 ≥2/3，失败回喂重写 description 最多 2 次）→ 通过后写 intake 提案，`--apply` 读到失败的路由报告会拒绝（[SKILL_COMPILER.md](design/SKILL_COMPILER.md)）
- **双层输出**：抽取层纯经验（三轴守门）；SKILL.md 正文是经验 × 世界知识转化的操作指令（受最小绑定纪律约束，[EXTRACTION_PRINCIPLES.md §九](design/EXTRACTION_PRINCIPLES.md)），references/ 保留原始切片保真可溯源

```
atoms → intake提案 → apply-patches(base_skill_sha自愈) → skills
                                ↓ domainEdits ≥ 10
                    darwin 9维体检 → paired对比+投票棘轮 → --done记账

              旁路审计：tool_call hook + quit终采专项扫描 → usage.jsonl（loaded/accepted/rejected/edited）
                          └→ darwin 双轨触发（使用次数/拒绝率）──────┘
```

## 使用审计（usage.jsonl）

管道旁路账本（数据目录下 `usage.jsonl`），记录每个 skill 四类事件：

| 事件 | 来源 | 时机 |
|---|---|---|
| `loaded` | extension `tool_call` hook | 模型读取 SKILL.md 实时记录（模糊匹配，下界估计） |
| `edited` | apply-patches | 提案应用成功时追加 |
| `accepted` / `rejected` | quit 终采专项扫描 | LLM 判定读取后是遵循还是修正（窗口无 SKILL.md 字样则零成本跳过） |

## skill 保鲜（darwin 体检，双轨触发）

满足任一轨即提示按 [skills/darwin-skill](packages/core/skills/darwin-skill/SKILL.md) 做 rubric 9 维体检：paired 对比验证 + 投票棘轮（只保留实测不退步的修改）+ 人在回路确认。完成后 `packages/core/scripts/darwin-check.ts --done <domain>` 记账。`darwin-check.ts` 裸跑可看报表：各 skill 加载/采纳率/修改计数与零使用（💀）标记。

## 配置

抽取引擎复用你给 pi 配好的凭据，**装完即用，无需任何配置**：

- **extension 在场**（在线入口）：走 pi 的 ModelRegistry，与主对话同一条认证链（auth.json / models.json / 环境变量 / `!command`），模型跟随你当前会话模型
- **纯 CLI 进程**（quit 终采等）：降级链 `AUTOSKILL_PROVIDER/MODEL 显式指定` → settings.json 默认 provider → 扫 models.json → `OPENAI_API_KEY` 直连
- **dsh 形态**：优先走宿主 `ctx.llm`（凭据在 dsh 自己的 profile/credentials 里，不读 `~/.pi`）；只有 spawn 独立进程时退回环境变量链，`kb_harvest` 无 env 凭据时自动改用宿主进程内抽取
- 可选：`AUTOSKILL_MODEL=便宜模型` 一行切换；`/kb` 看状态，`kb_doctor` 工具自检链路

## 快速开始

### 安装

AutoSkill 是标准 [pi package](https://pi.dev/packages)（约定目录：`extensions/` + `skills/`），用 pi 原生包机制安装：

```bash
# 方式一：本地目录（试用/开发）——v2 是三分包 monorepo，pi manifest 在 adapter-pi 子包
pi install ./AutoSkill4Personal/packages/adapter-pi

# 方式二：git（免维护目录位置，pi 管理副本；指向 packages/adapter-pi）
pi install git:github.com/<you>/AutoSkill4Personal/packages/adapter-pi

# 方式三：发布到 npm 后
pi install npm:autoskill-adapter-pi
```

装完重启 pi 即生效。pi 会把包声明写入 `~/.pi/agent/settings.json`（本地安装记录相对路径，不含用户名；移动目录后重跑一次 `pi install` 即可）。

**验证**：任意会话里让 agent 运行 `/kb` 看知识库状态，或调用 `kb_doctor` 工具自检 LLM 链路。

前置要求：[pi](https://pi.dev) 已安装并配置好模型（抽取引擎复用你给 pi 配的凭据，见下文配置节）；Node ≥ 22.6（脚本用到 `--experimental-strip-types`）。

### 日常使用

装完即全自动，无需记命令：谈出有价值内容时 agent 会自主调 `capture_knowledge`；收尾说一句"收割一下本会话知识"触发 `kb_harvest`；退出 pi 自动终采；下个会话开头若有积压会收到整合提示，若某主题已过编译就绪门且内容有变化，还会收到一条"可编译主题"提示（编译简报 → create-skill → `--validate` → `--apply`）。

### 可选维护操作

```bash
# 手动回填历史 session
node --experimental-strip-types packages/core/scripts/extract.ts ~/.pi/agent/sessions/<id>.jsonl
node --experimental-strip-types packages/core/scripts/extract.ts ~/.pi/agent/sessions/  # 整目录

# 大积压时批量重建（会跳过 agent-maintained 的 skill）
node --experimental-strip-types packages/core/scripts/assemble.ts
node --experimental-strip-types packages/core/scripts/package-skill.ts --all

# 技能编译（确定性部分）：就绪门 + 选材 + 编译简报
node --experimental-strip-types packages/core/scripts/compile-skills.ts --all
node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> --force

# ③ 正文生成（调 LLM）：简报 + 选中卡片完整正文 + create-skill 写法指引 → draft
# validate 不过回喂 errors 重写（最多 2 次）；仍不过保留 draft、不生成提案
node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> --generate
node --experimental-strip-types packages/core/scripts/compile-skills.ts --generate <briefDir>/<主题>.brief.json

# 校验产出的 SKILL.md / draft（M1/M2/M4/M5/M6；M3 路由自测见下）
node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> --validate <SKILL.md>

# ⑤ 路由自测（调 LLM）：扫描 skillsDir 各技能构成竞争集合，5 正+3 负探针，
# 正 ≥4/5、负 ≥2/3 才过；失败回喂重写 description 最多 2 次；产物 <briefDir>/<主题>.route.json
node --experimental-strip-types packages/core/scripts/compile-skills.ts \
  --route-test <SKILL.md> --skills-dir ~/.pi/agent/skills

# 通过后写 intake 提案（--apply 读到失败的路由报告会拒绝；再跑 apply-patches，pi 宿主下次启动会自动消费）
node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> \
  --apply <SKILL.md> --skills-dir ~/.pi/agent/skills
```

## 目录结构

```
knowledge/
  atoms.jsonl          # 知识卡片池（唯一事实源，文件名保留旧叫法）
  usage.jsonl          # 使用审计日志（loaded/accepted/rejected/edited）
  skill-state.json     # 整合账本 + darwin 记账
  compile-state.json   # 技能编译指纹（内容有变化才重编）
  intake/              # agent 提案队列
  cards/               # 组装的知识卡片
  compile/             # 编译简报（<domain>.brief.md / .json）
packages/core/        # 抽取/分诊/整合/编译/打包引擎（零宿主依赖，数据目录由 HostContext 注入）
packages/adapter-pi/  # pi 宿主适配层（extensions 入口 + skills 约定）
packages/adapter-dsh/ # dsh 宿主适配层（DeepSeek Harness bundle，M1 起步）
design/               # 原理文档（原则/切片清单/schema/整合指引/DSH_PLUGIN_PLAN）
```
