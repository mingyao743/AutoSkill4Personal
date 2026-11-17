/**
 * OpenCode Server 插件上下文的最小结构类型（设计文档 §3.2）。
 *
 * 为什么不 import @opencode/plugin 的类型：
 *  - 仓库内跑测试/构建的机器没装该依赖（OpenCode 加载插件时才解析）；
 *  - 只用到的面很窄（session/event/tool/skill/generate），结构类型足够，
 *    且对 OpenCode 版本演进更抗噪——未知字段一律走索引签名。
 *
 * 字段形状按官方文档 https://opencode.ai/docs/build/plugins/server ；
 * 消息形状（role/parts）按「扁平 {role, parts}」与「V1 包装 {info, parts}」
 * 两种都兼容，由 messages.ts 归一。
 */

/** 模型引用：generate.text 的 model 参数 / session.model 的形态 */
export interface OcModelRef {
  providerID: string;
  id: string;
  [k: string]: unknown;
}

export interface OcSessionInfo {
  id?: string;
  /** 会话所在目录（决定 vault 归属） */
  directory?: string;
  /** 会话当前模型（completer 直连用） */
  model?: OcModelRef;
  [k: string]: unknown;
}

/** 单条 tool part 的宽松形状（各版本字段名不齐，取第一个命中的） */
export interface OcPart {
  type?: string;
  text?: string;
  name?: string;
  tool?: string;
  toolName?: string;
  state?: { tool?: string; name?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** 会话消息：兼容扁平与 info 包装两种形态 */
export interface OcMessage {
  id?: string;
  role?: string;
  time?: { created?: number } | number;
  parts?: OcPart[];
  text?: string;
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** prompt 钩子事件（session.hook("prompt")；我们只读，不改 draft） */
export interface OcPromptEvent {
  sessionID?: string;
  prompt?: { text?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** compaction 钩子事件：messages 是即将被压缩的 transcript */
export interface OcCompactionEvent {
  sessionID?: string;
  messages?: OcMessage[];
  [k: string]: unknown;
}

/** ctx.event.subscribe 吐出的事件包（session.idle 等） */
export interface OcEventEnvelope {
  type?: string;
  properties?: { sessionID?: string; info?: OcSessionInfo; [k: string]: unknown };
  [k: string]: unknown;
}

/** 工具执行上下文（我们只消费 sessionID） */
export interface OcToolContext {
  sessionID?: string;
  signal?: AbortSignal;
  [k: string]: unknown;
}

/** 服务端插件 ctx：只声明本项目用到的方法 */
export interface OcPluginContext {
  app?: { version?: string };
  location?: {
    directory?: string;
    project?: { directory?: string; canonical?: string };
  };
  session: {
    get(input: { sessionID: string }): Promise<OcSessionInfo>;
    context(input: { sessionID: string }): Promise<readonly OcMessage[]>;
    /** 会话内瞬态生成：用会话当前模型，不进历史、不起工具 */
    generate(input: { sessionID: string; prompt: string }): Promise<{ text?: string; [k: string]: unknown }>;
    hook(
      kind: "prompt" | "compaction",
      handler: (event: OcPromptEvent & OcCompactionEvent) => void | Promise<void>,
    ): unknown;
    [k: string]: unknown;
  };
  experimental?: {
    generate?: {
      text(input: { model?: OcModelRef; prompt: string }): Promise<{
        text?: string;
        model?: OcModelRef;
        [k: string]: unknown;
      }>;
    };
  };
  event: {
    subscribe(input: { types: string[] }): AsyncIterable<OcEventEnvelope>;
  };
  tool: {
    transform(
      callback: (editor: {
        add(tool: {
          name: string;
          description: string;
          input: Record<string, unknown>;
          options?: { namespace?: string; codemode?: boolean };
          execute: (input: Record<string, unknown>, context: OcToolContext) => Promise<unknown> | unknown;
        }): void;
      }) => void,
    ): Promise<unknown>;
  };
  skill?: {
    reload?(): Promise<void>;
  };
  [k: string]: unknown;
}
