//! 窗口/系统交互命令。
//! 可能阻塞的命令一律 async + spawn_blocking，避免卡主线程。

use tauri::AppHandle;
use tauri::Manager;

/// Only the main workbench has a developer-mode preference. Keep the native
/// editing menu available while gating its Inspect item and debug shortcuts.
#[tauri::command]
pub async fn set_developer_mode(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Developer mode is only available in the main window".into());
    }
    if !enabled {
        window.close_devtools();
    }
    #[cfg(windows)]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        window.with_webview(move |webview| {
            // These are the app's own WebView2 settings, accessed on its UI thread.
            let result = unsafe {
                webview.controller().CoreWebView2()
                    .and_then(|view| view.Settings())
                    .and_then(|settings| settings.SetAreDevToolsEnabled(enabled))
            }.map_err(|error| error.to_string());
            let _ = sender.send(result);
        }).map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| error.to_string())?
        }).await.map_err(|error| error.to_string())??;
    }
    Ok(())
}

/// 前端首帧渲染完成后调用：显示调用方窗口（防白闪，主窗/设置窗通用）。
#[tauri::command]
pub fn window_ready(window: tauri::Window) -> Result<(), String> {
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 打开某分类的桌面栅栏窗口；已存在则聚焦。
#[tauri::command]
pub async fn open_fence(
    app: AppHandle,
    category_id: String,
    title: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let label = format!("fence-{category_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .position(x as f64, y as f64)
        .inner_size(w as f64, h as f64)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_bottom(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭某分类的栅栏窗口（不存在则忽略）。
#[tauri::command]
pub async fn close_fence(app: AppHandle, category_id: String) -> Result<(), String> {
    let label = format!("fence-{category_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}

/// 打开某日的桌面待办纸片窗口；已存在则聚焦。
///
/// 与 open_fence 共用同一套窗口参数（无边框/透明/置底/不进任务栏）。
/// 之所以是独立命令而不是给 open_fence 加参数：两者有各自的 label 前缀与
/// 默认行为（纸片默认贴左、栅栏默认居中），把差异塞进一个命令会让
/// 「栅栏」和「纸片」在类型上消失，调用方只能靠字符串区分。
#[tauri::command]
pub async fn open_todo_paper(
    app: AppHandle,
    date: String,
    title: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let label = format!("todo-{date}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .position(x as f64, y as f64)
        .inner_size(w as f64, h as f64)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        /*
         * 刻意**不**在这里设 always_on_bottom：层级改由前端按形态显式决定
         * （纸片默认压底、贴边胶囊置顶）。
         *
         * 因为 tao 在 WM_WINDOWPOSCHANGING 里有这么一段：
         *     if window_flags.contains(ALWAYS_ON_BOTTOM) { pos.hwndInsertAfter = HWND_BOTTOM }
         * 窗口只要还带着这个标记，**每次位置变化都会被强制塞回底部** ——
         * 于是 setAlwaysOnTop(true) 只生效一瞬就被推翻；而滑出动画一秒要改十几次位置，
         * 更是一路压到底。实测症状极具迷惑性：窗口能显示、能穿透、位置尺寸全对，
         * 只是 z 序紧贴 Program Manager、ex 样式里永远没有 WS_EX_TOPMOST。
         * 前端用 setAlwaysOnBottom(true/false) 显式设置同一标记则没有这个副作用。
         */
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 关闭某日的待办纸片窗口（不存在则忽略）。
#[tauri::command]
pub async fn close_todo_paper(app: AppHandle, date: String) -> Result<(), String> {
    let label = format!("todo-{date}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}

/// 当前已打开的待办纸片日期列表（启动时恢复用）。
#[tauri::command]
pub async fn list_todo_papers(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .webview_windows()
        .keys()
        .filter_map(|label| label.strip_prefix("todo-").map(|s| s.to_string()))
        .collect())
}

/// 弹出菜单窗口的 label（全局唯一，复用一个窗口，避免反复创建 WebView）。
const POPUP_LABEL: &str = "popup-menu";

/// 取菜单浮窗，不存在则创建（隐藏状态）。
///
/// 必须先创建、再发「渲染菜单」事件：事件只能投递给已存在的 WebView，
/// 若等到拿到尺寸才创建窗口，首次打开时事件会丢失 —— 菜单永远不显示。
/// 窗口创建后前端会自行渲染并注册监听，打开方等 ready 事件再发菜单数据。
fn ensure_popup(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(POPUP_LABEL) {
        return Ok(win);
    }
    tauri::WebviewWindowBuilder::new(
        app,
        POPUP_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("menu")
    .position(0.0, 0.0)
    .inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())
}

/// 预创建菜单浮窗（保持隐藏）。打开方在发菜单数据前调用，等浮窗 ready。
#[tauri::command]
pub async fn prepare_popup_menu(app: AppHandle) -> Result<(), String> {
    ensure_popup(&app).map(|_| ())
}

/// 显示右键菜单浮窗。
///
/// 菜单必须能溢出栅栏窗口边界，而 WebView 内的 DOM 无法超出自身窗口，
/// 因此菜单单独用一个无边框、置顶、跳过任务栏的小窗口承载（与原生 TrackPopupMenu 同理）。
/// 坐标按逻辑像素传入（前端用的是 CSS 像素），内部换算到屏幕物理坐标。
#[tauri::command]
pub async fn show_popup_menu(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    // 光标位置 = 屏幕物理像素；据此找到所在显示器以换算 scaleFactor
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|e| e.to_string())?;
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

    // 逻辑 → 物理
    let mut px = (x * scale).round();
    let mut py = (y * scale).round();
    let pw = (w * scale).round().max(1.0);
    let ph = (h * scale).round().max(1.0);

    // 夹到工作区内，避免菜单超出屏幕（与 Windows 弹出菜单一致）
    if let Some(m) = monitor.as_ref() {
        let wa = m.work_area();
        let left = wa.position.x as f64;
        let top = wa.position.y as f64;
        let right = left + wa.size.width as f64;
        let bottom = top + wa.size.height as f64;
        if px + pw > right {
            px = (right - pw).max(left);
        }
        if py + ph > bottom {
            py = (bottom - ph).max(top);
        }
        px = px.max(left);
        py = py.max(top);
    }

    let win = ensure_popup(&app)?;
    win.set_size(tauri::PhysicalSize::new(pw, ph))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::PhysicalPosition::new(px, py))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    // 取焦点：这样点到别处会让浮窗失焦，浮窗据此自动关闭（原生菜单行为）
    let _ = win.set_focus();
    Ok(())
}

/// 关闭菜单浮窗（不存在则忽略）。
#[tauri::command]
pub async fn hide_popup_menu(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(POPUP_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}
/// 系统文件夹选择对话框（OS 级，仅用于数据目录/文件路径选择）。
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 系统文件选择对话框（OS 级，用于添加文件条目）。
#[tauri::command]
pub async fn pick_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .blocking_pick_file()
            .map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 用系统默认方式打开路径（文件/文件夹/URL）。
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 在资源管理器中显示该项。
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}
