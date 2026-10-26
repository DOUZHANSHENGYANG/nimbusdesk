use crate::quick_tools::{self, SelectionSnapshot};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct QuickToolsShortcut(pub Mutex<Option<Shortcut>>);

static SHORTCUT_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn remember_shortcut_error(error: Option<String>) {
    if let Ok(mut current) = SHORTCUT_ERROR.lock() {
        *current = error;
    }
}

#[tauri::command]
pub fn quick_tools_shortcut_error() -> Option<String> {
    SHORTCUT_ERROR
        .lock()
        .ok()
        .and_then(|current| current.clone())
}

fn allowed_route(route: &str) -> bool {
    [
        "/tools",
        "/tools?tool=translate",
        "/tools?tool=naming",
        "/tools?tool=format",
        "/tools?tool=diagnose",
        "/tools?tool=regex",
        "/settings?tab=ai",
    ]
    .contains(&route)
}

#[tauri::command]
pub fn quick_tools_selection() -> Result<SelectionSnapshot, String> {
    quick_tools::snapshot()
}

#[tauri::command]
pub async fn quick_tools_open_window(app: AppHandle) -> Result<(), String> {
    // Menu entry explicitly opens an empty panel rather than reading its own controls.
    let revision = quick_tools::begin_capture()?;
    publish_and_show(&app, revision, Ok(String::new()))
}

fn show_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick-tools") {
        window.center().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "quick-tools",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("快捷工具 · 云台")
    .inner_size(760.0, 620.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .decorations(false)
    .skip_taskbar(true)
    .visible(false)
    .disable_drag_drop_handler()
    .background_color(tauri::window::Color(16, 16, 20, 255));
    if let Some(args) = browser_args {
        builder = builder.additional_browser_args(&args);
    }
    // The frontend calls window_ready after mounting; the snapshot is already available.
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

fn publish_and_show(
    app: &AppHandle,
    revision: u64,
    result: Result<String, String>,
) -> Result<(), String> {
    if !quick_tools::finish_capture(revision, result)? {
        return Ok(());
    }
    app.emit("quick-tools://selection", quick_tools::snapshot()?)
        .map_err(|e| e.to_string())?;
    show_window(app)
}

fn capture_from_hotkey(app: AppHandle) {
    // Both target identity and revision are captured in the key handler, before spawning.
    let target = quick_tools::selection::foreground_target();
    let Ok(revision) = quick_tools::begin_capture() else {
        return;
    };
    let Ok(cancel) = quick_tools::cancellation(revision) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let result = match target {
            Ok(target) => tauri::async_runtime::spawn_blocking(move || {
                quick_tools::worker::extract(target, &cancel)
            })
            .await
            .unwrap_or_else(|_| Err("选区读取异常，请手动粘贴".into())),
            Err(error) => Err(error),
        };
        // Failure still opens a clean, editable panel with a useful reason.
        let _ = publish_and_show(&app, revision, result);
    });
}

#[tauri::command]
pub async fn quick_tools_set_shortcut(
    app: AppHandle,
    state: State<'_, QuickToolsShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let result = replace_shortcut(&app, &state, &shortcut);
    remember_shortcut_error(result.as_ref().err().cloned());
    result
}

fn replace_shortcut(
    app: &AppHandle,
    state: &QuickToolsShortcut,
    shortcut: &str,
) -> Result<(), String> {
    let next = if shortcut.trim().is_empty() {
        None
    } else {
        Some(super::capture::parse_shortcut(shortcut)?)
    };
    let _change = super::desktop_shortcut::SHORTCUT_CHANGES
        .lock()
        .map_err(|_| "快捷键状态不可用")?;
    let mut current = state.0.lock().map_err(|_| "快捷工具快捷键状态不可用")?;
    if *current == next {
        return Ok(());
    }
    if let Some(next) = next {
        if app.global_shortcut().is_registered(next) {
            return Err("快捷键与已有功能冲突，请更换组合键".into());
        }
        app.global_shortcut()
            .on_shortcut(next, |app, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(window) = app.get_webview_window("quick-tools") {
                    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
                    {
                        let _ = window.hide();
                        return;
                    }
                }
                capture_from_hotkey(app.clone());
            })
            .map_err(|_| "快捷工具快捷键已被占用，请更换组合键")?;
    }
    if let Some(previous) = *current {
        if app.global_shortcut().unregister(previous).is_err() {
            if let Some(next) = next {
                let _ = app.global_shortcut().unregister(next);
            }
            return Err("无法更换快捷工具快捷键，已保留原组合键".into());
        }
    }
    *current = next;
    Ok(())
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let prefs = tauri::async_runtime::spawn_blocking(|| {
            super::data::read_current("quick-tools-settings")
        })
        .await;
        let prefs = match prefs {
            Ok(Ok(prefs)) => prefs,
            _ => {
                remember_shortcut_error(Some(
                    "无法读取快捷工具设置，请在搜索设置中重新设置快捷键".into(),
                ));
                let _ = app.emit(
                    "quick-tools://shortcut-error",
                    "无法读取快捷工具设置，请在搜索设置中重新设置快捷键",
                );
                return;
            }
        };
        let shortcut = prefs
            .as_ref()
            .map(|v| v.get("state").unwrap_or(v))
            .and_then(|v| v.get("shortcut"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Ctrl+Alt+T")
            .to_owned();
        if let Err(error) =
            quick_tools_set_shortcut(app.clone(), app.state::<QuickToolsShortcut>(), shortcut).await
        {
            let _ = app.emit("quick-tools://shortcut-error", error);
        }
    });
}

#[tauri::command]
pub async fn quick_tools_open_main(app: AppHandle, route: String) -> Result<(), String> {
    if !allowed_route(&route) {
        return Err("无效快捷工具位置".into());
    }
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    super::sys::reveal(&main)?;
    main.emit("search://navigate", route)
        .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("quick-tools") {
        let _ = window.hide();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn startup_shortcut_error_is_readable_until_success_clears_it() {
        super::remember_shortcut_error(Some("shortcut conflict".into()));
        assert_eq!(
            super::quick_tools_shortcut_error().as_deref(),
            Some("shortcut conflict")
        );
        assert_eq!(
            super::quick_tools_shortcut_error().as_deref(),
            Some("shortcut conflict")
        );
        super::remember_shortcut_error(None);
        assert_eq!(super::quick_tools_shortcut_error(), None);
    }

    #[test]
    fn routes_allow_only_known_tools_or_ai_preferences_without_text_payloads() {
        for route in [
            "/tools",
            "/tools?tool=translate",
            "/tools?tool=naming",
            "/tools?tool=format",
            "/tools?tool=diagnose",
            "/tools?tool=regex",
            "/settings?tab=ai",
        ] {
            assert!(super::allowed_route(route), "{route}");
        }
        for route in [
            "/settings",
            "/tools?source=secret",
            "/tools?tool=translate&source=secret",
            "/tools?tool=unknown",
            "https://example.test",
            "/tools#secret",
            "/tools\n",
            "/plans",
        ] {
            assert!(!super::allowed_route(route), "{route}");
        }
    }
}
