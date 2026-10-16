//! 真实磁盘文件操作：新建 / 重命名 / 删除（回收站）。
//! 全部 async + spawn_blocking，避免阻塞主线程。

use crate::commands::newfile;

use std::path::{Path, PathBuf};

/// Windows 文件名非法字符 + 保留名校验。
fn validate_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("empty-name".into());
    }
    if n == "." || n == ".." {
        return Err("invalid-name".into());
    }
    if n.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        return Err("invalid-name".into());
    }
    if n.chars().any(|c| (c as u32) < 0x20) {
        return Err("invalid-name".into());
    }
    // 结尾的 . 或空格在 Windows 上会被静默剥离，直接拒绝更明确
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("invalid-name".into());
    }
    let stem = n.split('.').next().unwrap_or(n).to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err("reserved-name".into());
    }
    Ok(())
}

/// 在 parent_dir 下新建文件夹或空文件，返回创建出的绝对路径。
/// kind: "folder" | "file"
#[tauri::command]
pub async fn create_entry(
    parent_dir: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_name(&name)?;
        let parent = PathBuf::from(parent_dir.trim());
        if !parent.is_dir() {
            return Err("parent-missing".into());
        }
        let target = parent.join(name.trim());
        if target.exists() {
            return Err("already-exists".into());
        }
        let created = if kind == "folder" {
            std::fs::create_dir(&target).map_err(|e| e.to_string())?;
            target
        } else {
            // 无扩展名时按 Windows「新建文本文档」的习惯补 .txt
            let file_target = if target.extension().is_none() {
                parent.join(format!("{}.txt", name.trim()))
            } else {
                target
            };
            if file_target.exists() {
                return Err("already-exists".into());
            }
            // 按扩展名决定初始内容：Office/图片/压缩包写入真实模板，
            // 纯文本保持 0 字节。详见 newfile.rs 的取值顺序。
            let payload = newfile::payload_for(&file_target.to_string_lossy());
            match payload {
                Some(bytes) => {
                    std::fs::write(&file_target, bytes).map_err(|e| e.to_string())?;
                }
                None => {
                    std::fs::File::create(&file_target).map_err(|e| e.to_string())?;
                }
            }
            file_target
        };
        Ok(created.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 重命名磁盘上的条目（同目录内改名），返回新路径。
#[tauri::command]
pub async fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_name(&new_name)?;
        let src = PathBuf::from(path.trim());
        if !src.exists() {
            return Err("not-found".into());
        }
        let parent = src.parent().ok_or_else(|| "no-parent".to_string())?;
        let dst = parent.join(new_name.trim());
        if dst == src {
            return Ok(src.to_string_lossy().to_string());
        }
        if dst.exists() {
            return Err("already-exists".into());
        }
        std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
        Ok(dst.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 删除到系统回收站（可撤销），不直接抹除。
#[tauri::command]
pub async fn delete_entry(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = Path::new(path.trim());
        if !p.exists() {
            return Err("not-found".into());
        }
        to_recycle_bin(&[path.trim().to_string()])
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 批量删除到回收站（一次调用，回收站里合并为一次可撤销操作）。
#[tauri::command]
pub async fn delete_entries(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let valid: Vec<String> = paths
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| Path::new(p).exists())
            .collect();
        if valid.is_empty() {
            return Err("not-found".into());
        }
        to_recycle_bin(&valid)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 确保目录存在（递归创建）。用于「全局根目录 + 分类子目录」自动就位。
#[tauri::command]
pub async fn ensure_dir(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(path.trim());
        if p.as_os_str().is_empty() {
            return Err("empty-path".into());
        }
        if p.is_dir() {
            return Ok(p.to_string_lossy().to_string());
        }
        if p.exists() {
            return Err("not-a-dir".into());
        }
        std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        Ok(p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

/// 用 Shell 的 SHFileOperationW + FOF_ALLOWUNDO 走回收站。
#[cfg(windows)]
fn to_recycle_bin(paths: &[String]) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, SHFILEOPSTRUCTW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, FO_DELETE,
    };

    // pFrom 需要「每个路径以 \0 结尾，整体再补一个 \0」
    let mut buf: Vec<u16> = Vec::new();
    for p in paths {
        buf.extend(p.encode_utf16());
        buf.push(0);
    }
    buf.push(0);

    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(buf.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16,
        ..Default::default()
    };

    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("shell-error-{code}"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("aborted".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn to_recycle_bin(_paths: &[String]) -> Result<(), String> {
    Err("unsupported-platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建目录（测试用，避免依赖 tempfile）
    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nimbusdesk-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("建临时目录");
        d
    }

    /// 回归：新建 Office 文件必须落盘真实模板，不能是 0 字节空壳。
    /// 这是「双击 .docx 报文件已损坏」的直接原因。
    #[test]
    fn create_entry_writes_office_template_bytes() {
        let dir = temp_dir("office");
        for (name, min_bytes) in [
            ("新建 Word 文档.docx", 500),
            ("新建 Excel 工作表.xlsx", 500),
            ("新建 PowerPoint 演示文稿.pptx", 500),
        ] {
            let out = tauri::async_runtime::block_on(create_entry(
                dir.to_string_lossy().to_string(),
                name.to_string(),
                "file".to_string(),
            ))
            .unwrap_or_else(|e| panic!("{name} 创建失败: {e}"));

            let size = std::fs::metadata(&out).expect("文件应存在").len();
            assert!(
                size >= min_bytes,
                "{name} 只有 {size} 字节，仍是空壳（应 >= {min_bytes}）"
            );

            // OOXML 是 zip 容器：头两字节必须是 PK
            let head = std::fs::read(&out).expect("可读");
            assert_eq!(&head[..2], b"PK", "{name} 不是有效 OOXML 容器");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 纯文本仍应是空文件，且无扩展名时自动补 .txt（Windows 习惯）。
    #[test]
    fn create_entry_keeps_text_empty_and_appends_txt() {
        let dir = temp_dir("text");

        let out = tauri::async_runtime::block_on(create_entry(
            dir.to_string_lossy().to_string(),
            "新建文本文档.txt".to_string(),
            "file".to_string(),
        ))
        .expect("创建 txt");
        assert_eq!(std::fs::metadata(&out).unwrap().len(), 0, "txt 应为空");

        let bare = tauri::async_runtime::block_on(create_entry(
            dir.to_string_lossy().to_string(),
            "无扩展名".to_string(),
            "file".to_string(),
        ))
        .expect("创建无扩展名文件");
        assert!(
            bare.ends_with(".txt"),
            "无扩展名应补 .txt，实际 {bare}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件夹仍然是文件夹，不受模板逻辑影响。
    #[test]
    fn create_entry_folder() {
        let dir = temp_dir("folder");
        let out = tauri::async_runtime::block_on(create_entry(
            dir.to_string_lossy().to_string(),
            "新文件夹".to_string(),
            "folder".to_string(),
        ))
        .expect("建文件夹");
        assert!(Path::new(&out).is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
