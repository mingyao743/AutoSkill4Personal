/** pi session entry 类型（仅本管道用到的子集） */

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | { type: string; [k: string]: unknown };

export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  [k: string]: unknown;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: AgentMessage;
  [k: string]: unknown;
}

/** 切分后的窗口（内存中间产物，不落盘） */
export interface Window {
  window_id: string;
  session_id: string;
  msg_range: [string, string];
  entry_count: number;
  entries: MessageEntry[];
}
