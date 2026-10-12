---
id: architecture
type: architecture-design
status: done
title: NimbusDesk 云台 — 架构设计
implements: [goal-and-requirements]
tags: [architecture, tauri2, shell, data-layer]
---

## 驱动

个人桌面绿色工作台：免安装、数据本地、自绘 UI、无原生控件观感。见 `goal-and-requirements`。

## 决策

### 前端
+- dev 端口 **16240**（HMR 16241）：本机常跑多个 Tauri 项目，避开默认 1420 撞车；`vite.config.ts` 与 `tauri.conf.json devUrl` 必须同步改。
- React 19 + TS + Vite + TailwindCSS v4（@tailwindcss/vite）；路径别名 `@/ → src/`。
- 路由 react-router-dom **HashRouter**（桌面 webview 稳妥）；页面切换由 `PageTransition` 用 GSAP（fromTo: alpha/y/blur）处理。
- 状态 Zustand + persist，storage 走 **tauriJsonStorage**（`src/lib/storage.ts`）：读 `read_json`、写 `write_json`，写侧 trailing 防抖 250ms，迁移前用 `flushAllStorage()` 落盘。
- 组件：shadcn/ui（radix 基）+ beUI 动效件（`src/components/motion/*`：button/tooltip/switch/tabs/center-morph-modal）。beUI theme-toggle 因依赖 next-themes 弃用，机制（View Transitions CSS）已吸收进自有实现。
- i18n：react-i18next，词典内联在 `src/lib/i18n.ts`（zh/en），语言实时切换并持久化。

### 设计系统（三层 token，`src/styles/tokens.css`）
1. **Primitive**：oklch 色板（brand 电光靛紫 277°、蓝调中性 270°、状态色）+ 圆角/阴影/动效时长原料。
2. **Semantic**：明暗两套语义变量（shadcn 兼容命名：background/card/primary/sidebar-*/chart-* 等），`.dark` 类切换。
3. **Component**：--titlebar-h/--sidebar-w/--page-pad 等。
规则：组件只允许消费 token；新增颜色先进 primitive。

### 主题径向扩散
- **首选 View Transitions**（新旧两份真实界面快照：圈内新主题内容、圈外旧主题内容，文字图标全程可见），CSS 侧 `html[data-vt="out"/"in"]` + clip-path circle keyframes（token: --pr-dur-theme-out/in + Material 强调曲线）。
- **无 VT 的运行时回退 GSAP 羽化幕布**（64px 软边 radial-gradient，纯色无内容，仅保证动效存在）。
- **关键时序契约**：store 的 setTheme 不直接应用 CSS —— `SettingsSync` 的 [theme] effect 在 `isThemeSwitching()` 时冻结，`applyTheme` 只发生在 `startViewTransition` 回调 / 幕布盖满时机。此前 VT「看似不工作/假」的真因即 store effect 提前切主题污染了旧快照（竞态），非 WebView2 不支持。
- `switching` 防重入；VT 失败/无支持路径均保证锁释放。

### Shell（无边框窗口）
- tauri.conf.json：decorations:false、visible:false（防白闪）、backgroundColor 匹配暗色底、1200×800 min 960×640。
- 自绘标题栏 `Titlebar`：左侧品牌区（可拖拽，名称随语言显示「云台」/「NimbusDesk」并 setTitle 同步任务栏）；右侧工具组 **中/EN 语言切换、明暗主题（径向扩散）、设置图标**，紧邻窗口控制三键；data-tauri-drag-region 拖拽、双击 toggleMaximize；onResized 同步最大化态。
- **设置是主窗口内完整路由**（`/settings`）：标题栏 ⚙️ → `navigate("/settings")`，全页呈现于内容区（含 PageTransition 过渡与顶栏标题），⚙️ 图标在 `/settings` 时高亮。曾试验过独立小窗方案，按用户偏好回退为路由。（label 分流仍保留 fence-* 栅栏窗口。）
- 关闭=隐藏到托盘（Rust on_window_event CloseRequested → hide + prevent_close）；真退出在托盘菜单。
- 启动时序：挂载 effect → applyTheme/changeLang（同步）→ 直接 invoke `window_ready`（**勿用 rAF**：窗口 visible:false 时 WebView2 不派发 rAF，等待首帧会死锁——曾导致窗口永远不出现）；Rust 侧另有 6s 兜底强显。
- 原生弹框禁用：ModalProvider 挂载时覆写 window.confirm/alert/prompt；Promise 式 confirm/alert/prompt 用 beui CenterMorphModal 呈现。OS 文件夹选择框是唯一例外（选目录本质是系统交互）。

### 数据层（Rust，`src-tauri/src/commands/`）
- 数据目录解析优先级：`data.dir` 指针文件（APPDATA→exe 目录）→ exe 旁 `data/`（可写探测）→ `%APPDATA%/nimbusdesk` 兜底。
- `set_data_dir`：复制旧目录全部 *.json 到新目录 + 写指针文件，返回迁移清单。
- JSON 读写：key 白名单 `[a-zA-Z0-9_-]`；写入 tmp + rename（copy 兜底）原子替换。
- **所有 IO/对话框命令 async + spawn_blocking**——Tauri 2 同步命令在主线程执行，阻塞会卡死事件循环（pick_folder 尤其）。
- 数据文件：settings.json / fences.json / files.json / plans.json / plans-archive.json。

### 托盘
- `tray.rs`：左键切换主窗显隐；菜单「显示/隐藏 + 退出」；菜单文案按 settings.json 的 lang 生成。

## 不变量

- 数据目录内只有 *.json 数据文件；一切状态可随目录整体拷走。
- 前端不直接知道数据目录真值，只持有展示副本；真值以 Rust 解析为准。
- 不引入任何原生样式控件；所有确认/输入走 ModalProvider。
- 主窗口关闭不退出进程（托盘常驻）。

## 模块：主页仪表盘（Task 4 已实现）

- 问候（时段判定）+ 日期；四统计卡（今日计划 done/total、进行中、收藏条目、开启栅栏数）GSAP 数字滚动 + 卡片 stagger 入场，点击跳对应页。
- 今日计划速览：顶层任务最多 6 条，状态圆钮直接切换；全部完成显示祝贺态。
- 最新收藏：最近 6 条条目点击即打开。
- 数据源复用 plans/files/fences 三个 store（主页只读，不引入新库）。

## 范围之外

- 悬浮栅栏窗口（多窗口 transparent/always_on_bottom）、OLE 拖出：Task 3 实现。
- 开机自启、FeatherFence 高级特性（亚克力/图标避让/自动清扫）。

## 模块：文件管理 + 桌面栅栏（Task 3 已实现）

- **数据模型**（`src/stores/files.ts`）：`FileCategory {id,name}` + `FileItem {id,categoryId,type:folder|file|url,title,path,tags[],createdAt}`，存 `files.json`；标签直接挂在条目上（无独立注册表，筛选从条目派生）；按 `categoryId|path` 去重收集。栅栏几何/开关/幽灵存 `fences.json`（`Record<catId,{x,y,w,h,ghost,open}>`）。
- **主界面**：分类 chips（全部/各分类 + 计数 + 栅栏开关 Monitor 图标）、选中分类的重命名/删除（有条目时禁删）、搜索（标题/路径）、多标签 AND 筛选、卡片网格（点击打开、悬停 显示/编辑/删除）、添加/编辑用 shadcn Dialog（类型三选段、路径、分类、逗号分隔标签）。
- **栅栏窗口**：Rust `open_fence(categoryId,title,x,y,w,h)` 创建 `label=fence-{id}` 透明无边框置底 skipTaskbar 窗口（physical px 定位）；`main.tsx` 按 label 前缀分流渲染 `FenceWindow`（html.fence-root 透明底）。能力：迷你标题栏拖拽移动、4×3 网格 + 滚轮翻页圆点、幽灵模式（失焦 opacity 0.14，眼睛按钮切换）、拖入收集（onDragDropEvent drop → probe_paths 判型 → 按分类入库 toast）、按住条目移动 6px 触发 **OLE 拖出**、几何移动/缩放后 500ms 防抖持久化、关闭时 setOpen(false)；主界面启动时恢复 open=true 的栅栏。
- **OLE 拖出**（`src-tauri/src/commands/dragdrop.rs`）：自实现 `IDataObject`（仅 CF_HDROP）+ `IEnumFORMATETC`（单格式）+ `IDropSource`（ESC 取消/按键释放落下/默认光标），`DoDragDrop` 阻塞在 spawn_blocking；windows crate 0.62 的类型归属：FORMATETC/STGMEDIUM/IDataObject 系在 `System::Com`，DoDragDrop/IDropSource/DROPEFFECT 在 `System::Ole`，MODIFIERKEYS_FLAGS 在 `System::SystemServices`，HRESULT 常量在 Foundation；`_Impl` trait 已是**安全签名**（GetData 返回 Result<STGMEDIUM>、QueryGetData/Next 返回 HRESULT），需 features: Graphics_Gdi + Com_StructuredStorage + SystemServices + windows-core 依赖（implement 宏）。
- 关闭窗口行为：main 隐藏进托盘，settings/fence 正常销毁（on_window_event 按 label 区分）。

## 模块：计划管理（Task 2 已实现）

- **数据模型**（`src/features/plans/types.ts`）：`PlanTask { id, parentId, title, note?, time?(HH:mm), status, createdAt }` 扁平数组按日存（`Record<date, PlanTask[]>`），树由 parentId 推导、数组顺序即兄弟顺序；状态机 `todo|doing|done`（done 覆盖原「完成态」，看板三列直接映射）。
- **存储**：双库 —— `plans.json`（活跃）+ `plans-archive.json`（归档，`{archivedAt, tasks}`）；均走 tauriJsonStorage + zustand persist；跨库动作 `archiveDay/restoreDay/autoArchivePastDays`。
- **归档规则**：启动时自动归档一切 `date < today` 的活跃日（toast 提示条数）；手动「归档此日」（confirm Modal）；归档视图可展开只读树、可恢复。
- **五视图**（`views/`）：大纲（递归树全 CRUD：点击标题编辑 title/time/note、+子任务、级联删除确认、行 stagger 动画）、看板（仅顶层任务三列，原生 HTML5 拖拽换列 + 拖入高亮）、时间轴（timed 排序轨道 + untimed 分区，状态可点）、日历（周一起始月网格，进度角标 done/total，归档日标灰，点选跳转）、归档浏览（倒序列表 + 展开 + 恢复）。
- **时间输入为文本校验**（`^([01]\d|2[0-3]):[0-5]\d$`），刻意不用原生 date/time 控件（与「无原生样式」约束一致）。
- 水合检测用 `onFinishHydration` 订阅（`hasHydrated` 非响应式教训的复用）。
- **网站条目自动抓取**（`src-tauri/src/commands/site.rs`）：录入链接 700ms 防抖 → reqwest（blocking in spawn_blocking，8s 超时/UA/重定向5次）抓 HTML → 朴素大小写无关扫描取 `<title>`、`meta[name=description]`/`og:description`、`<link rel~icon>`（优先 apple-touch）→ 只填空字段 + favicon 存 `item.iconUrl`（toast 反馈）；非 HTML 响应回退 `{host}/favicon.ico`。
- **条目图标**（`features/files/icons.tsx` `ItemIcon`）：网站 favicon（`<img>`，加载失败回退）→ 文件按扩展名映射 40+ 类型专属 lucide 图标与配色（pdf红/文档蓝/表格绿/图片紫/音视频/压缩包琥珀/代码天蓝/exe灰）→ 兜底 File。主页速览 / 文件卡片 / 栅栏网格三处统一。
- 类型选择器为 **motion layoutId 弹性滑块**；条目模型加 `note`（网站填 SEO 描述，可手改）与 `iconUrl`。
- 大纲交互（Todoist/Workflowy 式修订）：顶部快速添加、子树容器 `border-l-2` 引导线（缩进只由容器 margin 提供、行 padding 固定，避免双重缩进）、父任务 `done/total` 子树进度徽章、时间文本校验；大纲视图淘汰了按行累加缩进的旧实现。
