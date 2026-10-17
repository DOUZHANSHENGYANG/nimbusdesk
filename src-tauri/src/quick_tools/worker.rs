//! Isolated UIA access: providers cannot block the Tauri process indefinitely.
use super::selection::{self, CaptureTarget, MAX_SELECTION_CHARS};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

const WORKER_ARG: &str = "--quick-tools-selection-worker";
const MAX_REQUEST_BYTES: usize = 1024;
const MAX_REPLY_BYTES: usize = MAX_SELECTION_CHARS * 6 + 4096;
const DEADLINE: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize)]
struct Reply {
    text: Option<String>,
    error: Option<String>,
}

pub fn extract(target: CaptureTarget, cancel: &AtomicBool) -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|_| "无法启动选区读取，请手动粘贴")?;
    let request = serde_json::to_vec(&target).map_err(|_| "选区读取请求无效，请手动粘贴")?;
    let mut command = Command::new(executable);
    command.arg(WORKER_ARG);
    let bytes = crate::search::extract_worker::run_child(
        command,
        &request,
        cancel,
        DEADLINE,
        MAX_REPLY_BYTES,
    )
    .map_err(|error| {
        // Keep diagnostics static: selected text never appears in logs/errors.
        if error.contains("超时") {
            "选区读取超时，已停止读取进程，请手动粘贴"
        } else if error.contains("取消") {
            "选区读取已被更新的呼出替代"
        } else {
            "选区读取进程不可用或返回内容超出上限，请手动粘贴"
        }
        .to_owned()
    })?;
    let reply: Reply =
        serde_json::from_slice(&bytes).map_err(|_| "选区读取结果无效，请手动粘贴")?;
    if let Some(error) = reply.error {
        return Err(error.chars().take(512).collect());
    }
    selection::validate_selection(
        vec![reply.text.ok_or("未读取到选中文字，请手动粘贴")?],
        false,
    )
}

/// The executable calls this before Tauri initializes windows or background work.
pub fn run_if_worker() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(WORKER_ARG)) {
        return false;
    }
    let result = std::panic::catch_unwind(|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(MAX_REQUEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取选区请求，请手动粘贴".to_owned())?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("选区请求超出上限，请手动粘贴".into());
        }
        let target: CaptureTarget =
            serde_json::from_slice(&bytes).map_err(|_| "选区请求无效，请手动粘贴".to_owned())?;
        if !target.matches(target.hwnd, target.process_id) {
            return Err("原窗口不可用，请手动粘贴".into());
        }
        selection::capture(target)
    })
    .unwrap_or_else(|_| Err("选区提供程序异常，请手动粘贴".into()));
    let reply = match result {
        Ok(text) => Reply {
            text: Some(text),
            error: None,
        },
        Err(error) => Reply {
            text: None,
            error: Some(error.chars().take(512).collect()),
        },
    };
    if let Ok(bytes) = serde_json::to_vec(&reply) {
        if bytes.len() <= MAX_REPLY_BYTES {
            let _ = std::io::stdout().write_all(&bytes);
            let _ = std::io::stdout().flush();
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_text_wire_budget_covers_worst_case_json_escapes() {
        let text = "\u{1}".repeat(MAX_SELECTION_CHARS);
        let reply = serde_json::to_vec(&Reply {
            text: Some(text),
            error: None,
        })
        .unwrap();
        assert!(reply.len() <= MAX_REPLY_BYTES);
    }

    #[cfg(windows)]
    #[test]
    fn hanging_selection_provider_is_killed_and_reaped_at_selection_deadline() {
        let shell = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:/Windows".into())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(shell);
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        let started = std::time::Instant::now();
        let error = crate::search::extract_worker::run_child(
            command,
            b"{}",
            &AtomicBool::new(false),
            DEADLINE,
            MAX_REPLY_BYTES,
        )
        .unwrap_err();
        assert!(error.contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
