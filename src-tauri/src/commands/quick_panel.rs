//! 「快速面板」：一个快捷键呼出所有收纳盒，支持多 pane 并排。
//!
//! 与搜索窗/快捷工具窗同一套窗口生命周期：隐藏创建、前端挂载后
//! `window_ready()` 显示；关闭只 hide，不销毁，这样热键再按是即时的。
//! 快捷键注册沿用 `desktop_shortcut::SHORTCUT_CHANGES` 串行化，避免与
//! 搜索/快捷工具/Dock 同时改键时互相踩。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct QuickPanelShortcut(pub Mutex<Option<Shortcut>>);

static SHORTCUT_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn remember_shortcut_error(error: Option<String>) {
    if let Ok(mut current) = SHORTCUT_ERROR.lock() {
        *current = error;
    }
}

#[tauri::command]
pub fn quick_panel_shortcut_error() -> Option<String> {
    SHORTCUT_ERROR.lock().ok().and_then(|current| current.clone())
}

fn browser_args(app: &AppHandle) -> Option<String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.clone())
}

#[tauri::command]
pub async fn quick_panel_open_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick-panel") {
        window.center().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "quick-panel",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("快速面板 · 云台")
    .inner_size(1060.0, 680.0)
    .min_inner_size(720.0, 460.0)
    .center()
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .background_color(tauri::window::Color(16, 16, 20, 255));
    if let Some(args) = browser_args(&app) {
        builder = builder.additional_browser_args(&args);
    }
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn replace_shortcut(
    app: &AppHandle,
    state: &QuickPanelShortcut,
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
    let mut current = state.0.lock().map_err(|_| "快速面板快捷键状态不可用")?;
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
                if let Some(window) = app.get_webview_window("quick-panel") {
                    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
                        let _ = window.hide();
                        return;
                    }
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = quick_panel_open_window(app).await;
                });
            })
            .map_err(|_| "快速面板快捷键已被占用，请更换组合键")?;
    }
    if let Some(previous) = *current {
        if let Err(error) = app.global_shortcut().unregister(previous) {
            if let Some(next) = next {
                let _ = app.global_shortcut().unregister(next);
            }
            return Err(error.to_string());
        }
    }
    *current = next;
    remember_shortcut_error(None);
    Ok(())
}

#[tauri::command]
pub async fn set_quick_panel_shortcut(
    app: AppHandle,
    state: State<'_, QuickPanelShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let result = replace_shortcut(&app, &state, &shortcut);
    remember_shortcut_error(result.as_ref().err().cloned());
    result
}

/// 启动时从 settings.json 读取快捷键。settings 是 zustand persist 结构，
/// 真正的字段在 `state` 下；老版本没有这个键时用默认值。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let settings = tauri::async_runtime::spawn_blocking(|| {
            super::data::read_current("settings")
        })
        .await;
        let Ok(Ok(Some(value))) = settings else { return };
        let shortcut = value
            .get("state")
            .unwrap_or(&value)
            .get("quickPanelShortcut")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Ctrl+Shift+Space")
            .to_owned();
        if let Err(error) =
            set_quick_panel_shortcut(app.clone(), app.state::<QuickPanelShortcut>(), shortcut).await
        {
            remember_shortcut_error(Some(error.clone()));
            let _ = app.emit("quick-panel://shortcut-error", error);
        }
    });
}
