//! Discover and launch an existing or bundled Everything executable. No installer.
use serde::Serialize;
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
static START_LOCK: Mutex<()> = Mutex::new(());
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);
pub fn last_start_error() -> Option<String> {
    START_ERROR.lock().ok().and_then(|v| v.clone())
}
pub fn clear_start_error() { if let Ok(mut current)=START_ERROR.lock(){*current=None;} }
pub fn remember_start(result: &Result<EverythingStatus, String>) {
    if let Ok(mut current) = START_ERROR.lock() {
        *current = match result {
            Ok(status) => status.error.clone(),
            Err(error) => Some(error.clone()),
        };
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EverythingStatus {
    pub path: Option<String>,
    pub running: bool,
    pub ipc_available: bool,
    pub index_ready: Option<bool>,
    pub state: String,
    pub error: Option<String>,
}

fn launch_args(instance: &str) -> Result<Vec<String>, String> {
    if instance.len() > 128 || instance.chars().any(char::is_control) {
        return Err("Everything 实例名称无效".into());
    }
    let mut args = vec!["-startup".into()];
    if !instance.trim().is_empty() {
        args.extend(["-instance".into(), instance.trim().into()]);
    }
    Ok(args)
}
fn validate_executable(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .extension()
            .is_none_or(|x| !x.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择 Everything 可执行程序的完整路径".into());
    }
    let mut file = std::fs::File::open(path).map_err(|_| "找不到所选 Everything 程序")?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if !(64..=64 * 1024 * 1024).contains(&size) {
        return Err("所选文件不是有效的 Windows 程序".into());
    }
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).map_err(|e| e.to_string())?;
    if &dos[..2] != b"MZ" {
        return Err("所选文件不是有效的 Windows 程序".into());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if offset > size.saturating_sub(4) {
        return Err("Windows 程序头无效".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut signature = [0u8; 4];
    file.read_exact(&mut signature).map_err(|e| e.to_string())?;
    if signature != *b"PE\0\0" {
        return Err("Windows 程序头无效".into());
    }
    Ok(())
}
fn state_name(installed: bool, ipc: bool, ready: Option<bool>, running: bool) -> &'static str {
    if ipc {
        if ready == Some(true) {
            "ready"
        } else {
            "indexing"
        }
    } else if running {
        "running_without_ipc"
    } else if installed {
        "installed"
    } else {
        "absent"
    }
}

pub fn locate(
    preferred: Option<&str>,
    resources: Option<&Path>,
    instance: &str,
) -> Option<PathBuf> {
    if let Some(path) = preferred.filter(|p| !p.trim().is_empty()) {
        return Some(PathBuf::from(path.trim()));
    }
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(path) = native::running_path(instance) {
            candidates.push(path);
        }
        candidates.extend(native::registry_paths());
    }
    for env in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(env) {
            let root = PathBuf::from(root);
            candidates.push(root.join("Everything/Everything.exe"));
            candidates.push(root.join("Programs/Everything/Everything.exe"));
        }
    }
    if let Some(root) = resources {
        candidates.push(root.join("resources/everything/everything.exe"));
        candidates.push(root.join("everything/everything.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent() {
            candidates.push(root.join("resources/everything/everything.exe"));
            candidates.push(root.join("everything/everything.exe"));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/everything/everything.exe"),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn detect(
    preferred: Option<&str>,
    resources: Option<&Path>,
    instance: &str,
) -> EverythingStatus {
    let path = locate(preferred, resources, instance);
    let (running, ipc, ready, probe_error) = probe(instance);
    let path_error = launch_args(instance)
        .err()
        .or_else(|| path.as_ref().and_then(|p| validate_executable(p).err()));
    EverythingStatus {
        path: path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        running,
        ipc_available: ipc,
        index_ready: ready,
        state: if path_error.is_some() {
            "error"
        } else {
            state_name(path.is_some(), ipc, ready, running)
        }
        .into(),
        error: path_error.or(probe_error),
    }
}
pub fn probe(instance: &str) -> (bool, bool, Option<bool>, Option<String>) {
    #[cfg(windows)]
    {
        native::probe(instance)
    }
    #[cfg(not(windows))]
    {
        let _ = instance;
        (false, false, None, None)
    }
}
pub fn start(
    preferred: Option<&str>,
    resources: Option<&Path>,
    instance: &str,
) -> Result<EverythingStatus, String> {
    let mut args = launch_args(instance)?;
    let _guard = START_LOCK.lock().map_err(|_| "Everything 启动状态不可用")?;
    if probe(instance).1 {
        return Ok(detect(preferred, resources, instance));
    }
    let path =
        locate(preferred, resources, instance).ok_or("未找到 Everything，请选择本机程序路径")?;
    validate_executable(&path)?;
    // Bundled engine state follows the workbench data module. A system install
    // keeps its own existing configuration and database location.
    if path
        .parent()
        .is_some_and(|p| p.join("SOURCE.md").is_file() && p.join("License.txt").is_file())
    {
        let directory = crate::commands::data::with_data_dir(|root| {
            let directory = root.join("modules/search/everything");
            crate::database::reject_link_components(&directory)?;
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            Ok(directory)
        })?;
        args.extend([
            "-config".into(),
            directory
                .join("Everything.ini")
                .to_string_lossy()
                .into_owned(),
            "-db".into(),
            directory
                .join("Everything.db")
                .to_string_lossy()
                .into_owned(),
        ]);
    }
    let mut command = std::process::Command::new(&path);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Everything：{e}"))?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        if probe(instance).1 {
            return Ok(detect(Some(&path.to_string_lossy()), resources, instance));
        }
        if let Ok(Some(code)) = child.try_wait() {
            if !code.success() {
                return Err(format!(
                    "Everything 退出，状态码 {code}。请检查程序版本与索引权限"
                ));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut status = detect(Some(&path.to_string_lossy()), resources, instance);
    if !status.ipc_available {
        status.error=Some("程序已启动，等待索引服务；请检查 Everything 设置、首次启动界面及 NTFS 索引权限。Lite 版不支持 IPC。".into());
    }
    Ok(status)
}

#[cfg(windows)]
mod native {
    use super::*;
    use everything_ipc::IpcWindow;
    use windows::{
        Win32::{
            Foundation::{CloseHandle, ERROR_SUCCESS, HWND, LPARAM, WPARAM},
            System::{
                Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW},
                Threading::{
                    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                    QueryFullProcessImageNameW,
                },
            },
            UI::WindowsAndMessaging::{
                GetWindowThreadProcessId, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_USER,
            },
        },
        core::{PCWSTR, PWSTR},
    };
    fn window(instance: &str) -> Option<IpcWindow> {
        if instance.len() > 128 || instance.chars().any(char::is_control) {
            return None;
        }
        if instance.trim().is_empty() {
            IpcWindow::new()
        } else {
            IpcWindow::with_instance(Some(instance.trim()))
        }
    }
    fn send(hwnd: HWND, command: usize) -> Option<usize> {
        let mut result = 0;
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_USER,
                WPARAM(command),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                150,
                Some(&mut result),
            )
        };
        (sent.0 != 0).then_some(result)
    }
    pub(super) fn probe(instance: &str) -> (bool, bool, Option<bool>, Option<String>) {
        let Some(win) = window(instance) else {
            return (false, false, None, None);
        };
        match send(win.hwnd(), 1) {
            Some(minor) if minor >= 4 => {
                let ready = send(win.hwnd(), 401).map(|r| r != 0);
                (
                    true,
                    true,
                    ready,
                    ready.is_none().then(|| "Everything 状态探测超时".into()),
                )
            }
            Some(_) => (
                true,
                false,
                None,
                Some("Everything 当前实例不支持 IPC，请使用完整版".into()),
            ),
            None => (
                true,
                false,
                None,
                Some("Everything IPC 未响应，请检查程序状态及运行权限".into()),
            ),
        }
    }
    pub(super) fn running_path(instance: &str) -> Option<PathBuf> {
        let win = window(instance)?;
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(win.hwnd(), Some(&mut pid));
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        }
        .is_ok();
        let _ = unsafe { CloseHandle(process) };
        ok.then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
    pub(super) fn registry_paths() -> Vec<PathBuf> {
        let key: Vec<u16> =
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe"
                .encode_utf16()
                .chain(Some(0))
                .collect();
        let mut paths = vec![];
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let mut buf = vec![0u16; 32768];
            let mut size = (buf.len() * 2) as u32;
            let code = unsafe {
                RegGetValueW(
                    hive,
                    PCWSTR(key.as_ptr()),
                    None,
                    RRF_RT_REG_SZ,
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut size),
                )
            };
            if code == ERROR_SUCCESS {
                let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                paths.push(PathBuf::from(
                    String::from_utf16_lossy(&buf[..end]).trim_matches('"'),
                ));
            }
        }
        paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_arguments_keep_instance_literal_and_never_install_a_service() {
        assert_eq!(launch_args("").unwrap(), vec!["-startup"]);
        assert_eq!(
            launch_args("work & personal").unwrap(),
            vec!["-startup", "-instance", "work & personal"]
        );
        assert!(launch_args("bad\ninstance").is_err());
    }
    #[test]
    fn a_selected_non_program_is_rejected() {
        assert!(validate_executable(std::path::Path::new("relative/Everything.exe")).is_err());
        let path = std::env::temp_dir().join(format!("everything-{}.exe", std::process::id()));
        std::fs::write(&path, b"not an executable").unwrap();
        assert!(validate_executable(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn ipc_and_database_readiness_are_distinct_states() {
        assert_eq!(state_name(false, false, None, false), "absent");
        assert_eq!(state_name(true, false, None, false), "installed");
        assert_eq!(state_name(true, false, None, true), "running_without_ipc");
        assert_eq!(state_name(true, true, Some(false), true), "indexing");
        assert_eq!(state_name(true, true, Some(true), true), "ready");
    }
}
