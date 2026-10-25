//! MCP 预设：命名的一组 MCP 服务，用来在 MCP 页左侧快速切换查看。
//!
//! 与 Skills 预设（`presets.rs`）刻意分开存储：`mcp-presets.json`，
//! 成员是服务名而不是 id —— 服务删除后重建 id 会变，但名字仍是用户认得的那个；
//! 服务被删除时由 `remove_server` 自动从所有预设摘除，界面上不再留标灰的死条目。
//!
//! 写入同样「读-改-写 + 临时文件后替换」；JSON 损坏直接报错，绝不静默重置。

use crate::ahub::models::{new_id, now_iso};
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub server_names: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PresetFile {
    presets: Vec<McpPreset>,
}

fn err(code: &str, detail: &str) -> String {
    if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}: {detail}")
    }
}

fn path_of(root: &Path) -> PathBuf {
    root.join("mcp-presets.json")
}

fn read_at(root: &Path) -> Result<Vec<McpPreset>, String> {
    let path = path_of(root);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| err("preset.io", &e.to_string()))?;
    let file: PresetFile = serde_json::from_str(&text)
        .map_err(|e| err("preset.corrupt", &format!("{}|{e}", path.display())))?;
    Ok(file.presets)
}

fn write_at(root: &Path, presets: &[McpPreset]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(store::es)?;
    let path = path_of(root);
    let tmp = root.join(format!("mcp-presets.json.tmp-{}", new_id()));
    let text = serde_json::to_string_pretty(&PresetFile {
        presets: presets.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err("preset.io", &e.to_string()));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err("preset.io", &e.to_string()));
    }
    Ok(())
}

fn norm_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn ensure_unique(presets: &[McpPreset], name: &str, exclude: Option<&str>) -> Result<(), String> {
    let target = norm_name(name);
    if presets
        .iter()
        .any(|p| Some(p.id.as_str()) != exclude && norm_name(&p.name) == target)
    {
        return Err(err("preset.nameDuplicate", name.trim()));
    }
    Ok(())
}

fn dedupe(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && seen.insert(n.clone()))
        .collect()
}

pub fn list(app: &AppH) -> Result<Vec<McpPreset>, String> {
    read_at(&store::data_root(app))
}

pub fn create(
    app: &AppH,
    name: &str,
    description: &str,
    server_names: Vec<String>,
) -> Result<McpPreset, String> {
    create_at(&store::data_root(app), name, description, server_names)
}

pub fn update(
    app: &AppH,
    id: &str,
    name: Option<String>,
    description: Option<String>,
    server_names: Option<Vec<String>>,
) -> Result<McpPreset, String> {
    update_at(&store::data_root(app), id, name, description, server_names)
}

pub fn delete(app: &AppH, id: &str) -> Result<(), String> {
    delete_at(&store::data_root(app), id)
}

fn create_at(
    root: &Path,
    name: &str,
    description: &str,
    server_names: Vec<String>,
) -> Result<McpPreset, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(err("preset.nameRequired", ""));
    }
    let mut presets = read_at(root)?;
    ensure_unique(&presets, name, None)?;
    let ts = now_iso();
    let preset = McpPreset {
        id: new_id(),
        name: name.to_string(),
        description: description.trim().to_string(),
        server_names: dedupe(server_names),
        created_at: ts.clone(),
        updated_at: ts,
    };
    presets.push(preset.clone());
    write_at(root, &presets)?;
    Ok(preset)
}

fn update_at(
    root: &Path,
    id: &str,
    name: Option<String>,
    description: Option<String>,
    server_names: Option<Vec<String>>,
) -> Result<McpPreset, String> {
    let mut presets = read_at(root)?;
    let idx = presets
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| err("preset.notFound", id))?;
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err(err("preset.nameRequired", ""));
        }
        ensure_unique(&presets, &n, Some(id))?;
        presets[idx].name = n;
    }
    if let Some(d) = description {
        presets[idx].description = d.trim().to_string();
    }
    if let Some(m) = server_names {
        presets[idx].server_names = dedupe(m);
    }
    presets[idx].updated_at = now_iso();
    let updated = presets[idx].clone();
    write_at(root, &presets)?;
    Ok(updated)
}

fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    let mut presets = read_at(root)?;
    let before = presets.len();
    presets.retain(|p| p.id != id);
    if presets.len() == before {
        return Err(err("preset.notFound", id));
    }
    write_at(root, &presets)
}

/// 服务被删除后，把它从所有预设的成员里摘掉。
///
/// 成员存的是名字，删掉的服务留在预设里只会永远标灰；
/// 返回被改动的预设数，没有命中的预设时不落盘。
pub fn remove_server(app: &AppH, name: &str) -> Result<usize, String> {
    remove_member_at(&store::data_root(app), name)
}

fn remove_member_at(root: &Path, name: &str) -> Result<usize, String> {
    let mut presets = read_at(root)?;
    let mut changed = 0;
    for p in presets.iter_mut() {
        let before = p.server_names.len();
        p.server_names.retain(|n| n != name);
        if p.server_names.len() != before {
            p.updated_at = now_iso();
            changed += 1;
        }
    }
    if changed > 0 {
        write_at(root, &presets)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-mcp-preset-{tag}-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn create_list_update_delete_roundtrip() {
        let root = tmpdir("crud");
        let p = create_at(&root, "写作", "常用", vec!["a".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(p.server_names, vec!["a", "b"]);
        assert_eq!(read_at(&root).unwrap().len(), 1);
        let u = update_at(&root, &p.id, Some("写作2".into()), None, Some(vec!["b".into()])).unwrap();
        assert_eq!(u.name, "写作2");
        assert_eq!(u.server_names, vec!["b"]);
        delete_at(&root, &p.id).unwrap();
        assert!(read_at(&root).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_duplicate_name_case_insensitive() {
        let root = tmpdir("dup");
        create_at(&root, "Writing", "", vec![]).unwrap();
        let e = create_at(&root, "writing", "", vec![]).unwrap_err();
        assert!(e.starts_with("preset.nameDuplicate"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_list() {
        let root = tmpdir("corrupt");
        std::fs::write(path_of(&root), "{not json").unwrap();
        let e = read_at(&root).unwrap_err();
        assert!(e.starts_with("preset.corrupt"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_server_cleans_all_presets_and_skips_miss() {
        let root = tmpdir("remove");
        create_at(&root, "A", "", vec!["chrome".into(), "codegraph".into()]).unwrap();
        create_at(&root, "B", "", vec!["chrome".into()]).unwrap();
        create_at(&root, "C", "", vec!["other".into()]).unwrap();

        let n = remove_member_at(&root, "chrome").unwrap();
        assert_eq!(n, 2);
        let presets = read_at(&root).unwrap();
        assert_eq!(presets[0].server_names, vec!["codegraph"]);
        assert!(presets[1].server_names.is_empty());
        assert_eq!(presets[2].server_names, vec!["other"]);

        // 没有命中的预设时不落盘也返回 0
        assert_eq!(remove_member_at(&root, "chrome").unwrap(), 0);
        let _ = std::fs::remove_dir_all(root);
    }
}
