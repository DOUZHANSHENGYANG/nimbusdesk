//! SSEP 上游漂移检测：[source.upstream] watch=true & mode=git-scan
//! 执行 git ls-remote 比对远端 HEAD；失败容错（git 未装/无网络 → note）

use crate::ahub::skill_toml;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamReport {
    pub watched: bool,
    pub mode: String,
    pub remote: String,
    pub remote_head: String,
    pub last_head: String,
    pub changed: bool,
    pub note: String,
    pub checked_at: String,
}

pub fn check(dir: &Path) -> Result<UpstreamReport, String> {
    let doc = skill_toml::load(dir).ok_or("该技能未接入 SKILL.toml 协议")?;
    let watched = doc
        .get("source")
        .and_then(|s| s.get("upstream"))
        .and_then(|u| u.get("watch"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let mode = skill_toml::get_str(&doc, "source.upstream.mode").unwrap_or_default();
    let remote = skill_toml::get_str(&doc, "source.upstream.remote").unwrap_or_default();
    let last_head = skill_toml::get_str(&doc, "source.upstream.remote_head").unwrap_or_default();

    let base = UpstreamReport {
        watched,
        mode: mode.clone(),
        remote: remote.clone(),
        remote_head: String::new(),
        last_head,
        changed: false,
        note: String::new(),
        checked_at: crate::ahub::models::now_iso(),
    };

    if !watched {
        return Ok(UpstreamReport {
            note: "未开启上游追踪（[source.upstream].watch = false）".into(),
            ..base
        });
    }
    if mode != "git-scan" || remote.is_empty() {
        return Ok(UpstreamReport {
            note: format!("mode={mode}：本版本仅支持 git-scan + remote"),
            ..base
        });
    }

    // git ls-remote <remote> HEAD
    let out = crate::ahub::store::silent_command("git")
        .args(["ls-remote", &remote, "HEAD"])
        .output();
    let Ok(out) = out else {
        return Ok(UpstreamReport {
            note: "git 不可用（未安装或不在 PATH）".into(),
            ..base
        });
    };
    if !out.status.success() {
        return Ok(UpstreamReport {
            note: format!("git ls-remote 失败: {}", String::from_utf8_lossy(&out.stderr).trim()),
            ..base
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let head = stdout
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().next())
        .unwrap_or("")
        .to_string();
    if head.is_empty() {
        return Ok(UpstreamReport {
            note: "无法解析远端 HEAD".into(),
            ..base
        });
    }

    let changed = !base.last_head.is_empty() && base.last_head != head;
    let note = if base.last_head.is_empty() {
        "首次记录远端 HEAD".to_string()
    } else if changed {
        "上游有更新（HEAD 已变化）".to_string()
    } else {
        "上游无更新".to_string()
    };

    // 写回 [source.upstream].last_check / remote_head
    let mut doc2 = skill_toml::load(dir).unwrap_or(doc.clone());
    if let Some(src) = doc2.get_mut("source").and_then(|s| s.as_table_mut()) {
        if let Some(up) = src.get_mut("upstream").and_then(|u| u.as_table_mut()) {
            up.insert("last_check".into(), toml::Value::String(base.checked_at.clone()));
            up.insert("remote_head".into(), toml::Value::String(head.clone()));
        }
    }
    let text = toml::to_string_pretty(&doc2).map_err(|e| e.to_string())?;
    std::fs::write(skill_toml::path_for(dir), text).map_err(|e| e.to_string())?;

    Ok(UpstreamReport {
        remote_head: head,
        changed,
        note,
        ..base
    })
}
