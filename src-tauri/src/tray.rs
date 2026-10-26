//! 系统托盘：显示/隐藏主窗口、退出。
//! 菜单文案跟随 SQLite settings 的 lang（缺省 zh）。

use crate::commands::data::read_current;
use tauri::{Emitter, Manager};
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
    let tools = MenuItem::with_id(app,"quick-tools",if lang=="en"{"Quick tools"}else{"快捷工具"},true,None::<&str>)?;
    let desktop_show = MenuItem::with_id(app, "desktop-show", if lang == "en" { "Show desktop windows" } else { "显示桌面窗口" }, true, None::<&str>)?;
    let desktop_hide = MenuItem::with_id(app, "desktop-hide", if lang == "en" { "Hide desktop windows" } else { "隐藏桌面窗口" }, true, None::<&str>)?;
    let desktop_fold = MenuItem::with_id(app, "desktop-fold", if lang == "en" { "Fold desktop windows" } else { "收起桌面窗口" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &search, &capture, &tools, &desktop_show, &desktop_hide, &desktop_fold, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(app_name)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "capture" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::capture::open_capture(app, None, None).await;
                });
            }
            "search" => {
                let app=app.clone();tauri::async_runtime::spawn(async move{let _=crate::commands::search::search_open_window(app).await;});
            }
            "quick-tools" => { let app=app.clone();tauri::async_runtime::spawn(async move { let _=crate::commands::quick_tools::quick_tools_open_window(app).await; }); }
            "desktop-show" => { let _ = app.emit("desktop://recall-all", ()); }
            "desktop-hide" => { let _ = app.emit("desktop://hide-all", ()); }
            "desktop-fold" => { let _ = app.emit("desktop://fold-all", ()); }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => toggle_main(tray.app_handle()),
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                    let _ = tray.app_handle().emit("desktop://recall-all", ());
                }
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 托盘点击该收起还是该亮出主窗口。
///
/// 最小化的窗口 `is_visible()` 仍然返回 true —— 按「可见」处理会把窗口直接
/// `hide()`，用户看到的是窗口从任务栏消失（「打不开主界面」）；而且被隐藏时
/// 最小化状态还留着，下一次 `show()` 又只能回到最小化。所以最小化一律按
/// 「不在用户面前」处理。
fn should_hide(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let minimized = win.is_minimized().unwrap_or(false);
        if should_hide(visible, minimized) {
            let _ = win.hide();
        } else {
            let _ = crate::commands::sys::reveal(&win);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::should_hide;

    #[test]
    fn minimized_main_window_is_revealed_not_hidden() {
        assert!(should_hide(true, false), "可见且未最小化 → 收起");
        assert!(!should_hide(true, true), "最小化的窗口必须亮出来，不能 hide");
        assert!(!should_hide(false, true), "隐藏且最小化 → 亮出来");
        assert!(!should_hide(false, false), "不可见 → 亮出来");
    }
}
