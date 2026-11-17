# autoskill-adapter-opencode

把 [qdoc/AutoSkill](../../README.md)（会话知识自动沉淀）接进 [OpenCode](https://opencode.ai) 的服务端插件。

## 它做什么

- **自动编译**：每 30 个用户轮次，后台把会话内容编译成 qdoc 知识页（30 轮闸 → 信号门 → 预算闸 → 两级锁，与 dsh/pi 完全同一套 core 编排）
- **压缩前抢救**：会话 transcript 被压缩前，先把即将被抹掉的部分编译掉
- **空闲补跑**：会话空闲时补跑不足 30 轮的尾巴（≥5 轮才值得编）
- **手动沉淀**：`qdoc_capture` 工具——用户说「小q 沉淀」时立即编译剩余轮次
- **每日同步**：每天首次对话拉一次平台技能（安全重装，冲突不覆盖）
- **会话模型直连**：编译内核直接用当前会话的模型（`ctx.experimental.generate.text`，失败回退 `ctx.session.generate`），不要求另配 API key

数据隔离：知识数据在 `~/.config/qdoc/knowledge/opencode`，与 pi/dsh 互不沾染；技能落盘 `~/.config/opencode/skills`。

## 安装

前提：本仓库已就位（`npm run install-skill` 已跑过，`ow` 可用）。

```bash
# 项目级（推荐先在一个项目里试）
mkdir -p /path/to/project/.opencode/plugins
ln -s <本仓库>/packages/adapter-opencode /path/to/project/.opencode/plugins/autoskill-opencode

# 或全局
mkdir -p ~/.config/opencode/plugins
ln -s <本仓库>/packages/adapter-opencode ~/.config/opencode/plugins/autoskill-opencode
```

或用 opencode.json(c) 的 plugins 数组：

```jsonc
{
  "plugins": [
    { "package": "/绝对路径/AutoSkill4Personal/packages/adapter-opencode" }
  ]
}
```

依赖 `@opencode/plugin` 只是类型助手，缺了也能加载（入口做了降级）。要装的话：

```bash
cd ~/.config/opencode/plugins/autoskill-opencode && npm install
```

自检：`ow doctor --host opencode`（目录、插件、漂移一次查完）。

## 配置开关（环境变量，全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `OW_AUTO_INIT` | 未设 | `1` = 首次编译时自动初始化知识库（否则项目要先 `ow init`） |
| `OW_TURNS` | `30` | 编译窗口的轮次阈值 |
| `OW_AUTO_CHECK` | 开 | `0` = 关掉每日平台技能检查 |
| `AUTOSKILL_AUTO_UPDATE` | 关 | `1` = 仓库落后时自动 `git pull --ff-only` + 安全重装技能 + 热载 |
| `KB_DIR` | `~/.config/qdoc/knowledge/opencode` | 知识数据目录覆盖 |

## Git 自动更新的边界

`AUTOSKILL_AUTO_UPDATE=1` 只做 `git pull --ff-only`：分叉时必然失败并进入退避（1h → 2h → 4h），**绝不会** reset/checkout/force——fork 上的改动不可能被覆盖。失败详情在 `~/.config/qdoc/auto-update.json`。

注意：自动更新拉到**插件代码本身**的变化后，需要重启 OpenCode 服务进程（`opencode service restart`）才生效——已加载的模块不会热替换；技能（SKILL.md）则通过 `ctx.skill.reload()` 立即生效。

## 与 dsh/pi 适配器的差异

| | dsh | pi | opencode |
|---|---|---|---|
| 触发 | 定时器 | `before_agent_start` | prompt 钩子 + idle 事件 + compaction 钩子 + 工具 |
| 会话读取 | 会话文件（zstd） | sessionManager 内存 | `ctx.session.context()` live 读取 |
| LLM | 宿主 ctx.llm | pi 凭据链 | 会话当前模型（generate 直连） |
| 编译产物热载 | 原生 registry | 实体拷贝 + 提醒 | 实体拷贝 + `ctx.skill.reload()` |
