# 知识库维护

## 目录

```
.qdoc/
  concepts/ entities/ skills/ references/ synthesis/ journal/
  index.md      自动生成，别手改
  log.md        变更日志
  hot.md        近 7 天改动
  AGENTS.md     这个库该怎么写
  .manifest.json
  .ow/          运行态（gitignore）
    state.json  轮次水位
    lock/       vault 锁
    reports/    编译报告
    pending/    待确认队列
    policy.json 「这类别再问」
    skill-manifest.json  本机装了什么技能
  .publish/     （gitignore）
    ledger.json 发布账本
    conflicts/  冲突现场
```

## 重建索引

```bash
ow maintain            # 重建 index.md / hot.md
ow maintain --dry-run  # 只看会改什么
```

## 页面结构

每页固定 frontmatter：

```yaml
---
title: 页面标题
tags: [标签1, 标签2]
category: concepts
confidence: 0.8        # 0-1，低于 0.45 不发
status: active         # active / archived / disputed
sources: [会话来源]
---
```

`confidence < 0.45`、`status: archived|disputed`、正文 < 200 字符、推断占比 > 70% —— 都会被门禁拦下。

## 冲突怎么处理

`ow publish` 时如果平台侧版本已变（别人改过），本地不覆盖，落 `.publish/conflicts/`：

```
.publish/conflicts/<page>/
  local/    本地版本
  remote/   平台版本
```

看两边差异后，把要留的内容合进 vault 页面，再 `ow publish`。

## 预算

机器级，记在 `~/.config/qdoc/machine.json`：

```json
{"date":"2026-11-13","compiles":12,"tokens":48000,
 "by_vault":{"~/projA":{...},"~/projB":{...}}}
```

默认每日 ≤50 次 / ≤200k token，**整机合计**。超了当天不再自动编译（手动仍可）。
