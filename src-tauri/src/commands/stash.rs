//! 存储收纳盒：拖进来的文件**移动**进应用自己的 stash，而不是留个引用。
//!
//! 落点固定为 <数据目录>/stash/<分类 id>/ —— 跟数据目录一起搬走，换机器能带走。
//! 只在这个分类的 kind = storage 时由前端调用；快捷盒与映射盒永不走这里。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 同名时依次尝试 name (2).ext、name (3).ext…，绝不覆盖已有文件。
fn unique_target(dir: &Path, name: &OsString) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let raw = name.to_string_lossy();
    let (stem, ext) = match raw.rfind('.') {
        Some(index) if index > 0 => (raw[..index].to_string(), raw[index..].to_string()),
        _ => (raw.to_string(), String::new()),
    };
    for n in 2..10_000 {
        let next = dir.join(format!("{stem} ({n}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem} (overflow){ext}"))
}

/// 跨盘 rename 会失败，退化成「复制后删源」。目录要递归。
fn move_path(src: &Path, dst: &Path) -> Result<(), String> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        copy_dir(src, dst)?;
        std::fs::remove_dir_all(src).map_err(|e| format!("已复制但删不掉原目录：{e}"))
    } else {
        std::fs::copy(src, dst).map_err(|e| e.to_string())?;
        std::fs::remove_file(src).map_err(|e| format!("已复制但删不掉原文件：{e}"))
    }
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 把一批路径移动进存储盒，返回新的绝对路径（顺序与入参一致）。
#[tauri::command]
pub async fn stash_import(category_id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    // 分类 id 会直接做目录名：只放行 [A-Za-z0-9_-]，挡住 .. 这类穿越
    if category_id.is_empty()
        || !category_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("分类 id 不合法".into());
    }
    let root = crate::commands::data::resolve_data_dir()?
        .join("stash")
        .join(&category_id);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let mut moved = Vec::with_capacity(paths.len());
    for path in paths {
        let src = PathBuf::from(&path);
        if !src.exists() {
            return Err(format!("找不到这个路径：{path}"));
        }
        let name = src
            .file_name()
            .ok_or_else(|| format!("路径没有文件名：{path}"))?
            .to_owned();
        let target = unique_target(&root, &name);
        move_path(&src, &target)?;
        moved.push(target.to_string_lossy().to_string());
    }
    Ok(moved)
}
