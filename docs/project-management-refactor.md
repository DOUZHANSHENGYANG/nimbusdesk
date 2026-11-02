# 项目管理模块：现状盘点与重构方案

> 2026-11-01 起，文中的「业务范围（area）」「提醒」两处设计已作废：业务范围与项目/工作项提醒都从数据模型和界面移除，项目只剩一级。改版说明见 `project-management-local.md` 末节。

2026-10-31。调研对象：`src/features/projects/`（20 个实现文件 + 13 个测试文件）、`src-tauri/src/project_database.rs`、`docs/project-management-local.md`。结论先给：**这不是一次重构，是加两层（层级 + 权重）和两块内容（文档、图表）。** 现有模型、存储、禅道回写、文件 IO 都值得保留。

## 1. 现有能力盘点

| 需求 | 现状 | 落点 |
| --- | --- | --- |
| 多项目 | 已有：业务范围（area）→ 项目 → 工作项三级 | `types.ts`、`page.tsx` 左栏 |
| 项目录入 | 名称/备注/状态/业务范围/起止日期/人工进度 | `forms.tsx` `ProjectEditor` |
| 业务标签 | **无**，只有单一 `areaId` | — |
| 项目描述 | `note`（纯文本 textarea） | `forms.tsx` |
| 项目开始/结束 | `startDate`/`endDate`，参与自动进度推算 | `core.ts` `projectProgress` |
| 计划 + 子计划 | 项目侧「工作项」**扁平，无 `parentId`**；每日计划侧有树（`PlanTask.parentId`），可 `workItemId` 双向关联 | `types.ts`、`plans/types.ts`、`plan-binding.tsx` |
| 手动完成度 | 项目级 `progressManual`（0–100，优先于时间/计数）；**计划级无** | `core.ts:115` |
| 计划占比 | **无** | — |
| 项目文件区 | 已有：绑定目录/托管目录、目录导航、新建、导入、移动、回收站、MD 编辑、冲突保留草稿 | `files.tsx`、`api.ts`、`project_database.rs` |
| 项目文档类型 | **无类型**，只有自由文件树 | — |
| 多图分析 | 仅总览（状态分布、迭代进度条、需关注、最近改动） | `overview.tsx`、`overview-core.ts` |
| 敏捷迭代 | 已有：2/3 周或自定义迭代、结转（保留 ID/快照/历史计划）、成员关系 | `core.ts` `carryItem`、`details.tsx` |
| 截止提醒 | 已有：全局/项目/任务三级继承，时区与工作日 | `core.ts` `dueProjectReminders` |
| 禅道联动 | 已有：远程任务、执行、回写队列与冲突 | `zentao-*.ts` |
| 持久化 | JSON 存 `workbench.sqlite3` 的 blob，关系表由 `rebuild` 派生缓存 | `project_database.rs:55` |

## 2. 真实差距（只有五条）

1. **业务标签缺失**：一个项目只能落一个业务范围，跨业务的项目无法归类。
2. **计划没有层级**：`WorkItem` 没有 `parentId`，无法表达「开发计划 → 里程碑 → 子计划」。
3. **进度只有两个极端**：项目级人工百分比 + 计划级四态。中间没有「这条计划做到 60%」，也没有「这条子计划占父计划 40%」。
4. **文档是裸文件**：没有「这篇是本项目的 PRD」这个身份，模板只能靠人记。
5. **没有时间维度的图**：只有当下快照，没有甘特（起止）、燃尽（历史）、累积流（分状态历史）、速率（按迭代）。

## 3. 开源对照

| 项目 | 许可 | 语言 | 值得抄的具体点 | 结论 |
| --- | --- | --- | --- | --- |
| [Vikunja](https://vikunja.io/help/tasks/) | AGPL-3.0 | Go/Vue | 任务自带 **0–100 手动进度**（官方文档原话：Set a percentage between 0 and 100 to track progress manually）；List/Table/Gantt/Kanban 四视图同源 | 直接印证「手动完成度」是正确抽象，可照做 |
| [Taiga](https://community.taiga.io/t/solved-burn-down-chart-with-negative-points/1040) | MPL-2.0 | Python | 用户故事点数驱动**任务级燃尽**，不是数条数 | 权重（points）→ 燃尽，这正是「计划占比」的用途 |
| [Plane](https://docs.plane.so/pages/overview) | AGPL-3.0 | TS | 项目内 **Pages/Wiki**（规格、架构决策就近放）+ Project Templates 标准化项目结构 | 文档区形态照抄「项目内 Pages」，不抄它的视图体系 |
| [Leantime](https://support.leantime.io/en/article/maximizing-project-value-with-leantimes-lean-canvas-template-1l2ke94/) | AGPL-3.0 | PHP | Blueprint 画布模板（Lean Canvas 等）当「项目前期文档模板」 | 只借「模板即空白文档」的做法 |
| [Kaneo](https://kaneo.app/docs/core/functional/calendar-and-gantt) | **MIT** | TS | 极简 board + Gantt（有起止才进时间轴，只有一端就占一天） | **唯一可安全搬代码的**，Gantt 计算可参考 |
| [OpenProject](https://www.openproject.org/docs/user-guide/gantt-chart/) | GPL-3.0 | Ruby | 甘特 + 基线、按 sprint 的燃尽、每项目 Wiki | 借概念（基线/里程碑），代码不搬 |
| [Focalboard](https://github.com/mattermost/focalboard) | NOASSERTION | TS | 看板交互 | 许可不明且维护停滞，**不融合** |
| [Huly](https://github.com/hcengineering/platform) | EPL-2.0 | TS | 「文档 + 里程碑 + 任务」同项目的信息架构 | 只借 IA，体量不匹配 |
| [Docmost](https://github.com/docmost/docmost) / [Outline](https://www.getoutline.com/changelog/document-templates) | AGPL / NOASSERTION | TS | 文档模板（Outline 2020 起就有） | 只借模板交互 |

**融合取舍**：抄 Vikunja 的 `percent`、Taiga 的「权重驱动燃尽」、Plane 的「项目内 Pages + 模板」。PLANE/VIKunja/Leantime/Docmost 都是 AGPL，**代码不能进这个闭源桌面应用**，只借模型与交互；唯一可复制实现的 TS 参照是 Kaneo（MIT）。

## 4. 最小数据模型改动

```ts
Project    += tags: string[]                 // 业务标签，自由文本，复用 files 模块的逗号输入 + AND 筛选
WorkItem   += parentId: string | null        // 子计划
           += weight: number                 // 同层占比，默认 1
           += percent: number | null         // 人工完成度 0–100
           += startDate/endDate?: string|null // 甘特用，可空
ProjectData += snapshots: ProgressSnapshot[] // 每日每项目一行，用于燃尽/累积流/速率
```

规则（写进 `core.ts`，配单测）：

- `itemPercent`：有 `percent` 用它；否则 `done→100`，`cancelled` 与其余→0。
- `weightedPercent(children)`：`Σ(percent × weight) / Σweight`；无子项才用自身 `percent`。权重只在同层有意义。
- `projectProgress` 优先级保持「人工 > 权重聚合 > 时间推算」。旧的计数逻辑等价于全权重 1、doing 记 0，**老数据零迁移**。
- 状态与完成度单一真源：拖到 `done` → `percent=100`；`percent=100` → 状态回写 `done`。两处都在 store 里改，不在 UI 里各改各的。

Rust 侧**不用改**：`project_write` 对 `projects` 键走 `rebuild`，新字段随 JSON blob 走，关系表不需要新列（`project_database.rs:66`）。这是本方案最省事的地方，别再动 schema。

## 5. 文档区（不新增存储）

在项目目录下用 `文档/` 子目录 + 固定文件名做「槽位」，点「用模板创建」→ `createProjectEntry` + `writeProjectText` 写入模板，之后走既有 MD 编辑/预览/冲突逻辑：

| 槽位文件 | 模板骨架 |
| --- | --- |
| `文档/可行性分析.md` | 同类产品与解决方案对比、关键技术探索与突破、结论与取舍 |
| `文档/PRD.md` | 目标用户与场景、需求清单、范围外、验收口径 |
| `文档/技术架构.md` | 选型、模块边界、数据流、风险 |
| `文档/详细设计.md` | 功能设计、非功能（性能/安全/兼容）、核心用户流程 |
| `文档/开发计划.md` | 里程碑、子计划清单、验收标准 |

文件名即身份：改名就退化成普通文件，槽位显示「未创建」。`shortcut: 一类型只认一个固定文件名，要支持多份时改成 manifest。`

## 6. 图表（4 张，全部来自 snapshots + 现有模型）

- **甘特**：顶层计划按 `startDate..endDate`（缺失回退迭代区间），子计划折叠；里程碑用迭代结束日。
- **燃尽**：当前迭代剩余点数（`weight` 当点数）对日，理想线。
- **累积流**：`todo/doing/done` 三条堆叠面积，来自 snapshots。
- **迭代速率**：每个已结束迭代的完成点数柱状 + 均值线。

不引图表库（本项目零图表依赖，`plans/stats.ts` 已是手绘先例）：甘特是 DOM 条，其余是内联 SVG。`snapshots` 每天首次打开时幂等 upsert 一行，约 30 行。代价要认：**装完当天没有历史，燃尽/累积流要跑几天才有形状**。

## 7. 分期

| 期 | 内容 | 文件 | 验收 |
| --- | --- | --- | --- |
| P0 | 模型 + 校验 + 权重聚合计 | `types.ts` `core.ts` `copy.ts` `core.test.mjs` | `npm run check:projects` 全绿；老库直接打开 |
| P1 | 录入：项目标签、计划的父/占比/完成度/起止；列表树形缩进；详情显示占比条 | `forms.tsx` `page.tsx` `details.tsx` `board-core.ts` | 浏览器回归：建项目→打标签→建子计划→设占比→项目进度随子计划变 |
| P2 | 文档槽位 + 5 个模板 | 新 `doc-templates.ts` `documents.tsx`；`page.tsx` 复用 files tab | 绑定目录→一键生成 5 篇→内容非空→可编辑 |
| P3 | 图表页签 + snapshots | 新 `charts-core.ts` `charts.tsx`；`store.ts` `core.ts` | 4 张图单测 + 截图进 `docs/screenshots/` |
| P4 | 迭代容量/速率目标线（可选） | `overview.tsx` | 不阻塞前四期 |

每期一次提交，`npm run verify` 退出 0。

## 8. 明确不做

- **不合并 `PlanTask` 与 `WorkItem`**：一个是「今天做什么」，一个是「项目要交付什么」，生命周期、提醒、禅道、迭代都挂在后者上；合并要重写 20 个文件和 13 套测试，换来的只是概念少一个。复用方式是**复用视图组件与交互**，不是复用表。
- 不搬 Plane 的 Modules/Views/团队空间，不搬 Huly 的多产品线。
- 不把 UML/时序图塞进来——那是 `canvas` 模块的职责，项目管理只出甘特/燃尽/累积流/速率。
- 不做多项目组合（portfolio）资源分配：单机个人工作台不需要。

## 8.5 界面重组（模仿 Plane 的组织形式）

参照对象只用 **Plane**（[Pages](https://docs.plane.so/pages/overview)、Cycles/Modules 的页签式组织）与 **Vikunja**（同项目四视图），理由：它的 IA 与本地单机工作台最接近，且我们已有「项目 → 视图 → 详情」的骨架，是重组不是重画。

**先纠正上一版判断**：`ProjectViewsBar` 不是「重复的第二排筛选」，而是 Huly 风格的保存视图（`views-bar.tsx`，存 `settings.projectViews`）；「项目文件」页签的位置本来就等于 Plane 的 Pages；右侧详情面板已经是 peek 形态。这三处不用动。

真正要改的是三处：

1. **项目头没有身份**：业务范围、起止、进度、未完成数都不在标题旁，只有归档角标。项目的信息在列表页看不见。
2. **页签是 48px 条里的胶囊组**，Plane/Linear 用下划线页签；视觉上它像「模式切换」而不是「页面」。
3. **工具栏横着四件套**（迭代下拉 + 新建迭代 + 状态下拉 + 搜索）各占一份宽度，Plane 把它们收进「筛选/显示」popover，只留搜索。

目标骨架（一行一区，都是别人的成熟做法）：

```
┌──────────────────────────────────────────────────────────────┐
│ 云台重构  [桌面] [Tauri]  2026-10-01 → 12-31  ▓▓▓▓░░ 62%  … │ 项目头
├──────────┬───────────────────────────────────────────────────┤
│ 全部项目  │ 工作项  迭代  文档  图表                          │ 下划线页签
│ 无项目    ├───────────────────────────────────────────────────┤
│ ───────  │ ⌕ 搜索        筛选 ▾  显示 ▾      列表 ▾ 看板 甘特 │ 单行工具栏
│ 业务范围A ├───────────────────────────────────────────────────┤
│  · 项目1 │ ○ 计划标题        子计划 2/5  ×2  09-30           │ 列表
│ 业务范围B │ ○ 子计划 …                                        │
└──────────┴───────────────────────────────────────────────────┘
```

| 区块 | 改法 | 来源 |
| --- | --- | --- |
| 项目头 | 标题 + 业务标签 chips + 起止 + 权重聚合进度条 + 编辑/提醒/新建 | Plane 项目头 |
| 左栏 | 保持业务范围分组；项目行加未完成计数（已有） | Plane 侧栏、Linear |
| 页签 | 胶囊组换下划线页签；`files` 改叫「文档」 | Plane（Issues/Cycles/Pages） |
| 工具栏 | 搜索常驻左侧，迭代/状态收进「筛选」popover，右侧放视图切换 | Plane issue toolbar |
| 视图 | 列表 / 看板 + 后续甘特/燃尽同源切换 | Vikunja 四视图 |
| 详情 | 保持右侧 peek，补一条面包屑 | Plane issue peek |
| 新建 | 列表首行 `+ 新建计划`；看板列底 `+` | Plane/Linear |

抄不动也不该抄的：工作空间/成员/权限/评论/@提及、保存视图共享、自定义 issue 属性、实时协同。这些都要服务端，单机没有意义。

`browser.test.mjs` 与三个夹具断言的是当前 DOM（页签 role、`aria-pressed`、列选择器），改页签与工具栏要同步改断言；`npm run check:projects` 与 `verify:dist` 的 `check:visibility` 也要跟着跑。

**已落地（P0 + P1b，2026-10-31）**：

- **数据模型**：`Project.tags`；`WorkItem.parentId / weight / percent / startDate / endDate`。全部可选，老数据零迁移。
- **进度口径**：`itemPercent`（人工百分比优先，否则 done=100）→ `planPercent`（父计划按子计划权重加权，取消的不进分母）→ `projectProgress`（人工 > 顶层计划权重聚合 > 时间推算）。全默认权重时与旧的 done/total 完全等价，`core.test.mjs` 有对照断言。
- **校验**：标签去重且 ≤12；权重 0–1000；完成度 0–100；子计划不能指向自己、不能跨项目、不能成环；起止日期合法且先后有序。
- **单一真源**：`updateItem` 里统一——标 done 即 percent=100，手动拉到 100 即 done，退回未完成时清掉 100。
- **录入**：项目表单加业务标签（逗号分隔）；计划表单加父计划（候选已排除自己与子孙）、占比、完成度、起止。
- **呈现**：列表按层级缩进（每级 16px），有子计划或设过人工完成度的行显示进度徽章；详情面板加完成度滑杆（可直接调，附「恢复自动」）、占比与父计划。

**P2 项目文档（2026-10-31）**：五个固定槽位写在项目目录 `docs/` 下（`01-feasibility`、`02-prd`、`03-architecture`、`04-detailed-design`、`05-dev-plan`），文件名即身份。渲染位置在 `files.tsx` 内部（同一个「文档」页签：上面五类固定文档、下面自由文件树）；点「用模板创建」→ `project_create_entry` + `project_write_text` 写入骨架，之后编辑交给下面的文件区或系统默认程序。「全部创建」只补缺的，不覆盖已有内容。改名的文件不再算槽位（降级成普通文件），这是刻意的：不引 manifest，文件就是真源。模板正文中文，带表格与 checklist 骨架，单测守住「五条路径唯一、每篇有标题且不是空壳」；Rust 集成测试按同样的调用顺序验证建目录 → 建文件 → 写入 → 读回 → 冲突拒绝覆盖。

**P3 四张图（2026-10-31）**：`charts-core.ts` 全是纯函数——`snapshotOf`（按权重算点数）、`upsertSnapshot`（同一天幂等、超一年剪掉）、`burndown`（缺天沿用前一天，不画成 0）、`cfd`、`velocity`（迭代首尾已完成点数之差）、`ganttRows`（缺起止回退迭代/截止日，取消的不画）。`ProjectData.snapshots` 每天每项目一行，打开应用时 `recordSnapshot` 幂等写入；备份不合并别人的快照，避免历史被外来数据改写。界面在「图表」页签，两列卡片，甘特是 DOM 条、其余是内联 SVG，不引图表库。**装了当天没有形状**，要跑几天。

截图：`docs/screenshots/projects-charts.jpg`（首日：燃尽与速率显示"还没有历史快照"的诚实空状态，累积流只有一根 6% 宽的当日柱）。文档槽位没法在夹具里截到——夹具的目录绑定是 mock，调用直接返回 `FIXTURE_PROJECT_NOT_BOUND`，这条只能靠单测与真机验证。

**页面结构与视觉（P1a）**：

- 项目头身份行（业务范围 · 起止 · 进度条 · 未完成数，`page.tsx` 的 `projectMeta`）；
- 页签改纯文字下划线 44px（去掉图标），`files` 文案改「文档」；
- 工具栏从三条横带收成一条：迭代筛选与其 `＋/✎` 合成一个 28px 控件（`ProjectSelect` 新增 `size="sm"`），状态筛选 108px，搜索占余量，右侧是范围 + 条数 + 「保存当前视图」；
- 删掉左栏业务范围前的假箭头（它像可展开，实际只是选中范围），层级改用字重 + 缩进；
- 总览的迭代状态条把 `doing` 降到 brand/45：原先「1 项进行中」会把整条涂成品牌蓝，读起来像 100% 完成；
- 看板顶栏去掉与工具栏重复的条数（同一批卡片、同一个数），只留操作提示与筛选态；
- 文档页未绑定目录时给一个居中的空状态（图标 + 一句 + 两个动作），不再是一行灰字贴在左上角；文件页容器与列表页统一 `p-4`。

证据：`docs/screenshots/projects-header-tabs.jpg`（改前）、`docs/screenshots/projects-after.jpg`（改后 626px）、`docs/screenshots/projects-board.jpg`、`docs/screenshots/projects-docs-empty.jpg`（1440px）。测试脚本里「项目资料 → 文档」的断言同步改了。`npm run check:projects` 65/65，`tsc` 对这四个文件无报错。
过程与设计判断：`.oil-ui/project-page-refine/design-note.md`。

**窄窗实测**（对应 200% 缩放）：390px 下工具栏折成四行、项目头折三行，无重叠、无裁切；侧栏 140px 可读，项目名截断。真实最小窗宽是 960px，390 只作为压力上限。

**版式复盘（2026-11-01，走 `impeccable layout`）**：诊断出的结构问题是「搜索框吃掉全部余量、右侧元信息被挤到 11px 贴边」，以及「页签条 + 工具栏 + 卡片顶边三条横线挤在 90px 内」。按 Operate 模式的密度改法：工具栏去掉自己的下边线（筛选与列表连成一块）、搜索封顶 280px、范围/条数/保存视图用 `ml-auto` 收成右栏、页签条 44→40、列表行 `py-1.5`→`py-2`，让 chrome 紧、数据行松。机械检测 `impeccable detect --scope layout` 返回空。

同轮修掉一个我自己引入的回归：图表分支的条件写成了 `selectedProject ? charts : tasks`，导致「工作项」页签在有项目时渲染成图表。现在抽成 `resolveActiveTab(tab, hasProject)` 并由单测锁住（`core.test.mjs`）。

**打磨（2026-11-01，`impeccable polish`）**：全局已经有 `::selection`、主题化滚动条和 `:focus-visible` 的 2px `--ring` 外框（`src/index.css`），所以只修模块内自己发明的那几套：页签的 1px 虚线框、列表/总览/看板/文档槽位上的 `ring-1`/`ring-2` 与 `outline-none` 全部删掉，统一回到全局那一种焦点语言（`projects.css` 里的 box-shadow 焦点也删了）。另外：工具栏两个下拉的箭头收到 3.5（与周围图标同尺寸）、列表行尾箭头默认 40% 悬停提亮、文档槽位「未创建」与看板空列提示去掉 70% 透明度（10–11px 小字配 70% 不达 4.5:1）、速率图迭代名 9px→10px。机械检测 `impeccable detect` 返回空。

## 8.6 左栏信息架构（2026-11-01）

用户反馈左栏看不懂。原因是把「容器」和「过滤器」混在一列，还混了单位：

- 全部项目 / 无项目 是**范围过滤**；业务范围 → 项目是**容器树**；未分类是「没有业务范围的**项目**」，而「无项目」是「没有项目的**计划**」——两个「没有」分属不同层级却并排出现；
- 「全部项目」右边的数字是**项目数**，项目行右边的数字是**未完成计划数**，同一列两种单位。

现在左栏只回答一个问题：这些计划放在哪。数字统一成**未完成计划数**。

- 顶部：`全部计划`（跨项目汇总，含未归属），悬停说明「跨项目汇总，含未归属的计划」；
- 中间：业务范围树（业务开发 › 业务门户），没有业务范围的项目归进 `未归入业务范围` 这一组，与其他业务范围同级；
- 分隔线以下：`未归属计划`（没挂任何项目的计划）+ `显示归档项目`。

两名测试脚本里点左栏的断言同步改成新名字。截图 `docs/screenshots/projects-rail.jpg`。

## 9. 已确认范围（2026-10-31）1. 「计划的项目占比」= **计划在项目内的权重**，不做跨项目 portfolio 投入占比。
2. 「多图分析」= **甘特 / 燃尽 / 累积流 / 迭代速率**，不含 UML/时序/ER（那是 canvas 模块）。
3. 项目文档 = **写进项目目录的文件**（`docs/` 槽位，文件名 ASCII、正文中文），不进数据库。

## 10. 独立评审（已完成）

前三次尝试分别报 `upstream client (http 403)`、`ECONNREFUSED`、`Variant unavailable for multi2api/deepseek: medium`——都是默认模型/变体的问题。指定 `niu/deepseek-v4.1-flash` 后跑通，评审者只拿四张截图和判断标准，没有制作过程上下文。

评审结论与我采纳的处理：

| 评审指出 | 处理 |
| --- | --- |
| 截止日期是原生选择器，开始/结束却是 `YYYY-MM-DD` 纯文本，看着能点却没选择器 | **已改**：三处统一成 `type="date"` |
| 累积流只有一天历史也画一根满高柱，与燃尽/速率的「还没有历史」自相矛盾，同一句解释还重复三次 | **已改**：历史不足两天时，三张图合并成一句虚线说明，只出现一次 |
| 页签选中是下划线，聚焦却是描边方框，像焦点泄漏 | **已改**：焦点改成虚线 outline + offset，与选中态区分开 |
| 626px 下顶部动作折成两排，侧栏占 26% | **不改**：应用最小窗宽 960px，626 是我加的压力上限；900 一行放得下 |
| 看板卡片没有列表行的「关联计划 3」计数 | **不改**：看板密度不同，计数留在列表与详情里 |
| 空标题时保存按钮仍可点 | 未验证：表单有 `required`，原生校验会拦住提交 |

评审另外明确点名「最不值得改」的是图表页底部那行项目·点数汇总——保留。

## 11. 还没做

- 计划表单窄窗下是 7 行字段，`sm:max-w-md` 的对话框会滚动，没做分组折叠。
- 甘特没有拖拽改期，也没有基线对比（OpenProject 那套需要额外的历史版本）。
- 项目文档的五张卡片仍没有画面证据（夹具的目录绑定是 mock），只有 Rust 集成测试与 `doc-templates` 单测守着落盘与槽位识别。
