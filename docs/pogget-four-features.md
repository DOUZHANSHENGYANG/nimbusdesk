# Pogget 四项功能落地说明

> 对照源：`E:\01-Desktop\仙台\探索\pogget-core`（`PoggetCoreContainer.hpp` / `PoggetCoreManager.hpp` / `PoggetStorageProvider.cpp`）
> 目标：把 Pogget 里最有产品价值的四项能力落到云台的文件收纳模块，而不是复制 C++ / D3D 实现。

## 1. 每个收纳盒的外观参数

### 数据

`FileCategory.appearance`（`src/features/files/box-appearance.ts`）：

- `view: icons | list`
- `iconSize: 20–72`（默认 34）
- `nameMode: full | noExt | extOnly | none`
- `fontSize: 8–18`
- `fontFamily: system | segoe | yahei | mono`
- `showTextPreview` / `showMediaPreview`
- `titleBar: always | auto | hidden`
- `backgroundAlpha: 0.45–1`
- `radius: 0–28`

`boxAppearance()` 宽容读取，坏值/缺字段回默认；`boxAppearancePatch()` 只放行已知键并夹紧范围。

### 呈现

- 文件页盒子浮层：视图、图标尺寸、文字显示、字号、字体、文本/图片缩略。
- 桌面栅栏：同一份参数 + 标题栏显隐/悬停、背景透明度、圆角。
- 快速面板：同一份参数。
- `fenceLayout()` 新增可选 `appearance` 参数；不传时保持旧几何（现有测试不变）。

### 入口

盒子浮层标题栏的齿轮按钮 →「盒子外观」；栅栏标题栏的同一个按钮也打开这个面板。

## 2. 快速面板

### 窗口

- 新窗口 label：`quick-panel`（`src-tauri/src/commands/quick_panel.rs`）
- 1060×680，无边框、置顶、跳过任务栏；关闭只 hide，热键再按可立即显示。
- 快捷键：设置 →「快速面板快捷键」，默认 `Ctrl+Shift+Space`；Rust 启动时从 `settings.json` 读取并注册，保存时通过 `set_quick_panel_shortcut` 重新注册。

### 界面

`src/features/files/quick-panel.tsx`：

- 左栏：所有顶级收纳盒 + 条目数。
- 右侧：1–3 个可并排 pane；每个 pane 独立选盒、独立搜索、独立图标/列表切换。
- 顶部/每个 pane 都有拆分按钮；pane 头部可关闭。
- 双击打开；HTML5 拖拽条目到另一个 pane = `moveItemsToBox`。
- Esc 隐藏。

入口：文件收纳页工具栏的「快速面板」按钮，或全局快捷键。

## 3. 内联文件夹视图

`src/features/files/page.tsx`：

- 盒子浮层内双击文件夹 → 在同一浮层内读取该目录（`file_directory_snapshot`），不再跳资源管理器。
- 顶部 breadcrumb + ← / → / ↑：`inlineTrail` + `inlineCursor` 实现前进/后退栈；↑ 取父路径。
- 搜索、外观参数、条目图标/预览对目录内容同样生效。
- 退出内联视图 / 关闭盒子会清空栈，回到盒子根。

## 4. 编组 / 合并宿主

### 数据

- `FileCategory.groupColor`：`#rrggbb`，白色/空 = 未编组。
- `useFences.groups: Record<groupId, FenceGroupState>`（`fences.json`，persist version 2）：
  - `layout: sections | tabs`
  - 宿主窗口几何 `x/y/w/h`
  - `open`、`activeCategoryId`

### 磁吸

`fence.tsx` 标题拖动：

- 拖任一成员时记录自身与同色同伴的起点；`onMoved` 稳定后按「总位移」同步移动同伴（幂等，不会越拖越远）。
- 按住 Ctrl 开始拖动 = `temp=true`，只动当前窗口（Pogget 的临时解组）。
- 复用已有 `SNAP_TOLERANCE` 吸附与 `queueWindowOperation` 串行窗口操作。

### 合并宿主

- 新窗口 label：`fence-group-<hex>`（`src-tauri/src/commands/sys.rs`）。
- `src/features/files/fence-group.tsx`：
  - 垂直分区（sections）或顶部 Tab（tabs）。
  - 只做展示，条目仍归成员盒子；双击打开、图标/列表按每盒 appearance。
  - 宿主几何持久化；关闭写 `groups[color].open=false`。
- 入口：盒子外观面板 → 选编组颜色 →「合并为宿主窗口」；启动时已存在的编组只恢复宿主，不再重复开成员栅栏。

## 验证

```powershell
npm run verify
npm run build
```

新增测试：

- `src/features/files/box-appearance.test.mjs`
- `src/features/files/fence-group.test.mjs`
- `fence-presentation.test.mjs`（旧几何不变）
- `fence-interaction.test.mjs`（四档名称显示、现有键盘/拖拽行为）

## 未做的部分（诚实边界）

- 磁力访问窗（系统打开/保存对话框旁吸附）未做：需要 Win32 窗口钩子，建议单独排期。
- 合并宿主打开时会 `hide` 成员栅栏（不改 `open` 状态），关闭宿主后按原几何恢复；如果成员栅栏本身没启用，则不会凭空打开。
- 快速面板的跨 pane 拖拽只做「改归属 + 存储盒物理移动」，不做 OLE 拖出桌面。
