//! SSEP 内建轻量安全审查引擎（vet）
//!
//! 独立实现，不依赖外部 CLI。8 条核心规则 + 文档文件降级 +
//! verdict/level 计算 + [vet] 写回（SSEP v1.1 §2 vet 模块）。

use crate::ahub::skill_toml::{self, FILE};
use serde::Serialize;
use std::path::Path;

pub const VETTER_ID: &str = "agenthub-vet@0.1.0";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: String,
    pub severity: String, // critical | high | medium
    pub file: String,
    pub line: usize,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VetReport {
    pub verdict: String, // INSTALL | REVIEW | REJECT
    pub level: String,   // LOW | HIGH | EXTREME
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub findings: Vec<Finding>,
    pub content_hash: String,
    pub checked_at: String,
    pub checked_by: String,
}

const TEXT_EXTS: [&str; 14] = [
    "md", "txt", "py", "js", "ts", "jsx", "tsx", "sh", "ps1", "json", "toml", "yaml", "yml", "cmd",
];
const DOC_EXTS: [&str; 2] = ["md", "txt"];

struct Rule {
    id: &'static str,
    severity: &'static str,
    /// (pattern, description) 任一命中即算
    patterns: &'static [&'static str],
}

const RULES: &[Rule] = &[
    Rule {
        id: "R01-destructive",
        severity: "critical",
        patterns: &["rm -rf /", "rm -rf ~", "Remove-Item -Recurse -Force", "del /s /q C:\\"],
    },
    Rule {
        id: "R02-exec-download",
        severity: "critical",
        patterns: &["curl | bash", "curl |sh", "curl| bash", "wget | bash", "iex (iwr", "Invoke-Expression (Invoke-WebRequest", "iwr | iex"],
    },
    Rule {
        id: "R03-dynamic-exec",
        severity: "high",
        patterns: &["eval($", "eval(`", "exec(eval", "os.system(", "subprocess.call(", "subprocess.run("],
    },
    Rule {
        id: "R04-system-write",
        severity: "high",
        patterns: &["/etc/passwd", "C:\\Windows\\", "reg add ", "~/.ssh/", "authorized_keys"],
    },
    Rule {
        id: "R05-secrets",
        severity: "high",
        patterns: &["AWS_SECRET_ACCESS_KEY", "BEGIN RSA PRIVATE KEY", "BEGIN PRIVATE KEY", "api_key = \"", "apikey=\""],
    },
    Rule {
        id: "R06-obfuscation",
        severity: "medium",
        patterns: &[], // base64 长串走专门逻辑
    },
    Rule {
        id: "R07-env-harvest",
        severity: "medium",
        patterns: &["process.env", "os.environ", "Get-ChildItem env:"],
    },
    Rule {
        id: "R08-cred-files",
        severity: "medium",
        patterns: &[".env\"", "'/.env", "\".env\"", "credentials.json", ".npmrc"],
    },
];

fn downgrade(sev: &str) -> &str {
    match sev {
        "critical" => "medium",
        "high" => "low",
        _ => "low",
    }
}

fn rank(sev: &str) -> u32 {
    match sev {
        "critical" => 3,
        "high" => 2,
        "medium" => 1,
        _ => 0,
    }
}

/// 对技能目录运行安全审查
pub fn run(dir: &Path) -> Result<VetReport, String> {
    let mut findings: Vec<Finding> = Vec::new();

    fn scan_file(
        path: &std::path::Path,
        rel: &str,
        is_doc: bool,
        findings: &mut Vec<Finding>,
    ) {
        let Ok(text) = std::fs::read_to_string(path) else { return };
        for (ln, line) in text.lines().enumerate() {
            let lower = line.to_lowercase();
            for rule in RULES {
                if rule.id == "R06-obfuscation" {
                    continue; // 专门逻辑
                }
                for pat in rule.patterns {
                    if lower.contains(&pat.to_lowercase()) {
                        let sev = if is_doc { downgrade(rule.severity) } else { rule.severity };
                        if rank(sev) == 0 {
                            continue;
                        }
                        findings.push(Finding {
                            rule: rule.id.into(),
                            severity: sev.into(),
                            file: rel.into(),
                            line: ln + 1,
                            excerpt: line.trim().chars().take(120).collect(),
                        });
                        break;
                    }
                }
            }
            // R06：超长 base64 片段（≥2000 连续 base64 字符）
            for token in line.split_whitespace() {
                if token.len() >= 2000
                    && token
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
                {
                    let sev = if is_doc { "low" } else { "medium" };
                    if rank(sev) > 0 {
                        findings.push(Finding {
                            rule: "R06-obfuscation".into(),
                            severity: sev.into(),
                            file: rel.into(),
                            line: ln + 1,
                            excerpt: format!("{}… ({} chars)", &token[..40], token.len()),
                        });
                    }
                    break;
                }
            }
        }
    }

    fn walk(dir: &Path, base: &Path, findings: &mut Vec<Finding>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".agenthub-") || name == ".hub.json" || name == FILE {
                continue;
            }
            let p = entry.path();
            let rel = base.join(&name).to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                walk(&p, &base.join(&name), findings)?;
            } else {
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                if !TEXT_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let is_doc = DOC_EXTS.contains(&ext.as_str());
                scan_file(&p, &rel, is_doc, findings);
            }
        }
        Ok(())
    }

    walk(dir, Path::new(""), &mut findings)?;

    // 同规则同文件去重（保留首个）
    findings.sort_by(|a, b| (&a.rule, &a.file, a.line).cmp(&(&b.rule, &b.file, b.line)));
    findings.dedup_by(|a, b| a.rule == b.rule && a.file == b.file && a.line == b.line);

    let critical = findings.iter().filter(|f| f.severity == "critical").count() as u32;
    let high = findings.iter().filter(|f| f.severity == "high").count() as u32;
    let medium = findings.iter().filter(|f| f.severity == "medium").count() as u32;

    let (verdict, level) = if critical > 0 {
        ("REJECT", "EXTREME")
    } else if high > 0 {
        ("REVIEW", "HIGH")
    } else {
        ("INSTALL", "LOW")
    };

    let content_hash = skill_toml::tree_hash(dir)?;
    Ok(VetReport {
        verdict: verdict.into(),
        level: level.into(),
        critical,
        high,
        medium,
        findings,
        content_hash,
        checked_at: crate::ahub::models::now_iso(),
        checked_by: VETTER_ID.into(),
    })
}

/// 将审查结果写回 [vet]（SSEP vet 模块的合法写入者），并追加 vet 事件
pub fn write_vet(dir: &Path, report: &VetReport) -> Result<(), String> {
    let mut doc = skill_toml::load(dir).unwrap_or_else(|| toml::Value::Table(toml::value::Table::new()));
    if !doc.is_table() {
        doc = toml::Value::Table(toml::value::Table::new());
    }
    if !doc.is_table() {
        return Err("SKILL.toml root is not a table".into());
    }
    let root = doc.as_table_mut().unwrap();
    let mut vet = toml::value::Table::new();
    vet.insert("verdict".into(), toml::Value::String(report.verdict.clone()));
    vet.insert("level".into(), toml::Value::String(report.level.clone()));
    vet.insert("critical".into(), toml::Value::Integer(report.critical as i64));
    vet.insert("high".into(), toml::Value::Integer(report.high as i64));
    vet.insert("medium".into(), toml::Value::Integer(report.medium as i64));
    vet.insert("content_hash".into(), toml::Value::String(report.content_hash.clone()));
    vet.insert("checked_at".into(), toml::Value::String(report.checked_at.clone()));
    vet.insert("checked_by".into(), toml::Value::String(report.checked_by.clone()));
    root.insert("vet".into(), toml::Value::Table(vet));

    let text = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(skill_toml::path_for(dir), text).map_err(|e| e.to_string())?;
    skill_toml::append_event(
        dir,
        "vet",
        &report.level,
        &format!("{}: C{} H{} M{}", report.verdict, report.critical, report.high, report.medium),
        &report.content_hash,
    )
}
