use crate::ahub::models::*;
use crate::ahub::store::{self, AppH, es};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

fn prompts_dir(app: &AppH) -> PathBuf {
    store::data_root(app).join("prompts")
}
fn mcp_dir(app: &AppH) -> PathBuf {
    store::data_root(app).join("mcp")
}

// ---------------- Prompts ----------------

pub fn list_prompts(app: &AppH) -> Result<Vec<Prompt>, String> {
    let dir = prompts_dir(app);
    std::fs::create_dir_all(&dir).map_err(es)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(es)? {
        let entry = entry.map_err(es)?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(p) = store::read_json::<Prompt>(&path) {
                out.push(p);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 保存提示词到指定目录（纯路径版，便于直接测）。
///
/// `publish` 是发布语义开关：
///   · `false`（暂存）—— 只落盘内容/元数据，**不动** versions
///   · `true` （发布）—— 落盘后把当前正文记为一条新版本
/// 拆成两种语义是因为旧实现「每次保存都顺手存旧内容」，导致版本时间轴里堆满
/// 用户根本没打算留下的中间态。现在时间轴只代表用户显式发布过的节点。
pub fn save_prompt_at(dir: &Path, mut p: Prompt, publish: bool) -> Result<Prompt, String> {
    std::fs::create_dir_all(dir).map_err(es)?;
    let now = now_iso();
    if p.id.is_empty() {
        p.id = new_id();
        p.created_at = now.clone();
        p.versions = Vec::new();
    }
    let path = dir.join(format!("{}.json", p.id));
    if path.exists() {
        // 旧文件里的 versions 以磁盘上的为准 —— 前端只在编辑会话内持有副本，
        // 若期间别处写过版本（如批量发布），用前端的会覆盖丢掉。
        if let Ok(old) = store::read_json::<Prompt>(&path) {
            p.versions = old.versions;
        }
    } else {
        p.created_at = now.clone();
    }
    if publish {
        store::push_published(&mut p.versions, &p.content);
    }
    p.updated_at = now;
    store::write_json(&path, &p)?;
    Ok(p)
}

pub fn save_prompt(app: &AppH, p: Prompt, publish: bool) -> Result<Prompt, String> {
    save_prompt_at(&prompts_dir(app), p, publish)
}

pub fn delete_prompt(app: &AppH, id: &str) -> Result<(), String> {
    let path = prompts_dir(app).join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(es)?;
    }
    Ok(())
}

// ---------------- MCP servers ----------------

pub fn list_mcp(app: &AppH) -> Result<Vec<McpServer>, String> {
    let dir = mcp_dir(app);
    std::fs::create_dir_all(&dir).map_err(es)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(es)? {
        let entry = entry.map_err(es)?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(mut p) = store::read_json::<McpServer>(&path) {
                // 一次性迁移：从某工具收集来的 MCP 本就存在于该工具，补上来源工具作为应用目标，
                // 并写回磁盘 + 置标志位，之后用户移除不再被重新加回。
                if !p.targets_initialized {
                    if p.targets.is_empty() {
                        if let Some(o) = &p.origin {
                            if !o.harness.is_empty() {
                                p.targets = vec![o.harness.clone()];
                            }
                        }
                    }
                    p.targets_initialized = true;
                    let _ = store::write_json(&path, &p);
                }
                out.push(p);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn save_mcp(app: &AppH, mut s: McpServer) -> Result<McpServer, String> {
    let dir = mcp_dir(app);
    std::fs::create_dir_all(&dir).map_err(es)?;
    let now = now_iso();
    if s.id.is_empty() {
        s.id = new_id();
        s.created_at = now.clone();
        s.versions = Vec::new();
    }
    let path = dir.join(format!("{}.json", s.id));
    if path.exists() {
        if let Ok(old) = store::read_json::<McpServer>(&path) {
            let snapshot = |x: &McpServer| {
                serde_json::json!({
                    "command": x.command, "args": x.args, "env": x.env,
                    "url": x.url, "headers": x.headers, "transport": x.transport
                })
            };
            if snapshot(&old) != snapshot(&s) {
                store::push_version(&mut s.versions, &serde_json::to_string(&snapshot(&old)).unwrap_or_default());
            }
        }
    } else {
        s.created_at = now.clone();
    }
    s.updated_at = now;
    store::write_json(&path, &s)?;
    Ok(s)
}

pub fn delete_mcp(app: &AppH, id: &str) -> Result<(), String> {
    let path = mcp_dir(app).join(format!("{id}.json"));
    // 删除前记下服务名：预设成员按名字引用，文件删了就没法反查了
    let name = store::read_json::<McpServer>(&path).ok().map(|s| s.name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(es)?;
    }
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        crate::ahub::mcp_presets::remove_server(app, &name)?;
    }
    Ok(())
}

/// Standard `mcpServers` JSON config export.
pub fn export_config(servers: &[McpServer]) -> Value {
    let mut map = Map::new();
    for s in servers.iter().filter(|s| s.enabled && !s.name.is_empty()) {
        let entry = if s.transport == "stdio" {
            json!({
                "command": s.command,
                "args": s.args,
                "env": s.env,
            })
        } else {
            json!({
                "type": s.transport,
                "url": s.url,
                "headers": s.headers,
            })
        };
        map.insert(s.name.clone(), entry);
    }
    json!({ "mcpServers": map })
}


#[cfg(test)]
mod prompt_save_tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-prompt-{tag}-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn prompt(title: &str, content: &str) -> Prompt {
        Prompt {
            id: String::new(),
            title: title.into(),
            description: String::new(),
            content: content.into(),
            tags: Vec::new(),
            variables: Vec::new(),
            versions: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// 暂存不得产生任何版本 —— 这是「右侧时间轴只记录已发布版本」的根
    #[test]
    fn stash_never_creates_version() {
        let d = tmpdir("stash");
        let saved = save_prompt_at(&d, prompt("t", "first body"), false).unwrap();
        assert!(saved.versions.is_empty(), "首次暂存不该有版本");

        let mut again = saved.clone();
        again.content = "second body".into();
        let saved2 = save_prompt_at(&d, again, false).unwrap();
        assert!(saved2.versions.is_empty(), "再次暂存也不该有版本");

        // 落盘内容确实更新了（暂存是"保存但不记版本"，不是"不保存"）
        let on_disk = store::read_json::<Prompt>(&d.join(format!("{}.json", saved.id))).unwrap();
        assert_eq!(on_disk.content, "second body");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn publish_creates_version_and_keeps_history() {
        let d = tmpdir("publish");
        let v1 = save_prompt_at(&d, prompt("t", "body one"), true).unwrap();
        assert_eq!(v1.versions.len(), 1);
        assert_eq!(v1.versions[0].content, "body one");

        let mut next = v1.clone();
        next.content = "body two".into();
        let v2 = save_prompt_at(&d, next, true).unwrap();
        assert_eq!(v2.versions.len(), 2);
        assert_eq!(v2.versions[1].v, 2);
        assert_eq!(v2.versions[1].content, "body two");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 前端只在内存里持有 versions 副本；磁盘才是事实来源。
    /// 若保存时用前端的旧副本覆盖，会丢掉别处写入的版本。
    #[test]
    fn disk_versions_win_over_stale_payload() {
        let d = tmpdir("stale");
        let v1 = save_prompt_at(&d, prompt("t", "one"), true).unwrap();
        let mut v2 = v1.clone();
        v2.content = "two".into();
        let saved = save_prompt_at(&d, v2, true).unwrap();
        assert_eq!(saved.versions.len(), 2);

        // 模拟前端拿着只含 1 条版本的陈旧对象来暂存
        let mut stale = v1.clone();
        stale.content = "three".into();
        stale.versions.truncate(1);
        let saved3 = save_prompt_at(&d, stale, false).unwrap();
        assert_eq!(saved3.versions.len(), 2, "磁盘上的版本不能被陈旧副本截断");
        assert_eq!(saved3.content, "three");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 发布同样的正文不该刷出重复节点
    #[test]
    fn republish_same_content_is_noop() {
        let d = tmpdir("dup");
        let v1 = save_prompt_at(&d, prompt("t", "same"), true).unwrap();
        let v2 = save_prompt_at(&d, v1.clone(), true).unwrap();
        assert_eq!(v2.versions.len(), 1);
        std::fs::remove_dir_all(&d).ok();
    }
}
