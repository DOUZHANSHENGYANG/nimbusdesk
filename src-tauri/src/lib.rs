use tauri::Manager;

mod atomic;
mod database;
mod project_database;
mod zentao;
mod task_attachments;
mod state_merge;
mod knowledge;
mod commands;
mod tray;
mod organization_clock;
mod search;
mod quick_tools;
mod agenthub;

/// Entry used by the executable before initializing any UI or background tasks.
pub fn run_quick_tools_selection_worker() -> bool { quick_tools::worker::run_if_worker() }

pub fn run_search_extract_worker() -> bool { search::extract_worker::run_if_worker() }

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
        .manage(commands::search::SearchShortcut::default())
        .manage(commands::quick_tools::QuickToolsShortcut::default())
        .manage(commands::dock::DockShortcut::default())
        .invoke_handler(tauri::generate_handler![
            commands::data::write_plan_pair,
            commands::data::project_apply_remote_binding,
            commands::dock::dock_open,
            commands::dock::dock_close,
            commands::dock::dock_spring,
            commands::dock::window_show_no_activate,
            commands::dock::window_set_bounds,
            commands::dock::window_set_no_activate,
            commands::dock::set_dock_shortcut,
            commands::dock::dock_set_autohide,
            commands::zentao::zentao_secret_status,
            commands::zentao::zentao_test_connection,
            commands::zentao::zentao_forget_secret,
            commands::zentao::zentao_fetch_tasks,
            commands::zentao::zentao_read_task,
            commands::zentao::zentao_write_task,
            commands::projects::project_create_root,
            commands::projects::project_list_files,
            commands::projects::project_read_file,
            commands::projects::project_write_text,
            commands::projects::project_create_entry,
            commands::projects::project_transfer_file,
            commands::projects::project_import_file,
            commands::projects::project_trash_file,
            commands::projects::project_open_file,
            commands::desktop::desktop_open_hub,
            commands::desktop::desktop_close_hub,
            commands::desktop::desktop_open_main,
            commands::desktop::desktop_wait_drag_end,
            commands::quick_tools::quick_tools_open_window,
            commands::quick_tools::quick_tools_selection,
            commands::quick_tools::quick_tools_set_shortcut,
            commands::quick_tools::quick_tools_shortcut_error,
            commands::quick_tools::quick_tools_open_main,
            commands::search::search_home,
            commands::search::search_pin,
            commands::search::search_clear_recent,
            commands::search::search_apps_status,
            commands::search::search_apps_refresh,
            commands::search::search_query,
            commands::search::search_everything_detect,
            commands::search::search_everything_start,
            commands::search::search_document_defaults,
            commands::search::search_index_pause,
            commands::search::search_status,
            commands::search::search_refresh,
            commands::search::search_open_window,
            commands::search::search_set_shortcut,
            commands::search::search_open_result,
            commands::search::search_preview,
            commands::fence_drop::move_fence_entries,
            commands::desktop_shortcut::set_fence_shortcut,
            commands::capture::open_capture,
            commands::capture::set_capture_shortcut,
            commands::ai::ai_save_secret,
            commands::ai::ai_has_secret,
            commands::ai::ai_delete_secret,
            commands::ai::ai_chat,
            commands::ai::ai_models,
            commands::ai::ai_fetch,
            commands::ai::ai_fetch_cancel,
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
            commands::directory_map::file_directory_snapshot,
            commands::fileops::create_entry,
            commands::fileops::rename_entry,
            commands::fileops::delete_entry,
            commands::fileops::delete_entries,
            commands::site::fetch_site_meta,
            commands::dragdrop::drag_out,
            commands::shellicon::native_icon,
            commands::fileops::ensure_dir,
            commands::shellicon::native_icons,
            commands::agenthub::tb_root,
            commands::agenthub::tb_root_reveal,
            commands::agenthub::tb_skill_list,
            commands::agenthub::tb_skill_read,
            commands::agenthub::tb_skill_save,
            commands::agenthub::tb_skill_create,
            commands::agenthub::tb_skill_delete,
            commands::agenthub::tb_skill_import,
            commands::agenthub::tb_skill_reveal,
            commands::agenthub::tb_prompt_list,
            commands::agenthub::tb_prompt_save,
            commands::agenthub::tb_prompt_delete,
            commands::agenthub::tb_prompt_restore,
            commands::agenthub::tb_skill_restore,
            commands::agenthub::tb_mcp_list,
            commands::agenthub::tb_mcp_save,
            commands::agenthub::tb_mcp_delete,
            commands::agenthub::tb_mcp_export,
            commands::agenthub::tb_harness_scan,
            commands::agenthub::tb_harness_collect,
            commands::agenthub::tb_harness_push,
            commands::agenthub::tb_harness_remove,
        ])
        .setup(|app| {
            tray::create(app)?;
            organization_clock::start(app.handle().clone())?;
            commands::search::start(app.handle().clone());
            commands::quick_tools::start(app.handle().clone());
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
                } else if window.label() == "search" || window.label() == "quick-tools" {
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
