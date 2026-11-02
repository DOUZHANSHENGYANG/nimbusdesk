//! 文件/文件夹路径探测（拖入栅栏时判定类型与名称；删除前估风险与缓存元信息）。

use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathKind {
    pub path: String,
    /// "folder" | "file" | "missing"
    pub kind: String,
    pub name: String,
}

#[tauri::command]
pub async fn probe_paths(paths: Vec<String>) -> Result<Vec<PathKind>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .iter()
            .map(|p| {
                let kind = match fs::metadata(p) {
                    Ok(m) if m.is_dir() => "folder",
                    Ok(_) => "file",
                    Err(_) => "missing",
                };
                let name = std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                PathKind {
                    path: p.clone(),
                    kind: kind.to_string(),
                    name,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 条目元信息：删除风险分级与「映射盒」的缓存都靠它。
///
/// 目录**不递归统计大小**（`size` 为 `None`）—— 一个几百 GB 的目录递归一遍会让
/// 删除确认框卡住好几秒。调用方按「目录本身就值得二次确认」处理。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMeta {
    pub path: String,
    /// "folder" | "file" | "missing"
    pub kind: String,
    pub name: String,
    /// 文件字节数；目录或缺失为 None
    pub size: Option<u64>,
    /// 修改时间（epoch 毫秒）
    pub modified: Option<u64>,
}

#[tauri::command]
pub async fn path_meta(paths: Vec<String>) -> Result<Vec<PathMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .iter()
            .map(|p| {
                let meta = fs::metadata(p).ok();
                let kind = match &meta {
                    Some(m) if m.is_dir() => "folder",
                    Some(_) => "file",
                    None => "missing",
                };
                let name = std::path::Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                let size = match &meta {
                    Some(m) if m.is_file() => Some(m.len()),
                    _ => None,
                };
                let modified = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                PathMeta {
                    path: p.clone(),
                    kind: kind.to_string(),
                    name,
                    size,
                    modified,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}
