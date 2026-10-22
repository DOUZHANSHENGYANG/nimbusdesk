//! SSEP 安装流水线：.skillpack → verify CHECKSUMS → gate → 落库 → 事件
//! （docs/SSEP.md §7.3；本期实现本地包安装，git/http fetch 后续）

use crate::ahub::skill_toml::{self, FILE};
use crate::ahub::vet;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub name: String,
    pub version: String,
    pub verdict: String, // 包内审查结果
    pub warnings: Vec<String>,
    pub path: String,
}

fn es(e: std::io::Error) -> String {
    e.to_string()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 安装一个 .skillpack 目录到中枢
pub fn install_skillpack(pack: &Path, hub_skills: &Path, overwrite: bool) -> Result<InstallReport, String> {
    if !pack.join(FILE).exists() {
        return Err("所选目录不是 .skillpack（缺少 SKILL.toml）".into());
    }
    let doc = skill_toml::load(pack).ok_or("SKILL.toml 解析失败")?;
    let name = skill_toml::get_str(&doc, "meta.name")
        .ok_or("SKILL.toml 缺少 [meta].name")?;
    let version = skill_toml::get_str(&doc, "meta.version").unwrap_or_else(|| "0.0.0".into());
    let mut warnings: Vec<String> = Vec::new();

    // 1) verify CHECKSUMS
    let checksums_path = pack.join("CHECKSUMS");
    if checksums_path.exists() {
        let text = std::fs::read_to_string(&checksums_path).map_err(es)?;
        let mut checked = 0usize;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let mut it = line.splitn(2, "  ");
            let (Some(hash), Some(rel)) = (it.next(), it.next()) else {
                return Err(format!("CHECKSUMS 行格式错误: {line}"));
            };
            let rel = rel.trim();
            let fp = pack.join(rel);
            let data = std::fs::read(&fp).map_err(|_| format!("包内缺失文件: {rel}"))?;
            let actual = sha256_hex(&data);
            if actual != hash {
                return Err(format!("校验和不匹配: {rel}"));
            }
            checked += 1;
        }
        if checked == 0 {
            warnings.push("CHECKSUMS 为空，未执行完整性校验".into());
        }
    } else {
        warnings.push("包内无 CHECKSUMS，跳过完整性校验".into());
    }

    // 2) gate：内建安全审查
    let report = vet::run(pack)?;
    if report.verdict == "REJECT" {
        return Err(format!(
            "安全审查阻断（{}）：critical={}, high={} —— 请人工检查后再安装",
            report.verdict, report.critical, report.high
        ));
    }
    if report.verdict == "REVIEW" {
        warnings.push(format!(
            "安全审查需人工确认（REVIEW）：critical={}, high={}, medium={}",
            report.critical, report.high, report.medium
        ));
    }

    // 2.5) deps 依赖解析（缺失/不满足 → warning，不阻断）
    if let Some(deps) = doc.get("deps").and_then(|d| d.get("item")).and_then(|i| i.as_array()) {
        for d in deps {
            let dname = d.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if dname.is_empty() { continue; }
            let req = d.get("semver").and_then(|x| x.as_str()).unwrap_or("");
            let dst_dep = hub_skills.join(dname);
            let have = crate::ahub::skill_toml::load(&dst_dep)
                .and_then(|dd| crate::ahub::skill_toml::get_str(&dd, "meta.version"));
            match have {
                None => warnings.push(format!("缺少依赖技能: {dname}（semver: {req}）")),
                Some(hv) => {
                    if !semver_satisfies(&hv, req) {
                        warnings.push(format!("依赖版本不满足: {dname} 当前 {hv}，要求 {req}"));
                    }
                }
            }
        }
    }

    // 3) STALE 提示（包自带 vet 时不一致）
    if let Some(vh) = skill_toml::get_str(&doc, "vet.content_hash") {
        if !vh.is_empty() {
            let th = skill_toml::tree_hash(pack)?;
            if th != vh {
                warnings.push("包内容与 vet.content_hash 不一致（STALE），建议安装后重新审查".into());
            }
        }
    }

    // 4) 落库
    let dst = hub_skills.join(&name);
    if dst.exists() {
        if !overwrite {
            return Err(format!("exists: {name}"));
        }
        std::fs::remove_dir_all(&dst).map_err(es)?;
    }
    std::fs::create_dir_all(hub_skills).map_err(es)?;
    copy_tree(pack, &dst)?;

    // 5) 事件
    let th = skill_toml::tree_hash(&dst).unwrap_or_default();
    skill_toml::append_event(&dst, "install", "", &format!(".skillpack v{version}"), &th)?;

    Ok(InstallReport {
        name,
        version,
        verdict: report.verdict,
        warnings,
        path: dst.to_string_lossy().into_owned(),
    })
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(es)?;
    for entry in std::fs::read_dir(src).map_err(es)? {
        let entry = entry.map_err(es)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".agenthub-") {
            continue;
        }
        let s = entry.path();
        let d = dst.join(&name);
        if s.is_dir() {
            copy_tree(&s, &d)?;
        } else {
            std::fs::copy(&s, &d).map_err(es)?;
        }
    }
    Ok(())
}

/// 极简 semver 区间判定：支持 "", ">=", ">", "=", "==" 前缀（缺失补 .0）
fn semver_satisfies(have: &str, req: &str) -> bool {
    let req = req.trim();
    if req.is_empty() { return true; }
    let (op, rest) = if let Some(r) = req.strip_prefix(">=") { (">=", r) }
        else if let Some(r) = req.strip_prefix(">") { (">", r) }
        else if let Some(r) = req.strip_prefix("==") { ("=", r) }
        else if let Some(r) = req.strip_prefix("=") { ("=", r) }
        else { ("=", req) };
    let parse = |v: &str| -> Vec<u32> {
        let mut parts: Vec<u32> = v.split('.').map(|x| x.trim().parse().unwrap_or(0)).collect();
        while parts.len() < 3 { parts.push(0); }
        parts
    };
    let (h, r) = (parse(have), parse(rest));
    match op {
        ">=" => h >= r,
        ">" => h > r,
        _ => h == r,
    }
}
