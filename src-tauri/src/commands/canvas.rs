//! ThoughtDAG 画布的内置资源与本地会话读取命令。
//!
//! 画布页面由前端 `public/thoughtdag/` 直接同源加载，不再启动本地 Node 服务。
//! 这里只保留本机会话文件读取和“新窗口打开”两个职责。
use std::path::PathBuf;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRoot {
    key: String,
    path: String,
    builtin: bool,
    exists: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEntry {
    rel: String,
    size: u64,
    mtime: i64,
}

#[tauri::command]
pub fn canvas_open_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(window) = app.get_webview_window("canvas-window") {
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "canvas-window", WebviewUrl::App("index.html#/canvas".into()))
        .title("ThoughtDAG")
        .inner_size(1200.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .build()
        .map(|_| ())
        .map_err(|e| format!("打开画布窗口失败: {e}"))
}

fn root_dir(key: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match key {
        "claude-projects" => Some(home.join(".claude").join("projects")),
        "codex-sessions" => Some(home.join(".codex").join("sessions")),
        "dsh-sessions" => Some(home.join(".dsh").join("sessions")),
        _ => None,
    }
}

fn safe_path_in(root: &std::path::Path, rel: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let relative = std::path::Path::new(rel);
    if relative.components().any(|part| {
        matches!(
            part,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err("会话路径越界".into());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("会话根不可用: {e}"))?;
    let joined = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("会话文件不可用: {e}"))?;
    if !canonical.starts_with(&root) {
        return Err("会话路径越界".into());
    }
    Ok(canonical)
}

fn safe_path(key: &str, rel: &str) -> Result<PathBuf, String> {
    let root = root_dir(key).ok_or_else(|| format!("未知的会话根: {key}"))?;
    safe_path_in(&root, rel)
}

#[tauri::command]
pub fn canvas_session_roots() -> Vec<CanvasRoot> {
    ["claude-projects", "codex-sessions", "dsh-sessions"]
        .into_iter()
        .filter_map(|key| {
            let path = root_dir(key)?;
            Some(CanvasRoot {
                key: key.into(),
                path: path.to_string_lossy().into_owned(),
                builtin: true,
                exists: path.exists(),
            })
        })
        .collect()
}

fn walk(root: &std::path::Path, current: &std::path::Path, depth: usize, out: &mut Vec<CanvasEntry>) {
    if depth == 0 || out.len() >= 5000 { return; }
    let Ok(entries) = std::fs::read_dir(current) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false) {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, depth - 1, out);
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue; };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
        out.push(CanvasEntry { rel, size: meta.len(), mtime });
    }
}

#[tauri::command]
pub fn canvas_session_list(root_key: String) -> Result<Vec<CanvasEntry>, String> {
    let root = root_dir(&root_key).ok_or_else(|| format!("未知的会话根: {root_key}"))?;
    let mut out = Vec::new();
    walk(&root, &root, 4, &mut out);
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

fn read_text(key: &str, rel: &str) -> Result<String, String> {
    let path = safe_path(key, rel)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("读取会话失败: {e}"))?;
    let bytes = if path.extension().and_then(|s| s.to_str()) == Some("zstd") {
        crate::sessions::adapter::dsh::decode_zstd_frames(&bytes)?
    } else {
        bytes
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn canvas_session_read(root_key: String, rel: String) -> Result<String, String> {
    read_text(&root_key, &rel)
}

#[tauri::command]
pub fn canvas_session_head(root_key: String, rel: String, bytes: Option<usize>) -> Result<String, String> {
    let text = read_text(&root_key, &rel)?;
    let limit = bytes.unwrap_or(65536);
    Ok(text.chars().take(limit).collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRange {
    text: String,
    next_start: usize,
    eof: bool,
}

#[tauri::command]
pub fn canvas_session_read_range(root_key: String, rel: String, start: usize, length: usize) -> Result<CanvasRange, String> {
    let text = read_text(&root_key, &rel)?;
    let chars: Vec<char> = text.chars().collect();
    let end = (start + length).min(chars.len());
    Ok(CanvasRange {
        text: chars[start.min(chars.len())..end].iter().collect(),
        next_start: end,
        eof: end >= chars.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_rejects_absolute_and_parent_escapes() {
        let tmp = std::env::temp_dir().join(format!("nimbus-canvas-safe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("ok.jsonl"), "{}").unwrap();
        assert!(safe_path_in(&tmp, "ok.jsonl").is_ok());
        assert!(safe_path_in(&tmp, "../outside").is_err());
        assert!(safe_path_in(&tmp, "C:\\Users\\dz\\.ssh\\id_rsa").is_err());
        assert!(safe_path_in(&tmp, "/etc/passwd").is_err());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    #[ignore = "reads local harness sessions"]
    fn dsh_root_reads_a_session() {
        let entries = canvas_session_list("dsh-sessions".into()).unwrap();
        let Some(entry) = entries.iter().find(|e| e.rel.ends_with(".jsonl.zstd")) else { return; };
        let text = canvas_session_read("dsh-sessions".into(), entry.rel.clone()).unwrap();
        assert!(text.contains("\"type\""));
    }
}
