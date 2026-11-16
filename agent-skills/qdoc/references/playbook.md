# 常用流程一条龙

> 每个流程都是实测过的最短路径。命令输出里带的「下一步」提示照着做即可，不用再问用户。

## 发布一页到平台

```bash
ow publish --dry-run      # 先看门禁：拦截 0 才继续
ow publish                # 成功输出带 平台文件名 / UUID / 验证命令
ow query "<输出里的关键词>" # 验证（输出提示了用什么词）
```

- 发布失败先看输出里的门禁信息；再跑 `ow status` 看失败原因，**不要盲目重试**。
- 台账 doc_id 不可达（换 token / 旧数字 id）→ `ow publish` 会自动重建，不用手动处理。

## 改平台文件名 / 改 tag

```bash
ow doc rename references/foo.md 新标题          # 自动补 .md，台账同步
ow doc tag references/foo.md --add p:myproj     # 加 tag（逗号分隔多个）
ow doc tag references/foo.md --remove 旧tag
```

- `<page>` 用台账里的 vault 相对路径；也可以直接给平台 UUID。
- 项目分组 tag 用 `p:<短名>`（平台 tag ≤20 字符，超长静默截断）。
- 改正文不用这两个命令——改 vault 里的 md 再 `ow publish`（有门禁和版本管理）。

## 待办

```bash
ow todo list                       # 未完成（--all 含已完成，--due YYYY-MM-DD 过滤）
ow todo add "跟进 xx" --priority 1 --due 2026-11-20
ow todo done <id>                  # id 用 list 输出的完整 id
ow todo undone <id>                # 取消完成
ow todo edit <id> --title 新标题 --clear-due
ow todo projects                   # 项目与完成统计
```

- todo 是纯透传：不进台账、不进编译窗口。平台无删除，加错就用 `done` 收掉。
- `--project` 收项目名或 id；缺省落到「收件箱」。

## 接入新 agent 宿主

```bash
ow mcp-config --host qoder > ~/.qoder-cn/settings.json   # Qoder CN CLI
ow mcp-config --host codebuddy                            # CodeBuddy Code CLI（写入其 settings）
ow mcp-config --host workbuddy                            # WorkBuddy 桌面版：粘贴到连接器 UI
ow mcp-config --host raw                                  # 裸的 qdoc 服务器对象，嵌进已有配置
```

- 配置里 `alwaysAllow` 只放只读工具；写操作保留逐次确认。
- token 换了就重跑一次（输出含 token，别贴到公开场合）。
- 技能安装：`npm run install-skill` 同步四家宿主目录（`--check` 验漂移）。

## 排错速查

| 症状 | 动作 |
|---|---|
| 发布被拦 | 输出里有 `[门禁名] 原因`；按提示改页面对应字段 |
| 查询 0 结果 | 搜索是短语精确匹配，换更短的词重试 |
| 台账 doc_id 是旧数字 id | `ow publish` 一次即自愈重建（新 UUID），之后一切正常 |
| 技能推上去看不见 | 平台落库默认未启用，要人到 qdoc.chat 点启用 |
| MCP 报 502 | 平台网关抖动，ow 自带重试；仍失败等几分钟再试 |
| 「令牌缺少权限 todo:read/write」 | token 是分权限的：去 qdoc.chat 重新生成 token（勾选待办权限）并更新 `~/.config/qdoc/token` |
| 平台技能 description 显示成 `>` | SKILL.md 用了 YAML 折叠标量（`description: >` 换行写）；平台按行解析，只认单行。把 frontmatter 改成单行再 `ow sync --yes` |
