use tauri::Manager;

mod commands;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::data::get_data_dir,
            commands::data::set_data_dir,
            commands::data::read_json,
            commands::data::write_json,
            commands::sys::window_ready,
            commands::sys::open_fence,
            commands::sys::close_fence,
            commands::sys::pick_folder,
            commands::sys::pick_file,
            commands::sys::open_path,
            commands::sys::reveal_in_explorer,
            commands::fs::probe_paths,
            commands::site::fetch_site_meta,
            commands::dragdrop::drag_out,
        ])
        .setup(|app| {
            tray::create(app)?;
            // 兜底：若前端 6s 内未调用 window_ready（JS 崩溃/页面加载失败），
            // 强制显示主窗口，避免"窗口永远不出现"的无声失败。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                if let Some(win) = handle.get_webview_window("main") {
                    match win.is_visible() {
                        Ok(false) => {
                            let _ = win.show();
                            eprintln!("[nimbusdesk] frontend did not signal ready in 6s; window force-shown");
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口关闭 = 隐藏到托盘；其他窗口（如设置）正常关闭销毁
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
