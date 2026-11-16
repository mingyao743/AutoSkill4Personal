# AutoSkill

把 agent 会话中**正在流失的经验**沉淀为可路由、可保鲜、可分发的知识资产：

```
经验侧   会话记录 ──抽取──▶ 知识卡片池 ──整合/编译──▶ skills/*.md ──darwin 体检──▶ 持续优化
                              │
分发侧   skills ──ow 发布──▶ qdoc 平台 ◀──查询/待办/技能同步── 各 agent 宿主
                              └─ 知识页 vault（.qdoc/）：门禁 7 道 → 平台文档（台账 + 自愈）
```

两条链共用一个仓库：**经验侧**把对话变成 skill（pi/dsh 宿主内全自动），**分发侧**把 skill 与知识页推上 [qdoc.chat](design/EXTRACTION_QDOC_PLAN_2026-11-13.md) 平台，供四个宿主的 agent 随查随用。

## 经验侧：抽取 → 整合 → 编译

**五入口全自动**：`capture_knowledge`（单条声明）/ `kb_harvest`（收尾全采）/ compaction 抢救（唯一免审）/ quit 终采 / 手动回填 `extract.ts`。共用引擎、幂等跳窗、不占主对话轮次。

**准入三问**（任一"否"不入池，判据详见 [STORE_PLAN.md](design/STORE_PLAN.md)）：**可再生吗 / 会改变动作吗 / 说得出损失吗**。通过后按 **8 个文档类型**（sop/spec/template/case/postmortem/convention/index/rubric）分诊，物理分离为 instruction（进正文）/ reference（依据区）/ data（资料层）。

**整合与编译**：

- 日常主路径：知识卡片即待办队列，agent 写提案进 `intake/`，`apply-patches` 按 `base_skill_sha` 自愈消费（冲突只重做不丢失）
- 批量/编译：`compile-skills.ts` 就绪门 → 选材 → 编译简报 → `--generate` 调 LLM 产 SKILL.md → M 系列规则校验 → `--route-test` 路由自测（5 正 + 3 负探针）→ `--apply` 写提案
- 保鲜（darwin）：usage 审计双轨触发（使用次数/拒绝率）→ rubric 9 维体检 + 投票棘轮 + 人在回路

命令细节全部在 [SKILL_COMPILER.md](design/SKILL_COMPILER.md)，不在 README 里堆。

## qdoc：平台知识中心（分发侧）

**qdoc = qdoc.chat 平台 + ow CLI + qdoc 技能** 三件套，把仓库里的知识页与 skill 变成所有 agent 随查随用的在线资产：

- **平台**（qdoc.chat）：知识文档（发布/在线查询/改名/tag）+ 待办（todo）+ 技能市场（双向同步）。关键特性：**只有发布、没有删除**（下线只能打墓碑），发出去就在线；doc_id 是 UUID，台账记录认领关系，发现不可达自动**自愈重建**；文档可见性跟账号走，token 按功能分权限（`todo:read/write` 等 scope）
- **ow CLI**（`packages/cli`）：仓库 vault（`.qdoc/`：index/hot/references/skills/journal + `.publish/` 台账）到平台的**唯一正道**——门禁、去重、台账都在里面，手写页面会绕过全部检查。发布过 7 道本地门禁；查询本地优先 + 平台兜底、按词降级重试；待办纯透传；`mcp-config` 一键生成各宿主的 MCP 接入配置
- **qdoc 技能**（`agent-skills/qdoc`）：agent 侧的使用说明书，教 agent 正确用前两样——唤醒词、**平台事实卡**（tag ≤20 字符静默截断、`tools/list` 可能滞后、技能落库默认未启用……）、排错 playbook。四个宿主都已安装

对话里直接说（宿主 agent 按 SKILL.md 行动，无需记命令）：

| 说 | agent 做 |
|---|---|
| 「小q 沉淀」/「小q 查 X」/「小q 发布」 | `capture` / `query` / `publish` |
| 「小q 待办」/「小q 记一下 X」 | `todo list` / `todo add` |
| 「小q 状态」/「小q 确认」 | `status` / `review`（唯一不可回滚操作，必须人确认）|

命令速查：

```bash
npm run ow --silent -- status          # 水位/待发布/预算/锁/待确认
npm run ow --silent -- capture         # 编译当前会话 → 知识页
npm run ow --silent -- publish --dry-run   # 门禁预检，再去掉 --dry-run 实发
npm run ow --silent -- query "关键词"   # 查已发布文档
npm run ow --silent -- todo list       # 平台待办
```

全部命令见 `packages/cli/src/main.ts` HELP，常用流程一条龙见 [agent-skills/qdoc/references/playbook.md](agent-skills/qdoc/references/playbook.md)。

## 多宿主

技能（`agent-skills/` 下含 SKILL.md 的目录）用 `npm run install-skill` 统一装到四家宿主，`--check` 验漂移：

| 宿主 | 技能目录 | MCP 接平台 |
|---|---|---|
| dsh（DeepSeek Harness） | `~/.dsh/skills` | 自带 MCP 客户端 |
| pi | `~/.pi/agent/skills` | MCP |
| Qoder CN CLI | `~/.qoder-cn/skills` | `ow mcp-config --host qoder` 生成配置 |
| CodeBuddy Code CLI | `~/.codebuddy/skills` | `ow mcp-config --host codebuddy` |
| WorkBuddy 桌面版 | 技能市场上传 | `ow mcp-config --host workbuddy`（连接器 UI 粘贴） |

MCP 配置三家同构（`mcpServers` + http + headers），`alwaysAllow` 只放只读工具，写操作保留逐次确认。给新宿主单独发 token，可单独吊销。

## 配置

- 抽取引擎复用宿主已有凭据，装完即用：pi 走 ModelRegistry；dsh 优先 `ctx.llm`；纯 CLI 进程降级链 `AUTOSKILL_PROVIDER/MODEL` → settings.json → models.json → `OPENAI_API_KEY`
- qdoc 平台：token 放 `~/.config/qdoc/token`（平台分权限：`todo:read/write` 等 scope，旧 token 缺权限要重新生成勾选）
- `KB_DIR` 可覆盖知识数据目录（默认 `~/.pi/agent/data/autoskill/knowledge/`，**不在 checkout 内**——pi update 会 `git clean -fdx` 清空包内数据）

## 快速开始

```bash
# 1. 装 pi 包（AutoSkill 是标准 pi package，manifest 在 adapter-pi 子包）
pi install ./AutoSkill4Personal/packages/adapter-pi     # 本地目录
pi install git:github.com/<you>/AutoSkill4Personal/packages/adapter-pi

# 2. 验证：会话里跑 /kb（知识库状态）或调 kb_doctor（自检 LLM 链路）

# 3. qdoc 分发侧（可选，需要平台 token）
npm run ow --silent -- init && npm run ow --silent -- link   # 初始化 vault + 软链
npm run ow --silent -- publish --dry-run                      # 门禁预检
```

前置：Node ≥ 22.6（`--experimental-strip-types`）。装完即全自动：谈出有价值内容 agent 自主采集，收尾说一句"收割一下本会话知识"，退出自动终采。

## 目录结构

```
agent-skills/          # 可分发技能源（qdoc、ow-compiler），install-skill 同步到各宿主
packages/core/         # 抽取/分诊/整合/编译/打包引擎 + qdoc 发布器/同步/门禁（零宿主依赖）
packages/cli/          # ow 命令行（capture/publish/query/doc/todo/sync/mcp-config/...）
packages/adapter-pi/   # pi 宿主适配层（extensions 入口 + skills 约定）
packages/adapter-dsh/  # dsh 宿主适配层
.qdoc/                 # 知识页 vault（index/hot/references/skills/journal + .publish/ 台账）
scripts/install-skill.ts  # 四宿主技能安装/漂移检查
design/                # 原理与设计文档（见下）
```

## 详细文档

| 文档 | 内容 |
|---|---|
| [EXTRACTION_QDOC_PLAN_2026-11-13.md](design/EXTRACTION_QDOC_PLAN_2026-11-13.md) | **平台链路主文档**：通路/能力边界（实测）/同步/冲突/命令面/多宿主（§10.7b） |
| [SKILL_COMPILER.md](design/SKILL_COMPILER.md) | 技能编译管线与校验器 |
| [STORE_PLAN.md](design/STORE_PLAN.md) | 知识卡片准入三问与数据模型 |
| [EXTRACTION_PRINCIPLES.md](design/EXTRACTION_PRINCIPLES.md) | 抽取原则（历史三轴设计保留于此） |
| [INTEGRATE_GUIDE.md](design/INTEGRATE_GUIDE.md) | agent 整合提案写法 |
