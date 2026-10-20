use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Default)]
pub struct CaptureShortcut(pub Mutex<Option<Shortcut>>);

pub(crate) fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    let value = value.trim();
    let modified = value.split('+').any(|part| matches!(part.trim().to_ascii_lowercase().as_str(), "ctrl" | "control" | "alt" | "super" | "command" | "cmd" | "commandorcontrol" | "cmdorctrl"));
    if !modified { return Err("请使用包含 Ctrl、Alt 或系统键的组合键".into()); }
    value.parse::<Shortcut>().map_err(|_| "快捷键格式无效，例如 Ctrl+Alt+Space".into())
}

#[tauri::command]
pub async fn open_capture(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("capture") {
        if let (Some(x), Some(y)) = (x, y) {
            window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))
                .map_err(|e| e.to_string())?;
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let browser_args = app.config().app.windows.iter().find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.clone());
    let mut builder = tauri::WebviewWindowBuilder::new(&app, "capture", tauri::WebviewUrl::App("index.html".into()))
        .title("快速收集 · 云台")
        .inner_size(400.0, 600.0)
        .min_inner_size(360.0, 420.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .always_on_top(true)
        .skip_taskbar(true)
        .background_color(tauri::window::Color(16, 16, 20, 255))
        .visible(false);
    match (x, y) {
        (Some(x), Some(y)) => { builder = builder.position(x, y); }
        _ => { builder = builder.center(); }
    }
    if let Some(args) = browser_args { builder = builder.additional_browser_args(&args); }
    builder.build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_capture_shortcut(app: AppHandle, state: State<'_, CaptureShortcut>, shortcut: String) -> Result<(), String> {
    let next = parse_shortcut(&shortcut)?;
    let _change = super::desktop_shortcut::SHORTCUT_CHANGES.lock().map_err(|_| "快捷键状态不可用")?;
    let mut current = state.0.lock().map_err(|_| "快捷键状态不可用")?;
    if current.as_ref() == Some(&next) { return Ok(()); }
    if app.global_shortcut().is_registered(next) { return Err("快捷键与桌面栅格冲突，请更换组合键".into()); }
    // Register first: a conflicting new shortcut must not disable the old working one.
    app.global_shortcut().on_shortcut(next, |app, _, event| {
        if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { let _ = open_capture(app, None, None).await; });
        }
    }).map_err(|_| "快捷键被占用或无法注册，请更换组合键".to_string())?;
    if let Some(previous) = *current {
        if let Err(e) = app.global_shortcut().unregister(previous) {
            let _ = app.global_shortcut().unregister(next);
            return Err(format!("无法更换快捷键：{e}"));
        }
    }
    *current = Some(next);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_shortcut;

    #[test]
    fn refuses_unmodified_typing_keys_and_empty_shortcuts() {
        assert!(parse_shortcut("A").is_err());
        assert!(parse_shortcut("").is_err());
        assert!(parse_shortcut(" ").is_err());
    }

    #[test]
    fn accepts_capture_combination_and_rejects_invalid_keys() {
        assert!(parse_shortcut("Ctrl+Alt+Space").is_ok());
        assert!(parse_shortcut("Ctrl+NoSuchKey").is_err());
    }
}
