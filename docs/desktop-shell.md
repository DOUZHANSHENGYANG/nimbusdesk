# 桌面壳：多屏 / 焦点 / 自愈 / 作用域

桌面挂件（dock / fence / edge-dock / 快速收集）的窗口学，契约抄自 WinIsland 的
`DisplayResolver` / `InputSession` / 顶置自愈，落在 `src-tauri/src/display.rs` 与
`commands/dock.rs`。

## 怎么验证

| 行为 | 验证方法 |
|---|---|
| 多屏跟随 | 把鼠标移到第二块屏再唤起 dock —— 出现在鼠标那块屏；钉住某块屏后拔掉它 → 不跳主屏，跟随鼠标；插回来 → 自动回钉住的那块 |
| 点击不抢焦点 | 在别的应用打字时悬停/点 dock 按钮 —— 前台不切走 |
| 输入会话 | 点 dock 的「知识/收集」输入框 → 能直接打字；点别处 → 焦点还原 |
| 顶置自愈 | 打开开始菜单盖住 dock 再关 → 2 秒内 dock 回到最上层 |
| 圆角穿透 | 点胶囊圆角外的四个角 → 鼠标落到桌面 |

## 规矩（改这里之前先读）

1. **多屏只有一处判定**：`display.rs::pick` —— `auto` 跟随鼠标、指定 id 钉死、
   找不到**报错**，任何地方都不许再写「拿不到就 primary」。
   显示器接拔由 `start_watch` 每 3 秒比对并广播 `display://changed`。
2. **NOACTIVATE 是常态**：dock 窗口常驻 `WS_EX_NOACTIVATE`，点它不抢前台；
   只有文本框获得焦点（`pointerdown`/`focusin` 双通道）才经 `input_session_begin`
   临时放行，失焦 140ms 后 `end` 还原。
3. **顶置自愈**：`start_topmost_watch` 每 2 秒采样窗口中心点，被盖住就重申
   `HWND_TOPMOST`（不抢焦点）。
4. **点击穿透的边界**：曾试过 `SetWindowRgn` 把窗口裁成圆角形状
   （WinIsland 的做法）—— 撤了：GDI 区域没有抗锯齿，胶囊圆边起锯齿，
   且每次尺寸落定重裁会强制重绘，收拢时肉眼可见地卡一下。
   现状 = 矩形命中（圆角外的透明像素仍吃点击），真穿透等以后按
   分层窗口的 alpha 做再说。
5. **作用域设置与日志**：功能自带 `scopes/<id>.json` 与 `logs/<id>.log`
   （`ahub/scoped.rs`，id 规矩 = WinIsland manifest 的 `[a-z0-9-]`）；
   `scope_get` / `scope_set` / `log_append` / `log_tail` 四个命令，
   无人值守动作（定时 AI）成败都落 `logs/schedule-ai.log`。

## 边界

- 没做「嵌进任务栏」：dock 只有贴边悬浮一种摆放，`Monitor.work_area` 已避开任务栏；
- `currentMonitor()` 仅剩「查窗口自己在哪块屏拿 scale」的用途，不参与选屏；
- 可执行插件（manifest / 生命周期 / 熔断 / 隔离）未立项，等隔离选型。
