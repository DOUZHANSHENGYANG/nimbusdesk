# 云台胶囊 Dock（视觉稿）

屏顶一颗 44px 胶囊，点开就地长成 660px 卡片；五个入口（搜索 / 计划待办 / 收集 / 日历 / 每日资讯）**全部在卡片内完成**，只有齿轮「设置」跳主窗口。

先在浏览器里看：直接用浏览器打开仓库根目录的 `design-preview-dock.html`（它 <link> 的是 `src/styles/tokens.css`，所以永远与真源同步；右上角按钮切明暗，卡片头部可切五个 tab）。

## 几何契约

悬浮锚点不写进 `DockEdge`：吸附（`nearestDockEdge` / `settings.dockEdge`）仍然只认 left/right/top 三条边，卡片化的 Dock 只是「换了锚点的同一个窗口」。

| 常量 | 值 | 说明 |
|---|---|---|
| `DOCK_FLOAT_GAP` | 12 | 距工作区顶边 |
| `DOCK_CAPSULE_W` / `_H` | 464 / 44 | 胶囊态（窗口不能按内容自适应，给保守宽度） |
| `DOCK_CARD_W` / `_H` | 660 / 591 | 卡片态，五页共用一个矩形，切页不跳窗 |

`dockFloatBounds(area, mode)`：水平居中、距顶 12；工作区放不下时先裁宽高，再贴顶（不留缝）。两种形态共用一条中心线，切换只变宽高 —— 和侧栏「只变宽度」同一思路。

## 视觉方向（已定）

**浅色磨砂 · 三层材质**（A 骨架 + B 密度），交互稿：`design-demos/dock-glass/D-light-frosted.html`，截图 `docs/screenshots/dock-light-*.png`。

| 层 | 浅色取值 |
|---|---|
| 窗（卡片底） | white 84% → 72% 渐变 + blur(44px) saturate(190%) |
| 面（面板/统计块） | white 56% + 1px 发丝线 + 顶部内高光 |
| 内嵌（分段槽/输入） | gray 4.5% + 内阴影 |

文字三级：gray-850 / gray-700 / gray-600（10px 小字刻意不用 gray-500，它在 near-white 底上只有 ~4.4:1）。

## 为什么是「换壳」

现在的 Dock 是**贴边常驻玻璃竖条 100px + 飞出面板 408px**（`src/features/desktop/dock-core.ts` 的三形态）。功能不缺，缺的是形态：它是一条「边」，而不是一个「物件」。截图里那类交互的灵活来自三点，云台都能给：

| 要的东西 | 现在的状态 |
|---|---|
| 一个窗口承载多个页，切页不跳转 | Dock 的 flyout 已有 `DockPanel`（fences/plans/projects/capture），只差把入口换掉 |
| 拖入即收纳 | 栅栏已有 `onDragDropEvent` + `probe_paths` + 按分类入库 |
| 就地展开、不打断当前上下文 | 三个窗口族都在，主窗口不必前置 |

所以**不新增窗口**：胶囊 = strip 的新皮，卡片 = flyout 的新皮，几何仍由 `dock-core.ts` 算、仍用逻辑像素。

## 五个页各自的卡片职责

只放「3 秒内能完成」的事；超过的跳主窗口。

| 页 | 卡片内能做 | 不做（跳主窗口） |
|---|---|---|
| 搜索 | 输入即搜、范围 chips、分组结果、回车在卡内展开 | 高级筛选、批量操作 |
| 计划待办 | 勾选、快速添加、看今日进度环与最近一项 | 树形编辑、五视图切换 |
| 收集 | 写、切类型、拖入收纳、看最近 3 条 | 批量整理、归档到知识库 |
| 日历 | 月视图翻页、点日期看当日安排 | 新建计划、改期 |
| 每日资讯 | 换频道、点标题用默认浏览器打开、看热度 | 订阅管理、已读批量清除 |

齿轮带 ↗ 角标 = **唯一**跳主窗口的入口（设置）。

## 尺寸与 token

| 项 | 值 |
|---|---|
| 胶囊 | 高 44 · 圆角 `--pr-radius-full` · 宽度由内容撑开（本稿 463） |
| 卡片 | 660 宽 · 高随内容（本稿 476–479，五页基本等高，切换不跳） |
| 材质 | **不能用 `--glass`**（那是应用内内容面上的玻璃，深色只有 8.5% 白，桌面上会糊成一团）。悬浮层要独立三档：`--dock-fill` / `--dock-fill-strong` / `--dock-edge`，深色 ≈ #1f232a，浅色 ≈ #f0f3f6 |
| 边界 | `0 0 0 1px` 暗环 + 24–26px 大投影 + 顶部 1px 高光 + 一道品牌色薄光（`--pr-brand-500` 10%） |
| 选中 tab | `--primary` 实心 + `--primary-foreground`（不用下划线：玻璃上的细线会被壁纸吃掉） |
| 行高 | 32–34，统一密度 |

## 材质 token

`--dock-fill` / `--dock-face` / `--dock-inset` / `--dock-edge`（语义层）← `--pr-mat-dock-*`（材质层，明暗两套）。**不要拿 `--glass` 当 Dock 底色**：那是应用内玻璃，8.5% 白压不住桌面壁纸。

## 落地前的四个硬约束

1. **窗口尺寸归 Rust**：胶囊 44 / 卡片 660×496 切换时 `set_size` 一次到位（或 2–3 帧插值）；CSS 只过渡圆角、内边距、内容 stagger，**不要**用 transform 假装变宽。
2. **透明窗口里 `backdrop-filter` 糊不到桌面，所以别靠玻璃**：本稿能糊是因为壁纸和卡片在同一个文档里。真机要么走 DWM 材质（`window-vibrancy` / `DWMWA_SYSTEMBACKDROP_TYPE`），要么就是「实底 + 轻 blur」。硬约束是**卡片底色必须自己够实**（深色实测 ≈ #1f232a，与壁纸亮度差 ≥ 70/255），blur 只是加分项。
3. **顶部居中 + 置顶会压住最大化窗口的标题栏**：默认距顶 12px，设置里给三档（贴顶 / 跟随焦点窗口下沿 / 只在无最大化窗口时显示）。
4. **对比度与双语是闸门**：玻璃叠层正文 ≥4.5:1（新的 `--glass` 组合要纳入 `npm run check:contrast`）；五页的名称、占位、空态 zh+en 同时进 `src/lib/i18n.ts`。

## 验证

- 视觉稿本身：用浏览器打开 `design-preview-dock.html`，五个 tab 逐个点，确认卡片高度不变、无横向滚动（本稿实测 660×477~479，五页一致）。
- 落地后：`npm run check:i18n`、`npm run check:contrast`、再加一条 dock 的浏览器夹具（胶囊⇄卡片切换、切 tab 后 `aria-selected`、拖入高亮、齿轮跳 `/settings`）。

## 实测量（2x 截图取样）

| 项 | 深色 | 浅色 |
|---|---|---|
| 卡片底色 | rgb(31,35,42) · L 34.7 | rgb(240,243,246) · L 242.6 |
| 壁纸（卡片左侧） | L 114.6 | L 119.4 |
| 五页卡片高度 | 477.5 一致 | 477.5 一致 |

## 截图

- `docs/screenshots/dock-card-stage-dark.png` / `dock-card-stage-light.png`（带壁纸全景）
- `docs/screenshots/dock-capsule-dark.png` / `dock-capsule-light.png`
- `docs/screenshots/dock-card-search-dark.png` / `dock-card-search-light.png`
- `docs/screenshots/dock-card-plans-dark.png`
- `docs/screenshots/dock-card-collect-dark.png`
- `docs/screenshots/dock-card-cal-dark.png`
- `docs/screenshots/dock-card-news-dark.png`
