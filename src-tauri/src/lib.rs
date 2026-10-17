use tauri::Manager;

mod atomic;
mod database;
mod task_attachments;
mod state_merge;
mod knowledge;
mod commands;
mod tray;
mod organization_clock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(commands::capture::CaptureShortcut::default())
        .manage(commands::desktop_shortcut::FenceShortcut::default())
        .invoke_handler(tauri::generate_handler![
            commands::fence_drop::move_fence_entries,
            commands::desktop_shortcut::set_fence_shortcut,
            commands::capture::open_capture,
            commands::capture::set_capture_shortcut,
            commands::ai::ai_save_secret,
            commands::ai::ai_has_secret,
            commands::ai::ai_delete_secret,
            commands::ai::ai_chat,
            commands::ai::ai_models,
            commands::ai::ai_finalize_legacy_migration,
            commands::knowledge::knowledge_bind,
            commands::knowledge::knowledge_validate_folders,
            commands::knowledge::knowledge_captures,
            commands::knowledge::knowledge_scan,
            commands::knowledge::knowledge_templates,
            commands::knowledge::knowledge_search,
            commands::knowledge::knowledge_read,
            commands::knowledge::knowledge_update,
            commands::knowledge::knowledge_capture,
            commands::knowledge::knowledge_archive,
            commands::knowledge::knowledge_organize,
            commands::knowledge::knowledge_image,
            commands::data::get_data_dir,
            commands::data::set_data_dir,
            commands::backup::pick_backup_save_path,
            commands::backup::pick_backup_open_path,
            commands::backup::write_backup,
            commands::backup::read_backup,
            commands::backup::scan_dir_tree,
            commands::backup::restore_dir_tree,
            commands::data::read_json,
            commands::task_attachments::task_attachments_add,
            commands::task_attachments::task_attachment_location,
            commands::task_attachments::task_attachments_export,
            commands::task_attachments::task_attachments_import,
            commands::data::write_json,
            commands::sys::window_ready,
            commands::sys::set_developer_mode,
            commands::sys::open_fence,
            commands::sys::close_fence,
            commands::sys::open_todo_paper,
            commands::sys::close_todo_paper,
            commands::sys::list_todo_papers,
            commands::sys::pick_folder,
            commands::sys::pick_file,
            commands::sys::open_path,
            commands::sys::reveal_in_explorer,
            commands::sys::show_popup_menu,
            commands::sys::hide_popup_menu,
            commands::sys::prepare_popup_menu,
            commands::fs::probe_paths,
            commands::fileops::create_entry,
            commands::fileops::rename_entry,
            commands::fileops::delete_entry,
            commands::fileops::delete_entries,
            commands::site::fetch_site_meta,
            commands::dragdrop::drag_out,
            commands::shellicon::native_icon,
            commands::fileops::ensure_dir,
            commands::shellicon::native_icons,
        ])
        .setup(|app| {
            tray::create(app)?;
            organization_clock::start(app.handle().clone())?;
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
                } else if window.label() == "capture" {
                    // The capture frontend flushes its draft before hiding the window.
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
