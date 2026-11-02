# GitHub 仓库 · 本地仓库

侧栏「项目 › GitHub 仓库」页的第四段：**本地仓库**。

GitHub 那三段管的是**远程**仓库（我的 / 已 star / 今日热榜）；这一段管**本机磁盘上**那些
不推到任何远程的仓库 —— 私人实验、内网代码、还没建 remote 的项目。

**它与项目无关**：仓库在磁盘上，不属于哪个项目；挂到项目下会把「同一份代码换个项目看」
变成一道没意义的二选一。要登记到项目的是文档、工作项、计划，不是代码目录。

## 能做什么

| 操作 | 说明 |
| --- | --- |
| 添加仓库 | 选一个目录登记进来（上限 20，同路径去重） |
| 看状态 | 分支 · 未提交改动数 · 最近一次提交（短 hash + 标题） |
| 刷新 | 重新读一遍；进这一段时自动读一次 |
| 打开目录 | 在资源管理器里定位到仓库根目录 |
| 移除 | 只从列表里去掉，**不碰磁盘上的仓库** |

## 刻意不做的事

**只读**：不提交、不暂存、不推送。要写操作去 git 自己那儿做 —— 工作台没有理由持有
「改坏你仓库」的能力。也因此，这里再怎么看走眼也不会丢代码。

## 实现

- 前端：`src/features/projects/repos.tsx` 的 `LocalRepos`（挂在 `github-panel.tsx` 的
  第四段），`api.ts` 的 `gitRepoStatus()`。
- 数据：`src/stores/local-repos.ts`（zustand persist，键名 `local-repos`，存路径数组）。
  与项目数据完全分开 —— 所以备份/恢复不会带着一堆本机路径到处跑。
- Rust：`src-tauri/src/commands/git.rs` 的 `git_repo_status`。直接调
  `git --no-pager -C <path>` 读状态，而不是自己解析 `.git`：object/ref 格式等于重写半个
  git，submodule、worktree、detached HEAD 这些边界会一件件冒出来。代价是要求机器上有
  git —— 没有时回 `noGit`，界面照实说明，不假装仓库是干净的。
- 错误带 `kind`（`notFound` / `noGit` / `notRepo` / `failed`），前端按种类出双语文案，
  不把 git 的英文 stderr 直接怼到界面上（`failed` 才回原文，便于排查）。
- 每条 git 都带 `GIT_TERMINAL_PROMPT=0` 与 `GIT_OPTIONAL_LOCKS=0`：挂进来的仓库可能没有
  upstream，任何一次读取都不该弹窗或写锁。

## 验证

```powershell
npm run check:rust      # 含 git.rs 单测：count_changed / parse_commit / 路径不存在的 kind
npm run verify:fast
```

真机（Windows，走 CDP）：

```powershell
node E:\User\Agent\opencode\skills\tauri-window-debug\scripts\dev-with-cdp.mjs
# 经 IPC 直读命令，三种情况各一次：
#   git_repo_status("<本仓库>")   → main / dirty / 最近提交
#   git_repo_status("C:\\Windows")      → { kind: "notRepo" }
#   git_repo_status("Z:\\nope")         → { kind: "notFound" }
```

**注意**：「添加仓库」用的是系统目录选择框，自动化点不到。要验这一段渲染，
往 `read_json("local-repos")`／`write_json("local-repos")` 注入 `{ state: { repos: [...] }, version: 0 }`
再重载，比点框可靠。

截图：`docs/screenshots/github-local-repos.png`（四段页签 + 三种状态各一行）。

## 边界

- 只列**工作区**状态：不含 stash、未跟踪目录展开、子模块细节。
- 登记的是绝对路径，换机器后这些路径会失效；界面会照实显示「路径不存在」，不自动清理。
- 上限 20；去重与裁剪在 store 的 `add` 里。
- 远程仓库的关联仍走前三段（含「关联到项目」），两者互不代管。
