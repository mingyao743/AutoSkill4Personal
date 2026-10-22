# AutoSkill

把 pi 对话中**正在流失的经验**沉淀为可路由的 skill：对话记录 → 知识原子 → 卡片 → skill。安装一次 extension，之后全自动。

```
对话(五入口) ──抽取──▶ 原子池 atoms.jsonl ──整合──▶ skills/*.md ──体检──▶ 持续优化
                       （待办队列）      （agent 提案队列）     （darwin-skill）
```

## 什么时候抽取（五入口）

| 入口 | 触发时机 | 产物状态 |
|---|---|---|
| `capture_knowledge` 工具 | agent 刚得出结论/踩坑/方法时**单条声明** | draft · conf 0.8 |
| `kb_harvest` 工具 | 任务收尾、会话积累大量知识时，后台全量终采 | draft · conf 0.6 |
| compaction 抢救 | 长对话压缩前，自动抢救被压缩区（唯一免审入口） | **published** · conf≥0.7 |
| quit 终采 | `pi` 退出时 detached spawn 全量回扫 | draft · conf 0.6 |
| 手动回填 | 对历史 session 跑 `scripts/extract.ts` 补抽 | 同上 |

所有入口共用一个引擎，已抽窗口自动跳过（幂等），绝不占用主对话轮次。

## 抽取什么（准入标准）

三条判定轴，**任一为零则不入池**（详见 [EXTRACTION_PRINCIPLES.md](design/EXTRACTION_PRINCIPLES.md)）：

| 轴 | 定义 | 反例 |
|---|---|---|
| **稀缺性** | 不在模型参数知识里 | "GRPO 是什么"的回答 |
| **验证性** | 被现实验证过（执行结果/用户确认） | 听起来专业但未检验的推测 |
| **复现性** | 未来任务会再次遇到 | 一次性事务 |

价值来源优先级：**人→模型（否定/修正/决策理由）＞ 世界→模型（预期违背）＞ 文档映射**。对话的高价值几乎全部产生于人机摩擦点与现实检验点。

产出形状：5 类知识 × 44 切片（[SLICE_CATALOG.json](design/SLICE_CATALOG.json)）

```
01 业务认知   02 操作SOP   03 模板库   04 案例样例   05 问题复盘
```

## 如何抽取

1. 会话按 **50 条消息 / 40k 字符**切窗，序列化后交 LLM（流式调用，思考 token 不限预算）
2. 单窗产出原子 JSON 数组，schema 校验 + `atom_type` 必须命中切片清单
3. `atom_id = sha1(category+domain+content)` 幂等，重复内容不重入库
4. LLM 配置**零额外配置**（见下文"配置"节）

## 原子 → skill（整合）

- **增量整合（日常主路径）**：原子即待办队列。pi 会话注入提示，agent 按 [INTEGRATE_GUIDE.md](design/INTEGRATE_GUIDE.md) 写提案到 `knowledge/intake/`；应用器 session_start 时串行消费（`base_skill_sha` 失配→丢弃→原子退队列下轮重做——无锁并发，冲突只重做不丢失）
- **批量工具**：积压 >25 条或 bootstrap 时跑 `assemble.ts`（LLM 判重合并 → 5 类确定性组卡）+ `package-skill.ts`（生成路由 description，<15k 内联单文件否则拆 references）。agent 精修过的 skill 标注 `agent-maintained` 保护，批量不覆盖
- **双层输出**：抽取层纯经验（三轴守门）；SKILL.md 正文是经验 × 世界知识转化的操作指令（受最小绑定纪律约束，[EXTRACTION_PRINCIPLES.md §九](design/EXTRACTION_PRINCIPLES.md)），references/ 保留原始切片保真可溯源

## skill 保鲜（darwin 体检）

某 skill 被 agent 增量修改累计 ≥10 次（`AUTOSKILL_DARWIN_THRESHOLD` 可调），下个会话提示按 [skills/darwin-skill](skills/darwin-skill/SKILL.md) 做 rubric 9 维体检：paired 对比验证 + 投票棘轮（只保留实测不退步的修改）+ 人在回路确认。完成后 `scripts/darwin-check.ts --done <domain>` 记账。

## 配置

抽取引擎复用你给 pi 配好的凭据，**装完即用，无需任何配置**：

- **extension 在场**（在线入口）：走 pi 的 ModelRegistry，与主对话同一条认证链（auth.json / models.json / 环境变量 / `!command`），模型跟随你当前会话模型
- **纯 CLI 进程**（quit 终采等）：降级链 `AUTOSKILL_PROVIDER/MODEL 显式指定` → settings.json 默认 provider → 扫 models.json → `OPENAI_API_KEY` 直连
- 可选：`AUTOSKILL_MODEL=便宜模型` 一行切换；`/kb` 看状态，`kb_doctor` 工具自检链路

## 快速开始

### 安装

AutoSkill 是标准 [pi package](https://pi.dev/packages)（约定目录：`extensions/` + `skills/`），用 pi 原生包机制安装：

```bash
# 方式一：本地目录（试用/开发）
pi install ./AutoSkill

# 方式二：git（免维护目录位置，pi 管理副本）
pi install git:github.com/<you>/AutoSkill

# 方式三：发布到 npm 后
pi install npm:autoskill
```

装完重启 pi 即生效。pi 会把包声明写入 `~/.pi/agent/settings.json`（本地安装记录相对路径，不含用户名；移动目录后重跑一次 `pi install` 即可）。

**验证**：任意会话里让 agent 运行 `/kb` 看知识库状态，或调用 `kb_doctor` 工具自检 LLM 链路。

前置要求：[pi](https://pi.dev) 已安装并配置好模型（抽取引擎复用你给 pi 配的凭据，见下文配置节）；Node ≥ 22.6（脚本用到 `--experimental-strip-types`）。

### 日常使用

装完即全自动，无需记命令：谈出有价值内容时 agent 会自主调 `capture_knowledge`；收尾说一句"收割一下本会话知识"触发 `kb_harvest`；退出 pi 自动终采；下个会话开头若有积压会收到整合提示。

### 可选维护操作

```bash
# 手动回填历史 session
node --experimental-strip-types scripts/extract.ts ~/.pi/agent/sessions/<id>.jsonl
node --experimental-strip-types scripts/extract.ts ~/.pi/agent/sessions/  # 整目录

# 大积压时批量重建（会跳过 agent-maintained 的 skill）
node --experimental-strip-types scripts/assemble.ts
node --experimental-strip-types scripts/package-skill.ts --all
```

## 目录结构

```
knowledge/
  atoms.jsonl          # 原子池（唯一事实源）
  skill-state.json     # 整合账本 + darwin 记账
  intake/              # agent 提案队列
  cards/               # 组装的知识卡片
extensions/knowledge-capture/   # pi 插件（五入口）
lib/                  # 抽取/整合/配置引擎
scripts/              # extract / assemble / package / darwin-check
design/               # 原理文档（原则/切片清单/schema/整合指引）
```
