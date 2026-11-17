/**
 * OpenCode 插件入口（设计文档 §3）。
 *
 * 加载方式（README 有完整步骤）：
 *   - 项目级：.opencode/plugins/autoskill-opencode/ ← 软链或复制本目录
 *   - 全局：  ~/.config/opencode/plugins/autoskill-opencode/
 *             或 opencode.json(c) 的 plugins 数组写绝对路径
 *
 * 依赖说明：@opencode/plugin 只是 Plugin.define 的类型/标记助手。
 * 本地目录形态下依赖可能没装——这里做了降级：import 失败就用恒等 define，
 * OpenCode 加载的是同一个普通对象（默认导出的 { id, setup })。
 */
import { initHostContext, opencodeDataDir } from "./host.ts";
import { createChatCompleter, sessionModel } from "./completer.ts";
import { setChatCompleter, clearChatCompleter } from "../../packages/core/lib/base/llm.ts";
import { registerTriggers } from "./triggers.ts";
import type { OcPluginContext } from "./types.ts";

type Define = <T>(def: T) => T;

let Plugin: { define: Define } | undefined;
try {
  ({ Plugin } = await import("@opencode/plugin"));
} catch {
  // 依赖未安装（本地目录直载形态）：走恒等 define，不影响加载
}

const define: Define = Plugin?.define ?? ((def) => def);

export default define({
  id: "autoskill",
  async setup(ctx: OcPluginContext) {
    initHostContext();
    setChatCompleter(
      createChatCompleter({
        getModel: (sessionID) => sessionModel(ctx.session.get, sessionID),
        generateText: async ({ model, prompt }) => {
          const generate = ctx.experimental?.generate?.text;
          if (!generate) throw new Error("experimental.generate 不可用");
          return await generate({ model, prompt });
        },
        sessionGenerate: async ({ sessionID, prompt }) =>
          await ctx.session.generate({ sessionID, prompt }),
      }),
    );
    const registration = await registerTriggers(ctx);
    console.error(
      `[autoskill] opencode 插件已加载（OpenCode ${ctx.app?.version ?? "?"}，数据目录 ${opencodeDataDir()}）`,
    );
    return () => {
      registration.dispose();
      clearChatCompleter();
      console.error("[autoskill] opencode 插件已卸载");
    };
  },
});
