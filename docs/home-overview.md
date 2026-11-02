# 首页两视图：总览 / 脉络

首页（`/`）有两个视图，右上角切换。版式与项目页总览共用 `src/components/ui/dashboard.tsx` 里的数字格、卡片与分段条，两页的比例、字号、间距是同一套。

（原来还有第三个「清单」视图，已删除：它把今日计划平铺成一行行，内容一少就是一屏空白，而且和「计划管理」页重复。想要逐条勾选、看子任务与时间分组，去计划管理。）

## 总览（默认落点）

首页不再写日期与标题（侧栏已经说明这是「首页」），内容按四段排：

1. **读数**：今日计划、待办工作项（含逾期）、笔记、资讯；整块可点，分别去 `/plans`、`/projects`、`/ai/knowledge`、`/tools/feeds`。
2. **上半区左右分栏**：左边上下两块——「近 7 天计划数」柱状图（`dailyPlanSeries()` 按天统计排了几条）+「当前项目」进度条；右边是「今日资讯」幻灯片，一个源一张，带左右翻页与圆点，条目来自该源最新 3 条。
3. **文件收纳盒**：一行方块，显示每个盒子的名称与条目数，点击进文件收纳；**只做快速访问，不接拖拽/拖入**。
4. **AI 资源**：提示词 / 技能 / MCP / Harness 工具四个数字，读的是本机清单（`useData` + `loadHarnessReports()`），点击进 `/toolbox/*` 对应目录。

图表仍用 `recharts`，只有首页用到；首屏闭包由 `npm run check:bundle` 守住。

### 资讯卡显示哪个渠道

- 默认 = **订阅顺序里的第一个源**：自定义订阅在 `mergedSources()` 里排在静态渠道前面，所以就是「我添加的第一个 RSS」（比如 AI 早报）。
- 想固定看别的渠道：设置 → 资讯 → **主页资讯** → 渠道。选中的渠道被删掉时自动退回默认，不会留一张空卡。
- 逻辑在 `pickHomeFeed()`（`src/features/home/overview-core.ts`），状态是 `settings.homeFeedSource`（`null` = 自动）。

## 脉络

原来的星图（节点 = 计划/收藏/知识/栅栏），默认暂停播放省 GPU，点播放才动。

## 验证

- `npm run check:home`：`src/features/home/overview-core.test.mjs` 覆盖待办排序（无截止日排最后）、资讯时间线合并与去重、相对时间粒度、主页渠道的默认与失效回退。
- `node scripts/check-home-overview-browser.mjs`（先起 Vite，端口 17800）：真组件 + mock 原生边界，验证总览是落点且「清单」视图已消失、四个数字格取值、待办与资讯的深链（`/projects?item=…`、`/feeds`）、笔记卡内容、资讯卡钉在第一个订阅并可切换（含渠道被删后的回退）、勾选计划写回，以及侧栏一级只剩「工作台 / 资料」（AI 的条目落在资料里）。
- 截图：`docs/screenshots/home-overview.png`（暗，含侧栏）、`home-overview-light.png`（亮）。
