use crate::search::{self, ContentIndex, SearchHit, runtime};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
#[derive(Default)]
pub struct SearchShortcut(pub Mutex<Option<Shortcut>>);
#[tauri::command]
pub async fn search_set_shortcut(
    app: AppHandle,
    state: State<'_, SearchShortcut>,
    shortcut: String,
) -> Result<(), String> {
    let next = if shortcut.trim().is_empty() {
        None
    } else {
        Some(super::capture::parse_shortcut(&shortcut)?)
    };
    let _change = super::desktop_shortcut::SHORTCUT_CHANGES
        .lock()
        .map_err(|_| "快捷键状态不可用")?;
    let mut current = state.0.lock().map_err(|_| "搜索快捷键状态不可用")?;
    if *current == next {
        return Ok(());
    }
    if let Some(next) = next {
        if app.global_shortcut().is_registered(next) {
            return Err("快捷键与已有功能冲突，请更换组合键".into());
        }
        app.global_shortcut()
            .on_shortcut(next, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("search") {
                        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                            let _ = w.hide();
                            return;
                        }
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = search_open_window(app).await;
                    });
                }
            })
            .map_err(|_| "搜索快捷键被其他应用占用，请更换组合键")?;
    }
    if let Some(previous) = *current {
        if let Err(error) = app.global_shortcut().unregister(previous) {
            if let Some(next) = next {
                let _ = app.global_shortcut().unregister(next);
            }
            return Err(error.to_string());
        }
    }
    *current = next;
    runtime::set_shortcut_error(None);
    Ok(())
}
pub fn start(app: AppHandle) {
    runtime::start(app.clone());
    search::file_runtime::start(app.clone());
    search::apps::start(app.clone());
    let startup_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = runtime::preferences();
        if prefs
            .get("everythingAutoStart")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            let resources = startup_app.path().resource_dir().ok();
            let result = search::everything_app::start(
                prefs
                    .get("everythingPath")
                    .and_then(serde_json::Value::as_str),
                resources.as_deref(),
                prefs
                    .get("everythingInstance")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            );
            search::everything_app::remember_start(&result);
            let _ = startup_app.emit("search://status", runtime::status());
            search::file_runtime::request_refresh();
        }
    });
    tauri::async_runtime::spawn(async move {
        let settings = match tauri::async_runtime::spawn_blocking(|| {
            super::data::read_current("search-settings")
        })
        .await
        {
            Ok(Ok(v)) => v,
            _ => return,
        };
        let shortcut = settings
            .as_ref()
            .map(|v| v.get("state").unwrap_or(v))
            .and_then(|s| s.get("shortcut"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Ctrl+Alt+K")
            .to_owned();
        if let Err(error) =
            search_set_shortcut(app.clone(), app.state::<SearchShortcut>(), shortcut).await
        {
            runtime::set_shortcut_error(Some(error.clone()));
            let _ = app.emit("search://shortcut-error", error);
        }
    });
}
#[tauri::command]
pub async fn search_open_window(app: AppHandle) -> Result<(), String> {
    runtime::request_refresh();
    if let Some(w) = app.get_webview_window("search") {
        w.center().map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        let _ = w.emit("search://focus", ());
        return Ok(());
    }
    let args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "search",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("搜索 · 云台")
    .inner_size(760.0, 560.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .disable_drag_drop_handler()
    .background_color(tauri::window::Color(16, 16, 20, 255));
    if let Some(args) = args {
        builder = builder.additional_browser_args(&args);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn search_status() -> Result<runtime::SearchStatus, String> {
    tauri::async_runtime::spawn_blocking(runtime::status)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn search_refresh() {
    runtime::request_refresh();
    search::file_runtime::request_refresh();
}
#[tauri::command]
pub fn search_apps_status() -> search::apps::AppStatus {
    search::apps::status()
}
#[tauri::command]
pub fn search_apps_refresh() {
    search::apps::refresh();
}
#[tauri::command]
pub async fn search_document_defaults() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(search::file_runtime::defaults)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn search_index_pause(paused: bool) {
    search::file_runtime::pause(paused);
}
#[tauri::command]
pub async fn search_everything_detect(
    app: AppHandle,
    path: Option<String>,
    instance: Option<String>,
) -> Result<search::everything_app::EverythingStatus, String> {
    let resources = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = runtime::preferences();
        let path = path.as_deref().or_else(|| {
            prefs
                .get("everythingPath")
                .and_then(serde_json::Value::as_str)
        });
        let instance = instance
            .as_deref()
            .or_else(|| {
                prefs
                    .get("everythingInstance")
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or("");
        search::everything_app::detect(path, resources.as_deref(), instance)
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn search_everything_start(
    app: AppHandle,
    path: Option<String>,
    instance: Option<String>,
) -> Result<search::everything_app::EverythingStatus, String> {
    let resources = app.path().resource_dir().ok();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let prefs = runtime::preferences();
        let path = path.as_deref().or_else(|| {
            prefs
                .get("everythingPath")
                .and_then(serde_json::Value::as_str)
        });
        let instance = instance
            .as_deref()
            .or_else(|| {
                prefs
                    .get("everythingInstance")
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or("");
        let result = search::everything_app::start(path, resources.as_deref(), instance);
        search::everything_app::remember_start(&result);
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    search::file_runtime::request_refresh();
    Ok(result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReply {
    results: Vec<SearchHit>,
    total: usize,
    indexing: bool,
    warnings: Vec<String>,
    elapsed_ms: u64,
}
#[tauri::command]
pub async fn search_query(
    query: String,
    scope: Option<String>,
    limit: Option<usize>,
    include_files: Option<bool>,
) -> Result<SearchReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let scope = scope.unwrap_or_else(|| "all".into());
        let limit = limit.unwrap_or(60).min(100);
        if query.len() > 4096 || query.chars().any(char::is_control) {
            return Err("搜索词过长或包含控制字符".into());
        }
        if !["all", "app", "file", "plan", "knowledge", "feed"].contains(&scope.as_str()) {
            return Err("无效搜索分类".into());
        }
        let mut results = vec![];
        let mut warnings = vec![];
        let preferences = runtime::preferences();
        let pinyin = preferences
            .get("pinyinEnabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        if scope != "file" && scope != "app" {
            match super::data::with_data_dir(|root| {
                ContentIndex::open(root)?.query_with_pinyin(&query, &scope, limit, pinyin)
            }) {
                Ok(hits) => results = hits,
                Err(error) => warnings.push(error),
            }
        }
        if scope == "all" || scope == "app" {
            match search::apps::query(&query, limit) {
                Ok(hits) => results.extend(hits),
                Err(error) => warnings.push(error),
            }
        }
        if scope == "all" || scope == "file" {
            match search::file_runtime::query(&query, limit) {
                Ok(hits) => results.extend(hits),
                Err(error) => warnings.push(error),
            }
        }
        if (scope == "all" && include_files.unwrap_or(true)) || scope == "file" {
            let settings = runtime::preferences();
            let backend = settings
                .get("fileBackend")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("auto");
            let instance = settings
                .get("everythingInstance")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let (_, ipc, ready, error) = search::everything_app::probe(instance);
            if backend != "windows" && (!ipc || ready != Some(true)) {
                let reason = error.unwrap_or_else(|| {
                    if ipc {
                        "Everything 正在建立索引"
                    } else {
                        "Everything 未运行"
                    }
                    .into()
                });
                warnings.push(if backend == "everything" {
                    reason
                } else {
                    format!("{reason}；文件搜索使用 Windows 索引，仅覆盖系统已收录的位置")
                });
            }
            match search::files::query_filtered(&query, limit, backend, instance, settings.get("hideNoisyResults").and_then(serde_json::Value::as_bool).unwrap_or(true)) {
                Ok(hits) => results.extend(hits),
                Err(error) => warnings.push(error),
            }
        }
        results.sort_by(search::compare_hits);
        let mut seen = std::collections::HashSet::new();
        results.retain(|h| {
            let key = if h.kind == "file" || h.kind == "folder" {
                h.path
                    .as_ref()
                    .map(|p| format!("path:{}", search::path_identity(p)))
                    .unwrap_or_else(|| h.id.clone())
            } else {
                h.id.clone()
            };
            seen.insert(key)
        });
        results.truncate(limit);
        Ok(SearchReply {
            total: results.len(),
            results,
            indexing: {
                let files=search::file_runtime::status();
                runtime::is_indexing() || files.running || files.name_running || search::apps::status().indexing
            },
            warnings,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn allowed_route(route: &str) -> bool {
    if route.chars().any(char::is_control) || route.contains('\\') {
        return false;
    }
    ["/plans", "/knowledge", "/feeds", "/files"]
        .contains(&route.split('?').next().unwrap_or_default())
}
#[tauri::command]
pub async fn search_open_result(
    app: AppHandle,
    result: SearchHit,
    action: String,
) -> Result<(), String> {
    if action != "open" && action != "reveal" {
        return Err("无效搜索操作".into());
    }
    let opened = (action == "open").then(|| result.clone());
    if result.kind == "app" {
        let id = result.id;
        tauri::async_runtime::spawn_blocking(move || {
            if action == "reveal" { search::apps::reveal(&id) } else { search::apps::launch(&id) }
        }).await.map_err(|e| e.to_string())??;
    } else if action == "reveal" {
        let path = result.path.ok_or("该条目没有本地路径")?;
        if !std::path::Path::new(&path).is_absolute() {
            return Err("文件路径无效".into());
        }
        super::sys::reveal_in_explorer(path).await?;
    } else if ["file", "folder"].contains(&result.kind.as_str()) {
        let path = result.path.ok_or("缺少文件路径")?;
        if !std::path::Path::new(&path).is_absolute() || !std::path::Path::new(&path).exists() {
            return Err("文件已移动、删除或磁盘离线，请重新搜索".into());
        }
        super::sys::open_path(path).await?;
    } else {
        let route = result.route.ok_or("缺少工作台位置")?;
        if !allowed_route(&route) {
            return Err("无效工作台位置".into());
        }
        let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
        main.show().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
        main.emit("search://navigate", route)
            .map_err(|e| e.to_string())?;
    }
    if let Some(result) = opened {
        // Successful activation stays successful even when local history storage fails.
        let saved = tauri::async_runtime::spawn_blocking(move || search::personalization::opened(result)).await;
        match saved {
            Ok(Ok(home)) => { runtime::set_history_error(None); let _ = app.emit("search://home", home); }
            _ => { runtime::set_history_error(Some("最近使用保存失败，可在存储恢复后重试".into())); }
        }
        let _ = app.emit("search://status", runtime::status());
    }
    if let Some(w) = app.get_webview_window("search") { let _ = w.hide(); }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPreview {
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
}
#[tauri::command]
pub async fn search_preview(path: String) -> Result<SearchPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let path = std::path::Path::new(&path);
        if !path.is_absolute() {
            return Err("预览路径无效".into());
        }
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let mut result = SearchPreview {
            kind: "unsupported".into(),
            text: None,
            data_url: None,
        };
        if !metadata.is_file() {
            return Ok(result);
        }
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            _ => None,
        };
        if let Some(mime) = mime {
            if metadata.len() > 5 * 1024 * 1024 {
                return Err("图片预览上限 5 MiB".into());
            }
            use base64::Engine;
            let mut bytes = vec![];
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(5 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 5 * 1024 * 1024 {
                return Err("图片预览上限 5 MiB".into());
            }
            result.kind = "image".into();
            result.data_url = Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ));
        } else if [
            "md", "txt", "rs", "ts", "tsx", "js", "jsx", "json", "jsonc", "css", "html", "xml",
            "yaml", "yml", "toml", "py", "java", "cpp", "c", "h", "sql", "log", "csv", "ini",
            "conf", "sh", "ps1",
        ]
        .contains(&ext.as_str())
        {
            let mut bytes = vec![];
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(128 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            result.kind = "text".into();
            result.text = Some(String::from_utf8_lossy(&bytes).into_owned());
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    #[test]
    fn search_routes_only_target_workbench_content() {
        for route in [
            "/plans?date=2026-10-18&task=1",
            "/knowledge?note=a.md",
            "/feeds?article=https%3A%2F%2Fa.test",
            "/files?item=1",
        ] {
            assert!(super::allowed_route(route));
        }
        for route in [
            "https://evil.test",
            "//evil.test",
            "/knowledge/../../settings",
            "/settings",
            "/plans\\x",
            "/plans\n",
        ] {
            assert!(!super::allowed_route(route));
        }
    }
}

#[tauri::command]
pub async fn search_home() -> Result<search::personalization::Home,String> {
    tauri::async_runtime::spawn_blocking(search::personalization::home).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn search_pin(app:AppHandle,result:SearchHit,pinned:bool)->Result<search::personalization::Home,String>{
    let home=tauri::async_runtime::spawn_blocking(move||search::personalization::pin(result,pinned)).await.map_err(|e|e.to_string())??;
    let _=app.emit("search://home",&home);Ok(home)
}
#[tauri::command]
pub async fn search_clear_recent(app:AppHandle)->Result<search::personalization::Home,String>{
    let home=tauri::async_runtime::spawn_blocking(search::personalization::clear_recent).await.map_err(|e|e.to_string())??;
    let _=app.emit("search://home",&home);Ok(home)
}
