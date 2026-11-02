# ThoughtDAG 画布（内置）

「画布」页（`/tools/canvas`）直接加载随应用打包的 ThoughtDAG：问答是节点，连线即上下文。

**入口只有一个**：AI 对话页头部的「画布」按钮（侧栏「工具 › 画布」已撤，因为同一件事在两个地方出现只会让人问「哪个才是真的」）。画布页头部有「← 返回对话」，回到 `/ai/agent`。

## 当前实现

- ThoughtDAG 的 `dist` 已放在 `public/thoughtdag/`，随前端构建复制到 `dist/thoughtdag/`，由云台自己的 WebView 同源加载，**不需要用户下载源码、安装 Node 或启动额外进程**。
- 入口：`/thoughtdag/index.html?su=1`；资源路径已改写为 `/thoughtdag/assets/...`。
- `__nimbus_bridge.js` 随页面加载，只在 iframe 内生效：`window.desktop.sessions` 通过 `postMessage` 转发到 Tauri 命令，可列出/读取本机 Claude Code、Codex、DSH 会话；独立浏览器标签页保留 ThoughtDAG 自己的回退路径。
- 模型列表由云台的 provider 配置生成；画布里的对话请求走 `ai_fetch` 的 SSE 通道，按服务商返回的 `delta.content` 逐块渲染（真流式）。服务商返回 5xx 时自动改用该 provider 的默认模型重试，仍失败则显示 HTTP 状态与错误体。
- `/api/models`、`/api/stream`、`/api/probe-models` 等由桥接层实现；网页抓取、PDF 解析、Claude 代理等宿主没有的 `/api/*` 统一返回 JSON 501，不再落到静态资源 404。
- 画布页只保留刷新、新窗口打开、复制图 JSON 等操作，不再要求选择目录。
- 「新窗口打开」创建的是一个应用内 Tauri 窗口（`index.html#/canvas`），不是系统浏览器：它保留同源 iframe、`window.desktop` 桥和云台凭据。系统浏览器无法访问 `tauri.localhost` 的 IPC，也没有 `/api/*` 代理，所以不作为默认入口。

## 从对话到画布

Agent 页顶部「在画布中打开」会把当前对话导出成一条 DSH 会话（`~/.dsh/sessions/...`），随后跳到画布页。在 ThoughtDAG 里点「打开本机 Agent 对话」，选中该会话（标题取第一条用户消息），就能把它摊成节点图继续分支。

## 会话 ↔ 图映射

`src-tauri/src/sessions/canvas_graph.rs` 提供纯数据映射：

- `session_to_graph(&Session)`：把一条 IR 会话按回合压成 ThoughtDAG 的 `nodes` / `edges` 链（工具事件不进图）。
- `graph_to_session(&Value, id, cwd)`：把画布节点按顺序还原成 `UserPrompt` / `AssistantReply` 事件。
- Tauri 命令：`sessions_thought_graph`（会话→图）、`sessions_import_thought_graph`（图→IR 会话）、`sessions_commit_thought_graph`（图→写入指定 runtime 会话，带目标目录与运行中检查）。

## 验证

```powershell
npm run build
npm run tauri dev
```

判定：打开「画布」页即出现 ThoughtDAG，无需选择目录；新建节点、追问、分段回答正常。

## 升级内置 ThoughtDAG

在 ThoughtDAG 源码目录先 `npm run build`，然后运行：

```powershell
npm run sync:thoughtdag -- <ThoughtDAG 源码目录>
```

脚本会复制 `dist`、复制 `canvas-bridge.js`、注入桥脚本，并把 `/assets/`、`/tutorial/` 等绝对路径改写成 `/thoughtdag/...`，避免手工漏改。
