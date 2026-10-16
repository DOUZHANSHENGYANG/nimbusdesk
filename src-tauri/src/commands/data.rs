//! 数据目录解析与 JSON 持久化。
//!
//! 目录优先级（绿色/便携优先）：
//! 1. 指针文件（`data.dir`，位于 exe 目录或 %APPDATA%/nimbusdesk）指向的自定义目录
//! 2. exe 同级 `data/`（可写时）
//! 3. %APPDATA%/nimbusdesk（兜底）
//!
//! 所有命令均为 async + spawn_blocking：Tauri 2 同步命令跑在主线程，
//! 阻塞 IO 会卡死 UI 事件循环。

use crate::atomic::{read_file_with_fallback, write_file_atomic};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const APP_DIR_NAME: &str = "nimbusdesk";
const POINTER_FILE: &str = "data.dir";

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
    let probe = path.join(".write-test");
    match fs::File::create(&probe) {
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

/// 解析当前数据目录（不创建）。
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
    // 优先 exe 旁（随 exe 迁移），失败则写 APPDATA
    if let Ok(exe) = exe_dir() {
        let p = exe.join(POINTER_FILE);
        if fs::write(&p, &content).is_ok() {
            return Ok(p.display().to_string());
        }
    }
    let appdata = appdata_dir()?;
    ensure_dir(&appdata)?;
    let p = appdata.join(POINTER_FILE);
    fs::write(&p, &content).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

fn data_file(key: &str) -> Result<PathBuf, String> {
    // key 只允许字母数字下划线连字符，防目录穿越
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid data key: {key}"));
    }
    let dir = resolve_data_dir()?;
    Ok(dir.join(format!("{key}.json")))
}

/// 读取 JSON。主文件不存在返回 `None`；主文件损坏/丢失时回退 `.bak` 自愈。
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
    let target = PathBuf::from(new_dir.trim());
    if target.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    ensure_dir(&target)?;
    if !is_writable_dir(&target) {
        return Err(format!("not writable: {}", target.display()));
    }
    let old = resolve_data_dir()?;
    let mut migrated: Vec<String> = Vec::new();
    if old != target {
        if let Ok(entries) = fs::read_dir(&old) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("json") {
                    let dest = target.join(entry.file_name());
                    if fs::copy(&p, &dest).is_ok() {
                        migrated.push(entry.file_name().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    let pointer = write_pointer(&target)?;
    Ok(serde_json::json!({
        "dataDir": target.display().to_string(),
        "pointerFile": pointer,
        "migrated": migrated,
    }))
}

fn blocking_read_json(key: String) -> Result<Option<Value>, String> {
    let path = data_file(&key)?;
    read_file(&path)
}

fn blocking_write_json(key: String, value: Value) -> Result<(), String> {
    let path = data_file(&key)?;
    write_file(&path, &value)
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

#[command]
pub async fn write_json(key: String, value: Value) -> Result<(), String> {
    blocking(move || blocking_write_json(key, value)).await?
}
