//! SKILL.toml — SSEP v1.1 扩展协议核心（见 docs/SSEP.md）
//!
//! 职责：CORE 生成/读取、lifecycle 事件追加、文件树哈希（STALE 判定）、
//! version bump。所有写操作保留既有未知 section（渐进增强）。

use crate::ahub::models::{new_id, now_iso};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const FILE: &str = "SKILL.toml";

fn new_table() -> toml::Value {
    toml::Value::Table(toml::value::Table::new())
}

pub fn path_for(dir: &Path) -> std::path::PathBuf {
    dir.join(FILE)
}

/// 读取 SKILL.toml；不存在或解析失败 → None（渐进增强：视为最小态）
pub fn load(dir: &Path) -> Option<toml::Value> {
    let text = std::fs::read_to_string(path_for(dir)).ok()?;
    toml::from_str(&text).ok()
}

pub fn save(dir: &Path, doc: &toml::Value) -> Result<(), String> {
    let text = toml::to_string_pretty(doc).map_err(|e| e.to_string())?;
    std::fs::write(path_for(dir), text).map_err(|e| e.to_string())
}

/// 点路径取字符串，如 "meta.version"、"vet.content_hash"
pub fn get_str<'a>(doc: &'a toml::Value, path: &str) -> Option<String> {
    let mut cur = doc;
    let parts: Vec<&str> = path.split('.').collect();
    for (i, p) in parts.iter().enumerate() {
        match cur.get(p) {
            Some(v) if i == parts.len() - 1 => return v.as_str().map(String::from),
            Some(v) => cur = v,
            None => return None,
        }
    }
    None
}

/// 确保嵌套 table 存在并返回（保留既有内容）
fn table_mut<'a>(root: &'a mut toml::Value, key: &str) -> &'a mut toml::value::Table {
    if !root.is_table() {
        *root = new_table();
    }
    let t = root.as_table_mut().unwrap();
    let v = t
        .entry(key.to_string())
        .or_insert_with(new_table);
    if !v.is_table() {
        *v = new_table();
    }
    v.as_table_mut().unwrap()
}

/// CORE 生成/同步（幂等）：缺 [meta]/[source] 则补齐；name 始终同步。
/// 已有 SKILL.toml 时不动 version/status/其他 section。
pub fn ensure_core(dir: &Path, name: &str, source_kind: &str, source_ref: &str) -> Result<(), String> {
    let mut doc = load(dir).unwrap_or_else(new_table);
    if !doc.is_table() {
        doc = new_table();
    }

    let meta = table_mut(&mut doc, "meta");
    meta.entry("protocol".to_string())
        .or_insert(toml::Value::Integer(1));
    meta.entry("id".to_string())
        .or_insert_with(|| toml::Value::String(new_id()));
    meta.insert("name".into(), toml::Value::String(name.to_string()));
    meta.entry("version".to_string())
        .or_insert(toml::Value::String("0.1.0".into()));
    meta.entry("status".to_string())
        .or_insert(toml::Value::String("active".into()));

    let src = table_mut(&mut doc, "source");
    src.entry("kind".to_string())
        .or_insert(toml::Value::String(source_kind.to_string()));
    src.entry("ref".to_string())
        .or_insert(toml::Value::String(source_ref.to_string()));
    src.entry("fetched_at".to_string())
        .or_insert(toml::Value::String(now_iso()));

    save(dir, &doc)
}

/// 追加 lifecycle.event（append-only）
pub fn append_event(dir: &Path, action: &str, level: &str, note: &str, hash: &str) -> Result<(), String> {
    let mut doc = load(dir).unwrap_or_else(new_table);
    let lifecycle = table_mut(&mut doc, "lifecycle");
    if !lifecycle.contains_key("event") {
        lifecycle.insert("event".into(), toml::Value::Array(Vec::new()));
    }
    let Some(arr) = lifecycle.get_mut("event").and_then(|v| v.as_array_mut()) else {
        return Err("lifecycle.event is not an array".into());
    };

    let mut ev = toml::value::Table::new();
    ev.insert("at".into(), toml::Value::String(now_iso()));
    ev.insert("action".into(), toml::Value::String(action.to_string()));
    if !level.is_empty() {
        ev.insert("level".into(), toml::Value::String(level.to_string()));
    }
    if !note.is_empty() {
        ev.insert("note".into(), toml::Value::String(note.to_string()));
    }
    if !hash.is_empty() {
        ev.insert("hash".into(), toml::Value::String(hash.to_string()));
    }
    arr.push(toml::Value::Table(ev));
    save(dir, &doc)
}

/// 版本 patch bump（"1.2.3" → "1.2.4"；非法格式 → "0.0.1"）
pub fn bump_patch(version: &str) -> String {
    let mut parts: Vec<u32> = version
        .split('.')
        .map(|p| p.trim().parse().unwrap_or(0))
        .collect();
    if parts.len() != 3 {
        return "0.0.1".into();
    }
    parts[2] += 1;
    format!("{}.{}.{}", parts[0], parts[1], parts[2])
}

/// 更新 [meta].version（工具专用；配合 lifecycle.event 记录级别）
pub fn set_version(dir: &Path, version: &str) -> Result<(), String> {
    let mut doc = load(dir).unwrap_or_else(new_table);
    table_mut(&mut doc, "meta").insert("version".into(), toml::Value::String(version.to_string()));
    save(dir, &doc)
}

/// 文件树哈希：排除 SKILL.toml 自身、.hub.json、*.agenthub-*；
/// 按相对路径排序，sha256(rel_path ⊥ 0x00 ⊥ sha256(content))
pub fn tree_hash(dir: &Path) -> Result<String, String> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".agenthub-") || name == ".hub.json" || name == FILE {
                continue;
            }
            let p = entry.path();
            let rel = base
                .join(&name)
                .to_string_lossy()
                .replace('\\', "/");
            if p.is_dir() {
                walk(&p, &base.join(&name), out)?;
            } else {
                let data = std::fs::read(&p).map_err(|e| e.to_string())?;
                let mut h = Sha256::new();
                h.update(&data);
                let fh = hex(&h.finalize());
                out.push((rel, fh));
            }
        }
        Ok(())
    }

    let mut items: Vec<(String, String)> = Vec::new();
    walk(dir, Path::new(""), &mut items)?;
    items.sort();
    let mut h = Sha256::new();
    for (rel, fh) in &items {
        h.update(rel.as_bytes());
        h.update([0u8]);
        h.update(fh.as_bytes());
    }
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// STALE 判定：[vet].content_hash 存在且 ≠ 当前树哈希
pub fn is_stale(dir: &Path) -> bool {
    let Some(doc) = load(dir) else { return false };
    let Some(vet_hash) = get_str(&doc, "vet.content_hash") else {
        return false;
    };
    if vet_hash.is_empty() {
        return false;
    }
    tree_hash(dir).map(|th| th != vet_hash).unwrap_or(false)
}

// ===================== SSEP 工具链：validate / status / pack =====================

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub rule: String,
    pub severity: String, // error | warning | info
    pub message: String,
}

fn is_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_sha256(v: &str) -> bool {
    v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit())
}

/// 协议校验（docs/SSEP.md §9）；无 SKILL.toml → 单条 info 提示
pub fn validate(dir: &Path) -> Result<Vec<Violation>, String> {
    let mut out: Vec<Violation> = Vec::new();
    let Some(doc) = load(dir) else {
        out.push(Violation {
            rule: "SSEP-CORE".into(),
            severity: "info".into(),
            message: "未接入协议（无 SKILL.toml）：视为最小态 version=0.0.0 / status=draft".into(),
        });
        return Ok(out);
    };

    // protocol
    let protocol = doc.get("meta").and_then(|m| m.get("protocol")).and_then(|v| v.as_integer());
    if protocol != Some(1) {
        out.push(Violation {
            rule: "SSEP-META-PROTOCOL".into(),
            severity: "error".into(),
            message: format!("protocol 必须为 1，当前为 {:?}", protocol),
        });
    }

    // version semver
    let version = get_str(&doc, "meta.version").unwrap_or_default();
    if version.is_empty() {
        out.push(Violation {
            rule: "SSEP-META-VERSION".into(),
            severity: "error".into(),
            message: "[meta].version 缺失".into(),
        });
    } else if !is_semver(&version) {
        out.push(Violation {
            rule: "SSEP-META-VERSION".into(),
            severity: "error".into(),
            message: format!("version 不是合法 semver: {version}"),
        });
    }

    // status 枚举
    let status = get_str(&doc, "meta.status").unwrap_or_default();
    const STATUSES: [&str; 4] = ["draft", "active", "deprecated", "archived"];
    if !STATUSES.contains(&status.as_str()) {
        out.push(Violation {
            rule: "SSEP-META-STATUS".into(),
            severity: "error".into(),
            message: format!("status 非法: {status}（允许 draft/active/deprecated/archived）"),
        });
    }

    // vet.content_hash
    let vet_hash = get_str(&doc, "vet.content_hash").unwrap_or_default();
    if !vet_hash.is_empty() && !is_sha256(&vet_hash) {
        out.push(Violation {
            rule: "SSEP-VET-HASH".into(),
            severity: "error".into(),
            message: "vet.content_hash 不是 64 位十六进制".into(),
        });
    }

    // deprecated → superseded_by 或事件 note
    if status == "deprecated" {
        let superseded = get_str(&doc, "meta.superseded_by").unwrap_or_default();
        let has_note = doc
            .get("lifecycle")
            .and_then(|l| l.get("event"))
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter().any(|ev| {
                    ev.get("action").and_then(|a| a.as_str()) == Some("deprecate")
                        && ev.get("note").and_then(|n| n.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if superseded.is_empty() && !has_note {
            out.push(Violation {
                rule: "SSEP-DEPRECATED".into(),
                severity: "warning".into(),
                message: "deprecated 状态需要 meta.superseded_by 或 deprecate 事件注明后继".into(),
            });
        }
    }

    // lifecycle 时间戳单调递增
    let timestamps: Vec<String> = doc
        .get("lifecycle")
        .and_then(|l| l.get("event"))
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ev| ev.get("at").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    for w in timestamps.windows(2) {
        if w[1] < w[0] {
            out.push(Violation {
                rule: "SSEP-LIFECYCLE-ORDER".into(),
                severity: "error".into(),
                message: "lifecycle.event 时间戳必须单调递增".into(),
            });
            break;
        }
    }

    // STALE
    if !vet_hash.is_empty() {
        let th = tree_hash(dir)?;
        if th != vet_hash {
            out.push(Violation {
                rule: "SSEP-STALE".into(),
                severity: "warning".into(),
                message: "STALE：文件树哈希与 vet.content_hash 不一致，部署/分发前需重新审查".into(),
            });
        }
    }

    Ok(out)
}

/// 状态机操作：设置 [meta].status（可附 superseded_by），并追加事件
pub fn set_status(dir: &Path, status: &str, superseded_by: &str) -> Result<(), String> {
    const STATUSES: [&str; 4] = ["draft", "active", "deprecated", "archived"];
    if !STATUSES.contains(&status) {
        return Err(format!("非法状态: {status}"));
    }
    let mut doc = load(dir).unwrap_or_else(new_table);
    let meta = table_mut(&mut doc, "meta");
    meta.insert("status".into(), toml::Value::String(status.to_string()));
    if !superseded_by.is_empty() {
        meta.insert("superseded_by".into(), toml::Value::String(superseded_by.to_string()));
    } else {
        meta.remove("superseded_by");
    }
    save(dir, &doc)?;
    let h = tree_hash(dir).unwrap_or_default();
    append_event(dir, status, "", "", &h)
}

/// 打包 .skillpack：剥离 [deploy]/[distribution]，生成 CHECKSUMS
/// 返回包目录路径
pub fn pack(dir: &Path, out_dir: &Path) -> Result<std::path::PathBuf, String> {
    let doc = load(dir).ok_or("该技能没有 SKILL.toml，无法打包（P0 minimal 之前）")?;
    let name = get_str(&doc, "meta.name").unwrap_or_else(|| {
        dir.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
    });
    let version = get_str(&doc, "meta.version").unwrap_or_else(|| "0.0.0".into());
    if name.is_empty() {
        return Err("无法确定技能名".into());
    }

    // 剥离 ENV 层
    let mut packed = doc.clone();
    if let Some(t) = packed.as_table_mut() {
        t.remove("deploy");
        t.remove("distribution");
    }

    let target = out_dir.join(format!("{name}-{version}.skillpack"));
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(es_io)?;
    }
    std::fs::create_dir_all(&target).map_err(es_io)?;

    // 复制文件（排除 .hub.json / *.agenthub-*；SKILL.toml 用剥离后的）
    let mut checksums: Vec<(String, String)> = Vec::new();
    copy_pack_tree(dir, &target, &mut checksums)?;

    // 写剥离后的 SKILL.toml
    let toml_text = toml::to_string_pretty(&packed).map_err(|e| e.to_string())?;
    std::fs::write(target.join(FILE), &toml_text).map_err(es_io)?;
    {
        let mut h = Sha256::new();
        h.update(toml_text.as_bytes());
        checksums.push((FILE.to_string(), hex(&h.finalize())));
    }

    // CHECKSUMS（排序）
    checksums.sort();
    let mut text = String::new();
    for (rel, hash) in &checksums {
        text.push_str(&format!("{hash}  {rel}\n"));
    }
    std::fs::write(target.join("CHECKSUMS"), &text).map_err(es_io)?;

    // 记录打包事件（写回原目录的 SKILL.toml）
    let mut doc2 = load(dir).unwrap_or_else(new_table);
    {
        let dist = table_mut(&mut doc2, "distribution");
        let mut h = Sha256::new();
        h.update(text.as_bytes());
        dist.insert("pack_hash".into(), toml::Value::String(hex(&h.finalize())));
        dist.insert("packed_at".into(), toml::Value::String(now_iso()));
    }
    save(dir, &doc2)?;
    append_event(dir, "pack", "", &format!("{}", target.display()), "")?;

    Ok(target)
}
/// 打包前的规范性检查（SSEP §7.1 分发约定）。
/// 返回 (name, version, warnings)。硬性不合规直接 Err。
pub fn check_pack_ready(dir: &Path) -> Result<(String, String, Vec<String>), String> {
    let doc = load(dir).ok_or_else(|| {
        "尚未接入 SKILL.toml 协议：请先生成协议档案（分发要求 CORE 完整）".to_string()
    })?;
    let mut warnings: Vec<String> = Vec::new();

    // 1) [meta].name 必备
    let name = get_str(&doc, "meta.name").unwrap_or_default();
    if name.trim().is_empty() {
        return Err("[meta].name 缺失，无法确定包名".into());
    }

    // 2) [meta].version 必须合法 semver（分发靠它定位版本）
    let version = get_str(&doc, "meta.version").unwrap_or_default();
    if version.is_empty() || !is_semver(&version) {
        return Err(format!("[meta].version 不是合法 semver: {version:?}（分发需要可定位的版本号）"));
    }
    if version == "0.0.0" {
        warnings.push("版本号为 0.0.0（未正式定版），建议先在「版本」页发布一个版本".into());
    }

    // 3) status：draft 不适合对外分发（SSEP §5 状态机）
    let status = get_str(&doc, "meta.status").unwrap_or_default();
    if status == "draft" {
        warnings.push("状态为 draft（草稿）：SSEP 约定 draft 不对外分发，建议先设为 active".into());
    } else if status == "deprecated" {
        warnings.push("状态为 deprecated（已弃用）：仍可分发，但使用方应迁移到后继技能".into());
    } else if status == "archived" {
        warnings.push("状态为 archived（已归档）：通常不应再分发".into());
    }

    // 4) 正文必备
    if !dir.join("SKILL.md").exists() {
        return Err("缺少 SKILL.md".into());
    }

    // 5) 依赖声明自洽性（仅提示）
    if let Some(arr) = doc.get("deps").and_then(|d| d.get("item")).and_then(|v| v.as_array()) {
        for it in arr {
            let dn = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if dn.is_empty() {
                warnings.push("存在未填写名称的依赖声明".into());
                break;
            }
        }
    }

    // 6) 审查新鲜度（STALE 时包内 [vet] 已过期）
    if is_stale(dir) {
        warnings.push("内容在审查后已变更（STALE）：包内 [vet] 结论已过期，建议重新审查后再分发".into());
    }

    Ok((name, version, warnings))
}
fn es_io(e: std::io::Error) -> String {
    e.to_string()
}

/// 复制打包树（排除 SKILL.toml/.hub.json/*.agenthub-*/CHECKSUMS），收集校验和
fn copy_pack_tree(dir: &Path, target: &Path, checksums: &mut Vec<(String, String)>) -> Result<(), String> {
    fn walk(src: &Path, dst: &Path, rel: &Path, checksums: &mut Vec<(String, String)>) -> Result<(), String> {
        std::fs::create_dir_all(dst).map_err(es_io)?;
        for entry in std::fs::read_dir(src).map_err(es_io)? {
            let entry = entry.map_err(es_io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == FILE || name == ".hub.json" || name == "CHECKSUMS" || name.starts_with(".agenthub-") {
                continue;
            }
            let s = entry.path();
            let r = rel.join(&name);
            let d = dst.join(&name);
            if s.is_dir() {
                walk(&s, &d, &r, checksums)?;
            } else {
                let data = std::fs::read(&s).map_err(es_io)?;
                let mut h = Sha256::new();
                h.update(&data);
                let hash = hex(&h.finalize());
                let rel_str = r.to_string_lossy().replace('\\', "/");
                checksums.push((rel_str, hash));
                std::fs::write(&d, &data).map_err(es_io)?;
            }
        }
        Ok(())
    }
    walk(dir, target, Path::new(""), checksums)
}

/// minor bump（"1.2.3" → "1.3.0"）
pub fn bump_minor(version: &str) -> String {
    let mut parts: Vec<u32> = version.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect();
    if parts.len() != 3 { return "0.1.0".into(); }
    parts[1] += 1;
    parts[2] = 0;
    format!("{}.{}.{}", parts[0], parts[1], parts[2])
}

/// major bump（"1.2.3" → "2.0.0"）
pub fn bump_major(version: &str) -> String {
    let mut parts: Vec<u32> = version.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect();
    if parts.len() != 3 { return "1.0.0".into(); }
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
    format!("{}.{}.{}", parts[0], parts[1], parts[2])
}

// ===================== SSEP 模块编辑（§4 权限矩阵：人写区） =====================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepItem {
    pub name: String,
    #[serde(default)]
    pub semver: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCfg {
    #[serde(default = "rt_scripts")]
    pub requires_scripts: String,
    #[serde(default = "rt_network")]
    pub requires_network: String,
    #[serde(default = "rt_minproto")]
    pub min_protocol: i64,
    #[serde(default)]
    pub config: String,
}
fn rt_scripts() -> String { "none".into() }
fn rt_network() -> String { "none".into() }
fn rt_minproto() -> i64 { 1 }

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCfg {
    #[serde(default)]
    pub watch: bool,
    #[serde(default = "up_mode")]
    pub mode: String,
    #[serde(default)]
    pub remote: String,
}
fn up_mode() -> String { "manual".into() }

/// 更新可选模块 [deps]/[runtime]/[source.upstream]（人写权限区）
pub fn update_ext(
    dir: &Path,
    deps: Option<Vec<DepItem>>,
    runtime: Option<RuntimeCfg>,
    upstream: Option<UpstreamCfg>,
) -> Result<(), String> {
    let mut doc = load(dir).ok_or("该技能未接入 SKILL.toml 协议")?;
    if !doc.is_table() {
        return Err("SKILL.toml root is not a table".into());
    }

    if let Some(deps) = deps {
        let arr: Vec<toml::Value> = deps
            .iter()
            .map(|d| {
                let mut t = toml::value::Table::new();
                t.insert("name".into(), toml::Value::String(d.name.clone()));
                t.insert("semver".into(), toml::Value::String(d.semver.clone()));
                t.insert("reason".into(), toml::Value::String(d.reason.clone()));
                toml::Value::Table(t)
            })
            .collect();
        let mut sec = toml::value::Table::new();
        sec.insert("item".into(), toml::Value::Array(arr));
        doc.as_table_mut()
            .unwrap()
            .insert("deps".into(), toml::Value::Table(sec));
    }

    if let Some(rt) = runtime {
        let mut t = toml::value::Table::new();
        t.insert("requires_scripts".into(), toml::Value::String(rt.requires_scripts));
        t.insert("requires_network".into(), toml::Value::String(rt.requires_network));
        t.insert("min_protocol".into(), toml::Value::Integer(rt.min_protocol));
        t.insert("config".into(), toml::Value::String(rt.config));
        doc.as_table_mut()
            .unwrap()
            .insert("runtime".into(), toml::Value::Table(t));
    }

    if let Some(up) = upstream {
        let src = table_mut(&mut doc, "source");
        let mut t = toml::value::Table::new();
        t.insert("watch".into(), toml::Value::Boolean(up.watch));
        t.insert("mode".into(), toml::Value::String(up.mode));
        t.insert("remote".into(), toml::Value::String(up.remote));
        src.insert("upstream".into(), toml::Value::Table(t));
    }

    save(dir, &doc)?;
    append_event(dir, "update", "", "更新协议模块配置", "")
}
