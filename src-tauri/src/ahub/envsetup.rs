//! 环境统一存放目录与一键安装（env-setup）。
//!
//! 职责：
//! - `settings.env_root` 的读写（一键安装的工具统一解压到 `<env_root>/<tool>/`）；
//! - 完整安装流程：下载官方 HTTPS zip → 解压到 `%TEMP%\agenthub-install\` →
//!   找最深可执行目录 → 整个解压目录移入 `<env_root>/<tool>/` → 追加用户级 PATH；
//! - 用户级 PATH 的备份（`data_root()/path-backup.json`）与恢复。
//!
//! 约束（brief / spec）：
//! - 安装包只接受 HTTPS zip 直链，不执行 msi/exe 静默安装；
//! - PATH 只改用户级（`HKCU\Environment` 的 `Path`），必须走 Windows API，禁止 `setx`；
//! - 追加前按大小写不敏感去重，且先把修改前的完整值备份下来；
//! - 下载 / 解压 / PATH 失败时清理临时文件或回滚，不影响已有环境。

use crate::ahub::models::InstallOutcome;
use crate::ahub::store::{self, AppH, es};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---------------- 环境根目录 ----------------

pub fn get_env_root(app: &AppH) -> String {
    store::load_settings(app).env_root
}

pub fn set_env_root(app: &AppH, path: &str) -> Result<(), String> {
    let p = path.trim().to_string();
    if !p.is_empty() {
        std::fs::create_dir_all(&p).map_err(es)?;
    }
    let mut s = store::load_settings(app);
    s.env_root = p;
    store::save_settings(app, &s)
}

// ---------------- 安装进度事件 ----------------

/// 安装进度事件（前端 InstallButton 监听）。stage: download | extract | path | done
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    tool: String,
    stage: String,
    percent: u8,
}

fn emit_progress(app: &AppH, tool: &str, stage: &str, percent: u8) {
    use tauri::Emitter;
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            tool: tool.to_string(),
            stage: stage.to_string(),
            percent,
        },
    );
}

// ---------------- PATH 追加去重（纯逻辑，可测） ----------------

/// 目录条目规范化：去空白与尾部斜杠、转小写 —— 供大小写不敏感去重。
fn normalize_entry(entry: &str) -> String {
    entry
        .trim()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

/// 目标目录是否已在 PATH 里（大小写不敏感，忽略尾部反斜杠差异）。
pub fn path_contains(current: &str, dir: &str) -> bool {
    let want = normalize_entry(dir);
    !want.is_empty() && current.split(';').any(|e| normalize_entry(e) == want)
}

/// 返回追加后的新 PATH；无需修改（已存在或目录名为空）时返回 None。
pub fn append_path_entry(current: &str, dir: &str) -> Option<String> {
    if normalize_entry(dir).is_empty() {
        return None;
    }
    if path_contains(current, dir) {
        return None;
    }
    let mut parts: Vec<&str> = current.split(';').filter(|s| !s.trim().is_empty()).collect();
    parts.push(dir);
    Some(parts.join(";"))
}

// ---------------- 用户级 PATH（注册表，Windows API） ----------------

#[cfg(windows)]
mod registry {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    pub const REG_SZ: u32 = 1;
    pub const REG_EXPAND_SZ: u32 = 2;

    type HKEY = isize;
    const HKEY_CURRENT_USER: HKEY = 0x8000_0001u32 as isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const HWND_BROADCAST: isize = 0xFFFF;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            hkey: HKEY,
            lpsubkey: *const u16,
            uloptions: u32,
            samdesired: u32,
            phkresult: *mut HKEY,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: HKEY,
            lpvaluename: *const u16,
            lpreserved: *mut u32,
            lptype: *mut u32,
            lpdata: *mut u8,
            lpcbdata: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            hkey: HKEY,
            lpvaluename: *const u16,
            reserved: u32,
            dwtype: u32,
            lpdata: *const u8,
            cbdata: u32,
        ) -> i32;
        fn RegCloseKey(hkey: HKEY) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            fuflags: u32,
            utimeout: u32,
            lpdwresult: *mut usize,
        ) -> usize;
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn reg_err(op: &str, code: i32) -> String {
        format!("{op} 失败（注册表错误码 {code}）")
    }

    /// 读用户 Path 原始值，返回（值, 类型）。值不存在（用户从没设过）时返回 ("", REG_SZ)。
    /// `%VAR%` 保持未展开原样，写回时也原样保留。
    pub fn read_user_path() -> Result<(String, u32), String> {
        unsafe {
            let mut hkey: HKEY = 0;
            let subkey = wide("Environment");
            let rc = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey);
            if rc != ERROR_SUCCESS {
                return Err(reg_err("打开注册表 Environment", rc));
            }
            let name = wide("Path");
            let mut ty: u32 = 0;
            let mut size: u32 = 0;
            let rc = RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut ty,
                std::ptr::null_mut(),
                &mut size,
            );
            if rc != ERROR_SUCCESS {
                RegCloseKey(hkey);
                if rc == ERROR_FILE_NOT_FOUND {
                    return Ok((String::new(), REG_SZ));
                }
                return Err(reg_err("读取用户 Path", rc));
            }
            let mut buf = vec![0u8; size as usize];
            let rc = RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut ty,
                buf.as_mut_ptr(),
                &mut size,
            );
            RegCloseKey(hkey);
            if rc != ERROR_SUCCESS {
                return Err(reg_err("读取用户 Path", rc));
            }
            buf.truncate(size as usize);
            // REG_SZ / REG_EXPAND_SZ 的数据都是 UTF-16，按 UTF-16 解码
            let units: Vec<u16> = buf
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let value = String::from_utf16_lossy(&units);
            Ok((value.trim_end_matches('\0').to_string(), ty))
        }
    }

    /// 写用户 Path（保持读到的原类型，通常是 REG_EXPAND_SZ）。
    pub fn write_user_path(value: &str, ty: u32) -> Result<(), String> {
        unsafe {
            let mut hkey: HKEY = 0;
            let subkey = wide("Environment");
            let rc = RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_SET_VALUE, &mut hkey);
            if rc != ERROR_SUCCESS {
                return Err(reg_err("打开注册表 Environment", rc));
            }
            let name = wide("Path");
            let mut bytes: Vec<u8> = value.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            bytes.extend_from_slice(&[0, 0]); // UTF-16 结尾 NUL
            let rc = RegSetValueExW(hkey, name.as_ptr(), 0, ty, bytes.as_ptr(), bytes.len() as u32);
            RegCloseKey(hkey);
            if rc != ERROR_SUCCESS {
                return Err(reg_err("写入用户 Path", rc));
            }
            Ok(())
        }
    }

    /// 广播 WM_SETTINGCHANGE，让资源管理器与后续新进程尽快看到新 PATH。
    pub fn broadcast_env_change() {
        unsafe {
            let env = wide("Environment");
            let mut result: usize = 0;
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                env.as_ptr(),
                SMTO_ABORTIFHUNG,
                2000,
                &mut result,
            );
        }
    }
}

#[cfg(not(windows))]
mod registry {
    pub const REG_SZ: u32 = 1;
    pub const REG_EXPAND_SZ: u32 = 2;

    pub fn read_user_path() -> Result<(String, u32), String> {
        Err("PATH 注册表操作仅支持 Windows".into())
    }
    pub fn write_user_path(_value: &str, _ty: u32) -> Result<(), String> {
        Err("PATH 注册表操作仅支持 Windows".into())
    }
    pub fn broadcast_env_change() {}
}

// ---------------- PATH 备份 / 恢复 ----------------

/// path-backup.json 的内容：最近一次修改前的完整用户 Path 值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathBackup {
    pub backed_up_at: String,
    pub value: String,
    #[serde(default = "default_reg_type")]
    pub value_type: u32,
}

fn default_reg_type() -> u32 {
    registry::REG_EXPAND_SZ
}

fn backup_file(app: &AppH) -> PathBuf {
    store::data_root(app).join("path-backup.json")
}

/// 把（值, 类型）写入备份文件。install_tool 与 backup_path 共用；测试用临时目录直接调用。
fn write_backup_file(file: &Path, value: &str, ty: u32) -> Result<(), String> {
    store::write_json(
        file,
        &PathBackup {
            backed_up_at: crate::ahub::models::now_iso(),
            value: value.to_string(),
            value_type: ty,
        },
    )
}

fn read_backup_file(file: &Path) -> Result<PathBackup, String> {
    store::read_json(file)
}

/// 立即备份当前用户 Path 到 `data_root()/path-backup.json`。返回备份文件路径。
/// （安装流程会自动备份；这个入口留给「手动再备份一次」的调用方。）
#[allow(dead_code)]
pub fn backup_path(app: &AppH) -> Result<String, String> {
    let (value, ty) = registry::read_user_path()?;
    let file = backup_file(app);
    write_backup_file(&file, &value, ty)?;
    Ok(file.to_string_lossy().into_owned())
}

/// 从备份恢复用户 Path。返回恢复的值。
pub fn restore_path(app: &AppH) -> Result<String, String> {
    let file = backup_file(app);
    let backup = read_backup_file(&file).map_err(|e| format!("读取 PATH 备份失败：{e}"))?;
    registry::write_user_path(&backup.value, backup.value_type)?;
    registry::broadcast_env_change();
    Ok(backup.value)
}

/// 备份当前值 → 大小写不敏感去重 → 追加 bin_dir。返回是否真的追加了。
fn append_to_user_path(app: &AppH, bin_dir: &Path) -> Result<bool, String> {
    let (current, ty) = registry::read_user_path()?;
    let new_entry = bin_dir.to_string_lossy().trim_end_matches('\\').to_string();
    let Some(updated) = append_path_entry(&current, &new_entry) else {
        // 已在 PATH（大小写不敏感）：不重复追加，也不产生新备份
        return Ok(false);
    };
    // 备份「修改前」的完整值 —— 必须发生在追加之前
    write_backup_file(&backup_file(app), &current, ty)?;
    registry::write_user_path(&updated, ty)?;
    registry::broadcast_env_change();
    Ok(true)
}

/// 把新目录并入当前进程的 PATH，让本进程内的 resolve_program 立刻能看到新装工具
/// （注册表改动对本进程不生效）。只影响本进程；已存在（大小写不敏感）时不动。
fn ensure_process_path(bin_dir: &Path) {
    let new_entry = bin_dir.to_string_lossy().trim_end_matches('\\').to_string();
    let current = std::env::var("PATH").unwrap_or_default();
    if path_contains(&current, &new_entry) {
        return;
    }
    // shortcut: 多线程下改进程环境变量理论上不安全；Windows 实际由 PEB 锁串行化，仅安装成功后调用一次
    unsafe {
        std::env::set_var("PATH", format!("{current};{new_entry}"));
    }
}

// ---------------- 一键安装 ----------------

fn staging_root() -> PathBuf {
    std::env::temp_dir().join("agenthub-install")
}

/// 清理本次下载与解压的临时文件（失败路径都要调用，A8）。
fn cleanup_temp(zip_path: &Path, extract_dir: &Path) {
    let _ = std::fs::remove_file(zip_path);
    let _ = std::fs::remove_dir_all(extract_dir);
}

fn is_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat"))
        .unwrap_or(false)
}

/// 目录里是否直接放着可执行文件（不含子目录）。
fn dir_has_executable(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().is_file() && is_executable(&e.path()))
        })
        .unwrap_or(false)
}

/// 找含 .exe/.cmd/.bat 的最深目录；没有则 None。
fn find_bin_dir(root: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, best: &mut Option<(usize, PathBuf)>) {
        if dir_has_executable(dir) {
            let depth = dir.components().count();
            if best.as_ref().map_or(true, |(d, _)| depth > *d) {
                *best = Some((depth, dir.to_path_buf()));
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, best);
                }
            }
        }
    }
    let mut best: Option<(usize, PathBuf)> = None;
    walk(root, &mut best);
    best.map(|(_, p)| p)
}

/// 下载 zip 到 dest，按百分比发进度事件。只允许 HTTPS 源，完成后校验大小 > 0。
fn download_zip(app: &AppH, tool_id: &str, url: &str, dest: &Path) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("安装包只允许从 HTTPS 官方源下载".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .user_agent("AgentHub/0.1 (env-setup)")
        .build();
    let resp = agent.get(url).call().map_err(|e| format!("下载失败：{e}"))?;
    let total = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n > 0);
    let mut file = std::fs::File::create(dest).map_err(es)?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last_percent: i64 = -1;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(es)?;
        written += n as u64;
        if let Some(total) = total {
            let percent = ((written.min(total) * 100) / total) as i64;
            if percent != last_percent {
                last_percent = percent;
                emit_progress(app, tool_id, "download", percent as u8);
            }
        }
    }
    file.flush().map_err(es)?;
    drop(file);
    if std::fs::metadata(dest).map_err(es)?.len() == 0 {
        return Err("下载内容为空".into());
    }
    Ok(())
}

/// 解压 zip 到 dest。与 skills::import_skill_zip 同一套防护：
/// enclosed_name() 拒绝绝对路径与 `..` 穿越；总量上限防撑爆磁盘。
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024; // 解压后总量上限 2GB
    let file = std::fs::File::open(zip_path).map_err(es)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法解析 ZIP：{e}"))?;
    std::fs::create_dir_all(dest).map_err(es)?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败：{e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err("ZIP 含非法路径条目（路径穿越）".into());
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(es)?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL {
            return Err("ZIP 解压后体积过大，已中止".into());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(es)?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(es)?;
        std::fs::write(&out, &buf).map_err(es)?;
    }
    Ok(())
}

/// 一键安装主流程。返回 `InstallOutcome`；失败时返回 Err 且不留下临时文件。
pub fn install_tool(
    app: &AppH,
    tool_id: &str,
    download_url: &str,
    tool_name: &str,
) -> Result<InstallOutcome, String> {
    let tool_id = tool_id.trim();
    let tool_name = tool_name.trim();
    if tool_id.is_empty() || tool_name.is_empty() {
        return Err("缺少工具标识或安装目录名".into());
    }
    // tool_name 会拼进安装路径，必须是安全目录名
    if tool_name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) || tool_name.contains("..")
    {
        return Err("工具目录名含有非法字符".into());
    }

    let env_root = get_env_root(app);
    if env_root.trim().is_empty() {
        return Err("尚未设置环境根目录：请先在设置页配置".into());
    }

    let staging = staging_root();
    std::fs::create_dir_all(&staging).map_err(es)?;
    let zip_path = staging.join(format!("{tool_id}.zip"));
    let extract_dir = staging.join(tool_id);
    let _ = std::fs::remove_dir_all(&extract_dir); // 上次失败的残留

    // 1) 下载
    if let Err(e) = download_zip(app, tool_id, download_url, &zip_path) {
        cleanup_temp(&zip_path, &extract_dir);
        return Err(e);
    }
    // 2) 解压到临时目录
    emit_progress(app, tool_id, "extract", 0);
    if let Err(e) = extract_zip(&zip_path, &extract_dir) {
        cleanup_temp(&zip_path, &extract_dir);
        return Err(format!("解压失败：{e}"));
    }
    // 3) 找最深可执行目录
    let Some(bin_dir) = find_bin_dir(&extract_dir) else {
        cleanup_temp(&zip_path, &extract_dir);
        return Err("解压结果中没有找到可执行文件（.exe/.cmd/.bat）".into());
    };

    // 4) 整个解压目录移入 <env_root>/<tool_name>/
    let dest = Path::new(env_root.trim()).join(tool_name);
    if dest.exists() {
        cleanup_temp(&zip_path, &extract_dir);
        return Err(format!("目标目录已存在：{}", dest.display()));
    }
    if let Err(e) = std::fs::rename(&extract_dir, &dest) {
        // %TEMP% 与环境根目录可能跨盘：rename 失败时回退到复制 + 删除
        if let Err(e2) = store::copy_dir_recursive(&extract_dir, &dest, false) {
            cleanup_temp(&zip_path, &extract_dir);
            return Err(format!("移动安装目录失败：{e} / {e2}"));
        }
        let _ = std::fs::remove_dir_all(&extract_dir);
    }
    let _ = std::fs::remove_file(&zip_path);

    // 5) 追加用户 PATH（备份 → 去重 → 追加），失败则回滚刚装上的目录
    let bin_rel = bin_dir.strip_prefix(&extract_dir).unwrap_or(Path::new(""));
    let final_bin = dest.join(bin_rel);
    emit_progress(app, tool_id, "path", 0);
    match append_to_user_path(app, &final_bin) {
        Ok(path_added) => {
            ensure_process_path(&final_bin);
            let verified = crate::ahub::cliscan::resolve_program(tool_id).is_some();
            emit_progress(app, tool_id, "done", 100);
            let message = if !path_added {
                "安装完成：目录已在 PATH 中，未重复追加".to_string()
            } else if verified {
                format!("安装完成，已验证 {tool_id} 可解析")
            } else {
                format!("安装完成，但未能立即解析 {tool_id}（重启应用后生效）")
            };
            Ok(InstallOutcome {
                tool: tool_id.to_string(),
                ok: true,
                message,
                install_path: dest.to_string_lossy().into_owned(),
                path_added,
            })
        }
        Err(e) => {
            // PATH 写失败：回滚刚装的目录，保持环境不变
            let _ = std::fs::remove_dir_all(&dest);
            Err(format!("更新 PATH 失败（已回滚安装目录）：{e}"))
        }
    }
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- PATH 追加去重 ----

    #[test]
    fn append_appends_new_entry() {
        assert_eq!(
            append_path_entry(r"C:\a;D:\b", r"D:\new\bin").unwrap(),
            r"C:\a;D:\b;D:\new\bin"
        );
    }

    #[test]
    fn append_dedupes_case_insensitively() {
        assert_eq!(append_path_entry(r"C:\Tools;D:\Dev", r"d:\dev"), None);
        assert_eq!(append_path_entry(r"c:\tools", r"C:\TOOLS"), None);
        assert_eq!(path_contains(r"C:\Windows\system32", r"c:\windows\SYSTEM32"), true);
    }

    #[test]
    fn append_ignores_trailing_slash() {
        assert_eq!(append_path_entry(r"C:\Tools\", r"C:\Tools"), None);
        assert_eq!(append_path_entry(r"C:\Tools", r"C:\Tools\"), None);
    }

    #[test]
    fn append_skips_empty_segments() {
        assert_eq!(append_path_entry("; ;C:\\a", "C:\\b").unwrap(), r"C:\a;C:\b");
    }

    #[test]
    fn append_rejects_empty_dir() {
        // 空目录名绝不能进 PATH
        assert_eq!(append_path_entry(r"C:\a", "   "), None);
        assert_eq!(append_path_entry(r"C:\a", ""), None);
    }

    // ---- PATH 备份文件（临时目录） ----

    #[test]
    fn backup_file_roundtrip_and_missing() {
        let dir = std::env::temp_dir().join(format!("ah-envsetup-bk-{}", crate::ahub::models::new_id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("path-backup.json");
        write_backup_file(&file, r"C:\old\bin;D:\x", registry::REG_EXPAND_SZ).unwrap();
        let b = read_backup_file(&file).unwrap();
        assert_eq!(b.value, r"C:\old\bin;D:\x");
        assert_eq!(b.value_type, registry::REG_EXPAND_SZ);
        assert!(!b.backed_up_at.is_empty());

        // 文件缺失必须报错 —— restore_path 靠这一点提示「没有可用的备份」
        assert!(read_backup_file(&dir.join("nope.json")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- zip 解压 + 最深可执行目录 ----

    fn make_tool_zip(path: &Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, '_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            w.start_file(*name, opts).unwrap();
            use std::io::Write as _;
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn extract_zip_finds_deepest_bin_dir() {
        let dir = std::env::temp_dir().join(format!("ah-envsetup-zip-{}", crate::ahub::models::new_id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        make_tool_zip(
            &dir.join("tool.zip"),
            &[
                ("maven/bin/mvn.cmd", "@echo off"),
                ("maven/bin/m2.conf", "config"),
                ("maven/conf/settings.xml", "<settings/>"),
                ("maven/README.txt", "readme"),
            ],
        );
        let out = dir.join("out");
        extract_zip(&dir.join("tool.zip"), &out).unwrap();
        assert!(out.join("maven/bin/mvn.cmd").is_file(), "文件应被解压出来");
        assert!(out.join("maven/conf/settings.xml").is_file());

        let bin = find_bin_dir(&out).expect("应找到含可执行文件的目录");
        assert!(
            bin.ends_with("bin"),
            "最深含可执行文件的目录应是 maven/bin，实际 {}",
            bin.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_rejects_path_traversal() {
        let dir = std::env::temp_dir().join(format!("ah-envsetup-evil-{}", crate::ahub::models::new_id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        make_tool_zip(&dir.join("evil.zip"), &[("../evil.exe", "MZ")]);
        let out = dir.join("out");
        assert!(extract_zip(&dir.join("evil.zip"), &out).is_err(), "路径穿越必须被拒绝");
        assert!(!dir.join("evil.exe").exists(), "绝不能写出 ZIP 之外的文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_bin_dir_none_without_executables() {
        let dir = std::env::temp_dir().join(format!("ah-envsetup-noexe-{}", crate::ahub::models::new_id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/readme.md"), "x").unwrap();
        assert_eq!(find_bin_dir(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
