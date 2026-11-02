//! 会话发现 / 预览 / 迁移的编排层。
//!
//! 迁移只做三件事：读源（只读）、写目标（新会话）、记账（幂等 state）。
//! 任何一步失败都不碰源会话；目标写入由各 adapter 保证原子/追加。
use crate::sessions::adapter;
use crate::sessions::ir::{Session, SessionCounts, SessionSummary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// 迁移状态是“读-改-写”，并发迁移会互相覆盖；串行化整个迁移即可。
static MIGRATE_LOCK: Mutex<()> = Mutex::new(());

pub fn runtimes() -> Vec<crate::sessions::ir::RuntimeInfo> {
    adapter::runtime_infos()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateRequest {
    pub source: String,
    pub session_id: String,
    pub target: String,
    /// 目标工作目录；缺省用源会话的 cwd。
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub source: String,
    pub source_id: String,
    pub target: String,
    pub target_id: String,
    pub cwd: String,
    pub counts: SessionCounts,
    pub dropped: Vec<String>,
    #[serde(default)]
    pub resume_command: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// 同一对 (source, id, target) 之前迁过，直接复用。
    #[serde(default)]
    pub skipped: bool,
}

fn state_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("NIMBUS_SESSION_STATE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let home = dirs::home_dir().ok_or("无法解析用户主目录")?;
    Ok(home.join(".nimbusdesk").join("session-migration").join("state.json"))
}

type State = BTreeMap<String, MigrateReport>;

fn load_state() -> State {
    let Ok(path) = state_path() else { return State::new(); };
    let Ok(text) = fs::read_to_string(&path) else { return State::new(); };
    match serde_json::from_str(&text) {
        Ok(state) => state,
        Err(_) => {
            let backup = path.with_extension("json.corrupt");
            fs::copy(&path, &backup).ok();
            State::new()
        }
    }
}

fn save_state(state: &State) -> Result<(), String> {
    let path = state_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建迁移状态目录失败: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    crate::sessions::replace_state_file(&tmp, &path).map_err(|e| format!("写回迁移状态失败: {e}"))?;
    Ok(())
}

fn key(source: &str, id: &str, target: &str) -> String {
    format!("{source}\u{1f}{id}\u{1f}{target}")
}

#[cfg(windows)]
pub(crate) fn target_app_running(target: &str) -> Option<&'static str> {
    #[cfg(test)]
    if std::env::var_os("NIMBUS_TEST_ALLOW_TARGET").is_some() {
        return None;
    }
    if target == "dsh" {
        // The npm `dsh` shim runs as node.exe; image-name checks cannot see it.
        let script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*deepseek*' -or $_.CommandLine -like '*dsh*' } | Select-Object -First 1 -ExpandProperty ProcessId";
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output();
        if let Ok(output) = output {
            if !String::from_utf8_lossy(&output.stdout).trim().is_empty() {
                return Some("node.exe (dsh)");
            }
        }
    }
    let names: &[&'static str] = match target {
        "workbuddy" => &["WorkBuddy.exe", "CodeBuddy.exe", "workbuddy.exe", "codebuddy.exe"],
        "opencode" => &["opencode.exe", "OpenCode.exe"],
        "dsh" => &["dsh.exe", "dsh"],
        _ => &[],
    };
    for name in names {
        let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
            .output()
        else { continue; };
        let text = String::from_utf8_lossy(&out.stdout);
        if text.to_ascii_lowercase().contains(&name.to_ascii_lowercase()) {
            return Some(name);
        }
    }
    None
}

#[cfg(not(windows))]
fn target_app_running(_target: &str) -> Option<&'static str> {
    None
}

pub fn list(runtimes: Option<Vec<String>>) -> Result<Vec<SessionSummary>, String> {
    let wanted = runtimes.unwrap_or_default();
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for adapter in adapter::all() {
        if !wanted.is_empty() && !wanted.iter().any(|r| r.eq_ignore_ascii_case(adapter.id())) {
            continue;
        }
        match adapter.discover() {
            Ok(mut list) => out.append(&mut list),
            Err(e) => errors.push(format!("{}: {e}", adapter.label())),
        }
    }
    out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    if out.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(out)
}

pub fn read(runtime: &str, id: &str) -> Result<Session, String> {
    adapter::get(runtime)?.read(id)
}

pub fn migrate(req: MigrateRequest) -> Result<MigrateReport, String> {
    let _guard = MIGRATE_LOCK.lock().map_err(|_| "迁移锁已损坏".to_string())?;
    let source = adapter::get(&req.source)?;
    let target = adapter::get(&req.target)?;
    if source.id() == target.id() {
        return Err("源与目标是同一个 runtime；请选择另一个目标".into());
    }
    let key = key(source.id(), &req.session_id, target.id());
    let mut state = load_state();
    if let Some(existing) = state.get(&key) {
        let mut report = existing.clone();
        report.skipped = true;
        return Ok(report);
    }
    if let Some(name) = target_app_running(target.id()) {
        return Err(format!("{name} 正在运行；请先退出目标客户端再迁移，避免写入冲突"));
    }
    let session = source.read(&req.session_id)?;
    let cwd = req
        .cwd
        .or_else(|| session.cwd.clone())
        .filter(|s| !s.trim().is_empty())
        .ok_or("源会话没有 cwd，请在迁移时指定一个目标目录")?;
    if !std::path::Path::new(&cwd).exists() {
        return Err(format!("目标目录不存在: {cwd}"));
    }
    let counts = session.counts();
    let result = target.write(&session, &cwd)?;
    let report = MigrateReport {
        source: source.id().into(),
        source_id: req.session_id,
        target: target.id().into(),
        target_id: result.id,
        cwd,
        counts,
        dropped: result.dropped,
        resume_command: result.resume_command,
        path: result.path,
        skipped: false,
    };
    state.insert(key, report.clone());
    save_state(&state)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::TEST_ENV_LOCK;

    #[test]
    fn list_smoke() {
        let all = list(None).unwrap_or_default();
        let mut counts = std::collections::BTreeMap::new();
        for item in &all {
            *counts.entry(item.runtime.clone()).or_insert(0usize) += 1;
        }
        println!("session list: total={} by_runtime={counts:?}", all.len());
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;
    use crate::sessions::TEST_ENV_LOCK;

    #[test]
    fn dsh_to_workbuddy_roundtrip() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let source = adapter::get("dsh").unwrap();
        let Some(summary) = source
            .discover()
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.message_count >= 4)
            .min_by_key(|s| s.size_bytes)
        else { return; };
        let tmp = std::env::temp_dir().join(format!("nimbus-transfer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe {
            std::env::set_var("WORKBUDDY_CONFIG_DIR", &tmp);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest {
            source: "dsh".into(),
            session_id: summary.id.clone(),
            target: "workbuddy".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
        }).unwrap();
        assert!(!report.target_id.is_empty());
        let target = adapter::get("workbuddy").unwrap();
        let written = target.read(&report.target_id).unwrap();
        assert!(!written.events.is_empty());
        unsafe {
            std::env::remove_var("WORKBUDDY_CONFIG_DIR");
            std::env::remove_var("NIMBUS_SESSION_STATE");
        }
        std::fs::remove_dir_all(&tmp).ok();
    }
}

#[cfg(test)]
mod cross_runtime_tests {
    use super::*;
    use crate::sessions::TEST_ENV_LOCK;

    fn pick(runtime: &str) -> Option<SessionSummary> {
        adapter::get(runtime).ok()?.discover().ok()?.into_iter().find(|s| s.message_count >= 4)
    }

    #[test]
    #[ignore = "reads local sessions; run manually after quitting the target apps"]
    fn workbuddy_to_dsh() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe { std::env::set_var("NIMBUS_TEST_ALLOW_TARGET", "1"); }
        let Some(source) = pick("workbuddy") else { return; };
        let tmp = std::env::temp_dir().join(format!("nimbus-wb-dsh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe {
            std::env::set_var("DSH_HOME", &tmp);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest {
            source: "workbuddy".into(),
            session_id: source.id,
            target: "dsh".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
        }).unwrap();
        assert!(!report.target_id.is_empty());
        let written = adapter::get("dsh").unwrap().read(&report.target_id).unwrap();
        assert!(!written.events.is_empty());
        unsafe {
            std::env::remove_var("DSH_HOME");
            std::env::remove_var("NIMBUS_SESSION_STATE");
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    #[ignore = "reads local sessions; run manually after quitting the target apps"]
    fn opencode_to_workbuddy() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe { std::env::set_var("NIMBUS_TEST_ALLOW_TARGET", "1"); }
        let Some(source) = pick("opencode") else { return; };
        let tmp = std::env::temp_dir().join(format!("nimbus-oc-wb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe {
            std::env::set_var("WORKBUDDY_CONFIG_DIR", &tmp);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest {
            source: "opencode".into(),
            session_id: source.id,
            target: "workbuddy".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
        }).unwrap();
        assert!(!report.target_id.is_empty());
        let written = adapter::get("workbuddy").unwrap().read(&report.target_id).unwrap();
        assert!(!written.events.is_empty());
        unsafe {
            std::env::remove_var("WORKBUDDY_CONFIG_DIR");
            std::env::remove_var("NIMBUS_SESSION_STATE");
        }
        std::fs::remove_dir_all(&tmp).ok();
    }
}

#[cfg(test)]
mod six_direction_tests {
    use super::*;
    use crate::sessions::TEST_ENV_LOCK;

    fn pick(runtime: &str) -> Option<SessionSummary> {
        adapter::get(runtime).ok()?.discover().ok()?.into_iter().find(|s| s.message_count >= 4)
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nimbus-six-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[ignore = "reads local sessions; run manually after quitting the target apps"]
    fn dsh_to_opencode() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe { std::env::set_var("NIMBUS_TEST_ALLOW_TARGET", "1"); }
        let Some(source) = pick("dsh") else { return; };
        let tmp = temp_dir("dsh-oc");
        let data = tmp.join("opencode");
        std::fs::create_dir_all(&data).unwrap();
        unsafe {
            std::env::set_var("OPENCODE_DATA_DIR", &data);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest { source: "dsh".into(), session_id: source.id, target: "opencode".into(), cwd: Some(tmp.to_string_lossy().into_owned()) }).unwrap();
        let written = adapter::get("opencode").unwrap().read(&report.target_id).unwrap();
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::UserPrompt));
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::AssistantReply));
        unsafe { std::env::remove_var("OPENCODE_DATA_DIR"); std::env::remove_var("NIMBUS_SESSION_STATE"); }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    #[ignore = "reads local sessions; run manually after quitting the target apps"]
    fn workbuddy_to_opencode() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe { std::env::set_var("NIMBUS_TEST_ALLOW_TARGET", "1"); }
        let Some(source) = pick("workbuddy") else { return; };
        let tmp = temp_dir("wb-oc");
        let data = tmp.join("opencode");
        std::fs::create_dir_all(&data).unwrap();
        unsafe {
            std::env::set_var("OPENCODE_DATA_DIR", &data);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest { source: "workbuddy".into(), session_id: source.id, target: "opencode".into(), cwd: Some(tmp.to_string_lossy().into_owned()) }).unwrap();
        let written = adapter::get("opencode").unwrap().read(&report.target_id).unwrap();
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::UserPrompt));
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::AssistantReply));
        unsafe { std::env::remove_var("OPENCODE_DATA_DIR"); std::env::remove_var("NIMBUS_SESSION_STATE"); }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    #[ignore = "reads local sessions; run manually after quitting the target apps"]
    fn opencode_to_dsh() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        unsafe { std::env::set_var("NIMBUS_TEST_ALLOW_TARGET", "1"); }
        let Some(source) = pick("opencode") else { return; };
        let tmp = temp_dir("oc-dsh");
        unsafe {
            std::env::set_var("DSH_HOME", &tmp);
            std::env::set_var("NIMBUS_SESSION_STATE", tmp.join("state.json"));
        }
        let report = migrate(MigrateRequest { source: "opencode".into(), session_id: source.id, target: "dsh".into(), cwd: Some(tmp.to_string_lossy().into_owned()) }).unwrap();
        let written = adapter::get("dsh").unwrap().read(&report.target_id).unwrap();
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::UserPrompt));
        assert!(written.events.iter().any(|event| event.kind == crate::sessions::ir::EventKind::AssistantReply));
        unsafe { std::env::remove_var("DSH_HOME"); std::env::remove_var("NIMBUS_SESSION_STATE"); }
        std::fs::remove_dir_all(&tmp).ok();
    }
}
