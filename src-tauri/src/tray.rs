//! 系统托盘：显示/隐藏主窗口、退出。
//! 菜单文案跟随 settings.json 的 lang（缺省 zh）。

use crate::commands::data::resolve_data_dir;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

fn read_lang() -> String {
    resolve_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("state").and_then(|s| s.get("lang")).cloned())
        .or_else(|| {
            // zustand persist 也可能直接平铺（无 version 包裹）
            resolve_data_dir()
                .ok()
                .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("lang").cloned())
        })
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "zh".into())
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let lang = read_lang();
    let (app_name, label_toggle, label_quit) = if lang == "en" {
        ("NimbusDesk", "Show / Hide NimbusDesk", "Quit")
    } else {
        ("云台", "显示 / 隐藏 云台", "退出")
    };

    let toggle = MenuItem::with_id(app, "toggle", label_toggle, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", label_quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(app_name)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
