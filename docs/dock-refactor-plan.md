# Dock 卡片重构：把手写页换成真组件

> 状态：计划（未开工）。这份文档是为了换会话后能直接接着做，不用重读整个上下文。

## 为什么

卡片里目前有三类页：

| 页 | 实现 | 问题 |
| --- | --- | --- |
| 收纳盒 / 计划 / 项目 | 直接嵌 `FencesFlyout` / `PlansFlyout` / `ProjectsFlyout` | 无，这套是正路 |
| 收集 | 卡片内简版 JSX | 和主窗口 `CollectPanel` 不是同一套视觉 |
| 日历 | 手写月格 + `.df-cal-*` | 和主窗口日历页面样式不一致 |
| 搜索 / 资讯 / 天气 / 通知 / 终端 | 手写 | 主窗口没有同款组件，暂只能手写 |

结论：真正要解耦的是 **收集** 与 **日历** 两个主窗口组件。

## 卡在哪

这两个组件都**不是可复用组件**，而是页面的一部分：

- 日历页把「当前月份 / 选中日 / 筛选」存在页面 state 里，还直接读路由；
- 收集页同理，且依赖主窗口的布局容器（宽度断点、侧栏开合）。

想在 660px 宽的卡片里复用，必须先把它们下沉成「受控组件」：状态由调用方传、
布局自适应、不读路由。

## 怎么做（两步，各一条 commit）

### 1. `refactor(calendar): 抽成受控组件`

- 新增 `src/features/calendar/CalendarView.tsx`，props：`{ month, selected, onMonthChange, onSelect, compact? }`
- 主窗口日历页改为薄壳：状态留在页面，渲染 `<CalendarView />`
- 卡片日历页改用同一个 `CalendarView`（`compact` 模式隐藏右侧清单）
- 回归：`npm run check:calendar-browser` + 截图对比主窗口与卡片

### 2. `refactor(collect): 抽成受控组件`

- 同样把 `CollectPanel` 里的表单拆成 `CaptureForm`（受控）
- 主窗口与卡片各包一层外壳

## 验收

- `npm run verify` 退出 0；
- 主窗口与卡片里同一功能的**字号 / 间距 / 圆角 / 空态文案**完全一致（截图为证，放 `docs/screenshots/`）；
- 卡片里不再出现第二套手写的日期格或表单控件。

## 顺带的视觉待办

- 卡片内所有横排（搜索筛选项、次标签行、收集页顶部按钮）统一「等分整行」，
  不留右侧空白 —— 这一条已经有两次踩坑记录：按内容宽度排会让整行看着歪。

## 剩余两项（已确认要做，尚未开工）

### A. 日历换成成熟组件

现状：卡片日历嵌的是主窗口的 `SchedulePage`（自己写的）。用户要求用现成组件、
要有 Windows 那种月份视图观感。

做法：

1. `npm i react-day-picker`（MIT，零运行时依赖，支持 `showOutsideDays`、`modifiers`、
   `components` 自定义单元格，正好能做「有任务的日子打点」）。
2. 新增 `src/features/desktop/dock-calendar.tsx`：`<DayPicker mode="single" showOutsideDays` 
   `modifiers={{ hasTask }} modifiersClassNames={{ hasTask: "df-cal-day-has" }} />`。
3. 主题：用 `components={{ Day: ... }}` 覆盖成项目 token（`--dock-face` / `--brand`），
   不要引入它自带 CSS —— 会跟 tokens 打架。
4. 回归：卡片宽高不变（660×591）；切月份不改变卡片高度。

### B. 通知接 Windows 通知中心

现状：通知页是应用内聚合（逾期 + 今天 + 未来两天），读不到微信/QQ 的系统通知。

做法：

1. Rust 侧加 `windows` crate 的 `UI_Notifications_Management` 特性，
   调 `UserNotificationListener::Current().GetNotificationsAsync(...)`。
2. 需要打包清单声明能力：`rescap:Capability Name="userNotificationListener"`，
   并且在「设置 → 隐私 → 通知」里让用户手动授权该应用。**未授权时返回空列表**，
   不能报错 —— 否则用户会以为功能坏了。
3. 前端：通知页分两段，「云台提醒」+「系统通知」，后者带应用名与时间。
4. 权限状态要有可见提示（例如「未授权，点这里去设置」）。

两项都要各开一次独立改动，别和别的混。
