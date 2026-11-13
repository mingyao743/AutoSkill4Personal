# ow —— qdoc 知识库 CLI

把 agent 干活的会话编译成知识页，推到 [qdoc.chat](https://qdoc.chat)，需要时在线查回来。

## 快速开始

```bash
# 1. 在你的项目里初始化
cd ~/my-project
node --experimental-strip-types <repo>/packages/cli/src/main.ts init

# 2. 配 token（三级查找，任选一个）
export QDOC_TOKEN=qdoc_xxx
# 或 echo qdoc_xxx > ~/.config/qdoc/token && chmod 600 ~/.config/qdoc/token

# 3. 干活。满 30 轮自动编译，或随时说「小q 沉淀」

# 4. 推到平台
ow publish

# 5. 查
ow query "关键词"
```

挂成命令（可选）：

```bash
alias ow='node --experimental-strip-types /path/to/repo/packages/cli/src/main.ts'
```

## 命令

| 命令 | 作用 | 会烧 token |
|---|---|---|
| `ow init` | 建 `.qdoc/` 骨架 | 否 |
| `ow status` | 水位、待发布、预算、锁、token | 否 |
| `ow capture` | 手动编译会话（见下方说明） | **是**（有凭据时） |
| `ow publish` | 推待发布页到平台 | 否 |
| `ow query <词>` | 在线检索已发布文档 | 否 |
| `ow sync` | 技能双向同步（`--light` 只查列表，`--adopt` 接管已有） | 否 |
| `ow review` | 处理待确认队列（唯一交互入口） | 否 |
| `ow link` | 建 `wiki -> .qdoc` 软链 | 否 |
| `ow maintain` | 重建 index / hot | 否 |
| `ow promote` | 把够格的知识页升级成技能 | 否 |

常用选项：`--vault <dir>` `--dry-run` `--json` `--help`

### `ow capture` 的两种结果

CLI 是独立进程，**拿不到 agent 自己的模型凭据**（dsh 存的是平台 refresh token，
不是 OpenAI 兼容 key）。所以：

```bash
ow capture --plan     # 只切窗，看哪些窗口值得编译，不烧 token
ow capture            # 有独立凭据就编译，没有就排队
```

没凭据时会写 `.qdoc/.ow/pending/capture.json`，等宿主会话接手。**推荐在 agent 里
说「小q 沉淀」**——那才是用宿主自己凭据的路径。

## 三条同步方向

| 方向 | 支持 | 说明 |
|---|---|---|
| 推文档 | ✅ | `ow publish` |
| 拉文档 | ❌ | 只在线查（`ow query`）——文档留在平台，不落本地 |
| 推技能 | ✅ | `ow sync --direction push` |
| 拉技能 | ✅ | `ow sync --direction pull`（本地已存在的不覆盖） |

**为什么文档不拉回本地**：知识页的权威副本在平台。拉回本地会产生「两份都能改」的局面，必然漂移。需要时查一下就行。

### 技能同步的四种结果

```bash
ow sync --light                  # 29ms，只看平台有哪些（查不出内容更新）
ow sync --direction pull         # 全量，拉/更新本地技能
ow sync --direction push         # 推本地改动（内容一致会自动跳过）
```

| 结果 | 含义 | 该做什么 |
|---|---|---|
| `↓ created` | 本地没有，拉下来 | 无 |
| `↻ updated` | 本地没改、平台更新了 | 无 |
| `＝ unchanged` | 一致 | 无 |
| `✎ diverged` | 本地改过、平台没变 | 留意：平台下次更新会冲突 |
| `⚠ conflict` | 两边都改了 | `ow review` 处理，本地改动不会丢 |
| `⊕ adopted` | 内容一致，已登记接管 | 无 |
| `? adoptable` | 本地有且内容不同，没接管 | 想交给平台管就加 `--adopt` |

**本地已有的技能不会被擅自覆盖**——内容不一致时只报 `adoptable`，要 `--adopt` 才接管。

### 推送的防线

覆盖线上技能是**唯一不可回滚**的操作，所以默认不推：

```bash
ow sync --direction push                # 会覆盖的只入队，不推
ow sync --direction push --only foo --yes   # 才真推
ow review                               # 逐条确认
```

| 情况 | 行为 |
|---|---|
| 平台没有 | 直接导入（无副作用） |
| 内容一致 | 跳过 |
| 内容不同、无 `--yes` | **入队等确认** |
| 内容不同、有 `--yes` | 真推 |

## 自动触发怎么工作

```
agent 干活 → 满 30 轮 → 信号门 → 机器锁 → vault 锁 → 进程内编译 → 写 .qdoc/ → 待发布
```

- **轮次**：dsh 数 `turn/end`，pi 数 `message.role === "user"`。注入的 runtime-context 不算。
- **信号门**：纯问答、纯检索、闲聊不编译（省 token）。
- **两级锁**：vault 锁（同项目跨 agent）+ 机器锁（跨项目全局并发 1）。
- **预算**：整机每日 ≤50 次 / ≤200k token，记在 `~/.config/qdoc/machine.json`。
- **模型**：用**各 agent 自己配的**，编译在 agent 进程内跑，不另配一套凭据。

## 发布门禁（7 道，全本地）

| 门 | 拦什么 |
|---|---|
| structure | 路径不合法、缺 title |
| size | 正文 >1MB |
| privacy | `sk-` / `ghp_` / `AKIA` / 私钥 / `password=` / 连接串 |
| quality | 置信度 <0.45、archived / disputed |
| dedup | 同标题已存在 |
| completeness | 正文 <200 字符、推断占比 >70% |
| unchanged | 正文哈希没变（跳过，省一次 API） |

## 平台限制（实测，会持续影响设计）

| 限制 | 后果 |
|---|---|
| 无 delete | 只能墓碑（改正文 + 标 tombstone） |
| 无 draft | 门禁必须全在本地跑，发出去就是正式文档 |
| `update_document` 不收 tags | tags 只在 create 时给，之后改不了 |
| `list_documents` 不含 tags | 读 tags 要逐个 `read_document`（N 次调用） |
| `search_documents` 是短语精确匹配 | 多词查询常常 0 结果，`ow query` 已加按词降级 |
| `import_skill_from_files` 落库为「未启用」 | 推完自己看不见，要人去平台点启用 |
| 技能导入 ≤50 文件 / 总 ≤2MB | 大技能（如 74 文件的）推不上去 |

## 目录结构

```
<project>/
  .qdoc/                     ← vault（可 git 提交，运行态已 gitignore）
    concepts/ entities/ skills/ references/ synthesis/ journal/
    index.md                 自动生成
    log.md                   变更日志
    hot.md                   近 7 天改动
    AGENTS.md                这个库该怎么写
    .manifest.json           页面清单
    .ow/                     运行态（gitignore）
      state.json             轮次水位
      lock/                  vault 锁
      reports/               编译报告
      pending/               待确认队列
      policy.json            「这类别再问」
      token                  项目级 token（可选）
    .publish/                （gitignore）
      ledger.json            发布账本
      conflicts/             冲突现场
  wiki -> .qdoc              软链（ow link）
```

## 技能晋升

知识页攒够证据后会变成技能，让 agent 下次直接照着做：

```bash
ow promote                      # 列出候选（干跑）
ow promote --write              # 真的生成到 agent-skills/
ow promote --explain <页面>      # 这页为什么不够格
```

三道门槛（都要满足）：

| 门槛 | 要求 | 为什么 |
|---|---|---|
| lineage | ≥2 个**独立会话**验证过 | 一次性的经验不可靠 |
| 引用 | ≥3 次被其他页 wikilink | 说明是枢纽知识 |
| 可执行 | 有「怎么做/验证」这类结构 | 技能要能照着做 |

生成时会做三件转换：去绝对路径、去 wikilink（技能包里没有 vault）、补 `SKILL.md` 的 name/description。

**生成不等于推送**——推上去仍要走 `ow sync` 的 review 防线。

## 待确认队列

后台**不能弹窗问人**，所以只写队列，人主动跑 `ow review` 处理：

```bash
ow review            # 交互：a=应用 d=diff s=跳过 x=不再问 q=退出
ow review --list     # 只列（非 tty 自动这样）
ow review --policy   # 看哪些已经放行
ow review --reset    # 清空放行规则
```

队列文件在 `.qdoc/.ow/pending/`，看得见、能 git 管。7 天没处理会在 `ow status` 里顶到显眼位置。

**「以后不再问」两级**：只放行这一条，或整个类型都不再问。都记在 `.ow/policy.json`，可撤销。

## 故障排查

```bash
ow status              # 先看这个：水位、预算、锁、token 都在这
ow publish --dry-run   # 只跑门禁，不发
```

| 症状 | 查什么 |
|---|---|
| 一直不自动编译 | `ow status` 看水位是否推进；会话是否满 30 轮；是否被信号门剔除 |
| 编译报「未找到可用 LLM 配置」 | 这是**旧的外置方案**的错。现在编译在进程内跑，用 agent 自己的凭据 |
| 发布全被拦 | `ow publish --dry-run` 看门禁明细 |
| 查询 0 结果 | 平台是短语精确匹配，换更短的词 |
| 锁一直不释放 | 30 分钟后自动回收；急用可删 `.qdoc/.ow/lock/` |
