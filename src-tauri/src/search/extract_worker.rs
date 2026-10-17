//! Isolates document parsers from the UI and makes every extraction cancellable.
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const WORKER_ARG: &str = "--search-extract-worker";
const MAX_REQUEST_BYTES: usize = 32 * 1024;
// JSON can escape one control byte to six bytes. Both directions are bounded.
const MAX_REPLY_BYTES: usize = super::extract::MAX_TEXT_BYTES * 6 + 4096;
const MAX_STDERR_BYTES: usize = 32 * 1024;
const DEADLINE: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize)]
struct Request {
    path: String,
}
#[derive(Serialize, Deserialize)]
struct Reply {
    text: Option<String>,
    error: Option<String>,
}

pub fn extract(path: &Path, cancel: &AtomicBool) -> Result<String, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("文档提取已取消".into());
    }
    let request = serde_json::to_vec(&Request {
        path: path.to_str().ok_or("文档路径编码无效")?.to_string(),
    })
    .map_err(|_| "无法编码文档提取请求")?;
    if request.len() > MAX_REQUEST_BYTES {
        return Err("文档路径超过提取请求上限".into());
    }
    let executable = std::env::current_exe().map_err(|e| format!("无法定位提取进程：{e}"))?;
    let mut command = Command::new(executable);
    command.arg(WORKER_ARG);
    let bytes = run_child(command, &request, cancel, DEADLINE, MAX_REPLY_BYTES)?;
    let reply: Reply = serde_json::from_slice(&bytes).map_err(|_| "文档提取进程返回了无效结果")?;
    if let Some(error) = reply.error {
        return Err(error.chars().take(512).collect());
    }
    let text = reply.text.ok_or("文档提取进程未返回正文")?;
    if text.len() > super::extract::MAX_TEXT_BYTES {
        return Err("文档提取结果超过上限".into());
    }
    Ok(text)
}

/// Must be called before Tauri initialization from the native binary entrypoint.
/// Returns true for worker invocations even when their request is invalid.
pub fn run_if_worker() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(WORKER_ARG)) {
        return false;
    }
    let result = std::panic::catch_unwind(|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(MAX_REQUEST_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取文档提取请求".to_string())?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("文档提取请求超过上限".into());
        }
        let request: Request =
            serde_json::from_slice(&bytes).map_err(|_| "文档提取请求无效".to_string())?;
        let path = Path::new(&request.path);
        if !path.is_absolute() {
            return Err("文档提取仅接受绝对路径".into());
        }
        crate::database::reject_link_components(path)
            .map_err(|_| "文档路径不能经过符号链接或 junction".to_string())?;
        super::extract::extract_file(path)
    })
    .unwrap_or_else(|_| Err("文档解析器异常终止".into()));
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
    // No log output is written to stdout: it is exclusively the JSON protocol.
    if let Ok(bytes) = serde_json::to_vec(&reply) {
        if bytes.len() <= MAX_REPLY_BYTES {
            let _ = std::io::stdout().write_all(&bytes);
            let _ = std::io::stdout().flush();
        }
    }
    true
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
struct WorkerJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WorkerJob {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE also reclaims a parser if its parent unwinds/exits.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn configure_job(child: &Child) -> Result<WorkerJob, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject,
            },
        },
        core::PCWSTR,
    };
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|e| format!("无法创建文档提取资源限制，已停止提取：{e}"))?;
    let job = WorkerJob(handle);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.ProcessMemoryLimit = 512 * 1024 * 1024;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|e| format!("无法设置文档提取 512 MB 内存上限，已停止提取：{e}"))?;
    unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) }
        .map_err(|e| format!("无法应用文档提取资源限制，已停止提取：{e}"))?;
    Ok(job)
}

fn read_bounded(mut pipe: impl Read, limit: usize, overflow: Option<Arc<AtomicBool>>) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = limit.saturating_sub(output.len());
                output.extend_from_slice(&buffer[..count.min(remaining)]);
                if count > remaining {
                    if let Some(overflow) = &overflow {
                        overflow.store(true, Ordering::SeqCst);
                    }
                }
                // Continue draining after the cap so neither pipe can deadlock.
            }
        }
    }
    output
}

pub(crate) fn run_child(
    mut command: Command,
    request: &[u8],
    cancel: &AtomicBool,
    timeout: Duration,
    output_limit: usize,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("文档提取已取消".into());
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动文档提取进程：{e}"))?;
    #[cfg(windows)]
    let _job = match configure_job(&child) {
        Ok(job) => job,
        Err(error) => {
            stop(&mut child);
            return Err(error);
        }
    };
    let input = child.stdin.take().ok_or("提取进程输入不可用")?;
    let output = child.stdout.take().ok_or("提取进程输出不可用")?;
    let errors = child.stderr.take().ok_or("提取进程错误流不可用")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let output_overflow = Arc::clone(&overflow);
    let output_thread =
        thread::spawn(move || read_bounded(output, output_limit, Some(output_overflow)));
    let error_thread = thread::spawn(move || read_bounded(errors, MAX_STDERR_BYTES, None));
    let payload = request.to_vec();
    let input_thread = thread::spawn(move || {
        let mut input = input;
        let _ = input.write_all(&payload);
    });
    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            stop(&mut child);
            break Err("文档提取已取消".to_string());
        }
        if overflow.load(Ordering::SeqCst) {
            stop(&mut child);
            break Err("文档提取输出超过上限".to_string());
        }
        if started.elapsed() >= timeout {
            stop(&mut child);
            break Err("文档提取超时，已停止解析进程".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(error) => {
                stop(&mut child);
                break Err(format!("读取提取进程状态失败：{error}"));
            }
        }
    };
    let _ = input_thread.join();
    let bytes = output_thread.join().map_err(|_| "读取提取结果失败")?;
    let _ = error_thread.join();
    let status = status?;
    if overflow.load(Ordering::SeqCst) {
        return Err("文档提取输出超过上限".into());
    }
    if !status.success() {
        return Err(format!("文档解析进程异常退出（{status}）"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_request_does_not_start_a_worker() {
        let cancelled = AtomicBool::new(true);
        assert!(
            extract(Path::new("missing.docx"), &cancelled)
                .unwrap_err()
                .contains("取消")
        );
    }

    #[cfg(windows)]
    fn shell(script: &str) -> Command {
        let executable = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:/Windows".into())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(executable);
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
        command
    }

    #[cfg(windows)]
    #[test]
    fn worker_deadline_kills_and_reaps_child() {
        let started = Instant::now();
        let error = run_child(
            shell("Start-Sleep -Seconds 30"),
            b"{}",
            &AtomicBool::new(false),
            Duration::from_millis(120),
            1024,
        )
        .unwrap_err();
        assert!(error.contains("超时"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn worker_cancellation_interrupts_an_inflight_child() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = Arc::clone(&cancel);
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            trigger.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let error = run_child(
            shell("Start-Sleep -Seconds 30"),
            b"{}",
            &cancel,
            Duration::from_secs(10),
            1024,
        )
        .unwrap_err();
        thread.join().unwrap();
        assert!(error.contains("取消"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn worker_caps_stdout_and_drains_stderr_without_deadlock() {
        let error = run_child(
            shell("[Console]::Out.Write(('x' * 200000))"),
            b"{}",
            &AtomicBool::new(false),
            Duration::from_secs(10),
            4096,
        )
        .unwrap_err();
        assert!(error.contains("上限"), "{error}");
        let bytes = run_child(
            shell("[Console]::Error.Write(('e' * 200000)); [Console]::Out.Write('ok')"),
            b"{}",
            &AtomicBool::new(false),
            Duration::from_secs(10),
            4096,
        )
        .unwrap();
        assert_eq!(bytes, b"ok");
    }

    #[cfg(windows)]
    #[test]
    fn memory_limited_job_allows_a_small_worker_to_finish() {
        let bytes = run_child(
            shell("[Console]::Out.Write('bounded-worker')"),
            b"{}",
            &AtomicBool::new(false),
            Duration::from_secs(10),
            1024,
        )
        .unwrap();
        assert_eq!(bytes, b"bounded-worker");
    }

    #[test]
    fn bounded_pipe_reader_keeps_only_its_budget() {
        let overflow = Arc::new(AtomicBool::new(false));
        assert_eq!(
            read_bounded(
                std::io::Cursor::new(b"abcdef"),
                3,
                Some(Arc::clone(&overflow))
            ),
            b"abc"
        );
        assert!(overflow.load(Ordering::SeqCst));
    }
}
