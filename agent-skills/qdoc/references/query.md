# 查询策略

## 三级降级

```
1. 本地 vault 里 grep
2. 不够 → search_documents
3. 命中 → read_document_content 读全文
```

## 平台搜索是短语精确匹配

实测：

| 查询 | 结果 |
|---|---|
| `qdoc MCP` | 0 命中 |
| `qdoc` | 2 命中 |
| `MCP` | 1 命中 |

**不是语义搜索**，是字面短语匹配。所以：

- 多词查询常常 0 结果
- `ow query` 已内置按词降级：原句无结果时，取最长的词重试，并提示降级了
- 自己写查询时优先用**单个关键术语**

## 来源还原

知识页末尾有 `<!-- ow:meta {...} -->` 注释，记着：

```json
{"schema":1,"agent":"dsh","session_id":"...","from_turn":1,"to_turn":30,
 "pages":[...],"compiled_at":"...","model":"..."}
```

`ow query` 会解析它并显示「来源：dsh / test-1 / 第 1-3 轮」。

**这个注释发布后仍在**（实测原样保留）。平台不会渲染 HTML 注释，所以不影响阅读。

## 读 tags 的成本

`list_documents` **不返回 tags**，要读必须对每篇单独 `read_document`。批量读 N 篇 = N 次调用。
