---
name: qdoc
description: 把当前会话里的知识沉淀成知识页、推到 qdoc.chat、并在需要时查回来；管理平台待办与文档字段（改名/改tag）。当用户说「小q」「qdoc」「待办」或要求记住/查一下某个技术结论时使用。也负责播报后台产生的待确认事项。
---

# qdoc —— 会话知识沉淀

## 唤醒词

| 用户说 | 你做 |
|---|---|
| `小q 沉淀` / `沉淀一下` | 跑 `ow capture`，编译当前会话 |
| `小q 查 <问题>` | 跑 `ow query "<问题>"` |
| `小q 发布` | 跑 `ow publish` |
| `小q 确认` | 跑 `ow review` |
| `小q 状态` | 跑 `ow status` |
| `小q 待办` / `我的待办` | 跑 `ow todo list`，按输出播报 |
| `小q 记一下 <事>` / `加个待办` | 跑 `ow todo add "<事>"` |
| `小q` 单独出现 | 先跑 `ow status --json`，按下面规则播报，然后问要做什么 |

**唤醒词判定**：句首或独立出现，且后面跟动词（沉淀/查/发布/确认/状态/待办）或什么都不跟，才算命令。
「小q 那个文档写得不错」这种后面跟名词的，是**正常聊天**，不要触发。

## 每次被唤醒先做的事

```bash
ow status --json
```

然后：

1. `sync.pendingReview > 0` → 用**一行**带过：「另有 N 项待确认，说 `小q 确认` 可以处理」
2. 不展开、不主动追问——用户没问就不说细节
3. 不要主动提「要不要沉淀」，等用户说

## 硬性规则

| 规则 | 原因 |
|---|---|
| **必须调 CLI，不要自己写页面** | 门禁、去重、账本都在 CLI 里；手写会绕过全部检查 |
| **不要自动发布** | `ow publish` 有 7 道门禁，但发出去就是正式文档，平台无删除 |
| **不要替用户确认 `ow review`** | 那是唯一不可回滚的操作，必须人决定 |
| **查不到就说查不到** | 不要编造知识页内容 |
| **改文档字段用 `ow doc`，别裸调 MCP** | 平台事实都在下面这张卡里；裸调容易踩过时 schema 的坑 |
| **用户给了明确指令就直接做** | 读操作不用问；写操作一句话说明 → 做 → 汇报结果，不反问 |

## 平台事实卡（2026-11-16 实测；动手前过一遍，别靠猜）

| 事实 | 别踩的坑 |
|---|---|
| doc_id 是 **UUID 字符串**（台账里存的就是） | 数字 id 是旧版遗留，遇到按「不可达」处理，先 `ow publish` 自愈 |
| `update_document` 可**单独**改 filename / tags / 正文（乐观锁 `base_version`） | 「只能改正文」是过时认知，别绕远路重建文档 |
| 平台 tag **上限 20 字符**，超长**静默截断** | 项目分组用 `p:<短名>`；按全名过滤会永远命中 0 |
| `search_documents` 匹配**文件名和正文**，支持 tag 过滤 | 别假设只搜文件名 |
| `tools/list` 的清单/schema **可能漏报滞后** | 能力以实际调用为准；`list_document_tags`、update 的 filename 都曾不在清单里 |
| 平台**无删除**（MCP 层）；可见性跟账号走，token 只管鉴权且**分权限**（todo:read 等） | 发出去就在线；doc_id 不可达=文档被删/迁移，发布器会自愈重建；报「缺少权限」= 要换带权限的新 token |
| 技能 import 后默认**未启用** | 要人去 qdoc.chat 技能页点「启用」，这不是 bug |
| 技能 description 由**平台自己按行解析** frontmatter，`update_skill` 传的 description 参数**不生效** | SKILL.md 的 description 必须写成**单行**（可带引号）；YAML 折叠标量 `>` 会被存成字面的 `">"` |

## 命令速查

```bash
ow status                 # 水位、待发布、预算、锁、待确认
ow capture --plan         # 只看会编译哪些窗口，不烧 token
ow capture                # 编译当前会话
ow publish --dry-run      # 只跑门禁，不发
ow publish                # 推到平台（成功输出自带验证命令）
ow query "关键词"          # 在线查已发布文档
ow doc rename <page|UUID> <新名>   # 改平台文件名
ow doc tag <page|UUID> --add a,b   # 改平台 tag
ow todo list              # 待办（--all 含已完成）
ow todo add "事"          # 加待办（--priority 0-3 / --due 日期）
ow todo done <id>         # 完成待办
ow sync --light           # 29ms 查平台技能增减
ow review                 # 处理待确认（交互）
```

## 常见情况

**「编译报未找到 LLM 配置」** —— 这是旧外置方案的说法。现在编译在 agent 进程内跑，用 agent 自己的凭据。如果真报这个错，说明你在 CLI 独立进程里跑 `ow capture`，改在 agent 里说「小q 沉淀」。

**「查询 0 结果」** —— 平台搜索是**短语精确匹配**，不是语义搜索。`qdoc MCP` 查不到就换 `MCP`。`ow query` 已内置按词降级，会自己重试。

**「发布被拦」** —— 跑 `ow publish --dry-run` 看是哪道门禁。7 道门禁全在本地跑，平台无草稿功能。

**「技能推上去看不见」** —— `import_skill_from_files` 落库是**未启用**状态，`list_available_skills` 只返回已启用的。要人去 qdoc.chat 技能页点「启用」。

## 详细文档

- `references/playbook.md` —— 常用流程一条龙（发布/改名/改tag/待办/排错）
- `references/capture.md` —— 什么时候值得沉淀、窗口怎么切
- `references/query.md` —— 查询策略与降级
- `references/maintain.md` —— 知识库维护

