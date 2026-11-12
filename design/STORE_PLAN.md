# 存的分诊方案（STORE_PLAN）

> 术语 v2（2026-11-11 全库统一）：原子→知识卡片、机械闸门→准入规则、雷达/片段发现→抽取触发机制、提炼/片段抽取→知识抽取、瞬态域→短效知识、台账→历史记录；数据层命名不变（`atoms.jsonl`、`atom_*` 字段、`extracted_by=signal-distill` 仍指知识卡片）。本文正文已按新叫法书写。

> 状态：v1 已实现（PR1-PR3）· 2026-11-10
> 范围：只解决"存"（该不该存 / 是什么 / 存到哪）。"评退"（usage 审计、darwin 体检、TTL 回收）不在本方案内。

## 一、要解决的问题（实测）

453 条知识卡片走了三扇门，规则完全不同：

| 入口 | 条数 | 旧门槛 |
|---|---|---|
| compaction 抢救 | 210 | 无三轴、无 catalog、无人工 → 直通 published |
| agent 主动声明 | 203 | **完全不校验**（`sources` 为空、类型自造） |
| 离线抽取 | 40 | 三轴 + 44 切片 + G4 机械拒 + 三道关 |

结果：文档里的严格理论只作用在 **9%** 的池子上；**45% 无来源**、**41% 类型名非法**（`通用切片`、`判据证据地图`…）；产出偏科（01+05 占 68%，03+04 仅 9%）。

根因两条：**把"可信度"当成了"价值"**；**三个入口三套规则**。

## 二、判据

只存"推导不出来"的东西。三问，任一答"否"不入池：

1. **可再生吗**：不存它，未来能不能低成本重新得到？
2. **会改变动作吗**：未来会不会影响某个做法或判断？
3. **说得出损失吗**：能不能写出一句"不存会导致什么"的具体后果？

第二条推论：不可再生的东西分两种存法——**指令**（该怎么做，进技能正文）与**事实**（是什么，进资料层）。

## 三、流水线

```
① 拆解      一段内容 → N 个最小可复用单元，一个单元只讲一件事          [LLM，同一次调用]
② 准入规则   sources / 接地 / 敏感信息 / 类型合法性                    [代码，前置省调用]
③ 判定       类型 + 价值理由 + 失效条件（关系判定 v2）                  [LLM，一次输出]
④ 落库       类型→分类查表；类型→去向查表；按去向分流                   [代码]
⑤ 复核       只有 data / 高价值工件进人工队列                          [人]
```

关键：**逻辑五步，实现一次 LLM 调用 + 两次规则校验**。四入口（capture / harvest / compaction / 回填）共用这一条，删除 compaction 的"免审"和 capture 的"免检"。

## 四、数据模型（新知识卡片强制，存量缺省兼容）

| 字段 | 取值 | 产生方 |
|---|---|---|
| `doc_type` | 8 枚举 | LLM |
| `keep_as` | `instruction` / `reference` / `data` | **查表推导**（仅 `case` 允许模型选 reference/data） |
| `why` | "不存会损失什么"（≥8 字） | LLM |
| `expires_when` | 失效条件（convention/index 必填） | LLM |
| `relation` | new/extends/supersedes/duplicate | v2 |

## 五、8 个类型

| 类型 | 回答什么 | 分类 | 去向 | 必填校验 |
|---|---|---|---|---|
| sop | 按什么顺序做（含排障子型） | 02 | instruction | step |
| spec | 什么算对 / 必须遵守 | 01 | instruction | concept_name + definition，且必须体现排他性 |
| template | 填空就能用 | 03 | instruction | template_name + skeleton |
| case | 照着它做（含客户资料） | 04 | reference（可 data） | case_name + solution |
| postmortem | 上次为什么炸 | 05 | instruction | problem + root_cause（需证据） |
| convention | 这环境的规矩 | 01 | instruction | concept_name + definition + **expires_when** |
| index | 东西在哪 | 01 | **data** | concept_name + definition + **expires_when** |
| rubric | 怎么打分 | 01 | instruction | concept_name + definition |

合并规则：`diagnostic` → sop 子型；`decision` → spec 的 `rationale`/`rejected`；`preference` 跨主题，属"全局层"，不建模。

## 六、落库分流

| keep_as | 写哪 | 后续 |
|---|---|---|
| instruction | atoms.jsonl | 进待整合队列 → assemble → package → SKILL.md |
| reference | atoms.jsonl | 打包时进 skill 的 `references/`，不进待整合队列 |
| data | atoms.jsonl（仍单一事实源） | 不进 assemble/package，只进资料索引（检索口 v2） |
| drop | 不写库 | errors.log 计数 |

## 七、准入规则（代码，零 token）

- `sources` 为空 → 拒
- msg_range 区间既无 user 又无 toolResult → 拒（G4）
- 敏感信息：`sk-` 一律拦；手机号/邮箱/证件号对 `data` 与 `case` 硬拦（客户资料必须先脱敏）
- `why` < 8 字 → 拒
- 类型必填字段缺失 / convention·index 缺 `expires_when` → 拒
- 被挡的知识卡片带原文摘要进 errors.log（可捞回）

## 八、与旧设计的差异

1. **44 切片退役**：实测 41% 的切片名是模型自造，该枚举已失效。`atom_type` 降级为可选细标签；新知识卡片只校验 8 类型。
2. **免检/免审删除**：capture 与 compaction 都过同一条准入规则。
3. **`index` 归 01（而非 04）**：04 的案例必填字段对索引不适用，01 的"关联对象"语义更贴。
4. **去向由类型推导**：模型只判类型，减少自由度即减少漂移。

## 九、本次实现（PR1-3）

- 新增 `packages/core/lib/admission.ts`：类型表、映射、准入规则、声明型来源合成
- `validate.ts`：类型化校验分支（新知识卡片）+ 旧知识卡片 catalog 校验保留
- `extract-core.ts`：类别由类型推导、接入准入规则
- `prompt.ts`：三问 + 拆解 + 8 类型 + why/expires
- `atom-store.ts` / `skill-state.ts` / `assemble.ts` / `package-skill.ts` / dsh provider：只消费 instruction
- capture 入口补 sources/准入规则/校验（pi + dsh）；工具新增 `doc_type` / `why` / `expires_when` / `keep_as`(case 专用) 参数；
  类型必填字段（step / concept_name / skeleton…）由 content 兜底（结构化字段只是渲染辅助）
- 修 `win_autoskil` 窗口 id 撞车（dsh compaction 传真实 session id；窗口短 id 剥 `session-` 前缀）
- 消息可读性：capture/harvest/quit 改为"项目名 + 动作"，不再打印绝对路径

## 十、未做 / 风险

- **资料层只写不读**：`data` 知识卡片没有检索入口，价值未兑现（v2 必须补）
- **关系判定未实现**：`relation` 恒为 new，`superseded_by` 仍空
- **存量 453 条不回填**：不伪造历史判断；`legacy` 由"无 doc_type"隐式标识
- **drop 不可见**：模型侧主动放弃的内容没有记账（只有准入规则拒的进 errors.log）
- **`why` 门可能误杀**：先跑 2 个真实 session 抽检，再看比例

## 十一、验收

1. 新入库知识卡片 `sources` 覆盖率 100%
2. `03+04` 占比从 9% → ≥20%
3. 产出 SKILL.md 正文中 `data` 类 0 条
4. 人工队列 ≤ 全部 draft 的 30%
5. dry-run 抽检 20 条，去向准确率 ≥80%
