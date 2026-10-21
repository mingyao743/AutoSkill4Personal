# 知识整合指南（agent 执行用）

> 本文件是给 pi 会话中的 agent 看的操作指引：把 pending 知识原子整合进 skills。
> 方法论蒸馏自 create-skill（TDD 式创建）+ 本项目并发设计（无锁提案队列）。
> 位置固定：`/Users/chenmingyao/Documents/cmy-only/AutoSkill/design/INTEGRATE_GUIDE.md`

## 什么时候做

- 收到系统注入的"有 N 条待整合原子"提示、且**当前任务已完成或空闲**时
- 不要在用户任务中途做；一次只整合一个域，量小（通常 ≤ 20 条）
- pending > 25 条时不做增量，提示用户跑批量：`node --experimental-strip-types scripts/assemble.ts && node --experimental-strip-types scripts/package-skill.ts --all`

## 整合流程（一个域一轮）

1. **读原料**：`knowledge/atoms.jsonl` 中未整合的原子（用 `node --experimental-strip-types scripts/apply-patches.ts` 看待整合清单和域分布；原子字段见 design/atom.schema.json）
2. **读目标**：`~/.pi/agent/skills/<domain>/SKILL.md` 现状 + `references/` 各文件。判断每条原子：
   - 并入现有 skill 的哪个节？与已有内容判重合并（近似重复 → 合并表述，sources 并集）
   - 还是**新建 skill**（domain 落不进任何现有 skill 的 description 覆盖范围时）
3. **写正文**（create-skill 核心要求）：
   - 正文是**操作指令**（"怎么做"），不是知识罗列——把原子内容改写成可执行步骤/判断规则
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
  "atom_ids": ["本提案整合的原子 id 列表"],
  "skill_md": "<完整新 SKILL.md 全文>",
  "files": { "references/02-操作SOP.md": "<完整文件内容>" }
}
```

规则：
- `skill_md` / `files` 是**全量替换**内容，不是 diff——基于你读到的当前版本完整写出
- `base_skill_sha` 用来检测并发：若别的会话先应用了提案，你的提案会被**丢弃，原子自动退回待整合**，下次会话重做即可，不要强行重试
- SKILL.md 头部保留这行标注（防止误跑批量打包覆盖精修）：
  `<!-- agent-maintained: 本文件由 agent 增量维护，批量重建会丢失精修，package-skill 已跳过本文件 -->`

## 并发与失败语义（无需担心）

- 你只往 intake/ 写唯一名文件，不存在锁
- 任何失败（提案被丢弃、崩溃、写一半）最坏结果是该轮没做成，原子留待下轮重做——知识不会丢
