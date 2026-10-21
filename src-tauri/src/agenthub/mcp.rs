//! MCP 服务管理：`<数据根>/mcp/<id>.json`，以及各工具配置格式的条目编码。
//!
//! 条目编码（`entry_*`）是纯函数：收集与分发都要在这里翻译，
//! 一个地方错了就会把别家工具的配置写成别的形状。

use crate::agenthub::models::*;
use crate::agenthub::{new_id, now_iso, push_version, read_json, safe_dir_name, write_json};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;

pub fn list(mcp_root: &Path) -> Result<Vec<TbMcpServer>, String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(mcp_root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = read_json::<TbMcpServer>(&path) {
            out.push(s);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn save(mcp_root: &Path, mut server: TbMcpServer) -> Result<TbMcpServer, String> {
    std::fs::create_dir_all(mcp_root).map_err(|e| e.to_string())?;
    let now = now_iso();
    if server.id.is_empty() {
        server.id = new_id("mc");
        server.created_at = now.clone();
        server.versions = Vec::new();
    }
    let path = mcp_root.join(format!("{}.json", safe_dir_name(&server.id)?));
    if path.exists() {
        if let Ok(old) = read_json::<TbMcpServer>(&path) {
            // 快照要在搬走 `old` 的字段之前算好（搬字段会让 `old` 变成半移动状态）。
            let previous = connection_snapshot(&old);
            server.versions = old.versions;
            if server.created_at.is_empty() {
                server.created_at = old.created_at;
            }
            // 只有「连接配置」变了才存档：改标签/备注不该刷版本。
            if previous != connection_snapshot(&server) {
                push_version(&mut server.versions, &serde_json::to_string(&previous).unwrap_or_default());
            }
        }
    } else {
        server.created_at = now.clone();
    }
    server.updated_at = now;
    write_json(&path, &server)?;
    Ok(server)
}

pub fn delete(mcp_root: &Path, id: &str) -> Result<(), String> {
    let path = mcp_root.join(format!("{}.json", safe_dir_name(id)?));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

pub fn connection_snapshot(s: &TbMcpServer) -> Value {
    json!({
        "command": s.command,
        "args": s.args,
        "env": s.env,
        "url": s.url,
        "headers": s.headers,
        "transport": s.transport,
    })
}

// ---------------- 各工具配置格式的条目 ----------------

/// 标准 `mcpServers` 条目（Claude Code / Cursor / Gemini / Cline …）。
pub fn entry_flat(s: &TbMcpServer) -> Value {
    if s.transport == "stdio" {
        json!({ "command": s.command, "args": s.args, "env": s.env })
    } else {
        json!({ "type": s.transport, "url": s.url, "headers": s.headers })
    }
}

/// VS Code(Copilot) 的 `servers` 条目：stdio 也必须带 `type`。
pub fn entry_vscode(s: &TbMcpServer) -> Value {
    if s.transport == "stdio" {
        json!({ "type": "stdio", "command": s.command, "args": s.args, "env": s.env })
    } else {
        json!({ "type": s.transport, "url": s.url, "headers": s.headers })
    }
}

/// OpenCode 的 `mcp` 条目：`command` 是数组、env 叫 `environment`、type 是 local/remote。
pub fn entry_opencode(s: &TbMcpServer) -> Value {
    if s.transport == "stdio" {
        let mut command = vec![Value::String(s.command.clone())];
        command.extend(s.args.iter().cloned().map(Value::String));
        json!({ "type": "local", "command": command, "environment": s.env, "enabled": s.enabled })
    } else {
        json!({ "type": "remote", "url": s.url, "headers": s.headers, "enabled": s.enabled })
    }
}

/// 标准导出：`{"mcpServers":{name:entry}}`，只含启用且有名子的条目。
pub fn export(servers: &[TbMcpServer], ids: &[String]) -> Value {
    let mut map = Map::new();
    for s in servers.iter().filter(|s| s.enabled && !s.name.trim().is_empty()) {
        if !ids.is_empty() && !ids.contains(&s.id) {
            continue;
        }
        map.insert(s.name.clone(), entry_flat(s));
    }
    json!({ "mcpServers": map })
}

/// 把探测到的条目转成工具箱里的服务（收集时用）。
pub fn from_detected(d: &TbDetectedServer, harness: &str, file: &str) -> TbMcpServer {
    TbMcpServer {
        id: String::new(),
        name: d.name.clone(),
        description: String::new(),
        transport: d.transport.clone(),
        command: d.command.clone(),
        args: d.args.clone(),
        env: d.env.clone(),
        url: d.url.clone(),
        headers: d.headers.clone(),
        tags: Vec::new(),
        enabled: true,
        origin: Some(TbOrigin {
            harness: harness.to_string(),
            file: file.to_string(),
            imported_at: now_iso(),
        }),
        versions: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
        extra: Map::new(),
    }
}

/// 覆盖已存在的同名服务时，只换连接配置，保留本地 id / 标签 / 版本历史。
pub fn merge_connection(old: &TbMcpServer, detected: &TbDetectedServer, harness: &str, file: &str) -> TbMcpServer {
    let mut merged = old.clone();
    merged.transport = detected.transport.clone();
    merged.command = detected.command.clone();
    merged.args = detected.args.clone();
    merged.env = detected.env.clone();
    merged.url = detected.url.clone();
    merged.headers = detected.headers.clone();
    merged.origin = Some(TbOrigin {
        harness: harness.to_string(),
        file: file.to_string(),
        imported_at: now_iso(),
    });
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenthub::new_id as test_id;
    use std::path::PathBuf;

    fn server(name: &str) -> TbMcpServer {
        TbMcpServer {
            id: String::new(),
            name: name.into(),
            description: String::new(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "srv".into()],
            env: BTreeMap::from([("K".to_string(), "V".to_string())]),
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

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nd-tb-mcp-{}", test_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stdio_and_remote_entries_use_the_right_shape_per_tool() {
        let stdio = server("a");
        assert_eq!(entry_flat(&stdio)["command"], "npx");
        assert!(entry_flat(&stdio).get("type").is_none(), "标准格式的 stdio 条目不带 type");
        assert_eq!(entry_vscode(&stdio)["type"], "stdio");
        assert_eq!(entry_opencode(&stdio)["command"][0], "npx");
        assert_eq!(entry_opencode(&stdio)["environment"]["K"], "V");

        let mut remote = server("b");
        remote.transport = "http".into();
        remote.url = "https://x/mcp".into();
        assert_eq!(entry_flat(&remote)["type"], "http");
        assert_eq!(entry_vscode(&remote)["url"], "https://x/mcp");
        assert_eq!(entry_opencode(&remote)["type"], "remote");
    }

    #[test]
    fn export_uses_standard_envelope_and_skips_disabled_or_unnamed() {
        let mut disabled = server("off");
        disabled.enabled = false;
        let mut unnamed = server("  ");
        unnamed.enabled = true;
        let out = export(&[server("a"), disabled, unnamed], &[]);
        let servers = out["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers["a"]["args"][1], "srv");
    }

    #[test]
    fn save_archives_only_connection_changes() {
        let root = tmp();
        let saved = save(&root, server("a")).unwrap();
        let mut renamed = saved.clone();
        renamed.tags = vec!["x".into()];
        let after_tag = save(&root, renamed).unwrap();
        assert!(after_tag.versions.is_empty(), "只改标签不该产生版本");

        let mut changed = after_tag.clone();
        changed.command = "uvx".into();
        let after_cmd = save(&root, changed).unwrap();
        assert_eq!(after_cmd.versions.len(), 1);
        let snapshot: Value = serde_json::from_str(&after_cmd.versions[0].content).unwrap();
        assert_eq!(snapshot["command"], "npx");

        let mut remote = saved.clone();
        remote.transport = "http".into();
        remote.url = "https://x".into();
        save(&root, remote).unwrap();
        assert_eq!(list(&root).unwrap().len(), 1);
        delete(&root, &saved.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrated_files_keep_unknown_fields() {
        let root = tmp();
        let legacy = r#"{"id":"m1","name":"legacy","command":"x","targets":["cursor"],"targetsInitialized":true,"createdAt":"","updatedAt":""}"#;
        std::fs::write(root.join("m1.json"), legacy).unwrap();
        let loaded = list(&root).unwrap().into_iter().next().unwrap();
        save(&root, loaded).unwrap();
        let text = std::fs::read_to_string(root.join("m1.json")).unwrap();
        assert!(text.contains("targetsInitialized"), "未知字段不能被抹掉: {text}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn merge_connection_keeps_local_identity() {
        let mut old = server("a");
        old.id = "keep-me".into();
        old.tags = vec!["mine".into()];
        let detected = TbDetectedServer {
            name: "a".into(),
            transport: "http".into(),
            command: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: "https://y".into(),
            headers: BTreeMap::new(),
        };
        let merged = merge_connection(&old, &detected, "cursor", "C:/x/mcp.json");
        assert_eq!(merged.id, "keep-me");
        assert_eq!(merged.tags, vec!["mine".to_string()]);
        assert_eq!(merged.url, "https://y");
        assert_eq!(merged.origin.unwrap().harness, "cursor");
    }
}
