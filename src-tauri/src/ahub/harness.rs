use crate::ahub::items;
use crate::ahub::models::*;
use crate::ahub::skills;
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedServer {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSkill {
    pub name: String,
    pub path: String,
    pub description: String,
    /// SKILL.md 的修改时间（毫秒时间戳）。用来回答「这个技能上次同步到该工具是什么时候」，
    /// 也是界面上「上次使用 / 从未使用」的可用信号 —— 工具运行时的真实调用记录各家都不落盘。
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReport {
    pub id: String,
    pub name: String,
    pub supports_mcp: bool,
    pub supports_skills: bool,
    pub config_path: String,
    /// 该工具定义的全部配置文件路径（存在与否都列出，供 Harness 工具页展示）
    pub config_paths: Vec<String>,
    pub exists: bool,
    pub mcp_servers: Vec<DetectedServer>,
    pub skills_dirs: Vec<String>,
    pub skills: Vec<DetectedSkill>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

/// 收集选择项：name + 是否覆盖同名中枢项（冲突弹框确认后产生）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub name: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// 预收集结果：先收集归档信息，通知用户后再执行
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreImportResult {
    pub new_items: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: Vec<String>,
    pub warnings: Vec<String>,
    pub backups: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    /// { "mcpServers": { name: {...} } }
    JsonFlat,
    /// { "servers": { name: { "type": "stdio"|"http", ... } } } (VS Code style)
    JsonServers,
    /// OpenCode: { "mcp": { name: { "type": "local"|"remote", "command": [...], "environment": {...} } } }
    OpenCode,
    /// Codex config.toml [mcp_servers.name]
    Toml,
}

#[derive(Debug, Clone)]
struct McpSource {
    path: PathBuf,
    format: Format,
    key: &'static str,
}

struct HarnessDef {
    id: &'static str,
    name: &'static str,
    mcp_sources: Vec<McpSource>,
    skills_dirs: Vec<PathBuf>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn appdata() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(PathBuf::from)
}

fn flat(path: PathBuf) -> McpSource {
    McpSource { path, format: Format::JsonFlat, key: "mcpServers" }
}

/// 默认展示顺序：常用的几个排前面（用户可以在「设置 → 工具顺序」里拖出自己的一份，
/// 那份存在 settings 的 `harnessOrder` 里，由前端覆盖这里的顺序）。
const DEFAULT_ORDER: &[&str] = &["opencode", "deepseek", "codex", "claude-code", "codebuddy", "pi-agent"];

fn defs(app: &AppH) -> Vec<HarnessDef> {
    let settings = store::load_settings(app);
    let mut list = vec![
        HarnessDef {
            id: "claude-code",
            name: "Claude Code",
            mcp_sources: vec![flat(home().join(".claude.json"))],
            skills_dirs: vec![home().join(".claude").join("skills")],
        },
        HarnessDef {
            id: "claude-desktop",
            name: "Claude Desktop",
            mcp_sources: appdata()
                .map(|d| vec![flat(d.join("Claude").join("claude_desktop_config.json"))])
                .unwrap_or_default(),
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "cursor",
            name: "Cursor",
            mcp_sources: vec![flat(home().join(".cursor").join("mcp.json"))],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "windsurf",
            name: "Windsurf",
            mcp_sources: vec![flat(
                home().join(".codeium").join("windsurf").join("mcp_config.json"),
            )],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "codex",
            name: "Codex CLI",
            mcp_sources: vec![McpSource {
                path: home().join(".codex").join("config.toml"),
                format: Format::Toml,
                key: "mcp_servers",
            }],
            skills_dirs: vec![home().join(".codex").join("skills")],
        },
        HarnessDef {
            id: "gemini-cli",
            name: "Gemini CLI",
            mcp_sources: vec![flat(home().join(".gemini").join("settings.json"))],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "vscode",
            name: "VS Code (Copilot MCP)",
            mcp_sources: appdata()
                .map(|d| {
                    vec![McpSource {
                        path: d.join("Code").join("User").join("mcp.json"),
                        format: Format::JsonServers,
                        key: "servers",
                    }]
                })
                .unwrap_or_default(),
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "cline",
            name: "Cline",
            mcp_sources: appdata()
                .map(|d| {
                    vec![flat(
                        d.join("Code")
                            .join("User")
                            .join("globalStorage")
                            .join("saoudrizwan.claude-dev")
                            .join("settings")
                            .join("cline_mcp_settings.json"),
                    )]
                })
                .unwrap_or_default(),
            skills_dirs: vec![],
        },
        // ---- PI Agent ----
        HarnessDef {
            id: "pi-agent",
            name: "PI Agent",
            mcp_sources: vec![
                flat(home().join(".pi").join("agent").join("mcp.json")),
                flat(home().join(".pi").join("mcp.json")),
            ],
            skills_dirs: vec![
                home().join(".agents").join("skills"),
                home().join(".pi").join("agent").join("skills"),
            ],
        },
        // ---- OpenCode（特殊格式：command 数组 / environment / local|remote）----
        HarnessDef {
            id: "opencode",
            name: "OpenCode",
            mcp_sources: vec![
                McpSource {
                    path: home().join(".config").join("opencode").join("opencode.json"),
                    format: Format::OpenCode,
                    key: "mcp",
                },
                McpSource {
                    path: home().join(".opencode").join("opencode.json"),
                    format: Format::OpenCode,
                    key: "mcp",
                },
            ],
            skills_dirs: vec![
                home().join(".config").join("opencode").join("skill"),
                home().join(".config").join("opencode").join("skills"),
                home().join(".opencode").join("skills"),
            ],
        },
        // ---- WorkBuddy ----
        HarnessDef {
            id: "workbuddy",
            name: "WorkBuddy",
            mcp_sources: vec![flat(home().join(".workbuddy").join("mcp.json"))],
            skills_dirs: vec![home().join(".workbuddy").join("skills")],
        },
        // ---- CodeBuddy ----
        HarnessDef {
            id: "codebuddy",
            name: "CodeBuddy",
            mcp_sources: vec![
                flat(home().join(".codebuddy").join("mcp.json")),
                flat(home().join(".codebuddy").join(".mcp.json")),
                flat(home().join(".codebuddy").join("config.json")),
            ],
            skills_dirs: vec![home().join(".codebuddy").join("skills")],
        },
        // ---- DeepSeek ----
        HarnessDef {
            id: "deepseek",
            name: "DeepSeek",
            mcp_sources: vec![
                flat(home().join(".deepseek").join("mcp.json")),
                flat(home().join(".deepseek").join("config.json")),
            ],
            skills_dirs: vec![home().join(".deepseek").join("skills")],
        },
    ];
    // custom skill source dirs from settings → pseudo harness（额外自定义 skills 存储路径）
    let custom: Vec<PathBuf> = settings
        .skill_source_dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect();
    if !custom.is_empty() {
        list.push(HarnessDef {
            id: "custom-dirs",
            name: "自定义目录",
            mcp_sources: vec![],
            skills_dirs: custom,
        });
    }
    // 默认顺序：DEFAULT_ORDER 里的排前面，其余保持静态表顺序（稳定排序）——
    // 前端拿到后还会按用户自己拖的那份再排一次。
    list.sort_by_key(|def| DEFAULT_ORDER.iter().position(|id| *id == def.id).unwrap_or(usize::MAX));
    list
}

fn as_str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(o)) = v {
        for (k, val) in o {
            let s = match val {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.insert(k.clone(), s);
        }
    }
    out
}

fn entry_to_detected(name: &str, v: &Value, format: Format) -> DetectedServer {
    if format == Format::OpenCode {
        // OpenCode: { type: local|remote, command: [..] | url, environment: {...} }
        let ttype = match v.get("type").and_then(|x| x.as_str()) {
            Some("local") => "stdio",
            Some("remote") => "http",
            _ => "stdio",
        };
        let (command, args): (String, Vec<String>) = match v.get("command").and_then(|x| x.as_array()) {
            Some(arr) if !arr.is_empty() => (
                arr[0].as_str().unwrap_or("").to_string(),
                arr.iter().skip(1).filter_map(|x| x.as_str().map(String::from)).collect(),
            ),
            _ => (String::new(), Vec::new()),
        };
        return DetectedServer {
            name: name.to_string(),
            transport: ttype.to_string(),
            command,
            args,
            env: as_str_map(v.get("environment")),
            url: v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            headers: as_str_map(v.get("headers")),
        };
    }
    let command = v.get("command").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let args: Vec<String> = v
        .get("args")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let env = as_str_map(v.get("env"));
    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    // 请求头：优先 headers，回退 http_headers（Codex TOML 风格）
    let mut headers = as_str_map(v.get("headers"));
    if headers.is_empty() {
        headers = as_str_map(v.get("http_headers"));
    }
    // Codex: bearer_token_env_var → 生成 Authorization: Bearer ${VAR} 说明
    if headers.is_empty() {
        if let Some(envvar) = v.get("bearer_token_env_var").and_then(|x| x.as_str()) {
            if !envvar.is_empty() {
                headers.insert("Authorization".to_string(), format!("Bearer ${envvar}"));
            }
        }
    }
    let ttype = v
        .get("type")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if !url.is_empty() && command.is_empty() {
                "http".to_string()
            } else {
                "stdio".to_string()
            }
        });
    DetectedServer {
        name: name.to_string(),
        transport: ttype,
        command,
        args,
        env,
        url,
        headers,
    }
}

fn parse_mcp_source(src: &McpSource) -> (Vec<DetectedServer>, Vec<String>, Vec<String>) {
    let mut servers = Vec::new();
    let mut found = Vec::new();
    let mut notes = Vec::new();
    let path = &src.path;
    if !path.exists() {
        return (servers, found, notes);
    }
    found.push(path.to_string_lossy().into_owned());
    match src.format {
        Format::JsonFlat | Format::JsonServers | Format::OpenCode => {
            match std::fs::read_to_string(path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            {
                Some(Value::Object(obj)) => {
                    if let Some(Value::Object(entries)) = obj.get(src.key) {
                        for (name, v) in entries {
                            servers.push(entry_to_detected(name, v, src.format));
                        }
                    } else if src.format == Format::OpenCode {
                        notes.push(format!("{}: 未找到 mcp 节点", path.display()));
                    }
                }
                Some(_) => notes.push(format!("{}: 配置文件结构无法识别", path.display())),
                None => notes.push(format!("{}: 配置文件解析失败（JSON 无效）", path.display())),
            }
        }
        Format::Toml => {
            match std::fs::read_to_string(path).ok().and_then(|t| toml::from_str::<toml::Value>(&t).ok()) {
                Some(table) => {
                    if let Some(entries) = table.get(src.key).and_then(|x| x.as_table()) {
                        for (name, v) in entries {
                            let json_v = toml_to_json(v);
                            servers.push(entry_to_detected(name, &json_v, Format::JsonFlat));
                        }
                    }
                }
                None => notes.push(format!("{}: 配置文件解析失败（TOML 无效）", path.display())),
            }
        }
    }
    (servers, found, notes)
}

fn parse_mcp_sources(def: &HarnessDef) -> (Vec<DetectedServer>, Vec<String>, Vec<String>) {
    let mut servers = Vec::new();
    let mut found = Vec::new();
    let mut notes = Vec::new();
    for src in &def.mcp_sources {
        let (mut s, mut f, mut n) = parse_mcp_source(src);
        servers.append(&mut s);
        found.append(&mut f);
        notes.append(&mut n);
    }
    (servers, found, notes)
}

fn toml_to_json(v: &toml::Value) -> Value {
    match v {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => json!(i),
        toml::Value::Float(f) => json!(f),
        toml::Value::Boolean(b) => json!(b),
        toml::Value::Array(a) => Value::Array(a.iter().map(toml_to_json).collect()),
        toml::Value::Table(t) => {
            let mut m = Map::new();
            for (k, val) in t {
                m.insert(k.clone(), toml_to_json(val));
            }
            Value::Object(m)
        }
        toml::Value::Datetime(d) => Value::String(d.to_string()),
    }
}

fn scan_skills_dirs(dirs: &[PathBuf]) -> (Vec<DetectedSkill>, Vec<String>) {
    let mut out = Vec::new();
    let mut found_dirs = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        found_dirs.push(dir.to_string_lossy().into_owned());
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("SKILL.md").exists() {
                    let text = std::fs::read_to_string(path.join("SKILL.md")).unwrap_or_default();
                    let (fm, _) = skills::split_doc(&text);
                    let name = {
                        let n = skills::fm_get_str(&fm, "name");
                        if n.is_empty() {
                            path.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
                        } else {
                            n
                        }
                    };
                    let updated_at = std::fs::metadata(path.join("SKILL.md"))
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    out.push(DetectedSkill {
                        name,
                        path: path.to_string_lossy().into_owned(),
                        description: skills::fm_get_str(&fm, "description"),
                        updated_at,
                    });
                }
            }
        }
    }
    (out, found_dirs)
}

/// 返回所有支持 MCP 的工具 (id, name)，按内置定义顺序
pub fn mcp_capable(app: &AppH) -> Vec<(String, String)> {
    defs(app)
        .into_iter()
        .filter(|d| !d.mcp_sources.is_empty())
        .map(|d| (d.id.to_string(), d.name.to_string()))
        .collect()
}

/// 解析某工具的 MCP 配置文件路径（优先已存在的 source，否则第一个）
pub fn config_target(app: &AppH, harness_id: &str) -> Result<(String, std::path::PathBuf), String> {
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        return Err(format!("未知工具: {harness_id}"));
    };
    let Some(src) = def
        .mcp_sources
        .iter()
        .find(|s| s.path.exists())
        .or_else(|| def.mcp_sources.first())
    else {
        return Err("该工具不支持 MCP 配置".into());
    };
    Ok((def.name.to_string(), src.path.clone()))
}

/// 按该工具的格式校验配置文本（JSON / TOML）
pub fn validate_config_text(app: &AppH, harness_id: &str, text: &str) -> Result<(), String> {
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        return Err(format!("未知工具: {harness_id}"));
    };
    let Some(src) = def.mcp_sources.first() else {
        return Err("该工具不支持 MCP 配置".into());
    };
    match src.format {
        Format::Toml => {
            toml::from_str::<toml::Value>(text).map_err(|e| format!("TOML 语法错误: {e}"))?;
        }
        _ => {
            serde_json::from_str::<Value>(text).map_err(|e| format!("JSON 语法错误: {e}"))?;
        }
    }
    Ok(())
}

fn report_for(def: &HarnessDef) -> HarnessReport {
    let (mcp_servers, mcp_found, mut notes) = if def.mcp_sources.is_empty() {
        (Vec::new(), Vec::new(), Vec::new())
    } else {
        parse_mcp_sources(def)
    };
    let (skills, skills_dirs) = scan_skills_dirs(&def.skills_dirs);
    if def.mcp_sources.is_empty() && def.skills_dirs.is_empty() {
        notes.push("未检测到".into());
    } else if mcp_found.is_empty() && skills_dirs.is_empty() {
        notes.push("未找到有效的配置或技能目录".into());
    }
    let exists = !mcp_found.is_empty() || !skills_dirs.is_empty();
    HarnessReport {
        id: def.id.to_string(),
        name: def.name.to_string(),
        supports_mcp: !def.mcp_sources.is_empty(),
        supports_skills: !def.skills_dirs.is_empty(),
        config_path: mcp_found.join(" · "),
        config_paths: def
            .mcp_sources
            .iter()
            .map(|source| source.path.to_string_lossy().into_owned())
            .collect(),
        exists,
        mcp_servers,
        skills_dirs,
        skills,
        notes,
    }
}

pub fn scan(app: &AppH) -> Vec<HarnessReport> {
    defs(app).iter().map(report_for).collect()
}

/// 只重新扫描一个工具：Harness 页每张卡片的「刷新」按钮用它，
/// 避免为了一个目录的变动去扫全部工具。
pub fn scan_one(app: &AppH, harness_id: &str) -> Result<HarnessReport, String> {
    defs(app)
        .iter()
        .find(|def| def.id == harness_id)
        .map(report_for)
        .ok_or_else(|| format!("未知工具: {harness_id}"))
}

// ---------------- Pre-import (归档信息，先收集结果供用户确认) ----------------

pub fn pre_import(app: &AppH, _harness_id: &str, kind: &str, names: &[String]) -> PreImportResult {
    let mut out = PreImportResult {
        new_items: vec![],
        conflicts: vec![],
    };
    match kind {
        "mcp" => {
            let existing = items::list_mcp(app).unwrap_or_default();
            for n in names {
                if existing.iter().any(|e| &e.name == n) {
                    out.conflicts.push(n.clone());
                } else {
                    out.new_items.push(n.clone());
                }
            }
        }
        "skills" => {
            let root = store::data_root(app).join("skills");
            for n in names {
                if root.join(n).exists() {
                    out.conflicts.push(n.clone());
                } else {
                    out.new_items.push(n.clone());
                }
            }
        }
        _ => {}
    }
    out
}

// ---------------- Import (collect into hub, copy-then-replace) ----------------

pub fn import(app: &AppH, harness_id: &str, kind: &str, selections: &[ImportSelection]) -> ImportResult {
    let mut res = ImportResult {
        imported: vec![],
        skipped: vec![],
        errors: vec![],
    };
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        res.errors.push(format!("未知工具: {harness_id}"));
        return res;
    };

    match kind {
        "mcp" => {
            let (detected, _, _) = parse_mcp_sources(&def);
            let existing = items::list_mcp(app).unwrap_or_default();
            for sel in selections {
                let Some(d) = detected.iter().find(|s| s.name == sel.name) else {
                    res.errors.push(format!("未找到: {}", sel.name));
                    continue;
                };
                if let Some(old) = existing.iter().find(|e| e.name == sel.name) {
                    if !sel.overwrite {
                        res.skipped.push(sel.name.clone());
                        continue;
                    }
                    // 覆盖：仅替换连接配置，保留 id/标签/版本历史（save_mcp 自动将旧配置存档为版本）
                    let mut updated = old.clone();
                    updated.transport = d.transport.clone();
                    updated.command = d.command.clone();
                    updated.args = d.args.clone();
                    updated.env = d.env.clone();
                    updated.url = d.url.clone();
                    updated.headers = d.headers.clone();
                    // 导入只搬连接配置，不记录「来自哪个工具」——来源会随工具卸载/迁移过期，
                    // 真正的事实是「这份配置当前接进了哪些工具」（targets）。
                    match items::save_mcp(app, updated) {
                        Ok(_) => res.imported.push(sel.name.clone()),
                        Err(e) => res.errors.push(format!("{}: {e}", sel.name)),
                    }
                } else {
                    let server = McpServer {
                        id: new_id(),
                        name: d.name.clone(),
                        description: String::new(),
                        transport: d.transport.clone(),
                        command: d.command.clone(),
                        args: d.args.clone(),
                        env: d.env.clone(),
                        url: d.url.clone(),
                        headers: d.headers.clone(),
                        tags: vec![],
                        enabled: true,
                        targets: vec![harness_id.to_string()],
                        targets_initialized: true,
                        origin: None,
                        versions: vec![],
                        created_at: now_iso(),
                        updated_at: now_iso(),
                    };
                    match items::save_mcp(app, server) {
                        Ok(_) => res.imported.push(sel.name.clone()),
                        Err(e) => res.errors.push(format!("{}: {e}", sel.name)),
                    }
                }
            }
        }
        "skills" => {
            for sel in selections {
                // find source dir across def skills dirs
                let mut src: Option<PathBuf> = None;
                for dir in &def.skills_dirs {
                    let p = dir.join(&sel.name);
                    if p.join("SKILL.md").exists() {
                        src = Some(p);
                        break;
                    }
                }
                let Some(src) = src else {
                    res.errors.push(format!("未找到技能目录: {}", sel.name));
                    continue;
                };
                match skills::import_skill_dir(app, &src, sel.overwrite) {
                    Ok(_dir_name) => res.imported.push(sel.name.clone()),
                    Err(_) if !sel.overwrite => res.skipped.push(sel.name.clone()),
                    Err(e) => res.errors.push(format!("{}: {e}", sel.name)),
                }
            }
        }
        other => res.errors.push(format!("未知类型: {other}")),
    }
    res
}

// ---------------- Apply (write back to harness) ----------------

fn stdio_entry(s: &McpServer) -> Value {
    let mut m = Map::new();
    m.insert("command".into(), json!(s.command));
    if !s.args.is_empty() {
        m.insert("args".into(), json!(s.args));
    }
    if !s.env.is_empty() {
        m.insert("env".into(), json!(s.env));
    }
    Value::Object(m)
}

fn remote_entry(s: &McpServer) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!(s.transport));
    m.insert("url".into(), json!(s.url));
    if !s.headers.is_empty() {
        m.insert("headers".into(), json!(s.headers));
    }
    Value::Object(m)
}

fn opencode_entry(s: &McpServer) -> Value {
    let mut m = Map::new();
    if s.transport == "stdio" {
        m.insert("type".into(), json!("local"));
        let mut cmd = vec![s.command.clone()];
        cmd.extend(s.args.iter().cloned());
        m.insert("command".into(), json!(cmd));
        if !s.env.is_empty() {
            m.insert("environment".into(), json!(s.env));
        }
    } else {
        m.insert("type".into(), json!("remote"));
        m.insert("url".into(), json!(s.url));
        if !s.headers.is_empty() {
            m.insert("headers".into(), json!(s.headers));
        }
    }
    m.insert("enabled".into(), json!(true));
    Value::Object(m)
}

/// 从 harness 配置文件中移除指定 MCP 条目（自动备份；解析失败绝不写回）
pub fn remove_mcp(app: &AppH, harness_id: &str, names: &[String]) -> ApplyResult {
    let mut res = ApplyResult {
        applied: vec![],
        warnings: vec![],
        backups: vec![],
        errors: vec![],
    };
    // 版本库：受管工具写入前自动快照
    let _ = crate::ahub::configvault::auto_snapshot(app, harness_id);
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        res.errors.push(format!("未知工具: {harness_id}"));
        return res;
    };
    let Some(src) = def.mcp_sources.iter().find(|s| s.path.exists()).cloned() else {
        res.warnings.push("该工具配置文件不存在，无需移除".into());
        return res;
    };
    let path = src.path.clone();
    if let Some(bak) = store::backup_file(&path).unwrap_or(None) {
        res.backups.push(bak.to_string_lossy().into_owned());
    }
    match src.format {
        Format::Toml => {
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    res.errors.push(e.to_string());
                    return res;
                }
            };
            let mut root: toml::Value = match toml::from_str(&text) {
                Ok(v) => v,
                Err(e) => {
                    res.errors.push(format!("配置文件解析失败，已取消写回: {e}"));
                    return res;
                }
            };
            if let Some(tbl) = root.get_mut(src.key).and_then(|v| v.as_table_mut()) {
                for n in names {
                    if tbl.remove(n).is_some() {
                        res.applied.push(n.clone());
                    } else {
                        res.warnings.push(format!("{} 中未找到 {}", def.name, n));
                    }
                }
            } else {
                res.warnings.push("配置中没有 MCP 段".into());
            }
            match toml::to_string_pretty(&root) {
                Ok(text) => {
                    if let Err(e) = std::fs::write(&path, text) {
                        res.errors.push(e.to_string());
                    }
                }
                Err(e) => res.errors.push(e.to_string()),
            }
        }
        _ => {
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    res.errors.push(e.to_string());
                    return res;
                }
            };
            let mut root: Map<String, Value> = match serde_json::from_str::<Value>(&text) {
                Ok(v) => v.as_object().cloned().unwrap_or_default(),
                Err(e) => {
                    res.errors.push(format!("配置文件解析失败（可能含注释），已取消写回: {e}"));
                    return res;
                }
            };
            if let Some(entries) = root.get_mut(src.key).and_then(|v| v.as_object_mut()) {
                for n in names {
                    if entries.remove(n).is_some() {
                        res.applied.push(n.clone());
                    } else {
                        res.warnings.push(format!("{} 中未找到 {}", def.name, n));
                    }
                }
            } else {
                res.warnings.push("配置中没有 MCP 段".into());
            }
            match serde_json::to_string_pretty(&root) {
                Ok(text) => {
                    if let Err(e) = std::fs::write(&path, text) {
                        res.errors.push(e.to_string());
                    }
                }
                Err(e) => res.errors.push(e.to_string()),
            }
        }
    }
    res
}

/// 从工具的技能目录里移除同名技能副本。
///
/// 只删该工具 skills_dirs 里、且确实含 SKILL.md 的目录 —— 中枢库（data_root/skills）
/// 不会被碰到。目录名即技能 dirName，与 apply(kind="skills") 的入参一致。
pub fn remove_skills(app: &AppH, harness_id: &str, names: &[String]) -> ApplyResult {
    let mut res = ApplyResult {
        applied: vec![],
        warnings: vec![],
        backups: vec![],
        errors: vec![],
    };
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        res.errors.push(format!("未知工具: {harness_id}"));
        return res;
    };
    if def.skills_dirs.is_empty() {
        res.errors.push("该工具未配置技能目录".into());
        return res;
    }
    for name in names {
        // 防御：只接受单层目录名，避免 ../ 之类把删除带出技能目录
        if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
            res.errors.push(format!("非法技能名: {name}"));
            continue;
        }
        let mut removed = false;
        let mut found = false;
        for dir in &def.skills_dirs {
            let target = dir.join(name);
            if !target.join("SKILL.md").is_file() {
                continue;
            }
            found = true;
            match std::fs::remove_dir_all(&target) {
                Ok(_) => removed = true,
                Err(e) => res.errors.push(format!("{name} ← {}: {e}", target.display())),
            }
        }
        if removed {
            res.applied.push(name.clone());
        } else if !found {
            res.warnings.push(format!("{name}: 该工具下没有这份技能"));
        }
    }
    res
}

/// 解析某工具的 MCP 配置文件：返回路径、文本、是否存在（供内嵌编辑器使用）
/// 把一段标准 mcpServers JSON 合并进某工具的配置文本（按该工具的格式转换），返回新文本。
/// 支持 JSON 与 TOML（Codex）两种目标格式；不写盘，交由前端预览/保存。
pub fn merge_mcp_json(app: &AppH, harness_id: &str, text: &str, json_text: &str) -> Result<String, String> {
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        return Err(format!("未知工具: {harness_id}"));
    };
    let Some(src) = def.mcp_sources.first() else {
        return Err("该工具不支持 MCP 配置".into());
    };

    // 解析粘贴的 JSON：支持 { mcpServers: {...} } / { servers: {...} } / 单个对象
    let parsed: Value = serde_json::from_str(json_text).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let mut incoming: Vec<(String, McpServer)> = Vec::new();
    let collect_from = |obj: &serde_json::Map<String, Value>| -> Vec<(String, McpServer)> {
        let mut out = Vec::new();
        for (name, v) in obj {
            if let Some(s) = value_to_server(name, v) {
                out.push((name.clone(), s));
            }
        }
        out
    };
    if let Some(m) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
        incoming.extend(collect_from(m));
    } else if let Some(m) = parsed.get("servers").and_then(|v| v.as_object()) {
        incoming.extend(collect_from(m));
    } else if let Some(obj) = parsed.as_object() {
        if obj.contains_key("command") || obj.contains_key("url") {
            if let Some(s) = value_to_server("imported-mcp", &parsed) {
                incoming.push(("imported-mcp".to_string(), s));
            }
        } else {
            incoming.extend(collect_from(obj));
        }
    }
    if incoming.is_empty() {
        return Err("未识别到任何 MCP 服务".into());
    }

    match src.format {
        Format::Toml => {
            let mut root: toml::Value = if text.trim().is_empty() {
                toml::Value::Table(Default::default())
            } else {
                toml::from_str(text).map_err(|e| format!("当前配置 TOML 语法错误: {e}"))?
            };
            if !root.is_table() {
                root = toml::Value::Table(Default::default());
            }
            let table = root.as_table_mut().unwrap();
            let servers = table
                .entry(src.key.to_string())
                .or_insert_with(|| toml::Value::Table(Default::default()));
            if !servers.is_table() {
                *servers = toml::Value::Table(Default::default());
            }
            let smap = servers.as_table_mut().unwrap();
            for (name, s) in &incoming {
                let mut t = toml::value::Table::new();
                if s.transport == "stdio" {
                    t.insert("command".into(), toml::Value::String(s.command.clone()));
                    if !s.args.is_empty() {
                        t.insert(
                            "args".into(),
                            toml::Value::Array(
                                s.args.iter().map(|a| toml::Value::String(a.clone())).collect(),
                            ),
                        );
                    }
                    if !s.env.is_empty() {
                        let mut env_t = toml::value::Table::new();
                        for (k, v) in &s.env {
                            env_t.insert(k.clone(), toml::Value::String(v.clone()));
                        }
                        t.insert("env".into(), toml::Value::Table(env_t));
                    }
                } else {
                    t.insert("url".into(), toml::Value::String(s.url.clone()));
                    if !s.headers.is_empty() {
                        let mut h_t = toml::value::Table::new();
                        for (k, v) in &s.headers {
                            h_t.insert(k.clone(), toml::Value::String(v.clone()));
                        }
                        t.insert("http_headers".into(), toml::Value::Table(h_t));
                    }
                }
                smap.insert(name.clone(), toml::Value::Table(t));
            }
            toml::to_string_pretty(&root).map_err(|e| e.to_string())
        }
        _ => {
            let mut root: Map<String, Value> = if text.trim().is_empty() {
                Map::new()
            } else {
                serde_json::from_str::<Value>(text)
                    .map_err(|e| format!("当前配置 JSON 语法错误: {e}"))?
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            };
            let entries = root.entry(src.key.to_string()).or_insert_with(|| json!({}));
            if !entries.is_object() {
                *entries = json!({});
            }
            let map = entries.as_object_mut().unwrap();
            for (name, s) in &incoming {
                let entry = match src.format {
                    Format::OpenCode => opencode_entry(s),
                    _ => {
                        if s.transport == "stdio" {
                            stdio_entry(s)
                        } else {
                            remote_entry(s)
                        }
                    }
                };
                map.insert(name.clone(), entry);
            }
            serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
        }
    }
}

/// 把单个 JSON 对象转成 McpServer（用于导入合并）
fn value_to_server(name: &str, v: &Value) -> Option<McpServer> {
    let d = entry_to_detected(name, v, Format::JsonFlat);
    if d.command.is_empty() && d.url.is_empty() {
        return None;
    }
    Some(McpServer {
        id: String::new(),
        name: name.to_string(),
        description: String::new(),
        transport: d.transport,
        command: d.command,
        args: d.args,
        env: d.env,
        url: d.url,
        headers: d.headers,
        tags: vec![],
        enabled: true,
        targets: vec![],
        targets_initialized: true,
        origin: None,
        versions: vec![],
        created_at: String::new(),
        updated_at: String::new(),
    })
}

pub fn read_config(app: &AppH, harness_id: &str) -> Result<Value, String> {
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        return Err(format!("未知工具: {harness_id}"));
    };
    let Some(src) = def
        .mcp_sources
        .iter()
        .find(|s| s.path.exists())
        .or_else(|| def.mcp_sources.first())
    else {
        return Err("该工具不支持 MCP 配置".into());
    };
    let exists = src.path.exists();
    let text = if exists {
        std::fs::read_to_string(&src.path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(json!({
        "path": src.path.to_string_lossy(),
        "text": text,
        "exists": exists,
        "format": match src.format {
            Format::Toml => "toml",
            Format::OpenCode => "opencode",
            _ => "json",
        },
    }))
}

/// 写回某工具的 MCP 配置文件：先校验（JSON/TOML），自动备份，再写入。
pub fn write_config(app: &AppH, harness_id: &str, text: &str) -> Result<Value, String> {
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        return Err(format!("未知工具: {harness_id}"));
    };
    let Some(src) = def
        .mcp_sources
        .iter()
        .find(|s| s.path.exists())
        .or_else(|| def.mcp_sources.first())
    else {
        return Err("该工具不支持 MCP 配置".into());
    };
    // 校验，避免写入损坏的配置
    match src.format {
        Format::Toml => {
            toml::from_str::<toml::Value>(text).map_err(|e| format!("TOML 语法错误，已取消保存: {e}"))?;
        }
        _ => {
            serde_json::from_str::<Value>(text).map_err(|e| format!("JSON 语法错误，已取消保存: {e}"))?;
        }
    }
    let backup = store::backup_file(&src.path).unwrap_or(None);
    // 版本库：受管工具写入前自动快照
    let _ = crate::ahub::configvault::auto_snapshot(app, harness_id);
    if let Some(parent) = src.path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&src.path, text).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": src.path.to_string_lossy(),
        "backup": backup.map(|b| b.to_string_lossy().into_owned()),
    }))
}

pub fn apply(app: &AppH, harness_id: &str, kind: &str, names: &[String]) -> ApplyResult {
    let mut res = ApplyResult {
        applied: vec![],
        warnings: vec![],
        backups: vec![],
        errors: vec![],
    };
    // 版本库：受管工具写入前自动快照
    let _ = crate::ahub::configvault::auto_snapshot(app, harness_id);
    let Some(def) = defs(app).into_iter().find(|d| d.id == harness_id) else {
        res.errors.push(format!("未知工具: {harness_id}"));
        return res;
    };

    match kind {
        "mcp" => {
            let Some(src) = def
                .mcp_sources
                .iter()
                .find(|s| s.path.exists())
                .or_else(|| def.mcp_sources.first())
                .cloned()
            else {
                res.errors.push("该工具不支持 MCP 写回".into());
                return res;
            };
            let path = src.path;
            let all = items::list_mcp(app).unwrap_or_default();
            let selected: Vec<&McpServer> = all
                .iter()
                .filter(|s| names.contains(&s.name) && s.enabled)
                .collect();

            match src.format {
                Format::JsonFlat | Format::JsonServers | Format::OpenCode => {
                    let mut root: Map<String, Value> = if path.exists() {
                        let text = match std::fs::read_to_string(&path) {
                            Ok(t) => t,
                            Err(e) => {
                                res.errors.push(e.to_string());
                                return res;
                            }
                        };
                        match serde_json::from_str::<Value>(&text) {
                            Ok(v) => v.as_object().cloned().unwrap_or_default(),
                            Err(e) => {
                                res.errors.push(format!("配置文件解析失败（可能含注释），为避免清空已取消写回: {e}"));
                                return res;
                            }
                        }
                    } else {
                        Map::new()
                    };
                    if let Some(bak) = store::backup_file(&path).unwrap_or(None) {
                        res.backups.push(bak.to_string_lossy().into_owned());
                    }
                    let entries = root.entry(src.key.to_string()).or_insert_with(|| json!({}));
                    if !entries.is_object() {
                        *entries = json!({});
                    }
                    let map = entries.as_object_mut().unwrap();
                    for s in &selected {
                        if def.id == "claude-desktop" && s.transport != "stdio" {
                            res.warnings
                                .push(format!("Claude Desktop 暂不支持 {} 类型，已跳过: {}", s.transport, s.name));
                            continue;
                        }
                        let entry = match src.format {
                            Format::OpenCode => opencode_entry(s),
                            _ => {
                                if s.transport == "stdio" {
                                    stdio_entry(s)
                                } else {
                                    remote_entry(s)
                                }
                            }
                        };
                        map.insert(s.name.clone(), entry);
                        res.applied.push(s.name.clone());
                    }
                    if let Err(e) = std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))) {
                        res.errors.push(e.to_string());
                        return res;
                    }
                    match std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap_or_default()) {
                        Ok(_) => {}
                        Err(e) => res.errors.push(e.to_string()),
                    }
                }
                Format::Toml => {
                    let mut root: toml::Value = if path.exists() {
                        let text = match std::fs::read_to_string(&path) {
                            Ok(t) => t,
                            Err(e) => {
                                res.errors.push(e.to_string());
                                return res;
                            }
                        };
                        match toml::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                res.errors.push(format!("配置文件解析失败，为避免清空已取消写回: {e}"));
                                return res;
                            }
                        }
                    } else {
                        toml::Value::Table(Default::default())
                    };
                    if let Some(bak) = store::backup_file(&path).unwrap_or(None) {
                        res.backups.push(bak.to_string_lossy().into_owned());
                    }
                    if !root.is_table() {
                        root = toml::Value::Table(Default::default());
                    }
                    let table = root.as_table_mut().unwrap();
                    let servers = table
                        .entry(src.key.to_string())
                        .or_insert_with(|| toml::Value::Table(Default::default()));
                    if !servers.is_table() {
                        *servers = toml::Value::Table(Default::default());
                    }
                    let smap = servers.as_table_mut().unwrap();
                    for s in &selected {
                        let mut t = toml::value::Table::new();
                        if s.transport == "stdio" {
                            // stdio: command / args / env
                            t.insert("command".into(), toml::Value::String(s.command.clone()));
                            if !s.args.is_empty() {
                                t.insert(
                                    "args".into(),
                                    toml::Value::Array(
                                        s.args.iter().map(|a| toml::Value::String(a.clone())).collect(),
                                    ),
                                );
                            }
                            if !s.env.is_empty() {
                                let mut env_t = toml::value::Table::new();
                                for (k, v) in &s.env {
                                    env_t.insert(k.clone(), toml::Value::String(v.clone()));
                                }
                                t.insert("env".into(), toml::Value::Table(env_t));
                            }
                        } else {
                            // remote: Codex 用 url + http_headers（内联表）；Bearer token 优先转 bearer_token_env_var
                            t.insert("url".into(), toml::Value::String(s.url.clone()));
                            if !s.headers.is_empty() {
                                let mut h_t = toml::value::Table::new();
                                for (k, v) in &s.headers {
                                    h_t.insert(k.clone(), toml::Value::String(v.clone()));
                                }
                                // 内联表：避免 TOML 子表与 Codex 期望的结构不符
                                t.insert("http_headers".into(), toml::Value::Table(h_t));
                            }
                        }
                        smap.insert(s.name.clone(), toml::Value::Table(t));
                        res.applied.push(s.name.clone());
                    }
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match toml::to_string_pretty(&root) {
                        Ok(text) => {
                            if let Err(e) = std::fs::write(&path, text) {
                                res.errors.push(e.to_string());
                            }
                        }
                        Err(e) => res.errors.push(e.to_string()),
                    }
                }
            }
        }
        "skills" => {
            if def.skills_dirs.is_empty() {
                res.errors.push("该工具未配置技能目录".into());
                return res;
            }
            let root = store::data_root(app).join("skills");
            for name in names {
                let src = root.join(name);
                if !src.join("SKILL.md").exists() {
                    res.errors.push(format!("技能不存在: {name}"));
                    continue;
                }
                let mut ok = false;
                for target_dir in &def.skills_dirs {
                    let dst = target_dir.join(name);
                    match store::copy_dir_recursive(&src, &dst, true) {
                        Ok(_) => ok = true,
                        Err(e) => res.errors.push(format!("{name} → {}: {e}", dst.display())),
                    }
                }
                if ok {
                    res.applied.push(name.clone());
                }
            }
        }
        other => res.errors.push(format!("未知类型: {other}")),
    }
    res
}
