//! 窗口/系统交互命令。
//! 可能阻塞的命令一律 async + spawn_blocking，避免卡主线程。

use tauri::AppHandle;
use tauri::Manager;

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
