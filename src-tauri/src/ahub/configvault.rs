//! 配置版本库（Config Vault）：为各 AI 工具的配置文件提供版本管理、每日自动备份与一键恢复。
//!
//! 设计要点：
//! - 只读快照：每次备份把配置文件**原样复制**到 vault，不改动原文件
//! - 内容哈希：用 sha2 记录，可判断"当前文件是否偏离最新快照"
//! - 恢复前自动兜底：恢复旧版本前，先把当前内容存为一个新快照，避免恢复本身造成丢失
//! - 每日备份：按本地日期判断，每天首次触发时给所有受管文件各打一个快照

use crate::ahub::harness;
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigVersion {
    pub v: u32,
    pub saved_at: String,
    pub hash: String,
    pub size: u64,
    /// manual | daily | auto | pre-restore
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub harness: String,
    pub name: String,
    pub path: String,
    pub versions: Vec<ConfigVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndex {
    /// 受版本管理的工具 id
    #[serde(default)]
    pub watched: Vec<String>,
    /// 是否启用每日自动备份
    #[serde(default)]
    pub daily: bool,
    /// 上次每日备份的本地日期（YYYY-MM-DD）
    #[serde(default)]
    pub last_daily: String,
    #[serde(default)]
    pub entries: Vec<VaultEntry>,
}

/// 单个受管文件的状态（供前端展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub harness: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub watched: bool,
    pub version_count: usize,
    pub last_saved_at: String,
    /// 当前文件是否与最新快照一致（false = 有未备份的改动）
    pub up_to_date: bool,
    /// 当前文件内容哈希
    pub current_hash: String,
}

fn vault_root(app: &AppH) -> PathBuf {
    store::data_root(app).join("config-vault")
}

fn index_path(app: &AppH) -> PathBuf {
    vault_root(app).join("index.json")
}

fn files_dir(app: &AppH) -> PathBuf {
    vault_root(app).join("files")
}

fn load_index(app: &AppH) -> VaultIndex {
    store::read_json::<VaultIndex>(&index_path(app)).unwrap_or_default()
}

fn save_index(app: &AppH, idx: &VaultIndex) -> Result<(), String> {
    store::write_json(&index_path(app), idx)
}

fn sha256_text(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 解析某工具的配置文件路径（复用 harness 的定义）
fn resolve_path(app: &AppH, harness_id: &str) -> Result<(String, PathBuf), String> {
    harness::config_target(app, harness_id)
}

/// 给某工具当前配置打一个快照
fn snapshot_inner(app: &AppH, idx: &mut VaultIndex, harness_id: &str, kind: &str) -> Result<ConfigVersion, String> {
    let (name, path) = resolve_path(app, harness_id)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let hash = sha256_text(&text);

    let entry = idx
        .entries
        .iter_mut()
        .find(|e| e.harness == harness_id);
    let entry = match entry {
        Some(e) => e,
        None => {
            idx.entries.push(VaultEntry {
                harness: harness_id.to_string(),
                name: name.clone(),
                path: path.to_string_lossy().into_owned(),
                versions: vec![],
            });
            idx.entries.last_mut().unwrap()
        }
    };
    // 内容未变则不重复记录
    if let Some(last) = entry.versions.last() {
        if last.hash == hash {
            return Ok(last.clone());
        }
    }
    let v = entry.versions.last().map(|x| x.v + 1).unwrap_or(1);
    let dir = files_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("txt");
    let file = dir.join(format!("{harness_id}-v{v}.{ext}"));
    std::fs::write(&file, &text).map_err(|e| e.to_string())?;

    let cv = ConfigVersion {
        v,
        saved_at: crate::ahub::models::now_iso(),
        hash,
        size: text.len() as u64,
        kind: kind.to_string(),
    };
    entry.versions.push(cv.clone());
    entry.path = path.to_string_lossy().into_owned();
    entry.name = name;
    Ok(cv)
}

// ---------------- 对外命令实现 ----------------

/// 已安装的 harness 数量（供侧边栏计数，轻量）
pub fn installed_count(app: &AppH) -> usize {
    harness::mcp_capable(app)
        .into_iter()
        .filter(|(id, _)| {
            harness::config_target(app, id)
                .map(|(_, p)| p.exists())
                .unwrap_or(false)
        })
        .count()
}

/// 列出所有 harness 的版本管理状态（已安装的排前面，再按名称）
pub fn status(app: &AppH) -> Vec<VaultStatus> {
    let idx = load_index(app);
    let mut out: Vec<VaultStatus> = harness::mcp_capable(app)
        .into_iter()
        .map(|(id, name)| {
            let (_, path) = match resolve_path(app, &id) {
                Ok(x) => x,
                Err(_) => (name.clone(), PathBuf::new()),
            };
            let exists = path.exists();
            let current_hash = if exists {
                std::fs::read_to_string(&path).map(|t| sha256_text(&t)).unwrap_or_default()
            } else {
                String::new()
            };
            let entry = idx.entries.iter().find(|e| e.harness == id);
            let last_hash = entry.and_then(|e| e.versions.last()).map(|v| v.hash.clone()).unwrap_or_default();
            VaultStatus {
                harness: id.clone(),
                name,
                path: path.to_string_lossy().into_owned(),
                exists,
                watched: idx.watched.contains(&id),
                version_count: entry.map(|e| e.versions.len()).unwrap_or(0),
                last_saved_at: entry
                    .and_then(|e| e.versions.last())
                    .map(|v| v.saved_at.clone())
                    .unwrap_or_default(),
                up_to_date: exists && !last_hash.is_empty() && last_hash == current_hash,
                current_hash,
            }
        })
        .collect();
    // 已安装优先，其次按名称
    out.sort_by(|a, b| {
        b.exists
            .cmp(&a.exists)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

pub fn index(app: &AppH) -> VaultIndex {
    load_index(app)
}

/// 设置受版本管理的工具列表
pub fn set_watched(app: &AppH, watched: Vec<String>) -> Result<VaultIndex, String> {
    let mut idx = load_index(app);
    idx.watched = watched;
    save_index(app, &idx)?;
    Ok(idx)
}

pub fn set_daily(app: &AppH, daily: bool) -> Result<VaultIndex, String> {
    let mut idx = load_index(app);
    idx.daily = daily;
    save_index(app, &idx)?;
    Ok(idx)
}

/// 手动/批量打快照
pub fn snapshot(app: &AppH, harness_ids: &[String], kind: &str) -> Result<Vec<ConfigVersion>, String> {
    let mut idx = load_index(app);
    let mut out = Vec::new();
    for id in harness_ids {
        match snapshot_inner(app, &mut idx, id, kind) {
            Ok(v) => out.push(v),
            Err(e) => {
                // 单个失败不阻断其余
                eprintln!("snapshot {id} failed: {e}");
            }
        }
    }
    save_index(app, &idx)?;
    Ok(out)
}

/// 每日自动备份：当天首次调用时为所有受管文件打快照
pub fn maybe_daily(app: &AppH) -> Result<usize, String> {
    let mut idx = load_index(app);
    if !idx.daily {
        return Ok(0);
    }
    let today = today();
    if idx.last_daily == today {
        return Ok(0);
    }
    let ids = idx.watched.clone();
    let mut n = 0;
    for id in &ids {
        if snapshot_inner(app, &mut idx, id, "daily").is_ok() {
            n += 1;
        }
    }
    idx.last_daily = today;
    save_index(app, &idx)?;
    Ok(n)
}

/// 写入前自动快照（仅当该工具受管时）
pub fn auto_snapshot(app: &AppH, harness_id: &str) -> Result<(), String> {
    let mut idx = load_index(app);
    if !idx.watched.contains(&harness_id.to_string()) {
        return Ok(());
    }
    let _ = snapshot_inner(app, &mut idx, harness_id, "auto");
    save_index(app, &idx)?;
    Ok(())
}

/// 读取某版本内容（用于预览）
pub fn read_version(app: &AppH, harness_id: &str, v: u32) -> Result<String, String> {
    let idx = load_index(app);
    let entry = idx
        .entries
        .iter()
        .find(|e| e.harness == harness_id)
        .ok_or("该工具没有版本记录")?;
    if !entry.versions.iter().any(|x| x.v == v) {
        return Err("版本不存在".into());
    }
    let ext = Path::new(&entry.path).extension().and_then(|e| e.to_str()).unwrap_or("txt");
    let file = files_dir(app).join(format!("{harness_id}-v{v}.{ext}"));
    std::fs::read_to_string(&file).map_err(|e| format!("读取快照失败: {e}"))
}

/// 恢复到某版本（恢复前先把当前内容存为新快照）
pub fn restore(app: &AppH, harness_id: &str, v: u32) -> Result<String, String> {
    let (_, path) = resolve_path(app, harness_id)?;
    let text = read_version(app, harness_id, v)?;
    // 语法校验
    harness::validate_config_text(app, harness_id, &text)?;
    // 兜底：当前内容先存一份
    let mut idx = load_index(app);
    let _ = snapshot_inner(app, &mut idx, harness_id, "pre-restore");
    save_index(app, &idx)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 清空版本记录（指定工具；为空则清空全部）
pub fn clear(app: &AppH, harness_ids: &[String]) -> Result<(), String> {
    let mut idx = load_index(app);
    let dir = files_dir(app);
    let targets: Vec<String> = if harness_ids.is_empty() {
        idx.entries.iter().map(|e| e.harness.clone()).collect()
    } else {
        harness_ids.to_vec()
    };
    for id in &targets {
        // 删除该工具的所有快照文件
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for ent in rd.flatten() {
                let n = ent.file_name().to_string_lossy().into_owned();
                if n.starts_with(&format!("{id}-v")) {
                    let _ = std::fs::remove_file(ent.path());
                }
            }
        }
    }
    idx.entries.retain(|e| !targets.contains(&e.harness));
    save_index(app, &idx)
}
