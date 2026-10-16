//! 备份 / 恢复的文件 IO。
//!
//! 这里**只做 IO，不做合并**：合并规则要知道各个 store 的数据形状
//! （plans 的 days 是「日期 → 任务数组」、files 是「categories + items」），
//! 放在前端 `src/features/settings/backup.ts` 更贴近数据、也更好测。
//!
//! 全部 async + spawn_blocking：Tauri 2 的同步命令跑在主线程，阻塞 IO 会卡死 UI。

use crate::atomic::write_file_atomic;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExport {
    /// 实际写出的文件路径
    pub path: String,
    /// 写入字节数（用户据此判断是否包含了目录结构）
    pub bytes: u64,
}

/// 弹出「另存为」对话框选备份文件路径。默认文件名带日期，便于区分多份备份。
#[tauri::command]
pub async fn pick_backup_save_path(app: tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter("NimbusDesk backup", &["json"])
            .blocking_save_file()
            .map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 弹出「打开」对话框选一个备份文件。
#[tauri::command]
pub async fn pick_backup_open_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .add_filter("NimbusDesk backup", &["json"])
            .blocking_pick_file()
            .map(|p| p.to_string()))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 原子写出备份文件（大文件也不会写一半）。
#[tauri::command]
pub async fn write_backup(path: String, content: String) -> Result<BackupExport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_file_atomic(&path, content.as_bytes()).map_err(|e| e.to_string())?;
        Ok(BackupExport {
            path: path.clone(),
            bytes: content.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 读入备份文件原文（解析与校验交给前端，便于给出带字段路径的错误）。
#[tauri::command]
pub async fn read_backup(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
        // 上限 64MB：备份是纯文本，超过这个量级几乎肯定是选错了文件
        const MAX: u64 = 64 * 1024 * 1024;
        if meta.len() > MAX {
            return Err(format!("file too large: {} bytes", meta.len()));
        }
        std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 扫描一个目录，返回**相对路径**列表（只含目录，按字典序）。
///
/// 备份里只记目录结构、不记文件内容：分类目录下可能是几个 GB 的实际文件，
/// 塞进备份既不现实也没必要 —— 用户真正会丢的是「分类树长什么样」。
#[tauri::command]
pub async fn scan_dir_tree(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&root);
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut out: Vec<String> = Vec::new();
        collect_dirs(&base, &base, &mut out, 0);
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 递归收集子目录（不含 root 自身）。深度上限 8 层，防异常目录结构打爆栈。
fn collect_dirs(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth >= 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
        collect_dirs(root, &path, out, depth + 1);
    }
}

/// 恢复时按备份里的相对路径重建目录（已存在则跳过）。
/// 返回实际新建的目录数。
#[tauri::command]
pub async fn restore_dir_tree(root: String, dirs: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = PathBuf::from(&root);
        std::fs::create_dir_all(&base).map_err(|e| format!("{}: {e}", base.display()))?;
        let mut made = 0usize;
        for rel in dirs {
            // 防御：备份文件可能被手工改过，拒绝任何逃出 root 的路径
            if rel.split('/').any(|seg| seg == ".." || seg.is_empty()) || rel.contains('\\') {
                continue;
            }
            let target = base.join(&rel);
            if target.is_dir() {
                continue;
            }
            if std::fs::create_dir_all(&target).is_ok() {
                made += 1;
            }
        }
        Ok(made)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}
