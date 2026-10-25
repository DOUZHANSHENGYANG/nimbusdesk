# AI 对话：Markdown 与回退

## Markdown 渲染

助手正文按 Markdown 渲染：标题、列表、表格、引用、代码块都走
`src/ahub/components/Markdown.tsx`（`marked` + `DOMPurify`，只信任净化后的 HTML）。
样式复用全局 `index.css` 里的 `.md-body`，不再由气泡的 `white-space: pre-wrap` 兜底；
外层加 `.agent-markdown` 关掉 pre-wrap，避免块级元素之间多出空行。

用户消息仍是原文气泡（不解释 Markdown），复制 / 导出拿到的也是用户输入的原文。

截图：`docs/screenshots/agent-markdown.png`。

## 回退到某条消息

用户消息悬停后多了一个「回退到这里」按钮（撤销箭头）：

- 停掉正在生成的那一轮；
- 删掉这条消息**及它之后**的全部消息，并落盘；
- 把这条消息的原文放回输入框（草稿存在 agent store 里，切换会话会清空），
  用户可以改完再发。

它不会调用模型，也不会保留被删掉的分支；需要保留旧回答时先导出 Markdown。
`编辑并重发` 仍是「就地替换 + 立刻重发」，两者分工不同。

截图：`docs/screenshots/agent-revert.png`。

## 输入区外观

输入框本身不再画一圈边框，只保留底色与工具栏；与对话区之间仍有一条 `border-top`
分隔线。聚焦时不再有额外的 ring 套在输入框上。

夹具：`src/features/agent/fixtures/agent-thread.html`（带 Markdown 的会话 + 回退按钮），
`node scripts/shot-agent-thread.mjs` 生成上面两张截图。
