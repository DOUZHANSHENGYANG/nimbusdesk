# 设置 · 独立路由与侧栏

设置从「一个页面 + 页内 tab」改成「左侧栏 + 每个功能区一条路由」。侧栏用的是**首页那份
`NavList`**（`src/components/shell/nav-list.tsx`），所以两处侧栏的分组、药丸、折叠行为、
角标位置天然一致 —— 不存在第二套实现漂移。

## 路由表

| 侧栏项 | 路由 | 装什么 |
| --- | --- | --- |
| 系统设置 | `/settings` | 外观 · 语言 · 数据目录 · 桌面 Dock · 功能开关 · 备份 |
| 项目 › 计划 | `/settings/plans` | 任务提醒 · 完成后的行为 |
| AI › 模型与搜索 | `/settings/ai/models` | 供应商配置 · 搜索服务 |
| AI › 知识库 | `/settings/ai/knowledge` | 库根目录 · 整理策略 |
| 工具 › 搜索 | `/settings/tools/search` | 快捷键 · 索引范围 |
| 工具 › 资讯 | `/settings/tools/feeds` | 订阅源 · 刷新 |
| 工具 › 桌面与收纳 | `/settings/tools/desktop` | 桌面栅格 · 收纳盒（含体积阈值） |
| 快捷键 | `/settings/shortcuts` | 六条全局快捷键（快速面板 / Dock / 桌面栅格 / 搜索 / 知识库 / 快捷工具） |
| 关于 | `/settings/about` | 版本 · 许可 · 日志目录 |

「返回」在侧栏底部（`回到工作台`），等价于原来的返回按钮。

## 快捷键统一在一处

六条全局快捷键（快速面板、Dock、桌面栅格、搜索窗口、快捷收集、选中文字快捷工具）以前各
散在自己的设置卡片里，每处都重写一遍「录制 → 保存 → 报错」的样板。现在都挂在
`/settings/shortcuts`。

**一行一条**：`名称 | 输入框 | 录制 | 清除 | 保存`，六行的按钮落在同一条竖线上（每行各自
是一个 grid，所以列宽写死 —— 用 `auto` 会因各行按钮多少不同而错位）。「这条快捷键在哪
生效」不占地方，挂在名称的 `title` 上；只有**当下要紧**的信息（正在录制、出错）才占第二行，
平时那一行不存在。

录制逻辑和这一行合并在 `src/components/ui/shortcut-row.tsx`（原来的
`features/knowledge/shortcut-recorder.tsx` 已删除 —— 它只剩这一个调用方，而「一行显示」
要求输入框与录制按钮是同一行里的并列格子）。

**只有呈现统一了，落盘没有搬。** 每一行把「存到哪」交给调用方传进来的 `save`：

| 行 | 存在哪 | 注意 |
| --- | --- | --- |
| 快速面板 | `invoke("set_quick_panel_shortcut")` + settings store | **只写 store 不会注册热键**，必须两步 |
| Dock | `invoke("set_dock_shortcut")` + settings store | 同上 |
| 桌面栅格 | `setDesktopShortcut()`（`files/desktop-runtime`）+ store | 注册失败不写记录 |
| 搜索窗口 | `saveSearchSettings({...settings, shortcut})` | 走 search store 自己那套保存 / 回滚 |
| 快捷收集 | `setCaptureShortcut()` + knowledge store + `flushAllStorage()` | 三件一起做 |
| 快捷工具 | `saveQuickToolsShortcut()`（`search/quick-tools-settings`） | 注册热键 + 写 `quick-tools-settings` 记录 |

加一行新快捷键：写一个 `save` 回调（注册 + 落盘），在 `settings/shortcuts.tsx` 里加一条
`<ShortcutRow>`，文案进 `settings.shortcuts.*`（zh / en 同时加）。

**验证**：`/settings/shortcuts` 上六行文案齐全、每行高度一行（约 32px）、六行的「保存」
按钮 x 坐标一致；改一条 → 「保存」写入后按钮回到禁用、`清除` 可清空；关掉应用重开，值还在
（说明落盘那步生效了，不只是本地镜像）。真机命令见下。

快捷工具面板的入口在「工具」页（`features/tools/page.tsx`），不在这一页。

## 旧深链

`/settings?tab=xxx` 仍然可用：`page.tsx` 的 `TAB_ROUTES` 会把它重定向到新路由
（`ai → /settings/ai/models`、`features → /settings` …）。标题栏齿轮入口、通知、书签
都不需要改。

## 加一个新设置页

1. 在 `src/features/settings/page.tsx` 里加一个区块组件；
2. 在 `SettingsSection` 联合类型里加一个 id，并在内容分支里渲染它；
3. `src/app/App.tsx` 的 `/settings` 子路由下加一条 `<Route path="…" element={<SettingsPage section="…" />} />`；
4. 在 `src/features/settings/layout.tsx` 的 `groups` 里挂到对应分区（或新增分区）；
5. 文案加到 `settings.nav.*`（zh / en 必须同时加，`npm run check:i18n` 会拦）。

## 验证

```powershell
npm run verify        # i18n / 对比度 / tsc / 单测 / cargo
```

真机（Windows）：

```powershell
node E:\User\Agent\opencode\skills\tauri-window-debug\scripts\dev-with-cdp.mjs
node …\scripts\cdp.mjs --js "location.hash='#/settings/plans'; 'go'" --wait 1200 --shot "$env:TEMP\plans.png"
node …\scripts\cdp.mjs --js "JSON.stringify([...document.querySelectorAll('.app-nav-item')].map(b=>b.textContent.trim()+':'+b.getAttribute('data-active')))"
```

重点看：侧栏五组是否齐全、活跃项是否跟着路由走（`data-active="true"`）、
`?tab=` 旧深链是否重定向、正文是否只剩该功能区的内容。

截图：`docs/screenshots/`（本次未附；需要时按上面命令补拍并在此登记文件名）。

## 边界

- 侧栏当前不折叠（设置分区少，一览比省空间重要）；要折叠就把 `collapsed` 接到
  `sidebarCollapsed` 并加底部按钮。
- AI 页有未保存改动时切走会先确认：状态在 `ai-dirty.tsx` 的 context 里，写方是 AI 页、
  拦方是侧栏。
