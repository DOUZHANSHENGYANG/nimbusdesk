//! 文件/文件夹路径探测（拖入栅栏时判定类型与名称）。

use serde::Serialize;
use std::fs;

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
