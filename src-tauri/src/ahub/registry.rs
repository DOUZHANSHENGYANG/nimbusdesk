//! SSEP 仓库安装：index.json 解析 + resolve/fetch + 完整性校验 + 批量安装
//! （docs/SSEP.md §7.2/§7.3；本期 ref 支持本地路径 / file://；git+http 后续）

use crate::ahub::install::{self, InstallReport};
use crate::ahub::skill_toml;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub name: String,
    pub version: String,
    pub hash: String,
    pub r#ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedIndex {
    pub base: String,
    pub entries: Vec<IndexEntry>,
}

fn es(e: std::io::Error) -> String {
    e.to_string()
}

/// 解析 index.json。兼容两种形态：
/// 单技能：{ name, versions: { "<ver>": { hash, ref } } }
/// 仓库：  { skills: [ { name, versions: {...} }, ... ] }
pub fn parse_index(index_path: &Path) -> Result<ResolvedIndex, String> {
    let p = if index_path.is_dir() {
        index_path.join("index.json")
    } else {
        index_path.to_path_buf()
    };
    if !p.exists() {
        return Err(format!("index.json 不存在: {}", p.display()));
    }
    let text = std::fs::read_to_string(&p).map_err(es)?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("index.json 解析失败: {e}"))?;
    let base = p.parent().unwrap_or(Path::new(".")).to_path_buf();

    let mut entries: Vec<IndexEntry> = Vec::new();
    let mut push_skill = |name: &str, versions: &serde_json::Value| {
        if let Some(map) = versions.as_object() {
            for (ver, meta) in map {
                entries.push(IndexEntry {
                    name: name.to_string(),
                    version: ver.clone(),
                    hash: meta.get("hash").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    r#ref: meta.get("ref").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                });
            }
        }
    };

    match &v {
        serde_json::Value::Object(obj) => {
            if let Some(skills) = obj.get("skills").and_then(|x| x.as_array()) {
                for sk in skills {
                    let name = sk.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    push_skill(name, sk.get("versions").unwrap_or(&serde_json::Value::Null));
                }
            } else if let Some(name) = obj.get("name").and_then(|x| x.as_str()) {
                push_skill(name, obj.get("versions").unwrap_or(&serde_json::Value::Null));
            }
        }
        _ => return Err("index.json 结构无法识别".into()),
    }

    if entries.is_empty() {
        return Err("index.json 中没有可用条目".into());
    }
    Ok(ResolvedIndex {
        base: base.to_string_lossy().into_owned(),
        entries,
    })
}

fn resolve_ref(r: &str, base: &Path) -> Result<PathBuf, String> {
    let raw = r.strip_prefix("file://").unwrap_or(r);
    let p = PathBuf::from(raw);
    let resolved = if p.is_absolute() {
        p
    } else {
        base.join(p)
    };
    if !resolved.join(skill_toml::FILE).exists() {
        return Err(format!("ref 指向的目录缺少 SKILL.toml: {r}"));
    }
    Ok(resolved)
}

/// 从 index 安装指定条目：resolve → 完整性（tree_hash vs index.hash）→ 复用安装流水线
pub fn install_from_index(
    index_path: &Path,
    name: &str,
    version: &str,
    hub_skills: &Path,
    overwrite: bool,
) -> Result<InstallReport, String> {
    let idx = parse_index(index_path)?;
    let entry = idx
        .entries
        .iter()
        .find(|e| e.name == name && e.version == version)
        .ok_or_else(|| format!("index 中未找到: {name}@{version}"))?;

    let pack = resolve_ref(&entry.r#ref, Path::new(&idx.base))?;

    // 完整性：index.hash 是发布时的树哈希
    if !entry.hash.is_empty() {
        let th = skill_toml::tree_hash(&pack)?;
        if th != entry.hash {
            return Err(format!("完整性校验失败：{name}@{version} 树哈希与 index.json 不符"));
        }
    }

    let mut report = install::install_skillpack(&pack, hub_skills, overwrite)?;
    if !entry.hash.is_empty() {
        report.warnings.push("已按 index.json 校验树哈希".into());
    }
    Ok(report)
}
