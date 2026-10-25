# Windows 通知中心接入

通知页从「只有云台自己的提醒」扩成两段：

| 段 | 数据 | 交互 |
| --- | --- | --- |
| 云台提醒 | `usePlans` 的 days：逾期 + 今天 + 未来两天 | 点一条跳到计划页 |
| 系统通知 | Windows `UserNotificationListener` 只读快照 | 显示应用名、标题、正文、时间；可刷新 |

截图：`docs/screenshots/dock-card-notice-dark.png`（上段云台提醒、下段系统通知）。

## 数据流

`src/features/desktop/dock-float.tsx` 的 `NoticePanel` →
`systemNotifications()`（`src/lib/tauri.ts`）→ `commands::notifications::system_notifications`。

Rust 返回：

```ts
interface SystemNotificationSnapshot {
  access: "allowed" | "denied" | "unsupported";
  items: { id: number; appName: string; title: string; body: string; createdAt: string }[];
  detail?: string | null; // 仅诊断，不在界面展示
}
```

- **allowed**：按创建时间倒序取最近 50 条 Toast 通知。正文取
  `Notification.Visual.Bindings[0].GetTextElements()`：第一条是标题，其余拼成正文。
- **denied**：未授权、没有 package identity、WinRT 调用失败 —— 一律返回
  **空列表 + access="denied"**，命令本身不抛错。前端只渲染一个可点击的
  「去设置授权」按钮（调 `open_notification_settings` 打开
  `ms-settings:privacy-notifications`）。
- **unsupported**：非 Windows 环境；前端同样只留一个提示，不崩。

WinRT 调用锁在一条 blocking 线程里（COM apartment 是线程本地的，
不能让 tokio 把 future 搬到未初始化的线程），见 `notifications.rs` 的
`collect_blocking`。

## 打包清单

`src-tauri/AppxManifest.xml` 声明：

```xml
<rescap:Capability Name="runFullTrust" />
<rescap:Capability Name="userNotificationListener" />
```

`UserNotificationListener` **要求 package identity**。Tauri 的 NSIS/MSI 安装包
不带包身份，因此直接跑 `nimbusdesk.exe` 时读取会走 denied —— 这是预期行为，不是
错误。要真正看到其他应用的通知，需要把 exe + 图标 + 该清单打成 MSIX（或注册为
稀疏包）并安装；安装后在「设置 → 隐私和安全性 → 通知」里允许云台读取通知中心，
再回卡片点刷新。

## 验证

- 自动：`node scripts/check-dock-float-browser.mjs`（dev server 在 17800）
  用 mock 的 `system_notifications` 断言两段结构、未授权只有一个
  `[data-notice-permission]` 按钮、点它会发 `open_notification_settings`、
  授权快照会显示应用名与标题。
- Rust：`cargo test --lib commands::notifications`（denied 快照为空、WinRT tick 转 Unix）。
- 手测（未打包）：打开卡片 → 通知 → 系统通知段只有一个「去设置授权」；点击后
  Windows 设置打开，页面不崩。
- 手测（MSIX）：允许通知权限 → 用微信/Outlook 各发一条通知 → 卡片通知页能看到
  应用名、标题与时间。
