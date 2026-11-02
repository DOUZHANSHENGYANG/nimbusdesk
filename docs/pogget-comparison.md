# Pogget 对比与借鉴清单

> 对照对象：本机 `E:\01-Desktop\仙台\探索\pogget-core`（PoggetCore，C++20）
> 及其官网截图、文档、公开 VinaUI 样式。
> 对照项目：NimbusDesk 云台（Tauri 2 + React 19）。
> 结论日期：2026-10-28。

## 结论先说

Pogget 值得抄的不是它的 C++ / D3D 引擎，而是它对「桌面文件」的产品抽象：

1. **把收纳盒分成三种语义**（映射 / 普通 / 目标），而不是把所有东西都塞进一个收藏夹；
2. **把多个收纳盒编组、合并成一个宿主窗口**，让桌面从一堆小窗变成可布局的工作区；
3. **把收纳盒的外观做成一组可调参数**（图标尺寸、列表/网格、文字预览、标题栏、透明度、材质、分页），而不是一套写死的样式；
4. **快速面板 + 磁力访问窗**：不打开主界面也能在所有盒子之间取放文件。

云台已经有第 1 条的完整实现（快捷 / 存储 / 映射），也有桌面栅栏、幽灵模式、翻页、拖入拖出、原生图标、盒内排序、撤销栈和删除风险分级。真正还缺的是第 2～4 条，以及 Pogget 那套「灰白分层 + 白卡片 + 彩色 Emoji 图标」的视觉语言。

## 功能对照表

| Pogget 能力 | Pogget 的做法 | 云台现状 | 建议 |
| --- | --- | --- | --- |
| 映射收纳盒 | 只存路径引用，不搬文件，原位置打开 | `shortcut` 收纳盒（引用条目） | 已有，语义对齐 |
| 普通收纳盒 | 文件真实移入盒内目录 | `storage` 收纳盒（`<data>/stash/<id>/`） | 已有，语义对齐 |
| 目标收纳盒 | 绑定真实文件夹，双向同步 | `mapped` 收纳盒 + 目录扫描 | 已有，语义对齐 |
| 收纳盒颜色 | 每个盒子一个颜色标签，白=未编组 | 按盒子种类固定蓝/琥珀/青 | 已有颜色，但不可自选 |
| 编组 / 磁力吸附 | 同色且相邻的窗口互相吸附，位置/大小联动 | 无 | **P0 值得抄** |
| 合并宿主 | 同色组件合并成一个大组件，垂直分区或顶部 Tab，位置独立于原窗口 | 无 | **P0 值得抄** |
| 临时解除编组 | 按住 Ctrl 拖动可临时脱离编组 | 无 | 跟编组一起做 |
| 快速面板 | 全局快捷键呼出所有盒子的内容，可拆分面板像浏览器一样管理 | 有全局搜索窗、快捷工具窗，但没有「所有盒子」面板 | **P0 值得抄** |
| 磁力访问窗 | 系统打开/保存对话框旁吸附一个访问窗，内容与盒子互通；可建隐身盒 | 无 | P1，需 Win32 窗口钩子 |
| 内联文件夹视图 | 在盒子内打开真实文件夹，带前进/后退历史 | 双击用资源管理器打开 | P1，价值高 |
| 盒内分区 | `sectionTitle` 分组、可折叠、分页时续页标题 | 只有分类/标签，盒内无分区 | P1 |
| 图标尺寸档位 | `IconSizeLevel` 多档 | 栅栏有 `dockTileSize`，文件页固定 | P1，低成本 |
| 列表视图 | `IsListView`，单列、行高更紧 | 栅栏支持图标/列表；主文件页只有盒子墙 | P1，主页面补列表 |
| 文本/媒体预览 | `.txt/.md` 显示正文缩略，图片/视频显示媒体缩略 | 只有文件类型图标 | P1，可先做 .txt/.md 与图片 |
| 文件名显示 | 显示 / 隐藏扩展名 / 只显示图标 | 固定显示完整名称 | P2 |
| 文字换行 / 省略 | `TextRenderMode`、`TextOmitOffset`、`AllowTextWrapOverflow` | 固定两行截断 | P2 |
| 字体与字号 | 每盒独立 `fontFamily` / `textSize` | 全局字体 | P2 |
| 自动淡出 | `AutoFade`、`FadeOutSwitch`、拖动时是否淡出 | 栅栏已有幽灵模式 | 已有核心，可补参数 |
| 标题栏自动隐藏 | `AutoHideTitleBar` | 无 | P2 |
| 窗口透明度/圆角/阴影 | `backgroundAlpha` / `titleAlpha` / `cornerRad` / `shadow*` | 栅栏固定样式 | P2 |
| 静态/动态材质 | D3D11 Mica/Acrylic 两层 | 无（Tauri WebView 用 CSS 材质） | 不抄实现，只抄「材质可选」概念 |
| 分页布局 | 固定/动态，横排/竖排/连续，最大行列 | 栅栏 4×3 + 滚轮翻页 | 已有基础，可补「连续滚动」 |
| 布局记忆 | `ResMem_` 按分辨率保存布局 | 栅栏按物理像素存几何 | P2，多显示器值得做 |
| 多选 / 批量 | Ctrl/Shift/Alt 多选、批量文件操作 | 文件页已有多选 | 已有 |
| 撤销/重做 | 100 步 `undoStack` / `redoStack`，删除有备份可还原 | rename/move/create 可撤销；删除走回收站不假装可撤销 | 已有骨架，删除还原可补 |
| 删除风险策略 | 按体积/条目数/是否目录提示「是否可撤销」 | `delete-risk.ts` 已参考 `DeleteUndoRiskPolicy` | 已有 |
| 通配符搜索 | `MatchWildcard` 支持 `*` / `?` | 普通子串搜索 | P2 |
| 虚拟条目 | 虚拟路径 / 虚拟文件操作 | 有 URL / 快捷方式条目 | 部分已有 |
| `.vina` 存储格式 | 自有二进制/JSON 混合 + 解析器 | JSON 文件，原子写 | 不抄，JSON 更适合云台 |

## 最值得抄的五件事（按投入产出排序）

### 1. 收纳盒外观参数（低成本，立刻提升）

Pogget 的 `ContainerModel` 把外观拆成一组独立字段：`IconSizeLevel`、`IsListView`、`ShowTextPreview`、`ShowMediaPreview`、`HideFileExtension`、`TextRenderMode`、`TextOmitOffset`、`AllowTextWrapOverflow`、`fontFamily`、`textSize`、`AutoHideTitleBar`、`backgroundAlpha`、`titleAlpha`、`cornerRad`、`shadowBlur/Alpha/Offset`。

云台已经有 `dockTileSize` 和 `fenceLayout(icons|list)`，说明底层不是不能做；缺的是把这些参数暴露到 **每个收纳盒** 上，并在文件页/栅栏共用同一份展示模型。建议先做：

- 每个盒子：`view: icons | list`、`iconSize: 32/40/48/56`、`showText: full | name | none`、`showPreview: bool`；
- 全局默认 + 单盒覆盖，存进 `files.json` 的 category 上，不新建存储文件；
- 文件页盒子浮层与桌面栅栏共用 `fenceLayout()` 的同一套计算，避免两处漂移。

### 2. 编组 / 合并宿主（中高成本，最像 Pogget 的差异化）

Pogget 的 `ContainerModel` 有 `MergedHostColor`、`MergedHostId`、`MergedHostLayoutMode`（0 垂直分区 / 1 顶部 Tab）、`MergedHostActiveMemberId`。同色窗口会磁力吸附；合并后的宿主只持有presentation state，条目仍归成员盒子。

云台可以先做「桌面栅栏编组」：

- `FenceSettings` 增加 `groupId` / `groupColor`（或直接复用分类颜色）；
- 拖动栅栏时，同组且边缘距离 < 12px 的窗口吸附对齐；移动一个，同组其它窗口跟随；
- 合并宿主用一个新的 Tauri 窗口渲染：垂直分区（滚动）或顶部 Tab，内部复用 `FenceWindow` 的网格；
- Ctrl 拖动临时解除吸附，松手恢复。

不建议第一步就做「任意窗口合并」；先把**桌面栅栏**这一层跑通，风险最小。

### 3. 快速面板（中成本，使用频率最高）

Pogget 的快速面板是「所有盒子的内容都在这里」，可拆分成多个 pane。云台已经有全局搜索窗（`features/search`）和快捷工具窗，可以复用同一套窗口创建/快捷键/主题同步：

- 新窗口 `quick-panel`，左侧盒子列表、右侧当前盒子网格；
- 顶部搜索框跨盒搜索（复用 `files` store 的过滤函数）；
- 支持把文件拖到另一个 pane / 盒子；
- 快捷键默认 `Ctrl+Shift+Space`，可在设置里改；
- 先做单 pane，第二期再做 split。

### 4. 内联文件夹视图（中成本，解决「打开文件夹就跳出应用」）

Pogget 的 `EnableInlineFolderView` / `IsInInlineFolderView` / `InlineFolderPath` / 前进后退历史，让用户在盒子内直接下钻真实文件夹。云台的映射盒目前是「扫描直接子项」，双击文件夹会用系统打开。建议：

- 映射盒浮层里双击文件夹 → 在当前浮层内切换 `currentPath`，标题显示面包屑；
- 顶部提供 ← / → / ↑；后退栈与前进栈与 Pogget 一致；
- 不改变磁盘，只改变「当前扫描根」；退出内联视图回到盒子根。

### 5. 文字/媒体缩略预览（低成本，观感提升明显）

Pogget 对 `.txt` / `.md` 读取正文片段画在图标位置上，对图片/视频画媒体缩略。云台目前统一用文件类型图标。建议先做：

- `.txt/.md`：Rust 侧读前 2KB，前端用 `<pre>` 画 3～4 行淡色文字；
- 图片：`convertFileSrc` + `loading="lazy"`，限制 64×64，失败回退类型图标；
- 视频：先只显示首帧占位（或不做，避免解码开销）；
- 缓存与现有 `meta-cache` 合并，避免每次渲染读盘。

## 不建议照搬的部分

- **C++ / VinaUI / D3D11 材质层**：云台是 Tauri WebView，抄实现没有意义；只抄「材质可选、窗口参数可调」的产品思路。
- **`.vina` 存储格式与 `vui.parser`**：云台已有 JSON + 原子写 + 跨窗口增量同步，换格式只会增加迁移风险。
- **Win32 磁力访问窗的窗口钩子**：收益高但实现重，等快速面板稳定后再评估。
- **Pogget 的「组件库」主页结构**：云台是工作台，不是纯文件工具；主页仍应以计划/项目/知识为主，文件只占一格。

## 视觉语言（已落地为 `pogget` 皮肤）

从 Pogget 官网 `css/vinaui.min.css` 与截图提取的公开值：

| 项 | 值 |
| --- | --- |
| 主色 | `#5279fb`（实心按钮用 `#3f63e0` 保证白字 5.1:1） |
| 页面底 | `#f9fafb` |
| 卡片/内容面 | `#ffffff` |
| 边框 | `#e5e7eb` |
| 主文字 | `#1f2937` |
| 次要文字 | `#6b7280` |
| 控件圆角 | `12px`（VinaUI `--vilinko-btn-radius: .75rem`） |
| 导航圆角 | `20px`（`--vilinko-nav-radius: 1.25rem`） |
| 卡片阴影 | `inset 0 -1.5px 0 rgba(0,0,0,.10), inset 0 -3px 0 rgba(0,0,0,.05)` + hover 外影 |
| 标题字重 | 700–800，负字距 |
| 图标 | 不用（全站统一 Lucide 单色线条图标） |

云台落地方式：

- `src/styles/pogget-skin.css`：只在 `html[data-skin="pogget"]` 下覆盖 token，原玻璃主题完整保留；
- `src/stores/settings.ts`：新增 `visualStyle: "pogget" | "nimbus"`，默认 `pogget`，设置页可切回；
- `src/components/shell/sidebar.tsx`：Pogget 风用白色药丸选中态；图标与 nimbus 一样走 Lucide（原先的彩色 Emoji 图标已撤）；
- `src/app/App.tsx`：Pogget 风侧栏/内容面接成一片（无外边距、无圆角浮层）；
- `src/components/shell/titlebar.tsx`：标题栏纯色（设置按钮同样用 Lucide）；
- `src/features/settings/page.tsx`：外观区新增「界面风格」两张预览卡。

## 建议的下一步顺序

1. 每个收纳盒的展示参数（第 1 条）—— 1～2 天；
2. 快速面板单 pane（第 3 条）—— 2～3 天；
3. 内联文件夹视图（第 4 条）—— 2～3 天；
4. 文字/媒体缩略预览（第 5 条）—— 1 天；
5. 编组 / 合并宿主（第 2 条）—— 1～2 周，单独开分支。

前 4 项都不动数据模型的核心，适合按现有「一次改动一次 commit + verify」的节奏推进。

## 已落地（2026-10-29）

四项已按 Pogget 的交互语义实现，细节见 `docs/pogget-four-features.md`：

1. 每个盒子的外观参数（图标尺寸 / 列表 / 预览 / 字体字号 / 标题栏 / 透明度 / 圆角）；
2. 快速面板（全局快捷键、1–3 个可拆 pane、跨 pane 移动）；
3. 内联文件夹视图（盒内下钻 + 前进/后退/向上）；
4. 同色编组、拖一个动整组、Ctrl 临时解组、合并宿主窗口（分区/Tab）。

`npm run verify` 与 `npm run build` 均通过。
