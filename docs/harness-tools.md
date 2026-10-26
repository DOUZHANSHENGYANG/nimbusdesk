# Harness 工具：路径、配置与迁移

「Harness 工具」页现在按工具分行管理：CLI 状态、配置文件、技能目录、备份和迁移入口都在同一条目里。
MCP / Skills 仍走各自页面；这里管的是**工具本身**。

页面是**一页到底**，不再切页签（原来是「Harness 工具 / 本机技能 / CLI 版本 / 配置备份」四个）：
「本机技能」只是技能页的只读副本（重复，已删），另外三个是同一批工具的不同侧面。
现在从上到下：

1. **工具卡片**（日常看的）：每张卡就有 CLI 版本 / 缺失 / 可更新状态与「更新 · 修复 · 安装」按钮、
   配置文件、技能目录、打开与复制路径、单卡刷新、迁移入口；
2. **CLI 版本**（维护类，默认折叠）：批量检查 / 批量更新的那张表；
3. **配置版本历史**（维护类，默认折叠）：配置文件的版本快照与回滚。

CLI 的状态与更新**已经落在卡上**，所以下面第 2 段平时收着就行 —— 它是给「一次更一批」用的。

**工具的展示顺序**在「设置 → 工具顺序」里拖（`HarnessOrderSection`，存 `settings.harnessOrder`），
工具卡片会跟着这份顺序排；没配过就用后端默认顺序，默认把常用的排前面：

```
opencode · dsh(deepseek) · codex · claude code · codebuddy · pi
```

其余工具（claude desktop / cursor / windsurf / gemini cli / vscode / cline / workbuddy / 自定义目录）
按静态表顺序排在后面（`harness.rs` 的 `DEFAULT_ORDER` + 稳定排序）。

## 已接入工具的目录结构（调研结果）

| 工具 | 配置文件 | 用户目录 / 技能目录 | 官方迁移变量 |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `~/.claude/`，`~/.claude/skills/` | `CLAUDE_CONFIG_DIR`（移动整个 `~/.claude`；`.claude.json` 需一并处理） |
| Codex CLI | `~/.codex/config.toml` | `~/.codex/`，`~/.codex/skills/` | `CODEX_HOME`（目录必须已存在） |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/` | `GEMINI_CLI_HOME`（根目录，CLI 在其下创建 `.gemini`） |
| OpenCode | `~/.config/opencode/opencode.json`、`~/.opencode/opencode.json` | `~/.config/opencode/skills/`、`~/.local/share/opencode/` | `XDG_CONFIG_HOME` / `XDG_DATA_HOME`（`OPENCODE_CONFIG_DIR` 是额外搜索目录） |
| CodeBuddy | `~/.codebuddy/mcp.json`、`~/.codebuddy/.mcp.json`、`~/.codebuddy/config.json` | `~/.codebuddy/`，`~/.codebuddy/skills/` | `CODEBUDDY_CONFIG_DIR` |
| PI Agent | `~/.pi/agent/mcp.json` | `~/.pi/agent/`，`~/.pi/agent/skills/` | `PI_CODING_AGENT_DIR`（必须指到 `agent` 这一层，不是 `~/.pi`） |
| DeepSeek | `~/.deepseek/mcp.json`、`~/.deepseek/config.json`（当前扫描口径） | `~/.deepseek/skills/` | `DSH_HOME`（官方 DSH 默认 `~/.dsh`，以本机安装为准） |
| WorkBuddy | `~/.workbuddy/mcp.json` | `~/.workbuddy/skills/` | 未发现公开变量，建议目录联接 |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `%APPDATA%\Claude\` | GUI 应用，建议目录联接 |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/` | GUI 应用，建议目录联接 |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/` | GUI 应用，建议目录联接 |
| VS Code / Cline | `%APPDATA%\Code\User\...` | VS Code/Cline 配置目录 | GUI 应用，建议目录联接 |

> 路径来自 `src-tauri/src/ahub/harness.rs` 的 `HarnessDef`，并对照各工具官方文档核对；
> 工具升级后路径可能变化，以页面实际扫描结果为准。

## 扫描与缓存（为什么有时候要等）

这个页面要准备两样数据，代价差三个数量级：

| 数据 | 来源 | 实测 |
|---|---|---|
| Harness 目录报告（哪些工具存在、有几个技能、MCP 配置在哪） | `harness::scan`：只读目录 + 解析配置文件，**不起子进程** | 约 **26 ms** |
| 工具版本列表 | `toolmgr::list`：`npm ls -g --json` + 每个 CLI 跑一次 `--version` | npm **约 1.6 s**，探针每个 **0.1–0.2 s × 十几个** |

所以「加载中」几乎全花在版本探针上，目录扫描不值一提。两条缓存都按「一天/五分钟」的粒度挡在
前端与后端：

- **目录报告**：`src/ahub/lib/harnessScan.ts` 是唯一入口 —— 自然日内全应用共用一份结果，
  并发调用共用同一个 in-flight Promise；任何一次「强制扫」（打开批量配置、单卡刷新）
  都会顺手刷新这份缓存。
- **版本列表**：`toolmgr::list` 后端 5 分钟 TTL + 安装/更新后显式失效
  （`invalidate_list_cache`）。反复进出页面不会重复探，真装了新工具也不用等太久。

## 每个工具能做什么

- **CLI**：显示 npm 当前版本；「检查 CLI 更新」批量查 registry；有更新、缺失或命令跑不起来时给
  「更新 / 安装 / 修复」，执行 `npm i -g <pkg>@latest`（包名来自静态表，不接受外部输入）。
- **配置文件**：每一条路径都能打开所在文件夹、复制完整路径；铅笔图标打开 `ConfigEditorPanel`
  实时编辑，保存前自动写快照并做语法校验；磁盘图标立即打一份配置快照。
- **技能目录**：列出每个 `skills` 目录并可直接打开/复制，避免去猜 `~/.xxx/skills`。
- **迁移**：迁移弹窗按工具给出官方环境变量（没有的给 junction 方案）和可复制命令；
  迁移前先备份、关闭工具，确认新目录可读后再清旧目录。应用不自动搬目录，避免搬一半
  或把正在登录的凭据弄丢。

## 为什么迁移不直接一键搬

配置文件经常被正在运行的 CLI 持有，凭据文件还可能是只读的；自动 `move` 一旦中途失败，
工具会以「配置丢失」状态启动。这里只生成**可核对、可复制**的命令，并要求用户先备份、退出工具，
再由用户执行；这是比「点一下然后坏了」更安全的做法。后续如果要做自动迁移，应先做
「复制 → 校验新目录 → 设变量 → 重开工具 → 确认无误 → 清旧目录」的完整事务。

## 验证

- 夹具：`src/ahub/fixtures/harness-skills.html`（mock `scan_harnesses`、`tool_list`、
  `vault_snapshot`、`tool_update`）。
- 截图：`docs/screenshots/harness-tools.png`（每个工具一行）、`harness-migrate.png`（迁移弹窗）。
- CLI 更新与配置版本历史的细节仍在折叠的「工具与版本」「配置版本管理」区块里。
