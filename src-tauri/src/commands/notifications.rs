use serde::Serialize;

/**
 * Windows 通知中心的只读桥。
 *
 * `UserNotificationListener` 属于 WinRT，必须在**打包应用**（带 package identity）
 * 且清单声明 `rescap:Capability Name="userNotificationListener"` 时才可能拿到授权。
 * 开发态/绿色 exe 没有包身份时 `Current()` 会直接失败 —— 这是预期路径，不是异常：
 * 一律回空列表 + access="denied"，前端只渲染一个「去设置授权」入口。
 */
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotification {
    pub id: u32,
    pub app_name: String,
    pub title: String,
    pub body: String,
    /// RFC3339（UTC）；排序和展示都用它
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationSnapshot {
    /// allowed | denied | unsupported
    pub access: String,
    pub items: Vec<SystemNotification>,
    /// 仅用于诊断；前端不直接展示原始错误
    pub detail: Option<String>,
}

fn denied(detail: Option<String>) -> SystemNotificationSnapshot {
    SystemNotificationSnapshot {
        access: "denied".into(),
        items: Vec::new(),
        detail,
    }
}

#[cfg(not(target_os = "windows"))]
fn unsupported() -> SystemNotificationSnapshot {
    SystemNotificationSnapshot {
        access: "unsupported".into(),
        items: Vec::new(),
        detail: None,
    }
}

#[tauri::command]
pub async fn system_notifications() -> SystemNotificationSnapshot {
    #[cfg(not(target_os = "windows"))]
    {
        return unsupported();
    }

    #[cfg(target_os = "windows")]
    {
        // 所有 WinRT 调用都锁在一条 blocking 线程里：COM apartment 是线程本地的，
        // 不能让 tokio 把 future 搬到另一条没初始化的线程上。
        match tauri::async_runtime::spawn_blocking(collect_blocking).await {
            Ok(snapshot) => snapshot,
            Err(error) => denied(Some(format!("通知线程失败：{error}"))),
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_blocking() -> SystemNotificationSnapshot {
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    // 已经初始化成 STA 时返回 RPC_E_CHANGED_MODE；忽略它，后续调用失败会走 denied。
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    match tauri::async_runtime::block_on(collect_notifications()) {
        Ok(snapshot) => snapshot,
        Err(error) => denied(Some(error)),
    }
}

#[cfg(target_os = "windows")]
async fn collect_notifications() -> Result<SystemNotificationSnapshot, String> {
    use windows::UI::Notifications::Management::{
        UserNotificationListener, UserNotificationListenerAccessStatus,
    };
    use windows::UI::Notifications::NotificationKinds;

    let listener = UserNotificationListener::Current()
        .map_err(|error| format!("UserNotificationListener::Current 失败：{error}"))?;

    let mut access = listener
        .GetAccessStatus()
        .map_err(|error| format!("GetAccessStatus 失败：{error}"))?;

    if access == UserNotificationListenerAccessStatus::Unspecified {
        access = listener
            .RequestAccessAsync()
            .map_err(|error| format!("RequestAccessAsync 失败：{error}"))?
            .await
            .map_err(|error| format!("RequestAccessAsync 等待失败：{error}"))?;
    }

    if access != UserNotificationListenerAccessStatus::Allowed {
        return Ok(denied(None));
    }

    let notifications = listener
        .GetNotificationsAsync(NotificationKinds::Toast)
        .map_err(|error| format!("GetNotificationsAsync 失败：{error}"))?
        .await
        .map_err(|error| format!("GetNotificationsAsync 等待失败：{error}"))?;

    let mut items = Vec::new();
    for notification in notifications {
        let id = notification.Id().unwrap_or(0);
        let app_name = app_display_name(&notification);
        let (title, body) = notification_text(&notification);
        let created_at = notification
            .CreationTime()
            .ok()
            .map(format_datetime)
            .unwrap_or_default();
        items.push(SystemNotification {
            id,
            app_name,
            title,
            body,
            created_at,
        });
    }
    // 新通知优先；最多 50 条，避免一次把卡片铺爆。
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    items.truncate(50);

    Ok(SystemNotificationSnapshot {
        access: "allowed".into(),
        items,
        detail: None,
    })
}

#[cfg(target_os = "windows")]
fn app_display_name(notification: &windows::UI::Notifications::UserNotification) -> String {
    if let Ok(app) = notification.AppInfo() {
        if let Ok(display) = app.DisplayInfo() {
            if let Ok(name) = display.DisplayName() {
                let value = name.to_string();
                if !value.trim().is_empty() {
                    return value;
                }
            }
        }
        if let Ok(id) = app.AppUserModelId() {
            let value = id.to_string();
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    "Windows".into()
}

#[cfg(target_os = "windows")]
fn notification_text(
    notification: &windows::UI::Notifications::UserNotification,
) -> (String, String) {
    let texts = notification
        .Notification()
        .ok()
        .and_then(|payload| payload.Visual().ok())
        .and_then(|visual| visual.Bindings().ok())
        .and_then(|bindings| bindings.GetAt(0).ok())
        .and_then(|binding| binding.GetTextElements().ok())
        .map(|elements| {
            elements
                .into_iter()
                .filter_map(|element| element.Text().ok())
                .map(|text| text.to_string())
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let title = texts.first().cloned().unwrap_or_default();
    let body = texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
    (title, body)
}

#[cfg(target_os = "windows")]
fn format_datetime(value: windows::Foundation::DateTime) -> String {
    use chrono::{DateTime, SecondsFormat, Utc};
    // WinRT DateTime 是 1601-01-01 起的 100ns tick；先换成 Unix epoch。
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
    let ticks = value.UniversalTime - EPOCH_DIFF_100NS;
    let seconds = ticks.div_euclid(10_000_000);
    let nanos = (ticks.rem_euclid(10_000_000) * 100) as u32;
    DateTime::<Utc>::from_timestamp(seconds, nanos)
        .map(|stamp| stamp.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/** 打开 Windows 的通知权限设置页（未授权提示里的唯一动作）。 */
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("仅支持 Windows".into());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-notifications"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW：不要闪黑框
            .spawn()
            .map_err(|error| format!("打开通知设置失败：{error}"))?;
        Ok(())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn denied_snapshot_is_empty_and_not_an_error() {
        let snapshot = denied(Some("no package identity".into()));
        assert_eq!(snapshot.access, "denied");
        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.detail.as_deref(), Some("no package identity"));
    }

    #[test]
    fn listener_failure_is_reported_as_denied_without_panicking() {
        // 测试进程没有 package identity；这里实际跑一遍 WinRT，确认不会 panic。
        let snapshot = collect_blocking();
        assert!(
            matches!(snapshot.access.as_str(), "allowed" | "denied"),
            "access 只能是 allowed/denied，收到 {}",
            snapshot.access
        );
        assert!(snapshot.items.len() <= 50);
    }

    #[test]
    fn winrt_ticks_convert_to_unix_epoch() {
        // 1970-01-01T00:00:00Z 的 WinRT tick（1601 起算的 100ns）
        let value = windows::Foundation::DateTime {
            UniversalTime: 116_444_736_000_000_000,
        };
        assert_eq!(format_datetime(value), "1970-01-01T00:00:00Z");
    }
}
