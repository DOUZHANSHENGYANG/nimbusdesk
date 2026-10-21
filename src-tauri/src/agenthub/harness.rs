//! 本机工具（Claude Code / Cursor / OpenCode / Codex …）的探测、收集与分发。
//!
//! 两件事在这里发生：
//!   1. **探测**：读各工具自己的 MCP 配置文件与技能目录，告诉用户"你这台机器上
//!      各工具现在有什么"。只读，不写。
//!   2. **分发**：把工具箱里的 MCP 服务 / 技能推到某个工具。**写别人家的配置文件
//!      是本功能风险最高的动作**，因此有三条硬约束：
//!        · 写前必留同目录备份（`.agenthub-bak-<stamp>`）；
//!        · 目标文件解析失败一律中止（宁可什么都不做，也不覆盖用户配置）；
//!        · 只增删目标键（`mcpServers` / `servers` / `mcp`），其余键原样保留。
//!
//! Codex 的 MCP 在 `config.toml` 里：本模块**只探测它的技能目录**，不读写那份
//! TOML（为一个工具引入 TOML 解析依赖不划算，读写风险也更高）。

use crate::agenthub::models::*;
use crate::agenthub::{backup_file, mcp, skills};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    /// `{ "mcpServers": { name: {...} } }`
    JsonFlat,
    /// `{ "servers": { name: { "type": "stdio"|"http", ... } } }`（VS Code）
    JsonServers,
    /// `{ "mcp": { name: { "type": "local"|"remote", "command": [...], "environment": {} } } }`
    OpenCode,
}

#[derive(Debug, Clone)]
struct McpSource {
    path: PathBuf,
    format: Format,
    key: &'static str,
}

impl McpSource {
    fn flat(path: PathBuf) -> Self {
        Self {
            path,
            format: Format::JsonFlat,
            key: "mcpServers",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HarnessDef {
    id: &'static str,
    name: &'static str,
    mcp: Vec<McpSource>,
    skills_dirs: Vec<PathBuf>,
}

fn home() -> PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if let (Ok(drive), Ok(rest)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        return PathBuf::from(format!("{drive}{rest}"));
    }
    PathBuf::from(".")
}

fn appdata() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

/// 内置工具表：只列**本机真实存在**的路径；探测时逐个判断是否存在。
fn defs() -> Vec<HarnessDef> {
    let h = home();
    let a = appdata();
    let ado = |sub: &str| -> Vec<PathBuf> { a.as_ref().map(|d| vec![d.join(sub)]).unwrap_or_default() };
    vec![
        HarnessDef {
            id: "claude-code",
            name: "Claude Code",
            mcp: vec![McpSource::flat(h.join(".claude.json"))],
            skills_dirs: vec![h.join(".claude").join("skills")],
        },
        HarnessDef {
            id: "claude-desktop",
            name: "Claude Desktop",
            mcp: ado("Claude/claude_desktop_config.json").into_iter().map(McpSource::flat).collect(),
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "cursor",
            name: "Cursor",
            mcp: vec![McpSource::flat(h.join(".cursor").join("mcp.json"))],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "windsurf",
            name: "Windsurf",
            mcp: vec![McpSource::flat(
                h.join(".codeium").join("windsurf").join("mcp_config.json"),
            )],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "codex",
            name: "Codex CLI",
            // config.toml 里的 MCP 不读写（见模块头注释），但技能目录照常。
            mcp: vec![],
            skills_dirs: vec![h.join(".codex").join("skills")],
        },
        HarnessDef {
            id: "gemini-cli",
            name: "Gemini CLI",
            mcp: vec![McpSource::flat(h.join(".gemini").join("settings.json"))],
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "vscode",
            name: "VS Code (Copilot MCP)",
            mcp: ado("Code/User/mcp.json")
                .into_iter()
                .map(|path| McpSource {
                    path,
                    format: Format::JsonServers,
                    key: "servers",
                })
                .collect(),
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "cline",
            name: "Cline",
            mcp: ado("Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json")
                .into_iter()
                .map(McpSource::flat)
                .collect(),
            skills_dirs: vec![],
        },
        HarnessDef {
            id: "opencode",
            name: "OpenCode",
            mcp: vec![
                McpSource {
                    path: h.join(".config").join("opencode").join("opencode.json"),
                    format: Format::OpenCode,
                    key: "mcp",
                },
                McpSource {
                    path: h.join(".opencode").join("opencode.json"),
                    format: Format::OpenCode,
                    key: "mcp",
                },
            ],
            skills_dirs: vec![
                h.join(".config").join("opencode").join("skill"),
                h.join(".config").join("opencode").join("skills"),
                h.join(".opencode").join("skills"),
            ],
        },
        HarnessDef {
            id: "pi-agent",
            name: "PI Agent",
            mcp: vec![
                McpSource::flat(h.join(".pi").join("agent").join("mcp.json")),
                McpSource::flat(h.join(".pi").join("mcp.json")),
            ],
            skills_dirs: vec![h.join(".agents").join("skills"), h.join(".pi").join("agent").join("skills")],
        },
        HarnessDef {
            id: "workbuddy",
            name: "WorkBuddy",
            mcp: vec![McpSource::flat(h.join(".workbuddy").join("mcp.json"))],
            skills_dirs: vec![h.join(".workbuddy").join("skills")],
        },
        HarnessDef {
            id: "codebuddy",
            name: "CodeBuddy",
            mcp: vec![
                McpSource::flat(h.join(".codebuddy").join("mcp.json")),
                McpSource::flat(h.join(".codebuddy").join("config.json")),
            ],
            skills_dirs: vec![h.join(".codebuddy").join("skills")],
        },
        HarnessDef {
            id: "deepseek",
            name: "DeepSeek",
            mcp: vec![
                McpSource::flat(h.join(".deepseek").join("mcp.json")),
                McpSource::flat(h.join(".deepseek").join("config.json")),
            ],
            skills_dirs: vec![h.join(".deepseek").join("skills")],
        },
    ]
}

fn note(code: &str, path: &str) -> TbNote {
    TbNote {
        code: code.to_string(),
        path: path.to_string(),
    }
}

fn item(name: &str, code: &str, detail: &str) -> TbTransferItem {
    TbTransferItem {
        name: name.to_string(),
        code: code.to_string(),
        detail: detail.to_string(),
    }
}

fn as_str_map(v: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(Value::Object(o)) = v {
        for (k, val) in o {
            out.insert(
                k.clone(),
                match val {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                },
            );
        }
    }
    out
}

/// 把某工具配置里的一条目翻译成通用形状（各格式字段名不同）。
fn entry_to_detected(name: &str, v: &Value, format: Format) -> TbDetectedServer {
    if format == Format::OpenCode {
        let transport = match v.get("type").and_then(|x| x.as_str()) {
            Some("remote") => "http",
            _ => "stdio",
        };
        let (command, args) = match v.get("command").and_then(|x| x.as_array()) {
            Some(arr) if !arr.is_empty() => (
                arr[0].as_str().unwrap_or_default().to_string(),
                arr.iter().skip(1).filter_map(|x| x.as_str().map(String::from)).collect(),
            ),
            _ => (String::new(), Vec::new()),
        };
        return TbDetectedServer {
            name: name.to_string(),
            transport: transport.to_string(),
            command,
            args,
            env: as_str_map(v.get("environment")),
            url: v.get("url").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            headers: as_str_map(v.get("headers")),
        };
    }
    let transport = match v.get("type").and_then(|x| x.as_str()) {
        Some(t) if t != "stdio" => t,
        _ => {
            if v.get("url").and_then(|x| x.as_str()).is_some_and(|u| !u.is_empty()) {
                "http"
            } else {
                "stdio"
            }
        }
    };
    TbDetectedServer {
        name: name.to_string(),
        transport: transport.to_string(),
        command: v.get("command").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        args: v
            .get("args")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        env: as_str_map(v.get("env")),
        url: v.get("url").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        headers: as_str_map(v.get("headers")),
    }
}

fn parse_mcp_source(src: &McpSource) -> (Vec<TbDetectedServer>, bool, Vec<TbNote>) {
    let shown = src.path.to_string_lossy().into_owned();
    if !src.path.exists() {
        return (Vec::new(), false, Vec::new());
    }
    let text = match std::fs::read_to_string(&src.path) {
        Ok(t) => t,
        Err(e) => return (Vec::new(), false, vec![note("mcpUnreadable", &format!("{shown} · {e}"))]),
    };
    let root: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        // 带注释、带尾逗号的 JSONC 会走到这里 —— 这种文件既不解析也不写回。
        Err(_) => return (Vec::new(), false, vec![note("mcpParseFailed", &shown)]),
    };
    let Some(obj) = root.as_object() else {
        return (Vec::new(), false, vec![note("mcpShapeUnknown", &shown)]);
    };
    let Some(entries) = obj.get(src.key).and_then(|x| x.as_object()) else {
        return (Vec::new(), true, vec![note("mcpNodeMissing", &shown)]);
    };
    let servers = entries
        .iter()
        .map(|(name, v)| entry_to_detected(name, v, src.format))
        .collect();
    (servers, true, Vec::new())
}

fn parse_mcp_sources(def: &HarnessDef) -> (Vec<TbDetectedServer>, Vec<String>, Vec<TbNote>) {
    let mut servers = Vec::new();
    let mut found = Vec::new();
    let mut notes = Vec::new();
    for src in &def.mcp {
        let (mut s, ok, mut n) = parse_mcp_source(src);
        servers.append(&mut s);
        if ok {
            found.push(src.path.to_string_lossy().into_owned());
        }
        notes.append(&mut n);
    }
    (servers, found, notes)
}

/// 扫描某工具的技能目录：目录里每个含 `SKILL.md` 的子目录算一个技能。
fn scan_skills_dirs(dirs: &[PathBuf]) -> (Vec<TbDetectedSkill>, Vec<String>) {
    let mut out = Vec::new();
    let mut found_dirs = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        found_dirs.push(dir.to_string_lossy().into_owned());
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join(skills::SKILL_MD).exists() {
                continue;
            }
            let text = std::fs::read_to_string(path.join(skills::SKILL_MD)).unwrap_or_default();
            let (fm, _) = skills::split_doc(&text);
            let declared = skills::fm_field(&fm, "name");
            out.push(TbDetectedSkill {
                name: if declared.is_empty() {
                    entry.file_name().to_string_lossy().into_owned()
                } else {
                    declared
                },
                path: path.to_string_lossy().into_owned(),
                description: skills::fm_field(&fm, "description"),
            });
        }
    }
    (out, found_dirs)
}

pub fn scan() -> Vec<TbHarnessReport> {
    defs()
        .into_iter()
        .map(|def| {
            let (mcp_servers, mcp_found, mut notes) = parse_mcp_sources(&def);
            let (detected, skills_dirs) = scan_skills_dirs(&def.skills_dirs);
            if def.mcp.is_empty() {
                notes.push(note("mcpUnsupported", ""));
            }
            if mcp_found.is_empty() && skills_dirs.is_empty() {
                notes.push(note("nothingFound", ""));
            }
            TbHarnessReport {
                supports_mcp: !def.mcp.is_empty(),
                supports_skills: !def.skills_dirs.is_empty(),
                id: def.id.to_string(),
                name: def.name.to_string(),
                config_path: mcp_found
                    .first()
                    .cloned()
                    .unwrap_or_else(|| {
                        def.mcp
                            .first()
                            .map(|s| s.path.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    }),
                exists: !mcp_found.is_empty() || !skills_dirs.is_empty(),
                mcp_servers,
                skills_dirs,
                skills: detected,
                notes,
            }
        })
        .collect()
}

// ---------------- 收集（别家 → 工具箱，只读对方） ----------------

pub(crate) fn collect(
    mcp_root: &Path,
    skills_root: &Path,
    harness: &str,
    kind: &str,
    names: &[String],
) -> Result<TbTransferResult, String> {
    let Some(def) = defs().into_iter().find(|d| d.id == harness) else {
        return Err(format!("未知工具: {harness}"));
    };
    collect_from_def(mcp_root, skills_root, &def, kind, names)
}

fn collect_from_def(
    mcp_root: &Path,
    skills_root: &Path,
    def: &HarnessDef,
    kind: &str,
    names: &[String],
) -> Result<TbTransferResult, String> {
    let harness = def.id;
    let mut res = TbTransferResult::default();
    match kind {
        "mcp" => {
            let (detected, found, _) = parse_mcp_sources(def);
            let file = found.first().cloned().unwrap_or_default();
            let existing = mcp::list(mcp_root)?;
            for name in names {
                let Some(d) = detected.iter().find(|s| &s.name == name) else {
                    res.skipped.push(item(name, "notFound", ""));
                    continue;
                };
                match existing.iter().find(|s| &s.name == name) {
                    // 同名已存在：默认跳过。要覆盖就先在工具箱里删掉那一条 ——
                    // 覆盖别人写过的配置是这一步里最容易出错的动作。
                    Some(_) => res.skipped.push(item(name, "exists", "")),
                    None => match mcp::save(mcp_root, mcp::from_detected(d, harness, &file)) {
                        Ok(_) => res.applied.push(name.clone()),
                        Err(e) => res.errors.push(item(name, "io", &e)),
                    },
                }
            }
        }
        "skills" => {
            for name in names {
                if skills_root.join(name).join(skills::SKILL_MD).exists() {
                    res.skipped.push(item(name, "exists", ""));
                    continue;
                }
                let src = def.skills_dirs.iter().map(|d| d.join(name)).find(|p| p.join(skills::SKILL_MD).exists());
                let Some(src) = src else {
                    res.skipped.push(item(name, "notFound", ""));
                    continue;
                };
                match skills::collect_from(skills_root, &src, harness) {
                    Ok(_) => res.applied.push(name.clone()),
                    Err(e) => res.errors.push(item(name, "io", &e)),
                }
            }
        }
        other => return Err(format!("未知类型: {other}")),
    }
    Ok(res)
}

// ---------------- 分发（工具箱 → 别家） ----------------

fn push_mcp(mcp_root: &Path, def: &HarnessDef, names: &[String]) -> Result<TbTransferResult, String> {
    let mut res = TbTransferResult::default();
    let Some(src) = def.mcp.iter().find(|s| s.path.exists()).or_else(|| def.mcp.first()) else {
        res.errors.push(item("", "notSupported", ""));
        return Ok(res);
    };
    let all = mcp::list(mcp_root)?;
    let selected: Vec<&TbMcpServer> = all
        .iter()
        .filter(|s| names.contains(&s.name) && s.enabled && !s.name.trim().is_empty())
        .collect();
    for name in names {
        if !all.iter().any(|s| &s.name == name) {
            res.skipped.push(item(name, "notFound", ""));
        } else if !selected.iter().any(|s| &s.name == name) {
            res.skipped.push(item(name, "disabled", ""));
        }
    }
    if selected.is_empty() {
        return Ok(res);
    }

    // 先解析现有配置；解析不了就中止 —— 覆盖一份自己看不懂的文件是最坏的结果。
    let mut root: Map<String, Value> = if src.path.exists() {
        let text = std::fs::read_to_string(&src.path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                res.errors.push(item(
                    "",
                    "parse",
                    &src.path.to_string_lossy(),
                ));
                return Ok(res);
            }
            Err(e) => {
                res.errors.push(item("", "parse", &format!("{} · {e}", src.path.to_string_lossy())));
                return Ok(res);
            }
        }
    } else {
        Map::new()
    };

    if let Ok(Some(bak)) = backup_file(&src.path) {
        res.backups.push(bak.to_string_lossy().into_owned());
    }
    let entries = root.entry(src.key.to_string()).or_insert_with(|| json!({}));
    if !entries.is_object() {
        *entries = json!({});
    }
    let map = entries.as_object_mut().expect("上面刚保证过是对象");
    for s in &selected {
        let entry = match src.format {
            Format::OpenCode => mcp::entry_opencode(s),
            Format::JsonServers => mcp::entry_vscode(s),
            Format::JsonFlat => mcp::entry_flat(s),
        };
        map.insert(s.name.clone(), entry);
        res.applied.push(s.name.clone());
    }
    if let Some(parent) = src.path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(&src.path, text) {
        res.errors.push(item("", "io", &e.to_string()));
    }
    Ok(res)
}

fn push_skills(skills_root: &Path, def: &HarnessDef, names: &[String]) -> TbTransferResult {
    let mut res = TbTransferResult::default();
    if def.skills_dirs.is_empty() {
        res.errors.push(item("", "notSupported", ""));
        return res;
    }
    for name in names {
        let mut done = false;
        for dir in &def.skills_dirs {
            if dir.join(name).join(skills::SKILL_MD).exists() {
                res.skipped.push(item(name, "exists", &dir.to_string_lossy()));
                done = true;
                continue;
            }
            match skills::push_to(skills_root, name, dir) {
                Ok(_) => done = true,
                Err(e) => {
                    if !skills_root.join(name).join(skills::SKILL_MD).exists() {
                        res.skipped.push(item(name, "notFound", ""));
                        done = true;
                    } else {
                        res.errors.push(item(name, "io", &e));
                    }
                }
            }
        }
        if done {
            res.applied.push(name.clone());
        }
    }
    res
}

fn remove_mcp(mcp_root: &Path, def: &HarnessDef, names: &[String]) -> Result<TbTransferResult, String> {
    let mut res = TbTransferResult::default();
    let Some(src) = def.mcp.iter().find(|s| s.path.exists()) else {
        res.errors.push(item("", "notFound", ""));
        return Ok(res);
    };
    let text = std::fs::read_to_string(&src.path).map_err(|e| e.to_string())?;
    let mut root: Map<String, Value> = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        other => {
            res.errors.push(item(
                "",
                "parse",
                &format!("{} · {other:?}", src.path.to_string_lossy()),
            ));
            return Ok(res);
        }
    };
    if let Ok(Some(bak)) = backup_file(&src.path) {
        res.backups.push(bak.to_string_lossy().into_owned());
    }
    // names 以工具箱里的 id 为准时先翻译成配置里的键名
    let local = mcp::list(mcp_root)?;
    let keys: Vec<String> = names
        .iter()
        .map(|n| {
            local
                .iter()
                .find(|s| &s.id == n || &s.name == n)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| n.clone())
        })
        .collect();
    if let Some(map) = root.get_mut(src.key).and_then(|x| x.as_object_mut()) {
        for key in &keys {
            if map.remove(key).is_some() {
                res.applied.push(key.clone());
            } else {
                res.skipped.push(item(key, "notFound", &src.path.to_string_lossy()));
            }
        }
    } else {
        for key in &keys {
            res.skipped.push(item(key, "notFound", &src.path.to_string_lossy()));
        }
    }
    // 一条都没删掉就不写回：没必要的写入等于没必要的风险。
    if res.applied.is_empty() {
        return Ok(res);
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(&src.path, out) {
        res.errors.push(item("", "io", &e.to_string()));
    }
    Ok(res)
}

fn remove_skills(def: &HarnessDef, names: &[String]) -> TbTransferResult {
    let mut res = TbTransferResult::default();
    if def.skills_dirs.is_empty() {
        res.errors.push(item("", "notSupported", ""));
        return res;
    }
    for name in names {
        let mut done = false;
        for dir in &def.skills_dirs {
            if !dir.join(name).join(skills::SKILL_MD).exists() {
                continue;
            }
            match skills::remove_from(name, dir) {
                Ok(Some(bak)) => {
                    res.backups.push(bak);
                    done = true;
                }
                Ok(None) => done = true,
                Err(e) => res.errors.push(item(name, "io", &e)),
            }
        }
        if done {
            res.applied.push(name.clone());
        } else {
            res.skipped.push(item(name, "notFound", ""));
        }
    }
    res
}

pub(crate) fn push(
    mcp_root: &Path,
    skills_root: &Path,
    harness: &str,
    kind: &str,
    names: &[String],
) -> Result<TbTransferResult, String> {
    let Some(def) = defs().into_iter().find(|d| d.id == harness) else {
        return Err(format!("未知工具: {harness}"));
    };
    match kind {
        "mcp" => push_mcp(mcp_root, &def, names),
        "skills" => Ok(push_skills(skills_root, &def, names)),
        other => Err(format!("未知类型: {other}")),
    }
}

pub(crate) fn remove(
    mcp_root: &Path,
    // 与 push 保持同样的参数形状，命令层不必分叉；移除只作用于对方目录，用不到本地技能根。
    _skills_root: &Path,
    harness: &str,
    kind: &str,
    names: &[String],
) -> Result<TbTransferResult, String> {
    let Some(def) = defs().into_iter().find(|d| d.id == harness) else {
        return Err(format!("未知工具: {harness}"));
    };
    match kind {
        "mcp" => remove_mcp(mcp_root, &def, names),
        "skills" => Ok(remove_skills(&def, names)),
        other => Err(format!("未知类型: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenthub::new_id as test_id;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nd-tb-harness-{tag}-{}", test_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn flat_def(config: PathBuf, skills_dir: PathBuf) -> HarnessDef {
        HarnessDef {
            id: "fake",
            name: "Fake Tool",
            mcp: vec![McpSource::flat(config)],
            skills_dirs: vec![skills_dir],
        }
    }

    fn stored(name: &str) -> TbMcpServer {
        TbMcpServer {
            id: String::new(),
            name: name.into(),
            description: String::new(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), name.into()],
            env: BTreeMap::new(),
            url: String::new(),
            headers: BTreeMap::new(),
            tags: Vec::new(),
            enabled: true,
            origin: None,
            versions: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn detects_the_three_json_shapes() {
        let dir = tmp("shapes");
        let flat = dir.join("flat.json");
        std::fs::write(
            &flat,
            r#"{"mcpServers":{"a":{"command":"npx","args":["x"],"env":{"K":"V"}}}}"#,
        )
        .unwrap();
        let (servers, ok, notes) = parse_mcp_source(&McpSource::flat(flat));
        assert!(ok && notes.is_empty());
        assert_eq!(servers[0].transport, "stdio");
        assert_eq!(servers[0].env["K"], "V");

        let vscode = dir.join("vscode.json");
        std::fs::write(&vscode, r#"{"servers":{"b":{"type":"http","url":"https://x"}}}"#).unwrap();
        let (servers, _, _) = parse_mcp_source(&McpSource {
            path: vscode,
            format: Format::JsonServers,
            key: "servers",
        });
        assert_eq!(servers[0].transport, "http");
        assert_eq!(servers[0].url, "https://x");

        let opencode = dir.join("opencode.json");
        std::fs::write(
            &opencode,
            r#"{"mcp":{"c":{"type":"local","command":["uvx","thing"],"environment":{"A":"B"}}}}"#,
        )
        .unwrap();
        let (servers, _, _) = parse_mcp_source(&McpSource {
            path: opencode,
            format: Format::OpenCode,
            key: "mcp",
        });
        assert_eq!(servers[0].command, "uvx");
        assert_eq!(servers[0].args, vec!["thing".to_string()]);
        assert_eq!(servers[0].env["A"], "B");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_or_unknown_configs_are_reported_not_guessed() {
        let dir = tmp("broken");
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ // 注释 }").unwrap();
        let (servers, ok, notes) = parse_mcp_source(&McpSource::flat(bad));
        assert!(servers.is_empty() && !ok);
        assert_eq!(notes[0].code, "mcpParseFailed");

        let arr = dir.join("arr.json");
        std::fs::write(&arr, "[]").unwrap();
        assert_eq!(parse_mcp_source(&McpSource::flat(arr)).2[0].code, "mcpShapeUnknown");

        let none = dir.join("none.json");
        std::fs::write(&none, "{}").unwrap();
        let (_, ok, notes) = parse_mcp_source(&McpSource::flat(none));
        assert!(ok, "文件存在但还没有 mcpServers 节点，算已找到");
        assert_eq!(notes[0].code, "mcpNodeMissing");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn push_mcp_backs_up_keeps_other_keys_and_aborts_on_broken_config() {
        let root = tmp("push-mcp");
        let config = root.join("tool.json");
        std::fs::write(&config, r#"{"theme":"dark","mcpServers":{"old":{"command":"keep"}}}"#).unwrap();
        let mcp_root = root.join("mcp");
        std::fs::create_dir_all(&mcp_root).unwrap();
        mcp::save(&mcp_root, stored("mine")).unwrap();
        let def = flat_def(config.clone(), root.join("skills"));

        let res = push_mcp(&mcp_root, &def, &["mine".to_string()]).unwrap();
        assert_eq!(res.applied, vec!["mine".to_string()]);
        assert_eq!(res.backups.len(), 1, "写前必须留备份");
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(after["theme"], "dark", "别的键必须原样保留");
        assert_eq!(after["mcpServers"]["old"]["command"], "keep");
        assert_eq!(after["mcpServers"]["mine"]["command"], "npx");

        // 坏配置：中止且不改动文件
        let broken = root.join("broken.json");
        std::fs::write(&broken, "{ oops").unwrap();
        let before = std::fs::read_to_string(&broken).unwrap();
        let res = push_mcp(&mcp_root, &flat_def(broken.clone(), root.join("skills")), &["mine".to_string()]).unwrap();
        assert_eq!(res.errors[0].code, "parse");
        assert_eq!(std::fs::read_to_string(&broken).unwrap(), before);

        // 不认识的名字 → notFound，且不写文件
        let res = push_mcp(&mcp_root, &def, &["ghost".to_string()]).unwrap();
        assert_eq!(res.skipped[0].code, "notFound");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_mcp_only_drops_the_targeted_key() {
        let root = tmp("remove-mcp");
        let config = root.join("tool.json");
        std::fs::write(&config, r#"{"mcpServers":{"a":{"command":"1"},"b":{"command":"2"}}}"#).unwrap();
        let mcp_root = root.join("mcp");
        std::fs::create_dir_all(&mcp_root).unwrap();
        let def = flat_def(config.clone(), root.join("skills"));

        let res = remove_mcp(&mcp_root, &def, &["a".to_string()]).unwrap();
        assert_eq!(res.applied, vec!["a".to_string()]);
        assert_eq!(res.backups.len(), 1);
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert!(after["mcpServers"].get("a").is_none());
        assert_eq!(after["mcpServers"]["b"]["command"], "2");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn collect_and_push_skills_between_tool_and_toolbox() {
        let root = tmp("skills");
        let skills_root = root.join("toolbox-skills");
        let foreign = root.join("tool-skills");
        std::fs::create_dir_all(foreign.join("theirs")).unwrap();
        std::fs::write(foreign.join("theirs").join(skills::SKILL_MD), "---\nname: Theirs\n---\n\nbody").unwrap();
        let def = flat_def(root.join("tool.json"), foreign.clone());

        let res = collect_from_def(&root.join("mcp"), &skills_root, &def, "skills", &["theirs".to_string()]).unwrap();
        assert_eq!(res.applied, vec!["theirs".to_string()]);
        assert!(skills_root.join("theirs").join(skills::SKILL_MD).exists());
        assert!(foreign.join("theirs").join(skills::SKILL_MD).exists(), "收集不改动对方");

        let again = collect_from_def(&root.join("mcp"), &skills_root, &def, "skills", &["theirs".to_string()]).unwrap();
        assert_eq!(again.skipped[0].code, "exists");

        let missing = collect_from_def(&root.join("mcp"), &skills_root, &def, "skills", &["ghost".to_string()]).unwrap();
        assert_eq!(missing.skipped[0].code, "notFound");

        // 分发：本地新建一个技能 → 推到对方目录；对方已有的报 exists
        let mine = skills::create(&skills_root, "Mine", "").unwrap();
        let res = push_skills(&skills_root, &def, &["mine".to_string()]);
        assert_eq!(res.applied, vec!["mine".to_string()]);
        assert!(foreign.join("mine").join(skills::SKILL_MD).exists());
        assert!(!foreign.join("mine").join(skills::HUB).exists(), "不要把自己的 sidecar 塞进别家目录");
        let res = push_skills(&skills_root, &def, &["mine".to_string()]);
        assert_eq!(res.skipped[0].code, "exists");

        // 移除：只删对方目录里的副本，本地源保留
        let res = remove_skills(&def, &["mine".to_string()]);
        assert_eq!(res.applied, vec!["mine".to_string()]);
        assert_eq!(res.backups.len(), 1);
        assert!(!foreign.join("mine").exists());
        assert!(skills_root.join(&mine.dir_name).join(skills::SKILL_MD).exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
