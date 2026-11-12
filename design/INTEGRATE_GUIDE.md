# 知识整合指南（agent 执行用）

> 术语 v2（2026-11-11 全库统一）：原子→知识卡片、机械闸门→准入规则、雷达/片段发现→抽取触发机制、提炼/片段抽取→知识抽取、瞬态域→短效知识、台账→历史记录；数据层命名不变（`atoms.jsonl`、`atom_*` 字段、`extracted_by=signal-distill` 仍指知识卡片）。本文正文已按新叫法书写。

> 本文件是给 pi 会话中的 agent 看的操作指引：把 pending 知识卡片整合进 skills。
> 方法论蒸馏自 create-skill（TDD 式创建）+ 本项目并发设计（无锁提案队列）。
> 位置固定：`/Users/chenmingyao/Documents/cmy-only/AutoSkill/design/INTEGRATE_GUIDE.md`

## 什么时候做

- 收到系统注入的"有 N 条待整合知识卡片"提示、且**当前任务已完成或空闲**时
- 不要在用户任务中途做；一次只整合一个主题，量小（通常 ≤ 20 条）
- pending > 25 条时不做增量，提示用户跑批量：`node --experimental-strip-types scripts/assemble.ts && node --experimental-strip-types scripts/package-skill.ts --all`
- **只有 `keep_as=instruction` 的知识卡片会出现在待整合队列**：`reference`（依据）由打包进 references/，`data`（资料）不进技能正文。不要把它们硬塞进 SKILL.md。

## 整合流程（一个主题一轮）

1. **读原料**：`knowledge/atoms.jsonl` 中未整合的 instruction 知识卡片（用 `node --experimental-strip-types scripts/apply-patches.ts` 看待整合清单和主题分布；知识卡片字段见 design/atom.schema.json）。新知识卡片带 `doc_type`（8 类型）与 `why`，分类已由类型推导，不要自己改 category。
2. **读目标**：`~/.pi/agent/skills/<domain>/SKILL.md` 现状 + `references/` 各文件。判断每条知识卡片：
   - 并入现有 skill 的哪个节？与已有内容判重合并（近似重复 → 合并表述，sources 并集）
   - 还是**新建 skill**（domain 落不进任何现有 skill 的 description 覆盖范围时）
3. **写正文**（create-skill 核心要求 + 最小绑定原则）：
   - 正文是**操作指令**（"怎么做"），不是知识罗列——把知识卡片内容改写成可执行步骤/判断规则
   - **允许结合世界知识转化，但受最小绑定约束**（规范见 design/EXTRACTION_PRINCIPLES.md §九）：
     写入正文的每个非经验事实，过**删除测试法**——删掉它，某条经验的行动价值受损才可写；
     判定口诀：删掉后经验变得看不懂/做不了/分不清适不适用 → 写；只是少点背景知识 → 不写。
     课程式内容（概念科普、通用最佳实践）一概不进正文。
   - 原始知识保留在 references/（按 5 类切片组织，带溯源 session id + 置信度）
   - frontmatter description 是路由命门：写清"是什么 + 何时用"，含具体触发词
4. **自测路由**（至少 1 题）：构造一个"应该命中本 skill"的典型问题，确认 description 能路由到它；再构造 1 个"不应命中"的邻近问题防误路由
5. **写提案**：不要直接改 skill 文件！写提案文件到
   `knowledge/intake/<patch_id>.patch.json`（唯一文件名，格式见下）
6. **应用**：跑 `node --experimental-strip-types /Users/chenmingyao/Documents/cmy-only/AutoSkill/scripts/apply-patches.ts`，确认"应用 1"

## 提案（patch）格式

```json
{
  "patch_id": "p_<8位随机hex>",
  "created_at": "<ISO 时间>",
  "author": "agent",
  "domain": "<目标 skill 名，kebab-case>",
  "action": "update",
  "base_skill_sha": "<sha1(现有 SKILL.md 内容)>，用 shasum 算；create 时省略",
  "atom_ids": ["本提案整合的知识卡片 id 列表"],
  "skill_md": "<完整新 SKILL.md 全文>",
  "files": { "references/02-操作SOP.md": "<完整文件内容>" }
}
```

规则：
- `skill_md` / `files` 是**全量替换**内容，不是 diff——基于你读到的当前版本完整写出
- `base_skill_sha` 用来检测并发：若别的会话先应用了提案，你的提案会被**丢弃，知识卡片自动退回待整合**，下次会话重做即可，不要强行重试
- SKILL.md 头部保留这行标注（防止误跑批量打包覆盖精修）：
  `<!-- agent-maintained: 本文件由 agent 增量维护，批量重建会丢失精修，package-skill 已跳过本文件 -->`

## 并发与失败语义（无需担心）

- 你只往 intake/ 写唯一名文件，不存在锁
- 任何失败（提案被丢弃、崩溃、写一半）最坏结果是该轮没做成，知识卡片留待下轮重做——知识不会丢
