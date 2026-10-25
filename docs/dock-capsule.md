# 云台胶囊 Dock

屏顶一颗 44px 胶囊，点开就地长成 660×591 的卡片。**所有日常操作都在卡片内完成**，
只有齿轮「设置」跳主窗口 —— 这是「3 秒内能做完的事不该跳窗口」这条规则的边界。

先在浏览器里看：打开仓库根目录的 `design-preview-dock.html`（<link> 的是
`src/styles/tokens.css`，永远与真源同步）。

## 实现状态

侧栏形态保留，设置 → **桌面 Dock → Dock 形态** 可切「屏顶胶囊」。

| 文件 | 负责 |
|---|---|
| `src/features/desktop/dock-float.tsx` | 胶囊 + 卡片、六个页、AI 对话副页与截图 |
| `src/features/desktop/dock-float-core.ts` | 今日进度、相对时间等纯函数 |
| `src/features/desktop/dock-float.css` | 悬浮层材质与全部卡片样式 |
| `src/features/desktop/dock.tsx` | 形态分流 + `applyFloat`（弹簧展开/收起） |
| `src-tauri/src/commands/dock.rs` | `dock_spring_to`：状态切换时一次性摆放窗口 |
| `src-tauri/src/commands/capture_window.rs` | `window_capture`：前台窗口截图（data URL，不落盘） |

## 六个页

**收纳盒 / 计划 / 项目 / 收集** 不是卡片里重写的，而是 `dock.tsx` 把侧栏那三个
Flyout 与 `CapturePanel` **本体**通过 `panels` 属性注入进来 —— 同一个功能只有
一份实现、一套密度、一套交互。

| 页 | 数据来源 | 动作 |
|---|---|---|
| 搜索 | `searchQuery(query, "all", true)` | 范围 chips（全部/文件/计划/项目/知识/资讯）+ 按类型分图标；点结果直接打开 |
| 收纳盒 | `FencesFlyout` 本体 | 分类 chips、宫格/列表、拖拽排序、剪贴板快收 |
| 计划 | `PlansFlyout` 本体 | 勾选、子任务、附件、删除可撤销 |
| 项目 | `ProjectsFlyout` 本体 | 在办项目 + 未完成工作项 |
| 收集 | `CapturePanel` 本体 | 收集表单（卡片内改为透明底，不引第二套材质） |
| 资讯 | `useFeeds.entriesBySource` + `mergedSources()` | 按**来源顺序**平铺，30 秒自动滚一行；点标题**在卡片内读正文**，星标收藏，外链去原网页 |

### AI 对话副页

头部星标把整张卡片切成对话页（不做第七个标签：六个已经挤满）。

- 多轮：历史原样回传给 `chatWithProvider`；收起再打开还在，**关掉应用清空**（刻意不落盘）
- 相机按钮：`window_capture()` 抓当前前台窗口，预览可单独丢弃，随这一条消息以
  `image_url` 内容块发出；`chatWithProvider` 检测到图片会自动挑有 vision 的 provider

## 动效

窗口只在状态切换时 `set_size` + `set_position` 各一次，视觉形变全部交给
**固定 660×591 卡片的 CSS `clip-path`**（240ms，`cubic-bezier(.4,0,.2,1)`）。
不再用 `scale` 伪造尺寸，所以动画中图标不会缩小、内容不会 reflow。

| 参数 | 展开 | 收起 |
|---|---|---|
| 窗口 | 一次到位 660×591 | 等 clip 收完再回 464×44 |
| 表面 | clip 从顶部居中 464×44 胶囊 → 全卡，圆角 22→20 | 反向 |
| 内容 | 卡片按最终尺寸排版，内容延迟 70ms 淡入 | 内容保持可见，随 clip 收窄 |
| 相位 | `resizing → expanding → expanded` | `collapsing → compact` |

相位切换带 generation 计数：**快速 hover 进出时旧动画自动作废**，不会停在半展开；
原生 `set_size` 串行提交，避免两次尺寸切换互相超车。

胶囊可拖：空白处按住 `startDragging()`，松手把横向位置记进 `dockFloatX`，下次展开
还在那儿；不悬停时透明度 0.62（置顶但不挡视线）。

## 验证

- `node --test src/features/desktop/dock-float-core.test.mjs`：今日进度、相对时间单位。
- `node scripts/check-dock-float-browser.mjs`（接进 `verify:dist`）：胶囊 44 → 展开
  `dock_spring_to` 目标 660×591、`data-phase=expanded`、卡片 `transform:none` 且
  `clip-path` 生效、头部 4 工具 + 3 窗口操作、5 个主标签等宽 → 六页切换尺寸不变
  → 详情/对话副页进退 → 齿轮跳 `/settings` → 收起回 `compact`/44。
- `node scripts/shots-dock.mjs`：重新生成下面的截图（改了外观就重跑，别拿旧图当文档）。

## 截图

| 文件 | 内容 |
|---|---|
| `docs/screenshots/dock-capsule.png` | 胶囊本体 |
| `docs/screenshots/dock-capsule-search.png` | 搜索页（范围 chips） |
| `docs/screenshots/dock-capsule-fences.png` | 收纳盒（侧栏本体） |
| `docs/screenshots/dock-capsule-news.png` | 资讯（按来源平铺） |
| `docs/screenshots/dock-capsule-news-reader.png` | 卡片内读正文 |
| `docs/screenshots/dock-capsule-chat.png` | AI 对话 |
| `docs/screenshots/dock-card-cal-dark.png` | 日历（react-day-picker） |
| `docs/screenshots/dock-card-notice-dark.png` | 通知（云台提醒 + 系统通知） |


## 交互（对齐 BrimDeck）

| 行为 | 说明 |
|---|---|
| 悬停展开 | 移入 120ms 迟滞、移出 500ms 缓冲、Esc 立即收起 |
| 焦点保护 | 卡片内还有焦点（正在输入）时移出不收 |
| 收起形态 | 胶囊（信息全）/ 指示条（一条细线），设置里切 |
| 完成度环 | 已完成/总数画弧，对应灵动岛的配额环 |
| 逾期提醒 | 有逾期任务时收起形态弹提示，5 秒自动收 |
| 最大化自动切换 | 前台窗口最大化时临时切成指示条，退出自动复原 |
| 卡片高度 | 底部把手拖动（420–900），松手才落盘 |
| 配色 | 天青（默认）/ 海洋 / 石墨 / 暖色，只换品牌色相 |

## 标签分层

胶囊（收起态）只放 **5 个主标签**：搜索 / 收纳盒 / 计划 / 项目 / 资讯 ——
再多就「选不过来」，其余功能只在展开态出现。

卡片头部（展开态）分三组，不再把 7 个图标平铺成同权重：

| 组 | 内容 |
| --- | --- |
| 品牌区 | orb · 云台 · 今日待办/已完成 |
| 工具组（4 个） | 日历 · 天气 · 通知 · 终端 |
| 窗口操作组（3 个） | AI 对话 · 设置 · 收起 |

主标签（图标 + 文字）严格等宽 5 列：搜索 · 收纳盒 · 计划 · 项目 · 资讯。

回归断言：`scripts/check-dock-float-browser.mjs` 校验主标签 5、工具组 4、
窗口操作组 3、胶囊快捷图标 5，以及 5 个主标签宽度一致。

## 收纳盒的「点开」动效

卡片里的收纳盒是网格（`dockTileSize` 可 Ctrl+滚轮调节，支持嵌套分类）。
点某个文件夹时量出那颗磁贴的矩形，写成网格的 `transform-origin`，再让网格重挂载
跑一次 `scale(0.42) → 1`（220ms）—— 观感是「从这颗图标长出一片网格」。
纯 CSS，没有动画库依赖。

## 相关页面

- **主页**：天气卡 + 今日待办卡 + 紧凑月历，一屏看完；点月格进日历页。
- **日历**：`react-day-picker`（v10）单日选择，`fixedWeeks` 固定 42 格 ——
  切月份日历高度不变，卡片不会跟着跳。用 `components.Day` 覆盖成项目 token
  风格（**不引它自带的 style.css**），有任务的日子打圆点；点日期在下方列出
  当天条目（来自 `usePlans` 的 `days[dateKey]`，子任务缩进）。
  截图：`docs/screenshots/dock-card-cal-dark.png`。
- **天气**：Open-Meteo（免 key），结果缓存 10 分钟；坐标在设置里配。
- **通知**：两段 —— **云台提醒**（逾期 + 今天 + 未来两天，点一条跳计划页）
  + **系统通知**（Windows 通知中心，只读，带应用名与时间）。未授权时系统段
  只有一个可点击的「去设置授权」，不报错；授权与打包清单见
  `docs/windows-notifications.md`。截图：`docs/screenshots/dock-card-notice-dark.png`。
- **终端**：拉起系统终端（Windows Terminal / PowerShell / cmd）到指定目录，
  不内嵌 PTY。内嵌需要 `portable-pty` + `xterm.js`，见 `docs/dock-refactor-plan.md`。
