/** 唤醒词解析：从严判定的边界 */
import { ok, eq, section, summary } from "./_harness.ts";
import { parseWakeWord } from "../lib/trigger/manual.ts";

const cases: Array<{ text: string; cmd: boolean; intent?: string; why: string }> = [
  { text: "小q", cmd: true, intent: "status", why: "裸唤醒 = 播报状态" },
  { text: "小q 沉淀", cmd: true, intent: "capture", why: "沉淀" },
  { text: "小q 记一下这段", cmd: true, intent: "capture", why: "记一下" },
  { text: "小q 发布", cmd: true, intent: "publish", why: "发布" },
  { text: "qdoc 推送", cmd: true, intent: "publish", why: "推送" },
  { text: "小q 查 部署流程", cmd: true, intent: "query", why: "查 + 参数" },
  { text: "小q 搜 MCP", cmd: true, intent: "query", why: "搜" },
  { text: "小q 确认", cmd: true, intent: "review", why: "确认" },
  { text: "qdoc 同步", cmd: true, intent: "sync", why: "同步" },
  { text: "小q 整理", cmd: true, intent: "maintain", why: "整理" },
  { text: "第一句。小q 沉淀", cmd: true, intent: "capture", why: "句首（标点后）" },
  { text: "看这个\n小q 发布", cmd: true, intent: "publish", why: "句首（换行后）" },
  { text: "小q 这个功能怎么做", cmd: false, why: "唤醒词后跟名词 = 普通提问" },
  { text: "qdoc 是什么", cmd: false, why: "后跟名词" },
  { text: "qdocx 是啥", cmd: false, why: "唤醒词是更长词的一部分" },
  { text: "我觉得小q 沉淀 挺好", cmd: false, why: "不在句首" },
  { text: "随便聊聊", cmd: false, why: "无唤醒词" },
  { text: "", cmd: false, why: "空输入" },
];

section("唤醒词边界");
for (const c of cases) {
  const r = parseWakeWord(c.text);
  ok(
    r.isCommand === c.cmd && (!c.cmd || r.intent === c.intent),
    `${JSON.stringify(c.text)} → ${r.isCommand ? r.intent : "非命令"}（${c.why}）`,
    r.isCommand !== c.cmd ? `期望 cmd=${c.cmd} 实际 ${r.isCommand}` : `期望 ${c.intent} 实际 ${r.intent}`,
  );
}

section("参数提取");
{
  eq(parseWakeWord("小q 查 部署流程").args, "部署流程", "查询参数完整取出");
  eq(parseWakeWord("小q 沉淀").args, "", "无参数时为空串");
  eq(parseWakeWord("小q 发布，谢谢").args, "谢谢", "中文逗号后的内容进参数");
}

process.exit(summary());
