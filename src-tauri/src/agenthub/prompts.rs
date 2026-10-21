//! 提示词管理：`<数据根>/prompts/<id>.json`（与源侧同格式同语义）。
//!
//! 「暂存」与「发布」两种保存语义照搬源侧：暂存只落盘内容，时间轴不动；
//! 发布把当前正文记为一条版本。这样时间轴只代表用户显式发布过的节点，
//! 而不是每次自动保存都堆一条中间态。

use crate::agenthub::models::*;
use crate::agenthub::{new_id, now_iso, push_published, read_json, safe_dir_name, write_json};
use std::path::Path;

pub fn list(prompts_root: &Path) -> Result<Vec<TbPrompt>, String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(prompts_root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(p) = read_json::<TbPrompt>(&path) {
            out.push(p);
        }
    }
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

pub fn save(prompts_root: &Path, mut prompt: TbPrompt, publish: bool) -> Result<TbPrompt, String> {
    std::fs::create_dir_all(prompts_root).map_err(|e| e.to_string())?;
    let now = now_iso();
    if prompt.id.is_empty() {
        prompt.id = new_id("pr");
        prompt.created_at = now.clone();
        prompt.versions = Vec::new();
    }
    let path = prompts_root.join(format!("{}.json", safe_dir_name(&prompt.id)?));
    if path.exists() {
        // 版本以磁盘为准：前端只在编辑会话里持有副本，若期间别处发布过，
        // 用前端的副本覆盖会把那些版本丢掉。
        if let Ok(old) = read_json::<TbPrompt>(&path) {
            prompt.versions = old.versions;
            if prompt.created_at.is_empty() {
                prompt.created_at = old.created_at;
            }
        }
    } else {
        prompt.created_at = now.clone();
    }
    if publish {
        push_published(&mut prompt.versions, &prompt.content, "");
    }
    prompt.updated_at = now;
    write_json(&path, &prompt)?;
    Ok(prompt)
}

pub fn delete(prompts_root: &Path, id: &str) -> Result<(), String> {
    let path = prompts_root.join(format!("{}.json", safe_dir_name(id)?));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 回滚到某个历史版本（版本历史保留，可来回切）。
pub fn restore(prompts_root: &Path, id: &str, v: u32) -> Result<TbPrompt, String> {
    let path = prompts_root.join(format!("{}.json", safe_dir_name(id)?));
    let mut prompt = read_json::<TbPrompt>(&path)?;
    let entry = prompt
        .versions
        .iter()
        .find(|x| x.v == v)
        .ok_or_else(|| format!("版本 v{v} 不存在"))?
        .clone();
    prompt.content = entry.content;
    prompt.updated_at = now_iso();
    write_json(&path, &prompt)?;
    Ok(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenthub::new_id as test_id;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nd-tb-prompts-{}", test_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn prompt(content: &str) -> TbPrompt {
        TbPrompt {
            id: String::new(),
            title: "t".into(),
            description: String::new(),
            content: content.into(),
            tags: Vec::new(),
            versions: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn stash_never_creates_a_version_but_still_saves() {
        let root = tmp();
        let saved = save(&root, prompt("first"), false).unwrap();
        assert!(saved.versions.is_empty());
        let mut again = prompt("second");
        again.id = saved.id.clone();
        let saved2 = save(&root, again, false).unwrap();
        assert!(saved2.versions.is_empty());
        let on_disk = read_json::<TbPrompt>(&root.join(format!("{}.json", saved.id))).unwrap();
        assert_eq!(on_disk.content, "second");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn publish_appends_and_repeats_are_ignored() {
        let root = tmp();
        let v1 = save(&root, prompt("one"), true).unwrap();
        assert_eq!(v1.versions.len(), 1);
        let mut same = prompt("one");
        same.id = v1.id.clone();
        let v2 = save(&root, same, true).unwrap();
        assert_eq!(v2.versions.len(), 1, "发布同样正文不该刷出重复节点");
        let mut next = prompt("two");
        next.id = v1.id.clone();
        let v3 = save(&root, next, true).unwrap();
        assert_eq!(v3.versions.len(), 2);
        assert_eq!(v3.versions[1].v, 2);
        assert_eq!(list(&root).unwrap().len(), 1);
        delete(&root, &v1.id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    /// 源侧 `Prompt` 里的 `variables` 字段：保存后必须还在
    #[test]
    fn unknown_fields_of_a_migrated_file_survive() {
        let root = tmp();
        let legacy = r#"{"id":"x","title":"legacy","content":"c","variables":[{"name":"n"}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}"#;
        std::fs::write(root.join("x.json"), legacy).unwrap();
        let mut loaded = list(&root).unwrap().into_iter().next().unwrap();
        loaded.tags = vec!["t".into()];
        save(&root, loaded, false).unwrap();
        let text = std::fs::read_to_string(root.join("x.json")).unwrap();
        assert!(text.contains("variables"), "未知字段不能被抹掉: {text}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn restore_brings_back_a_published_body() {
        let root = tmp();
        let v1 = save(&root, prompt("one"), true).unwrap();
        let mut next = prompt("two");
        next.id = v1.id.clone();
        let v2 = save(&root, next, true).unwrap();
        assert_eq!(v2.versions.len(), 2);
        let rolled = restore(&root, &v1.id, 1).unwrap();
        assert_eq!(rolled.content, "one");
        assert_eq!(rolled.versions.len(), 2, "回滚不该动历史");
        assert!(restore(&root, &v1.id, 9).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ids_with_separators_are_rejected() {
        let root = tmp();
        assert!(delete(&root, "../../evil").is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
