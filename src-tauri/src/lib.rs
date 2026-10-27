use tauri::Manager;

mod atomic;
mod database;
mod files_table;
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
mod schedule;
mod display;
// AgentHub（源侧工具箱后端）原样搬进来的模块，独立在 ahub/ 下。
mod ahub;

/// Entry used by the executable before initializing any UI or background tasks.
pub fn run_quick_tools_selection_worker() -> bool { quick_tools::worker::run_if_worker() }

pub fn run_search_extract_worker() -> bool { search::extract_worker::run_if_worker() }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须第一个注册：第二次双击图标时不再开一个「窗口藏着」的新进程，
        // 而是把已有主窗口亮出来 —— 否则用户点图标既看不到窗口也看不到任务栏按钮。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = crate::commands::sys::reveal(&win);
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            commands::notifications::system_notifications,
            commands::notifications::open_notification_settings,
            commands::dock::dock_set_enabled,
            commands::dock::dock_set_click_through,
            commands::dock::shell_launch,
            commands::dock::dock_spring,
            commands::stash::stash_import,
            commands::capture_window::window_capture,
            commands::stash::stash_delete,
            commands::dock::dock_spring_box,
            commands::dock::dock_spring_to,
            commands::dock::window_show_no_activate,
            commands::dock::window_set_bounds,
            commands::dock::window_set_no_activate,
            commands::dock::input_session_begin,
            commands::dock::input_session_end,
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
            commands::schedule::schedule_snapshot,
            commands::schedule::schedule_save,
            commands::schedule::schedule_delete,
            commands::schedule::schedule_set_enabled,
            commands::schedule::schedule_clear_history,
            commands::schedule::schedule_run_now,
            commands::schedule::schedule_preview,
            commands::schedule::schedule_action_result,
            commands::backup::pick_backup_save_path,
            commands::backup::pick_backup_open_path,
            commands::backup::write_backup,
            commands::backup::read_backup,
            commands::backup::scan_dir_tree,
            commands::backup::restore_dir_tree,
            commands::data::read_json,
            commands::data::files_load,
            commands::data::files_apply,
            commands::task_attachments::task_attachments_add,
            commands::task_attachments::task_attachment_location,
            commands::task_attachments::task_attachments_export,
            commands::task_attachments::task_attachments_import,
            commands::data::write_json,
            commands::sys::window_ready,
            ahub::commands::scope_get,
            ahub::commands::scope_set,
            ahub::commands::log_append,
            ahub::commands::log_tail,
            display::display_list,
            display::display_resolve,
            commands::sys::set_main_always_on_top,
            commands::sys::set_developer_mode,
            commands::sys::open_fence,
            commands::sys::close_fence,
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
            // ── AgentHub 原版命令（129 条，与源侧 invoke_handler 逐条一致）──
            ahub::commands::add_skill_source_dir,
            ahub::commands::ai_provider_create,
            ahub::commands::ai_provider_delete,
            ahub::commands::ai_provider_list,
            ahub::commands::ai_provider_presets,
            ahub::commands::ai_provider_set_default,
            ahub::commands::ai_provider_set_enabled,
            ahub::commands::ai_provider_test,
            ahub::commands::ai_provider_update,
            ahub::commands::ai_suggest_tags,
            ahub::commands::apply_to_harness,
            ahub::commands::auth_create_repo,
            ahub::commands::auth_github_poll,
            ahub::commands::auth_github_start,
            ahub::commands::auth_logout,
            ahub::commands::auth_save_pat,
            ahub::commands::auth_status,
            ahub::commands::check_pack_ready,
            ahub::commands::check_upstream,
            ahub::commands::cleanup_git_temp,
            ahub::commands::clear_skill_versions,
            ahub::commands::cli_explain,
            ahub::commands::cli_explain_versions,
            ahub::commands::cli_scan,
            ahub::commands::cli_tldr_clear,
            ahub::commands::cli_tldr_ensure,
            ahub::commands::cli_tldr_status,
            ahub::commands::delete_mcp,
            ahub::commands::delete_prompt,
            ahub::commands::delete_skill,
            ahub::commands::disk_scan,
            ahub::commands::disk_scan_cached,
            ahub::commands::ensure_skill_protocol,
            ahub::commands::export_mcp_config,
            ahub::commands::get_env_root,
            ahub::commands::get_settings,
            ahub::commands::git_fetch_skills,
            ahub::commands::ignore_all_vet_findings,
            ahub::commands::import_from_harness,
            ahub::commands::import_skill_folder,
            ahub::commands::import_skill_zip,
            ahub::commands::install_from_index,
            ahub::commands::install_skillpack,
            ahub::commands::install_tool,
            ahub::commands::list_mcp,
            ahub::commands::list_prompts,
            ahub::commands::list_skill_files,
            ahub::commands::list_skills,
            ahub::commands::merge_harness_config,
            ahub::commands::mirror_apply,
            ahub::commands::mirror_list,
            ahub::commands::mirror_plan,
            ahub::commands::mirror_rollback,
            ahub::commands::onboard_skills_batch,
            ahub::commands::ahub_open_path,
            ahub::commands::open_skill_file,
            ahub::commands::pack_skill,
            ahub::commands::pack_skills_batch,
            ahub::commands::parse_prompt_vars,
            ahub::commands::parse_skill_index,
            ahub::commands::pre_import,
            ahub::commands::preset_create,
            ahub::commands::preset_delete,
            ahub::commands::preset_export,
            ahub::commands::preset_list,
            ahub::commands::mcp_preset_list,
            ahub::commands::mcp_preset_create,
            ahub::commands::mcp_preset_update,
            ahub::commands::mcp_preset_delete,
            ahub::commands::preset_update,
            ahub::commands::preview_skill_dir,
            ahub::commands::read_harness_config,
            ahub::commands::read_import_file,
            ahub::commands::read_skill,
            ahub::commands::read_skill_file,
            ahub::commands::read_vet_report,
            ahub::commands::release_skill_version,
            ahub::commands::remove_from_harness,
            ahub::commands::remove_prompt_var,
            ahub::commands::remove_skill_source_dir,
            ahub::commands::rename_prompt_var,
            ahub::commands::render_prompt_vars,
            ahub::commands::repair_skill_tags,
            ahub::commands::restore_path_backup,
            ahub::commands::reveal_path,
            ahub::commands::review_vet_finding,
            ahub::commands::save_mcp,
            ahub::commands::save_prompt,
            ahub::commands::save_skill,
            ahub::commands::scan_harnesses,
            ahub::commands::scan_harness,
            ahub::commands::seed_skill_version,
            ahub::commands::set_auto_summary_on_import,
            ahub::commands::ahub_set_data_dir,
            ahub::commands::set_env_root,
            ahub::commands::set_harness_order,
            ahub::commands::set_prefs,
            ahub::commands::set_skill_status,
            ahub::commands::set_vet_review,
            ahub::commands::skill_extension,
            ahub::commands::skill_generate_summary,
            ahub::commands::skill_generate_summary_batch,
            ahub::commands::skill_import_abort,
            ahub::commands::skill_import_ai_fix,
            ahub::commands::skill_import_apply_fixes,
            ahub::commands::skill_import_cleanup,
            ahub::commands::skill_import_execute,
            ahub::commands::skill_import_explore,
            ahub::commands::skillhub_categories,
            ahub::commands::skillhub_install,
            ahub::commands::skillhub_search,
            ahub::commands::storage_stats,
            ahub::commands::sync_pull,
            ahub::commands::sync_push,
            ahub::commands::sync_set_remote,
            ahub::commands::sync_status,
            ahub::commands::test_mcp_connectivity,
            ahub::commands::tool_check_latest,
            ahub::commands::tool_list,
            ahub::commands::tool_update,
            ahub::commands::update_skill_ext,
            ahub::commands::validate_prompt_var_name,
            ahub::commands::vault_clear,
            ahub::commands::vault_index,
            ahub::commands::vault_installed_count,
            ahub::commands::vault_maybe_daily,
            ahub::commands::vault_read_version,
            ahub::commands::vault_restore,
            ahub::commands::vault_set_daily,
            ahub::commands::vault_set_watched,
            ahub::commands::vault_snapshot,
            ahub::commands::vault_status,
            ahub::commands::vet_skill,
            ahub::commands::write_harness_config,
        ])
        .setup(|app| {
            // 主窗口必须有图标，否则任务栏按钮上是一块空白：窗口是隐藏创建、稍后 show 的，
            // 不显式 set_icon 就没人给它 WM_SETICON（托盘那份是单独设的，所以托盘一直好看）。
            // dev 下也能拿到 —— default_window_icon() 来自 tauri.conf.json 的 bundle.icon。
            if let (Some(icon), Some(win)) = (app.default_window_icon().cloned(), app.get_webview_window("main")) {
                let _ = win.set_icon(icon);
            }
            tray::create(app)?;
            organization_clock::start(app.handle().clone())?;
            schedule::engine::start(app.handle().clone());
            commands::search::start(app.handle().clone());
            commands::quick_tools::start(app.handle().clone());
            // 多屏热插拔监听：显示器接拔/改分辨率时广播 display://changed，
            // 桌面挂件（dock/fence/快速收集）据此重算自己的位置
            display::start_watch(app.handle().clone());
            // 顶置自愈（P4）：被任务栏/开始菜单压住时把 dock 抬回最上层
            commands::dock::start_topmost_watch(app.handle().clone(), "desktop-dock");
            // AgentHub 原版启动清理：把 ZIP 的 DOS 纪元哨兵时间戳（1980-01-01）改写为
            // 可信时间。与源侧同一段代码、同样放后台线程、同样幂等。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let root = ahub::store::data_root(&handle).join("skills");
                    let n = ahub::store::normalize_epoch_times(&root);
                    if n > 0 {
                        eprintln!("[agenthub] 已把 {n} 个文件的 DOS 纪元时间戳改写为可信时间");
                    }
                });
            }
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
