# AutoSkill dsh 适配方案（v2：宿主独立原则）

> 状态：proposed · 基于 dsh 0.2.1-rc.x（developer preview）· 2026-10-23

## 一、v1 方案错在哪

v1（DSH_PLUGIN_PLAN.md 首版）围绕「双 harness 共享」搭建：

- 阶段 0：`--dest ~/.agents/skills` 让 dsh 扫描根吃到 pi 的输出
- 引擎共用同一数据目录（`~/.pi/agent/data/autoskill/`）
- dsh 配置 `customSkillDirs` 反向指向 `~/.pi/agent/skills`

这三个都是**让一个安装横跨两个宿主**的耦合 hack——数据在谁的命名空间里都不干净，卸载一边留下脏引用，升级一边破坏另一边。

## 二、v2 基石：宿主独立原则

1. **一个安装只属于一个宿主**。装进 pi 就是 pi 的子系统，装进 dsh 就是 dsh 的 bundle；数据目录、输出目标、凭据链、入口映射全部住在该宿主的命名空间内。
2. **两个适配层互不感知**。adapter-pi 不知道 dsh 存在，adapter-dsh 不读 `~/.pi` 下任何一个字节。各自独立安装、独立卸载、独立升级。
3. **引擎是共享代码，不是共享运行时**。`core/` 零宿主依赖；数据目录等宿主上下文由适配层**启动时注入**引擎，引擎自身不知道宿主是谁。

```
packages/
  core/                    # 引擎：抽取/组卡/校验/账本（现 lib/ + scripts/）
    lib/{extract-core,llm,atom-store,apply-patches,skill-state,usage-store,…}.ts
    scripts/{extract,assemble,package-skill,darwin-check}.ts
    唯一约束：零宿主 import；dataDir 由外部注入

  adapter-pi/              # pi 安装形态（现 extensions/knowledge-capture + 根 package.json 的 pi manifest）
    extensions/knowledge-capture/index.ts
    数据：~/.pi/agent/data/autoskill/          （现状不变）
    输出：pi 的 skills 目录约定                （现状不变）
    凭据：pi ModelRegistry → 降级链            （现状不变）

  adapter-dsh/             # dsh 安装形态（新增）
    package.json             # dsh.bundle manifest
    cordis.patch.yml
    src/{index,skill-provider,tools,entries}.ts
    数据：<dshHome>/data/autoskill/            （DSH_HOME 或 ~/.dsh，独立）
    输出：dsh skill registry（registerProvider，原生形态，不落 SKILL.md）
    凭据：dsh llm 服务（inject ['llm']）→ 环境变量降级链
```

每个包独立分发：`pi install …/adapter-pi`、`dsh plugin --profile X add dsh-autoskill`。

## 三、引擎去宿主化（M0 前置改造）

现状 `lib/atom-store.ts` 硬编码 `KB_DIR ?? ~/.pi/...`。改为**上下文注入**：

```ts
// core/lib/context.ts（新增）
export interface HostContext {
  host: "pi" | "dsh" | "cli";
  dataDir: string;        // 原子池/cards/intake/skill-state 全在此之下
}
let ctx: HostContext;
export function setHostContext(h: HostContext): void { ctx = h; }
export function hostContext(): HostContext { return ctx; }
```

- 适配层入口第一步 `setHostContext(...)`；CLI 用 `AUTOSKILL_DATA_DIR` / `--data-dir`
- 默认值规则只在适配层实现：pi → `~/.pi/agent/data/autoskill`，dsh → `<dshHome>/data/autoskill`
- 这一处小改是整个独立性的技术前提：引擎不再认识任何宿主路径

## 四、dsh 适配层设计

### 4.1 manifest（publish.md 规范字段均已实测）

```jsonc
// packages/adapter-dsh/package.json
{
  "name": "dsh-autoskill",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",           // dsh 对 TS entry 的支持待验证（风险 R1）；不支持则 tsdown 转 lib/
  "engines": { "dsh": ">=0.2.0-rc.2" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# packages/adapter-dsh/cordis.patch.yml
- insert:
    - id: autoskill
      name: dsh-autoskill
```

### 4.2 skill provider（输出形态 = dsh 原生 registry）

不落 SKILL.md 文件，直接注册 provider——这是 dsh 宿主内的**原生**输出方式（文件扫描反而是绕路）：

```ts
// packages/adapter-dsh/src/skill-provider.ts
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import { setHostContext } from 'autoskill-core/lib/context.ts'     // 引擎注入
import { domains, loadDomainBody } from 'autoskill-core/lib/atom-store.ts'

export const name = 'autoskill'
export const inject = ['skills']

export function apply(ctx: Context) {
  setHostContext({ host: "dsh", dataDir: dshDataDir() })            // 独立数据目录
  const provider: SkillProvider = {
    list: () => domainCandidates(),      // 每知识主题一个 candidate
    get: (n) => loadDomainBody(n),       // 按需读全文（可记 loaded 账，见 4.4）
  }
  const dispose = ctx.skills.registerProvider(provider)
  ctx.effect(dispose)
}
```

配置项（schemastery）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 数据目录定位基准 |
| `exposeCards` | `false` | 卡片层是否也暴露为可加载 skill（细粒度路由） |
| `knowledge` | — | CLI 形态下等价 `AUTOSKILL_DATA_DIR` |

已实测前提：web profile 默认内置 `dsh-skill` + `dsh-skill-filesystem` + `dsh-tool-skill` 三件套，provider 注册后模型自动获得目录与 `skill` 加载工具，无需额外挂载。

### 4.3 抽取五入口的 dsh 映射（逐个独立交付）

| 入口 | pi 实现 | dsh 实现 | 成本 |
|---|---|---|---|
| capture_knowledge | extension 工具 | `defineTool` 同名同 schema 注册，execute 原样调 core `appendAtoms` | 低 |
| kb_harvest | detached spawn CLI | 同名工具触发 core CLI（`--data-dir` 指向 dsh 目录） | 低 |
| compaction 抢救 | `session_before_compact` | dsh compaction 包扩展点（**待查证 R2**）；无则降级手动 | 中 |
| quit 终采 | `session_shutdown` | dsh session 生命周期事件（**待验证 R2**） | 中 |
| 手动回填 | CLI | CLI：`node scripts/extract.ts <session> --data-dir <dsh目录>` | 零 |

**dsh 原生增值**：dsh 内置 Schedule 服务（cron/每日/间隔），可定时跑 `assemble.ts` 实现「真·定时整合」，替代 pi 侧靠 session_start 注入提示的机制——这是 dsh 形态独有能力。

### 4.4 凭据与审计（各自宿主内闭环）

- **LLM 凭据**：适配层优先 `inject: ['llm']` 复用 dsh host 已配好的服务（等价于 pi 版复用 ModelRegistry）；host 无 llm 服务时走 core 降级链（env → settings → models.json）。两条链都在**本宿主内**解析，不跨宿主。
- **使用审计**：usage.jsonl 落在本宿主数据目录。dsh 侧 `provider.get()` 是模型读 skill 的唯一真相源——比 pi 的模糊匹配更精确，loaded 记账直接在 get 里追加。
- **darwin 体检**：accepted/rejected 回扫逻辑在 core，由 dsh Schedule 任务驱动（对应 pi 的 quit 终采扫描），结果落本宿主 usage.jsonl。

## 五、仓库迁移与兼容

### 方案 B：三分包 monorepo（推荐）

按第二节结构拆 `packages/{core,adapter-pi,adapter-dsh}`。迁移步骤：

1. `git mv lib scripts` → `packages/core/`；`extensions` → `packages/adapter-pi/`
2. 根 package.json 的 pi manifest 移入 `packages/adapter-pi/package.json`
3. 相对导入修正：`../../lib/x.ts` → `autoskill-core/lib/x.ts`（workspace 依赖或 path alias）
4. 新增 `packages/adapter-dsh/`

**兼容注意**：已有用户 settings.json 记录的是相对安装路径（`./AutoSkill`），拆包后需重跑一次 `pi install ./AutoSkill/packages/adapter-pi`。迁移 PR 里必须写明并给一次性验证步骤（`/kb` 应报出原数据目录）。

### 方案 A：根包不动 + dsh 子目录（低扰动备选）

根保持 pi 形态，仅新增 `plugins/dsh-autoskill/` 引用 `../lib`。运行时同样满足独立原则（dsh 数据目录独立），但分发形态纠缠（dsh git 安装会拉进整个 pi 仓库），作为迁移期过渡可接受、终态不推荐。

## 六、任务清单

- [ ] **M0** 引擎去宿主化：HostContext 注入改造 + 两形态回归（`/kb` 与 smoke 抽取各跑通一次，pi 侧数据目录必须原位不动）
- [ ] **M1** dsh bundle 骨架：manifest + patch；`dsh plugin --profile web add` 走通，`--dump-config` 出现 autoskill 层（同时验证 R1：TS entry 是否可用）
- [ ] **M2** provider 上线：注册成功、模型可见知识主题目录、`get` 返回全文；dsh 数据目录首次导入（从现有 session 用 CLI 补抽，`--data-dir` 指 dsh 目录）
- [ ] **M3** 两工具：capture_knowledge / kb_harvest 在 dsh 会话可调用且原子入库
- [ ] **M4** 生命周期入口：查证 R2 并挂接 compaction / shutdown；查证失败则记录替代（Schedule 回扫）
- [ ] **M5** dsh 原生增值：Schedule 定时 assemble + darwin 回扫
- [ ] **M6** 发布：npm 发 dsh-autoskill（含构建产物，免 prepare 白名单）
- [ ] **M7** 双形态冒烟清单：pi、dsh 各跑一遍「抽→整→路由→审计→darwin 记账」，纳入日常回归

## 七、风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | dsh 是否支持 `.ts` main 未实测 | M1 首日验证；不行则 tsdown 单文件转译（参照 dsh 自家 skill-filesystem 的 `main: lib/index.js`） |
| R2 | compaction / session 生命周期扩展点未查证 | M4 查证；查证失败有兜底（手动 CLI / Schedule 回扫），不阻塞 M0-M3 |
| R3 | 迁移破坏既有 pi 安装（相对路径失效） | 迁移 PR 附一次性重装步骤 + `/kb` 验证数据目录原位 |
| R4 | dsh developer preview 破坏性变更 | engines 宽范围 + M7 冒烟作心跳 |
| R5 | 引擎改动需两形态同步回归 | M7 清单化；core 变更 PR 标注影响面 |

## 八、一句话总结

**引擎共享代码，运行时互不相识**：core 只认识注入进来的 HostContext；装进谁家，数据目录、输出形态（pi 落 SKILL.md / dsh 注册 registry）、凭据链、五入口映射就是谁家的原生形态。砍掉 v1 全部跨宿主指向（`--dest` 反指、customSkillDirs 反指、共享 `~/.pi` 数据目录）。
