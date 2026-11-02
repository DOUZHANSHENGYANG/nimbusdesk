# GitHub 仓库（侧栏「项目」下的独立页）

入口：**侧栏 项目 → GitHub 仓库**（`/github`）。它是独立页面，不混进「项目管理」的本地项目列表；两边靠「关联本地项目」显式连起来。

页面做四件事：我的仓库（标 fork / 归档）、star、今日热榜、README 阅读与划词翻译；另外三个动作只在本机生效——置顶、下载源码包、关联本地项目。

## 配置 token

未连接时就在主界面右上角填：一个 token 输入框 + 「保存」（回车同效），旁边一个外链去 GitHub 新建 token；三个页签在连接前不可点，列表区域留空。没有单独的连接页，也没有说明段落——权限、存放位置这些只在出错时提示。

两条来源，按优先级取用：

1. 本机凭据管理器（Windows Credential Manager，target `NimbusDesk/GitHub/token`）——粘贴后点「保存」。和禅道凭据共用同一套存取实现（`src-tauri/src/credential_vault.rs`），不写 JSON、不进备份、不出现在日志里。
2. 环境变量 `GITHUB_TOKEN`，其次 `GH_TOKEN`——启动应用前设置即可，页面直接可用。

最小权限：公开仓库读与 star 用 `public_repo`；要读私有仓库再加 `repo`。token 只用于 `api.github.com`，README 走带 token 的 `GET /repos/{owner}/{repo}/readme`（`Accept: application/vnd.github.raw`）。

一次列 5 页 × 100 条（最多 500 条，按最近更新排序），翻到不满页就停；再多就用搜索框收敛，不做无限滚动。**超过 500 条（最后一页仍是满页）时这一轮不做「消失」比对**——拿不到全集就不该下「被删了」的结论。

## 列表

- **我的仓库**：`GET /user/repos`。`fork: true` 的行显示 fork 角标（悬停给出上游仓库），`archived` 显示「已归档」。star 状态来自已 star 快照，点星标是乐观更新，失败回滚并提示。
- **已 star**：`GET /user/starred` 的快照。别人的仓库也在这一栏——不要用「我的仓库」过滤。
- **今日热榜**：GitHub 没有 trending API，直接读 `https://github.com/trending?since=daily` 的 HTML（`article.Box-row`），解析名次、描述、语言、总 star、窗口内新增 star。页面结构变化时解析结果为空，自动退到 `GET /search/repositories?q=created:>7d&sort=stars`，并在列表上方标明「口径不同」。热榜行不支持 star / 置顶 / 关联（避免为每条榜单再查一次状态），要收就点右侧外链。

## README 与划词翻译

点任意一行在右侧抽屉打开 README：走 `GET /repos/{owner}/{repo}/readme`：带 token 能读私有仓库，也不受 `readme.md` / `README.rst` 这类大小写与文件名影响——只有 404 才算「没有 README」，渲染用 `react-markdown + remark-gfm`，脚本与 HTML 一律跳过，链接交给系统浏览器。

划词翻译是两段式：选中文字后才浮出「翻译」按钮，点了才发请求；整段超过 1200 字符不翻。

- 首选免费端点：`POST https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false`，body 是字符串数组，**无需鉴权**，国内可直连。老的 `edge.microsoft.com/translate/auth` 在 2026-08 之后返回 404，不要再用。
- 兜底：本机已配置的 AI（`chatWithProvider`）。译文下方标「必应翻译」或「AI 翻译」，避免把兜底结果当成机器翻译。
- 目标语言跟随界面语言（中文 → `zh-Hans`，其他 → `en`）。

注：`body` 默认 `user-select: none`，README 容器必须同时带 `md-body selectable`，否则选不中文字，划词翻译无从触发。

## 缓存与刷新

本机状态里存了上一次成功刷新的快照（`cache` + `knownRepos`，持久化 key `github`）：

- **进入页面先渲染快照**，网络请求在后台跑；有快照就不显示加载态，也不会退回「填 token」。
- 网络回来后再替换成最新数据；`viewer` / 已 star / 热榜 / 我的仓库都各自替换，互不阻塞。
- **「消失」判定不受缓存影响**：只有一次成功且完整的刷新才更新基线并做差集（见上一节）。
- **README 也缓存**：按 `owner/name` 存原文，打开抽屉先用缓存渲染，取到新的再换；单条上限 120 KB、最多 24 条，按最近打开时间 LRU 淘汰。
- 换账号（`login` 变化）时快照跟着换：基线与 `missing` 一起重置，不会把旧账号的仓库当成本账号的。

## 置顶（本软件独有）

置顶只改变本软件里的排序：置顶的仓库排在列表最前，行首显示图钉。数据存在本机 `github` 状态里（`pins`），按 `owner/name` 记，不写 GitHub。

**为什么不去改 GitHub 的 pinned：** GitHub 没有提供写 pinned 的接口。GraphQL Mutation 里只有 `pinIssue` / `pinIssueComment` / `pinEnvironment`，`updateUserPinnedItems` 这类字段在 schema 里不存在（多次 introspection 与调用都返回 `Field ... doesn't exist on type 'Mutation'`）；REST 也没有对应端点，个人页置顶只能在网页上手动「Customize your pins」。所以这里按「不操作 GitHub 仓库」的约定：置顶纯属本软件行为，不发起任何写请求，也不替你打开个人页。

## 上游变化：消失与删除

页面在前台时每 5 分钟对齐一次「我的仓库」，最小化时按 visibility 门控跳过；手动点刷新也会对齐。只有**拉取成功**才更新基线——网络失败不会把整份列表误判成删光。

- **仓库消失**（被删除、改名、转移，或 token 失去访问权限）：上一轮有、这一轮没有的条目会留在列表下方，名字加删除线并标「已不存在」，上方一行提示「N 个仓库已从 GitHub 消失」。点 × 可以移除这条过期条目；点外链去 GitHub 确认。
- **上游仓库被删除**：fork 仓库在 GitHub 上仍然存在，但 API 不再返回 `parent`。这类行在 fork 角标后面加一个「上游已删除」标记（红色），提示你的 fork 还能用、只是上游没了。
- 消失的仓库如果之后又出现（改名改回、权限恢复），标记会自动清掉，不用手动处理。
- 基线绑定账号（`login`）：换了 token 换了人，直接重置换基线，不会把上一个账号的仓库全判成「已不存在」。
- 只认「两次成功拉取的差集」，且这一轮必须是全集（没被 500 条上限截断），否则按「不知道」处理。

## 下载源码包

行上的下载按钮把仓库打成 zip 存到指定文件夹，**不 clone、不自动解压**：

- 默认目标 = 系统下载目录（`dirs::download_dir()`），第一次可点「选择文件夹」改，选过就记住（`downloadDir`）。
- 走 `https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}`，带进度不可见的 120 秒超时与 512 MiB 上限。
- 同名文件已存在时加 `-2`、`-3`，**绝不覆盖**；先写 `.zip.part` 再改名，失败不会留下半个文件。
- `owner` / `repo` 按 `[A-Za-z0-9._-]`、`branch` 允许 `/`（`release/2026` 这类真实分支）但拒绝 `..`、`\\`、空段，落盘文件名再把 `/` 折成 `-`——这段字符串直接变成落盘路径。

## 关联本地项目

行上的关联按钮列出当前本地项目（不含已归档），点一个就把 `项目 ⇄ 仓库` 记在本机（`links`）。**一个仓库可以挂多个本地项目**（monorepo、同一份代码的多个本地副本），对话框不关闭，接着点别的项目就行；再点一次画着高亮的那条就取消这一条关联。唯一性只要求同一对「项目 × 仓库」不重复，所以联动不会二义。底部「全部解除关联」一次摘掉这个仓库的所有关联。

关联后行上出现项目名徽标：挂了一个是项目名，多于一个时后面跟 `+N`，悬停给出全部名字。在关联对话框里点 ↗ 跳到 **项目管理 → 该项目**（走现有 `?project=` 深链）。项目被删掉时这条关联自然失效，不影响仓库数据，因为关联不写进 `ProjectData`。

## 视觉与工程约定

- 颜色只消费 `src/styles/tokens.css` 的 token；star 高亮沿用页面既有的 amber 写法，置顶用 `primary`。
- 网络请求全部走 `src/sources/http.ts`（Tauri 内是 `tauri-plugin-http`，绕开 WebView CORS），没有第二套 fetch。
- token 与下载在 Rust `commands::github`：`github_token_status` / `github_token` / `github_save_token` / `github_forget_token` / `github_default_download_dir` / `github_download_zip`。
- 本机状态在 `src/features/projects/github-store.ts`（持久化 key `github`，SQLite 命名空间 `projects/github`），进存储前过 `validateGithubData`。版本 2 增加了 `knownRepos`（上一轮成功拉到的清单）和 `missing`（消失仓库的快照 + 时间）；v1 数据会被补成空表后照常升级。

## 验证

```powershell
npm run check:projects      # 含 github-core 的解析/URL/翻译/置顶排序/关联去重/翻页用例
npm run check:rust          # 含 token 形状与下载路径转义校验
# 需要网络与本机凭据管理器的两条，手动跑：
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored github
npm run dev                 # 夹具需要 Vite 在 17800
$env:PLAYWRIGHT_MODULE="<本机 playwright-core 的 index.mjs>"
node scripts/check-github-browser.mjs
```

浏览器回归跑夹具 `src/features/projects/fixtures/github.html`（mock IPC + mock `plugin:http`，不联网），断言覆盖：4 条仓库、2 条 fork 角标、1 条归档角标、star 快照收敛、热榜 3 条带今日新增、README 渲染、拖选出「翻译」并拿到译文、置顶把仓库顶到第一行、下载回显保存路径、关联后出现项目徽标（挂两个项目时后面跟 `+1`）、满页时接着取第二页（101 条、页码 1→2）、上游变化（消失条目 + 提示条 + fork 上游删除标记 + 移除条目）、无 token 时不发 GitHub 请求。

那两条 `--ignored` 用例是真机证据：一条在本机凭据管理器里存取删一个 `GitHub` 命名空间的 token，一条真去 codeload 下 `octocat/Hello-World` 的 zip 并断言文件以 `PK` 开头、文件名符合命名规则。

截图：`docs/screenshots/project-management-github-connect.png`（未连接时的连接屏）、`project-management-github-list.png`（列表）、`project-management-github-readme.png`（README + 划词翻译）、`project-management-github-actions.png`（置顶 + 关联徽标）、`project-management-github-upstream-gone.png`（仓库消失 + 上游删除标记）。

## 已知边界

- 热榜靠页面结构，GitHub 改版会先退到 Search 口径；两条都不通时列表为空并提示。
- 「今日」按 GitHub 页面自己的窗口（约每 6 小时刷新），不是本机零点的严格统计。
- 翻译端点是 Edge 前端的内部接口，没有 SLA；挂了就走 AI 兜底，AI 也没配时提示失败。
- 置顶不改 GitHub 个人页（没有 API），也不代你打开 GitHub；下载只存 zip，不解压、不建 git 仓库。
- 仓库/star 列表最多 500 条（5 页），不做无限滚动；超出的用搜索或去 GitHub 看。
- 「消失」是按两次成功拉取的差集判断的：离线期间被删的仓库，要等下一次成功刷新才会标出来；改名会被当成「旧的消失 + 新的出现」。
