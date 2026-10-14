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
