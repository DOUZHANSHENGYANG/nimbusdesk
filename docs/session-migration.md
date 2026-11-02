# 会话迁移：OpenCode / DeepSeek Harness / WorkBuddy

「会话」页（`/toolbox/sessions`）把三家本机会话收进一张表，并支持任意方向迁移。

## 数据来源

| Runtime | 读 | 写 |
|---|---|---|
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite，WAL；只读连接；兼容 legacy `session`/`message` 与 v2 `session_v2`/`session_message`） | 生成官方 export JSON；先试 `opencode session import`，失败时启动临时 `opencode serve`，走 `/api/experimental/session/import` |
| DeepSeek Harness | `~/.dsh/sessions/<cwd>/session-<uuid>/session*.jsonl[.zstd]`（多帧 zstd） | 生成 v0 `session.jsonl.zstd`（header 帧 + events 帧），登记 `~/.dsh/storages/workspace.json` |
| WorkBuddy | `~/.workbuddy*` 的 `projects/<slug>/<uuid>.jsonl` | 写新 JSONL（`message` 行） |

`~/.workbuddy` 与 `~/.workbuddy-ai` 自动探测；`WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR` 优先。

## 迁移语义

- **源会话只读**：迁移只创建目标新会话，绝不改源文件/源数据库。
- **IR 是有损投影**：用户消息与助手正文保留；工具调用/结果、思考正文、runtime 私有字段、部分工具参数不跨 runtime（目标写入器会在 `dropped` 里列出）。
- **幂等**：`~/.nimbusdesk/session-migration/state.json` 记录 `source + sessionId + target`，重复迁移直接回放上次结果（返回 `skipped: true`）。
- **原子写**：目标文件先写 `.tmp`，再用平台原子替换（Windows `MoveFileExW` / 其他 `rename`）；DSH 的 workspace.json 同样 tmp + 替换。
- **运行中检测**：Windows 下写 WorkBuddy / OpenCode / DSH 前会检查目标进程（DSH 的 npm shim 通过 `node.exe` 命令行识别），目标在运行就拒绝迁移（避免写冲突）。

## 验证

```powershell
cd src-tauri
cargo test sessions::adapter -- --test-threads=1
cargo test sessions::transfer::transfer_tests::dsh_to_workbuddy_roundtrip -- --test-threads=1
```

本机实测（2026-10-29）：三家聚合 368 条（DSH 76 / OpenCode 152 / WorkBuddy 140）；六个方向（OpenCode/DSH/WorkBuddy 两两）均有真实会话迁移与读回验证。

## 已知边界

- OpenCode 的 `session import` 在本机 v2.1.4 不可用：官方 `session export` 原始会话仅改 id 后再导入返回 `Internal Server Error`，自建导出返回 `Bad Request`。写入器会回退到临时 `opencode serve` 的 `/api/experimental/session/import`；该路径已实测可写入并读回，但依赖本机 `opencode` CLI 与 v2 API。
- WorkBuddy 桌面任务列表：写入项目 JSONL 后会向 `workbuddy.db` 的 `sessions` 表插入一条元数据（表不存在或结构不同则静默跳过，不改既有行）。
- 三家写入器当前都只写用户/助手消息，不保留工具调用；DSH 的错误/工具事件也会进入 `dropped`。WorkBuddy 读取器会从 `<system-reminder>` 包裹中提取 `<user_query>`，纯注入消息才丢弃。
- 会话格式随版本变化：适配器带格式探测，识别不了会拒绝写而不是猜。
