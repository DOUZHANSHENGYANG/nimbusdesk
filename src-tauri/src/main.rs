// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if tauri_app_lib::run_quick_tools_selection_worker() { return; }
    if tauri_app_lib::run_search_extract_worker() { return; }
    tauri_app_lib::run()
}
