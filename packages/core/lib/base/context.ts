/**
 * HostContext：引擎去宿主化的注入点（方案 v2 基石）。
 *
 * core 零宿主依赖——它不认识 pi / dsh / 任何宿主的路径约定；
 * 数据目录等宿主上下文由适配层（extensions/knowledge-capture、plugins/dsh-autoskill）
 * 或 CLI 参数在启动时注入。默认值规则只在适配层实现，不在这里。
 *
 * 注入语义：
 *  - setHostContext 幂等：已注入时再调无效（extension 与 spawn CLI 各自进程各注一次）
 *  - 未注入时 hostContext() 返回 null——调用方（core 内部）必须显式处理，
 *    而不是静默回退到某个宿主路径（那会重新耦合）
 */
export type HostKind = "pi" | "dsh" | "cli";

export interface HostContext {
  /** 宿主种类：决定日志措辞与诊断指引，不参与路径计算 */
  host: HostKind;
  /** 知识数据根目录：atoms.jsonl / cards/ / intake/ / skill-state.json / usage.jsonl 全在此之下 */
  dataDir: string;
  /** skills 输出目录（可选）：落盘文件形态的宿主提供（pi）；原生 registry 形态可省略（dsh） */
  skillsDir?: string;
  /** 凭据定位基准（可选）：pi 形态 = ~/.pi/agent；core 据此读 models.json/settings.json。
   *  不注则降级链只走环境变量直连——core 绝不自带宿主路径默认值 */
  homeDir?: string;
  /** 凭据文件显式覆盖（可选）：优先于 homeDir 拼接；用于非标准布局 */
  modelsPath?: string;
  settingsPath?: string;
}

let ctx: HostContext | null = null;

/** 注入（幂等：已注入时再调无效；冲突注入拒绝，早期暴露 bug） */
export function setHostContext(h: HostContext): void {
  if (ctx) {
    const same = ctx.host === h.host && ctx.dataDir === h.dataDir &&
      (ctx.skillsDir ?? null) === (h.skillsDir ?? null) &&
      (ctx.homeDir ?? null) === (h.homeDir ?? null);
    if (!same) {
      throw new Error(
        `HostContext 冲突注入：${ctx.host}:${ctx.dataDir} ≠ ${h.host}:${h.dataDir}`,
      );
    }
    return;
  }
  ctx = h;
}

/** 未注入返回 null（core 调用方显式处理，禁止静默回退宿主路径） */
export function hostContext(): HostContext | null {
  return ctx;
}

/** CLI 便捷注入：--data-dir <dir> / AUTOSKILL_DATA_DIR 环境变量；都没有则返回 false 不注入 */
export function setHostContextFromArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (ctx) return true; // 已注入（幂等）
  const i = args.indexOf("--data-dir");
  const dir =
    (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined) ??
    env.AUTOSKILL_DATA_DIR;
  if (!dir) return false;
  setHostContext({ host: "cli", dataDir: dir });
  return true;
}
