//! 便携数据目录解析、SQLite 状态与兼容 JSON 命令。
//!
//! 目录优先级（绿色/便携优先）：
//! 1. 指针文件（`data.dir`，位于 exe 目录或 %APPDATA%/nimbusdesk）指向的自定义目录
//! 2. exe 同级 `data/`（可写时）
//! 3. %APPDATA%/nimbusdesk（兜底）
//!
//! 所有命令均为 async + spawn_blocking：Tauri 2 同步命令跑在主线程，
//! 阻塞 IO 会卡死 UI 事件循环。

use crate::atomic::{read_file_with_fallback, write_file_atomic};
use crate::database;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const APP_DIR_NAME: &str = "nimbusdesk";
const POINTER_FILE: &str = "data.dir";
static DATA_IO: Mutex<()> = Mutex::new(());
static PROBE_ID: AtomicU64 = AtomicU64::new(0);

/// Resolve under the same lock as relocation so callers cannot write the old
/// directory after its verified snapshot has been published.
pub fn with_data_dir<T>(operation: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let _guard = DATA_IO.lock().map_err(|_| "data directory lock poisoned")?;
    operation(&resolve_data_dir()?)
}

fn appdata_dir() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA").map_err(|_| "APPDATA not found".to_string())?;
    Ok(PathBuf::from(base).join(APP_DIR_NAME))
}

fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "no parent of exe".to_string())
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

fn is_writable_dir(path: &Path) -> bool {
    let probe = path.join(format!(
        ".nimbusdesk-write-check-{}-{}",
        std::process::id(),
        PROBE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(mut f) => {
            let ok = f.write_all(b"ok").is_ok();
            drop(f);
            let _ = fs::remove_file(&probe);
            ok
        }
        Err(_) => false,
    }
}

fn valid_pointer(path: &Path) -> bool {
    path.is_dir() && is_writable_dir(path)
}

/// 按便携优先策略解析数据目录，必要时创建默认目录。
pub fn resolve_data_dir() -> Result<PathBuf, String> {
    let appdata = appdata_dir()?;
    // 1a. %APPDATA%/nimbusdesk/data.dir
    if let Ok(content) = fs::read_to_string(appdata.join(POINTER_FILE)) {
        let p = PathBuf::from(content.trim());
        if valid_pointer(&p) {
            return Ok(p);
        }
    }
    // 1b. exe 旁 data.dir
    if let Ok(exe) = exe_dir() {
        if let Ok(content) = fs::read_to_string(exe.join(POINTER_FILE)) {
            let p = PathBuf::from(content.trim());
            if valid_pointer(&p) {
                return Ok(p);
            }
        }
        // 2. 便携 exe 旁 data/
        let portable = exe.join("data");
        if ensure_dir(&portable).is_ok() && is_writable_dir(&portable) {
            return Ok(portable);
        }
    }
    // 3. %APPDATA% 兜底
    ensure_dir(&appdata)?;
    if !is_writable_dir(&appdata) {
        return Err(format!("data dir not writable: {}", appdata.display()));
    }
    Ok(appdata)
}

fn write_pointer(target: &Path) -> Result<String, String> {
    let content = target.to_string_lossy().to_string();
    let appdata = appdata_dir()?;
    // Existing APPDATA pointers have resolver priority, so update that pointer
    // rather than leaving a stale higher-priority value after moving the data.
    let preferred = appdata.join(POINTER_FILE);
    if preferred.exists() {
        write_file_atomic(&preferred.to_string_lossy(), content.as_bytes())
            .map_err(|e| e.to_string())?;
        return Ok(preferred.display().to_string());
    }
    if let Ok(exe) = exe_dir() {
        let p = exe.join(POINTER_FILE);
        if write_file_atomic(&p.to_string_lossy(), content.as_bytes()).is_ok() {
            return Ok(p.display().to_string());
        }
    }
    ensure_dir(&appdata)?;
    let p = appdata.join(POINTER_FILE);
    write_file_atomic(&p.to_string_lossy(), content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// 仅用于旧 AI 迁移文件；读取失败时尝试 `.bak`，JSON 解析失败显式报错。
fn read_file<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let text = match read_file_with_fallback(&path.to_string_lossy()) {
        Ok(s) => s,
        // 主文件与 .bak 都不存在 → 该 key 还没写过，不是错误
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

/// 原子写 JSON：tmp → fsync → .bak → rename（见 `crate::atomic`）。
fn write_file<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_file_atomic(&path.to_string_lossy(), content.as_bytes()).map_err(|e| e.to_string())
}
fn blocking_get_data_dir() -> Result<String, String> {
    resolve_data_dir().map(|p| p.display().to_string())
}

fn blocking_set_data_dir(new_dir: String) -> Result<Value, String> {
    let _guard = DATA_IO.lock().map_err(|_| "data directory lock poisoned")?;
    let target = PathBuf::from(new_dir.trim());
    if target.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    database::reject_link_components(&target)?;
    ensure_dir(&target)?;
    if !is_writable_dir(&target) {
        return Err(format!("not writable: {}", target.display()));
    }
    let old = resolve_data_dir()?;
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    let migrated = database::snapshot_to(&old, &target)?;
    let pointer = write_pointer(&target)?;
    Ok(serde_json::json!({
        "dataDir": target.display().to_string(),
        "pointerFile": pointer,
        "migrated": migrated,
    }))
}

fn blocking_read_json(key: String) -> Result<Option<Value>, String> {
    read_current(&key)
}

/// Native readers share the same SQLite authority as frontend persistence.
pub fn read_current(key: &str) -> Result<Option<Value>, String> {
    database::validate_key(key)?;
    with_data_dir(|root| {
        if key == "ai-settings" {
            read_file(&root.join("ai-settings.json"))
        } else {
            database::read_at(root, key)
        }
    })
}

#[derive(Deserialize)]
pub struct ExpectedState {
    pub value: Value,
}

fn blocking_write_json(
    key: String,
    value: Value,
    base: Option<ExpectedState>,
) -> Result<Value, String> {
    database::validate_key(&key)?;
    with_data_dir(|root| {
        if key == "ai-settings" {
            write_file(&root.join("ai-settings.json"), &value)?;
            Ok(value)
        } else if let Some(base) = base {
            database::write_with_base_at(root, &key, &value, &base.value)
        } else {
            database::write_at(root, &key, &value)?;
            Ok(value)
        }
    })
}

async fn blocking<T>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task join error: {e}"))
}

use tauri::command;

#[command]
pub async fn get_data_dir() -> Result<String, String> {
    blocking(blocking_get_data_dir).await?
}

#[command]
pub async fn set_data_dir(new_dir: String) -> Result<Value, String> {
    blocking(move || blocking_set_data_dir(new_dir)).await?
}

#[command]
pub async fn read_json(key: String) -> Result<Option<Value>, String> {
    blocking(move || blocking_read_json(key)).await?
}

/// `files` 行级表的读取入口（见 `crate::files_table`）。
#[command]
pub async fn files_load() -> Result<Value, String> {
    blocking(|| {
        with_data_dir(|root| {
            let conn = database::open_at(root)?;
            crate::files_table::ensure_schema(&conn)?;
            crate::files_table::load(&conn)
        })
    })
    .await?
}

/// 应用一份增量：只有真正变了的实体进来，写一条就是一条 UPDATE。
#[command]
pub async fn files_apply(delta: Value) -> Result<(), String> {
    blocking(move || {
        with_data_dir(|root| {
            let mut conn = database::open_at(root)?;
            crate::files_table::ensure_schema(&conn)?;
            crate::files_table::apply(&mut conn, &delta)
        })
    })
    .await?
}

#[command]
pub async fn write_json(
    key: String,
    value: Value,
    base: Option<ExpectedState>,
) -> Result<Value, String> {
    let searchable = crate::search::sources_key(&key);
    let refresh_files = key == "search-settings" || key == "knowledge-settings";
    let result = blocking(move || blocking_write_json(key, value, base)).await?;
    if result.is_ok() && searchable {
        crate::search::runtime::request_refresh();
    }
    if result.is_ok() && refresh_files {
        crate::search::file_runtime::request_refresh();
    }
    result
}

/// Archive/restore changes both plan envelopes and their link indexes under one
/// SQLite writer transaction, while sharing the relocation directory lock.
#[command]
pub async fn write_plan_pair(
    plans: Value,
    archive: Value,
    base_plans: Value,
    base_archive: Value,
) -> Result<Value, String> {
    let result = blocking(move || {
        with_data_dir(|root| {
            let (plans, archive) = database::write_plan_pair_with_base_at(
                root,
                &plans,
                &archive,
                &base_plans,
                &base_archive,
            )?;
            Ok(serde_json::json!({ "plans": plans, "archive": archive }))
        })
    })
    .await?;
    if result.is_ok() {
        crate::search::runtime::request_refresh();
    }
    result
}

/// A binding/merge must publish all dependent envelopes together, including
/// archived descendants. Resolve the root while holding the relocation lock.
#[command]
pub async fn project_apply_remote_binding(
    projects: Value,
    plans: Value,
    archive: Value,
    base_projects: Value,
    base_plans: Value,
    base_archive: Value,
) -> Result<Value, String> {
    let result = blocking(move || {
        with_data_dir(|root| {
            let (projects, plans, archive) = database::write_project_binding_with_base_at(
                root,
                &projects,
                &plans,
                &archive,
                &base_projects,
                &base_plans,
                &base_archive,
            )?;
            Ok(serde_json::json!({ "projects": projects, "plans": plans, "archive": archive }))
        })
    })
    .await?;
    if result.is_ok() {
        crate::search::runtime::request_refresh();
    }
    result
}
