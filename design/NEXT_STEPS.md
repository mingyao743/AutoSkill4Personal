# 新环境续作待办（NEXT_STEPS）

> 起点：`5e2ffaa feat: dsh 三处宿主 bug 修复 + SKILL_COMPILER 确定性部分`（main，工作区干净）
> 适用：换一台机器/换一套凭据后继续开发与统一验收。
> 原则：**开发不依赖真实模型（mock 可测）；真实模型只用于最后的统一验收**。

## 〇、出发前先确认边界

已完成的（不要重做）：

- dsh 三个 bug：assemble-timer 数据目录、provider 组卡路径、ctx.llm 凭据链（含 session 路径/id 兜底）；
- 编译器的确定性 60%：就绪门、选材器、短效判定、M1/M2/M4/M5/M6 契约校验、编译指纹、intake 提案；
- 回归：`smoke-one-stage` 99 / `smoke-skill-compiler` 81 / `smoke-dsh` 31，全绿。

没做的（本文件的事）：

- ③ 正文生成（开发）；
- ⑤ 路由自测（开发，产品内的发布前质量门）；
- 真实模型/真实会话上的统一校准（测试）。

**不要**顺手改的东西：atoms 数据格式与存量数据；apply-patches 的单一写入者模型；把 M3 标成"已通过"。

---

## 一、新环境准备（先跑通，不写代码）

依赖：Node ≥ 22.6（`--experimental-strip-types`）、`zstd` 可执行文件、`pi` 或 `dsh`、可用模型凭据。

```bash
git clone <repo> && cd AutoSkill4Personal
npm run smoke                 # 三套回归，零凭据、零网络；必须 99/81/31 全过
```

宿主接入：

- **pi**：`pi install ./AutoSkill4Personal/packages/adapter-pi`（v2 是 monorepo，manifest 在子包）；重启后 `/kb`、`kb_doctor` 自检。
- **dsh**：profile patch 里已有三条 `autoskill*` 行；**必须给 autoskill 配 llm 路由**（凭据在宿主里）：

```yaml
- id: autoskill
  config:
    llm:
      provider: <provider>
      model: <model>
```

数据目录：

| 宿主 | 路径 |
|---|---|
| pi | `~/.pi/agent/data/autoskill/knowledge` |
| dsh | `$DSH_HOME/data/autoskill/knowledge`（默认 `~/.dsh/...`） |
| 任意 CLI | `--data-dir` 或 `AUTOSKILL_DATA_DIR` |

验证清单：

- [ ] `npm run smoke` 99/81/31
- [ ] `compile-skills.ts --all --json` 能列出真实主题，无崩溃
- [ ] pi：`/kb` 的"可编译"一栏有值（或为"无"，但命令不报错）
- [ ] dsh：`kb_harvest` 返回里显示"可编译主题"；`errors.log` 不再出现"未找到可用 LLM 配置"
- [ ] dsh：`errors.log` 无新增 `[autoskill] 进程内管线失败`

---

## 二、待办 A：真实数据冒烟（测试，半天）

目的：确认新环境的数据与凭据能走完"抽 → 组卡 → 编译简报 → 校验 → 提案"。

```bash
# 1) 看主题与是否就绪
node --experimental-strip-types packages/core/scripts/compile-skills.ts --all --json > /tmp/compile.json

# 2) 取一个就绪主题，产简报
node --experimental-strip-types packages/core/scripts/compile-skills.ts --domain <主题> --force

# 3) 手工（或让 agent）按简报写一份 SKILL.md，然后校验
node --experimental-strip-types packages/core/scripts/compile-skills.ts \
  --domain <主题> --skills-dir <skillsDir> --validate /path/SKILL.md
```

验收：M1/M2/M4/M5/M6 全过（M3 显示 ⏳ 是预期）；旧卡片主题会带"类型按 5 类目录推断"warning，正常。

---

## 三、待办 B：③ 正文生成（开发，mock 可测）

现状：CLI 只产出[编译简报](SKILL_COMPILER.md)，正文交给 create-skill。目标是把它变成可重复执行的生成步骤。

设计要点：

- 新参数：`compile-skills.ts --generate <brief.json>`（或 `--domain X --generate`），**绝不直接落 skill 文件**；
- 输入：简报 JSON + 选中卡片的完整正文（从 `atoms.jsonl` 按 atom_id 取，简报里只截了 400 字）+ `skills/create-skill/SKILL.md` 作为写法指引；
- 输出：`<briefDir>/<skill>.draft.md`；
- 质量环：调用 `validateSkillMd`，不通过就把 `report.errors` 回喂重写，**最多 2 次**；仍不通过则保留 draft、打印错误、不生成提案；
- 依赖注入：用 `setChatCompleter`（core 已有）注入模型调用，测试用 mock，不碰真实凭据；
- 不要做的事：不要自动 `--apply`；不要绕过 `--validate`；不要覆盖 `agent-maintained`。

验收：

- [ ] mock 测试覆盖：一次通过 / 两次修复后通过 / 两次仍失败（保留 draft、无提案）
- [ ] 真实环境：一个 ≥5 张卡的主题生成 draft，M1/M2/M4/M5/M6 全过
- [ ] 人工盲评：只读正文能照做（"能少踩一次坑"），不是知识快照

## 四、待办 C：⑤ 路由自测（开发，发布前质量门）

这是设计里"技能会不会被加载"的唯一可测手段，**是产品功能，不是一次性脚本**。

设计要点：

- 新参数：`compile-skills.ts --route-test <SKILL.md> --skills-dir <dir>`；
- 目录：扫描 `<skillsDir>/*/SKILL.md` 的 frontmatter description，与候选一起构成"竞争集合"；
- 探针：每个候选生成 5 条正样本（应该命中它）+ 3 条负样本（邻近但不该命中）；按 `sha1(description + 目录指纹)` 缓存到 `<dataDir>/compile/route-cache.json`；
- 判定：逐条问"这条请求会加载哪个技能"，正样本要求候选排第 1（≥4/5），负样本要求候选不排第 1（≥2/3）；
- 失败处理：把失败样例回喂重写 description（最多 2 次），仍失败则**阻断 `--apply`**；
- 与现有校验的关系：`validateSkillMd` 继续只返回 `needsRoutingTest`；路由报告是独立产物（`compile/<skill>.route.json`），`--apply` 读到失败报告必须拒绝。

验收：

- [ ] 3 个 mock 技能 + 6 条已知查询的判定测试（含误命中）
- [ ] 真实目录：正 ≥4/5、负 ≥2/3，失败可复现、重写有次数上限
- [ ] `--apply` 在路由报告失败时拒绝写提案

## 五、待办 D：真实统一校准（测试，换环境后做）

1. **抽取质量**（一段式，隔离库，绝不写真实知识库）：

```bash
node --experimental-strip-types packages/core/scripts/extract-calibrate.ts <session.jsonl[.zstd]> \
  --probe "已知 P0 信号 1" --probe "已知 P0 信号 2" --out-dir /tmp/calib
node --experimental-strip-types packages/core/scripts/review-sheet.ts <session> --calib /tmp/calib --out /tmp/REVIEW.md
```

判据见 `design/ONE_STAGE_EXTRACT.md §七`：探针召回（主指标）、每批 drop 有账、盲评摘要率 ≤10%、fail-safe <5%、摘抄率中位 <40%。

2. **编译产物**：对 3 个最高价值主题各生成/编译一次，人工盲评"能照做"；记录描述长度、触发短语数、路由测试结果。

3. **端到端**：pi 与 dsh 各跑一遍"抽 → 编译 → 校验 → 提案 → apply-patches → 审计/darwin 计数"。

---

## 六、已知坑（换环境最容易踩）

1. **dsh 有两条抽取路径**：环境里有 `OPENAI_API_KEY`（或可解析的 models.json）→ spawn 独立进程；否则 → 宿主进程内走 `ctx.llm`。工具返回里会写"后台独立进程 / 宿主进程内"，先看这个再排错。
2. **进程内管线在宿主退出时可能被截断**：覆盖水位已推进的部分不会重抽，下次继续，属预期。
3. **`compile-state.json` 会导致重跑显示"内容与上次编译一致"**：这是防重复烧 token 的闸门，重编用 `--force`。
4. **`--apply` 必须显式 `--skills-dir`**：CLI 不替宿主猜输出目录（dsh 形态根本不落 SKILL.md）；`references` 只有磁盘上已存在才会随提案打包。
5. **`agent-maintained` 技能默认拒绝覆盖**，`--force` 才动。
6. **M3 没被确定性校验覆盖**：`--validate` 通过 ≠ 可发布；发布前必须有路由测试或人工探针。
7. **旧知识卡片没有 `doc_type`**：按 01→spec / 02→sop / 03→template / 04→case / 05→postmortem 推断，会有 warning；预算按**主类型**分档（不是出现过的最大档）。
8. **短效知识阻断阈值是"≥2 条判据命中"**，与设计文本的"任一命中"不同（避免误杀 spec/rubric 主题），常量在 `compile-skill.ts` 的 `TRANSIENT_BLOCK_HITS`。
9. **dsh 插件 `inject` 含 `llm`**：宿主版本太老、没有 `ctx.llm` 时插件不会加载；`errors.log` 会记"宿主没有 ctx.llm"。
10. **会话文件**：dsh 是 `<dshHome>/sessions/<cwd-slug>/<id>/session.v4.jsonl[.zstd]`，需要 `zstd`；自定义 `DSH_HOME` 已支持。
11. **测试不要 import `adapter-dsh/src/tools.ts`**：它依赖 `@deepseek-ai/dsh-tools`，本地无 node_modules；会话路径逻辑已抽到 `session-path.ts` 可直接测。若必须测 apply 接线，临时放一个 `node_modules/@deepseek-ai/dsh-tools` stub（type-only 之外的 `defineTool` 一个函数即可），测完删除。
12. **Node 版本**：22.6+；仓库无构建步骤、无 lockfile，靠宿主提供依赖。

---

## 七、建议顺序与完成定义

```
A 环境冒烟（半天） → B ③ 开发（mock 驱动） → D-1 抽取校准 → C ⑤ 开发 → D-2 编译产物盲评 → 两宿主端到端
```

完成定义（DoD）：

- [ ] `npm run smoke` 三套全绿，且新增 B/C 的 mock 测试
- [ ] 真实环境：≥1 个主题走完"简报 → 生成 → 校验 → 路由 → 提案 → 应用"
- [ ] 路由测试失败时 `--apply` 拒绝
- [ ] 校准表可交给人工盲评，结论按 `ONE_STAGE_EXTRACT §七` 的判据记录
- [ ] 文档：`SKILL_COMPILER.md` 的"未落地"清单清零，`README` 快速开始与实现一致
