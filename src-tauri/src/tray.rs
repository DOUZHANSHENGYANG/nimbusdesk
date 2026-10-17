//! 系统托盘：显示/隐藏主窗口、退出。
//! 菜单文案跟随 SQLite settings 的 lang（缺省 zh）。

use crate::commands::data::read_current;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

fn read_lang() -> Result<String, String> {
    let settings = read_current("settings")?;
    Ok(settings
        .as_ref()
        .and_then(|v| v.get("state").unwrap_or(v).get("lang"))
        .and_then(|v| v.as_str())
        .unwrap_or("zh")
        .to_owned())
}

pub fn create(app: &tauri::App) -> tauri::Result<()> {
    let lang = read_lang().map_err(std::io::Error::other)?;
    let (app_name, label_toggle, label_capture, label_quit) = if lang == "en" {
        (
            "NimbusDesk",
            "Show / Hide NimbusDesk",
            "Quick capture",
            "Quit",
        )
    } else {
        ("云台", "显示 / 隐藏 云台", "快速收集", "退出")
    };

    let toggle = MenuItem::with_id(app, "toggle", label_toggle, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", label_quit, true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", label_capture, true, None::<&str>)?;
    let search = MenuItem::with_id(app,"search",if lang=="en"{"Search"}else{"搜索"},true,None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &search, &capture, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(app_name)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "capture" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::capture::open_capture(app).await;
                });
            }
            "search" => {
                let app=app.clone();tauri::async_runtime::spawn(async move{let _=crate::commands::search::search_open_window(app).await;});
            }
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
