# 每日首次访问自动检查（2026-11-17）

状态：已实现（dsh/pi 接线、安全重装、平台拉取、状态展示）

## 为什么不用固定定时器

原计划是“每天 03:00 全量 + 每 30 分钟轻量”。桌面 agent 的实际使用形态是：

- 笔记本 03:00 可能在睡眠，定时器直接错过；
- 用户不打开 agent 时，技能更新没有意义；
- 30 分钟轮询会在后台无用户时也打平台，收益很小。

改成：**当天第一次有用户活动时检查一次**。技能只有在 agent 运行时才被使用，首次运行前检查反而更及时。

## 触发点

| 宿主 | 信号 | 位置 |
|---|---|---|
| pi | `before_agent_start` 的 user 轮 | `packages/adapter-pi/knowledge-capture.ts` |
| dsh | 定时器发现会话文件 mtime 变化（说明有用户活动） | `packages/adapter-dsh/src/index.ts` |

不要在 `session_start` 单独做：长会话跨天不会再次触发。两个宿主都在每次活动时调 `maybeAutoSync()`，由内部的日期闸决定是否真正执行。

## 状态

机器级，按 host 分开：

```
~/.config/qdoc/auto-sync.json
{
  "schema": 1,
  "hosts": {
    "dsh": {
      "lastSuccessDate": "2026-11-17",
      "lastFullAt": "...",
      "attemptDate": "2026-11-17",
      "attemptsToday": 0,
      "nextRetryAt": null,
      "lastResult": { ... }
    }
  }
}
```

- 只有**成功**才写 `lastSuccessDate`；同日第二次直接返回 `already-checked`。
- 平台失败：`attemptsToday++`，退避 1h/2h/4h，最多 3 次/天；不阻塞对话。
- 锁：`~/.config/qdoc/auto-sync.lock`，TTL 10 分钟，dsh/pi 同时启动时只有一个跑。

## 检查内容

### 1. 仓库技能漂移 → 安全重装

基线在 `~/.config/qdoc/skill-install.json`（安装时写入）。

| 宿主当前 hash | 基线 | 仓库 | 动作 |
|---|---|---|---|
| = 仓库 | 任意 | 相同 | 无事 |
| = 基线 | 不同 | 不同 | 自动重装 |
| ≠ 基线 | — | 不同 | 用户手改过 → 不覆盖，提示 |
| 不存在 | — | — | 安装（没有可丢的内容） |

写入是原子替换（临时目录 + rename），不会让 agent 读到半个技能。

### 2. 平台技能 → 拉取

- 平台新增：直接拉。
- 平台更新 + 本地未改：直接覆盖（`writeSkillDir` 已改成原子替换并清理旧文件）。
- 平台更新 + 本地改过：只落冲突现场，不覆盖。
- 平台移除：只标记，不删本地。

## git 检查

同一轮会跑一次 `git ls-remote origin HEAD`：本地 HEAD 与远端不同时，`git fetch` 后算 `HEAD..origin/<branch>` 的落后提交数，写进 `lastResult.repo.git.behind`，超过 0 时在通知/`ow status` 里提示。

**只提示，不自动 pull**：宿主进程正在用这份代码，自动 pull 后插件不会热更新，反而制造“代码变了但进程没变”的错觉。要更新请手动 `git pull` 后重启宿主。`OW_GIT_CHECK=0` 可关闭。

## 可见性

- pi：`ctx.ui.notify`，只在有变化/冲突/失败时提示。
- dsh：结果写进 `auto-sync.json`，`ow status` 常显；qdoc 前门技能被唤醒时一行播报。
- 干净时完全安静。

## 环境变量

- `OW_AUTO_CHECK=0`：关闭自动检查（排查用）。
- `QDOC_MACHINE_DIR`：覆盖机器级状态目录（测试/多实例）。

## 清单位置

平台技能清单已迁到机器级、按宿主分文件：

```
~/.config/qdoc/skill-manifests/dsh.json
~/.config/qdoc/skill-manifests/pi.json
~/.config/qdoc/skill-manifests/qoder.json
~/.config/qdoc/skill-manifests/codebuddy.json
```

旧的项目级 `.qdoc/.ow/skill-manifest.json` 仍可读：读取时按 `target` 拆回宿主，写入后落新路径；旧文件不删，避免多项目迁移一半。

## 后续

- dsh 的 `notify` 仍写 `errors.log`；要 GUI toast 需要额外 client 插件，暂不做。
- 仓库技能删除后的 prune 尚未实现。
