//! 技能管理：`<数据根>/skills/<dir-name>/SKILL.md`。
//!
//! frontmatter 按**原文**读写，不做结构化解析（不引 YAML 解析器）。这样做的
//! 结果是：用户没动 frontmatter 时落盘字节不变 —— 也就不存在「保存一次把用户
//! 的 YAML 写坏」这类故障。`fm_field` 只做列表页的粗读（name/description），
//! 真源永远是原文本身。
//!
//! 云台私有的标签与版本历史放在同目录 `.hub.json`（源侧同名 sidecar），
//! 且**原样保留未知字段**：别家工具写进去的 `vetReport`/`summary` 不会被抹掉。

use crate::agenthub::models::*;
use crate::agenthub::{copy_dir_recursive, dir_size_and_count, newest_mtime, now_iso, push_published, read_sidecar, safe_dir_name, slugify, stamp, write_json};
use serde_json::{json, Value};
use std::path::Path;

pub const SKILL_MD: &str = "SKILL.md";
pub const HUB: &str = ".hub.json";

// ---------------- frontmatter 原文处理 ----------------

/// 拆出 (frontmatter 原文, 正文)。没有 frontmatter 时前段为空串，正文原样返回。
pub fn split_doc(doc: &str) -> (String, String) {
    let d = doc.strip_prefix('\u{feff}').unwrap_or(doc);
    let Some(first_end) = d.find('\n') else {
        return (String::new(), d.to_string());
    };
    if d[..first_end].trim_end_matches('\r').trim() != "---" {
        return (String::new(), d.to_string());
    }
    let mut idx = first_end + 1;
    while idx <= d.len() {
        let end = d[idx..].find('\n').map(|i| idx + i).unwrap_or(d.len());
        let line = d[idx..end].trim_end_matches('\r').trim();
        if line == "---" || line == "..." {
            let fm = d[first_end + 1..idx].trim_end_matches(['\n', '\r']).to_string();
            let body_start = if end < d.len() { end + 1 } else { end };
            return (fm, d[body_start..].trim_start_matches(['\n', '\r']).to_string());
        }
        if end >= d.len() {
            break;
        }
        idx = end + 1;
    }
    // 只有开头没有闭合：整篇当正文，不做改写（宁可不解析，也不猜）
    (String::new(), d.to_string())
}

/// (frontmatter 原文, 正文) → 文档文本。
pub fn compose_doc(frontmatter: &str, body: &str) -> String {
    let fm = frontmatter.trim_matches(['\n', '\r']).trim_end();
    let b = body.trim_start_matches(['\n', '\r']);
    if fm.trim().is_empty() {
        return b.to_string();
    }
    format!("---\n{fm}\n---\n\n{b}")
}

/// 从 frontmatter 原文里粗读一个顶层标量字段（仅用于列表展示）。
///
/// 认「列 0 起的 `key:`」、带引号的值、以及 `>`/`|` 块标量的续行；
/// 嵌套映射等复杂结构返回空串 —— 需要精确值时读原文。
pub fn fm_field(fm: &str, key: &str) -> String {
    let lines: Vec<&str> = fm.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with([' ', '\t']) || line.trim_start().starts_with('#') {
            continue;
        }
        let Some(rest) = line.strip_prefix(key).and_then(|r| r.strip_prefix(':')) else {
            continue;
        };
        let value = rest.trim();
        if value.is_empty() {
            return String::new();
        }
        let block = value == ">" || value == "|" || value.starts_with(">-") || value.starts_with("|-") || value.starts_with(">+") || value.starts_with("|+");
        if block {
            let mut parts: Vec<String> = Vec::new();
            for cont in &lines[i + 1..] {
                if cont.trim().is_empty() {
                    continue;
                }
                if !cont.starts_with([' ', '\t']) {
                    break;
                }
                parts.push(cont.trim().to_string());
            }
            return parts.join(" ").trim().to_string();
        }
        return unquote(value);
    }
    String::new()
}

fn unquote(v: &str) -> String {
    let quoted = v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted {
        return v[1..v.len() - 1].to_string();
    }
    match v.find(" #") {
        Some(i) => v[..i].trim_end().to_string(),
        None => v.to_string(),
    }
}

/// 把一个值写成合法的 YAML 标量（新建技能时用）。多行压成空格 —— 值里带换行
/// 的正确写法是块标量，这里不替用户做那个决定。
pub fn yaml_scalar(v: &str) -> String {
    let flat = v.replace(['\n', '\r'], " ").trim().to_string();
    let needs = flat.is_empty()
        || flat.contains([':', '#', '"', '\''])
        || flat.starts_with(['-', '?', '*', '&', '!', '|', '>', '@', '`', '%', '[', ']', '{', '}', ',', ' ', '\''])
        || flat.ends_with(' ');
    if !needs {
        return flat;
    }
    format!("\"{}\"", flat.replace('\\', "\\\\").replace('"', "\\\""))
}

// ---------------- 读写 ----------------

fn hub_tags(hub: &serde_json::Map<String, Value>) -> Vec<String> {
    hub.get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn hub_versions(hub: &serde_json::Map<String, Value>) -> Vec<TbVersion> {
    hub.get("versions")
        .and_then(|v| serde_json::from_value::<Vec<TbVersion>>(v.clone()).ok())
        .unwrap_or_default()
}

fn hub_origin(hub: &serde_json::Map<String, Value>) -> Option<TbOrigin> {
    hub.get("origin").and_then(|v| serde_json::from_value(v.clone()).ok())
}

pub fn meta_for(dir: &Path) -> Result<TbSkillMeta, String> {
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("无法取目录名: {}", dir.display()))?;
    let path = dir.join(SKILL_MD);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (fm, _) = split_doc(&text);
    let hub = read_sidecar(&dir.join(HUB));
    let declared = fm_field(&fm, "name");
    let (bytes, file_count) = dir_size_and_count(dir, &[HUB])?;
    Ok(TbSkillMeta {
        name: if declared.is_empty() { dir_name.clone() } else { declared },
        description: fm_field(&fm, "description"),
        tags: hub_tags(&hub),
        origin: hub_origin(&hub),
        versions: hub_versions(&hub).len(),
        bytes,
        file_count,
        updated_at: newest_mtime(dir),
        dir_name,
    })
}

pub fn list(skills_root: &Path) -> Result<Vec<TbSkillMeta>, String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(skills_root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(SKILL_MD).exists() {
            if let Ok(meta) = meta_for(&path) {
                out.push(meta);
            }
        }
    }
    out.sort_by_key(|m| m.name.to_lowercase());
    Ok(out)
}

pub fn read(skills_root: &Path, dir_name: &str) -> Result<TbSkillDoc, String> {
    let dir = skills_root.join(safe_dir_name(dir_name)?);
    if !dir.join(SKILL_MD).exists() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let text = std::fs::read_to_string(dir.join(SKILL_MD)).map_err(|e| e.to_string())?;
    let (frontmatter, body) = split_doc(&text);
    let hub = read_sidecar(&dir.join(HUB));
    Ok(TbSkillDoc {
        meta: meta_for(&dir)?,
        frontmatter,
        body,
        path: dir.join(SKILL_MD).to_string_lossy().into_owned(),
        version_list: hub_versions(&hub),
    })
}

fn write_hub(dir: &Path, mutate: impl FnOnce(&mut serde_json::Map<String, Value>)) -> Result<(), String> {
    let path = dir.join(HUB);
    let mut hub = read_sidecar(&path);
    mutate(&mut hub);
    write_json(&path, &Value::Object(hub))
}

pub fn save(skills_root: &Path, payload: TbSkillSave) -> Result<TbSkillMeta, String> {
    let dir = skills_root.join(safe_dir_name(&payload.dir_name)?);
    if !dir.join(SKILL_MD).exists() {
        return Err(format!("技能不存在: {}", payload.dir_name));
    }
    let text = compose_doc(&payload.frontmatter, &payload.body);
    crate::atomic::write_file_atomic(&dir.join(SKILL_MD).to_string_lossy(), text.as_bytes())
        .map_err(|e| format!("保存 SKILL.md 失败: {e}"))?;
    write_hub(&dir, |hub| {
        hub.insert("tags".into(), json!(payload.tags));
        if payload.publish {
            let mut versions = hub_versions(hub);
            if push_published(&mut versions, &text, &payload.note) {
                hub.insert("versions".into(), serde_json::to_value(&versions).unwrap_or(json!([])));
            }
        }
    })?;
    meta_for(&dir)
}

pub fn create(skills_root: &Path, name: &str, description: &str) -> Result<TbSkillMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("技能名不能为空".into());
    }
    let dir = skills_root.join(slugify(name));
    if dir.exists() {
        return Err(format!("已存在同名技能目录: {}", dir.file_name().unwrap_or_default().to_string_lossy()));
    }
    let mut fm = format!("name: {}", yaml_scalar(name));
    if !description.trim().is_empty() {
        fm.push_str(&format!("\ndescription: {}", yaml_scalar(description)));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建技能目录失败: {e}"))?;
    let text = compose_doc(&fm, "");
    crate::atomic::write_file_atomic(&dir.join(SKILL_MD).to_string_lossy(), text.as_bytes())
        .map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
    write_json(&dir.join(HUB), &json!({ "tags": [] }))?;
    meta_for(&dir)
}

pub fn delete(skills_root: &Path, dir_name: &str) -> Result<(), String> {
    let dir = skills_root.join(safe_dir_name(dir_name)?);
    if !dir.join(SKILL_MD).exists() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))
}

/// 把一个外部技能目录**复制**进来（源侧 `data/skills/<x>` 或别家工具的技能目录）。
/// 同名目录已存在时报错而不是覆盖 —— 收集/导入一律不删改对方，也不悄悄盖掉本地版本。
pub fn import_dir(skills_root: &Path, src: &Path) -> Result<TbSkillMeta, String> {
    if !src.is_dir() || !src.join(SKILL_MD).exists() {
        return Err(format!("该目录里没有 {SKILL_MD}: {}", src.display()));
    }
    let raw = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "无法取源目录名".to_string())?;
    let dir_name = safe_dir_name(&raw)?;
    let dest = skills_root.join(&dir_name);
    if dest.exists() {
        return Err(format!("已存在同名技能: {dir_name}"));
    }
    copy_dir_recursive(src, &dest, &[])?;
    meta_for(&dest)
}

/// 从别家工具**收集**技能：与 `import_dir` 同义，但先归档来源信息，
/// 让用户之后还能知道这个技能是从哪个工具收进来的。
pub fn collect_from(skills_root: &Path, src: &Path, harness_id: &str) -> Result<TbSkillMeta, String> {
    let meta = import_dir(skills_root, src)?;
    let dir = skills_root.join(&meta.dir_name);
    let stamp = now_iso();
    write_hub(&dir, |hub| {
        if hub.get("origin").is_none() {
            hub.insert(
                "origin".into(),
                json!({
                    "harness": harness_id,
                    "file": src.to_string_lossy(),
                    "importedAt": stamp,
                }),
            );
        }
        let mut versions = hub_versions(hub);
        if versions.is_empty() {
            // 收集进来的那一刻记一条基点，之后「发布时间轴」才有参照。
            let text = std::fs::read_to_string(dir.join(SKILL_MD)).unwrap_or_default();
            push_published(&mut versions, &text, "");
            hub.insert("versions".into(), serde_json::to_value(&versions).unwrap_or(json!([])));
        }
    })?;
    meta_for(&dir)
}

/// 把技能目录**复制**到别家工具的技能目录。目标已存在时报错（不覆盖对方）。
pub fn push_to(skills_root: &Path, dir_name: &str, skills_dir: &Path) -> Result<String, String> {
    let src = skills_root.join(safe_dir_name(dir_name)?);
    if !src.join(SKILL_MD).exists() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let dest = skills_dir.join(safe_dir_name(dir_name)?);
    if dest.exists() {
        return Err(format!("{} 里已存在同名技能", skills_dir.display()));
    }
    std::fs::create_dir_all(skills_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;
    copy_dir_recursive(&src, &dest, &[HUB])?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 从别家工具的技能目录里**删掉**一个技能（先整目录备份再删）。
pub fn remove_from(dir_name: &str, skills_dir: &Path) -> Result<Option<String>, String> {
    let dir_name = safe_dir_name(dir_name)?;
    let target = skills_dir.join(&dir_name);
    if !target.join(SKILL_MD).exists() {
        return Err(format!("{} 里没有这个技能", skills_dir.display()));
    }
    // 目标是一整个目录，`backup_file`（只对单个文件有效）不适用：
    // 这里在同级复制一份带后缀的目录作为旁路备份，再删原件。
    let backup = skills_dir.join(format!("{dir_name}.agenthub-bak-{}", stamp()));
    copy_dir_recursive(&target, &backup, &[])?;
    std::fs::remove_dir_all(&target).map_err(|e| format!("删除失败: {e}"))?;
    Ok(Some(backup.to_string_lossy().into_owned()))
}

/// 回滚到某个历史版本：把那条版本的正文**原样**写回。
///
/// 回滚不改动版本历史（时间轴只增不删），用户因此可以来回切。写回的是版本里
/// 存的字节，不是「重新拼装一遍」的结果 —— 拼装会顺手规整空白，让回滚后的
/// 文件与当时发布的不是同一份。
pub fn restore(skills_root: &Path, dir_name: &str, v: u32) -> Result<TbSkillDoc, String> {
    let dir = skills_root.join(safe_dir_name(dir_name)?);
    if !dir.join(SKILL_MD).exists() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hub = read_sidecar(&dir.join(HUB));
    let entry = hub_versions(&hub)
        .into_iter()
        .find(|x| x.v == v)
        .ok_or_else(|| format!("版本 v{v} 不存在"))?;
    crate::atomic::write_file_atomic(&dir.join(SKILL_MD).to_string_lossy(), entry.content.as_bytes())
        .map_err(|e| format!("回滚失败: {e}"))?;
    read(skills_root, dir_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agenthub::new_id as test_id;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nd-tb-skills-{}", test_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn doc_round_trip_is_stable() {
        let text = "---\nname: demo\ndescription: A: B\n---\n\n# Title\n\nbody\n";
        let (fm, body) = split_doc(text);
        assert_eq!(fm, "name: demo\ndescription: A: B");
        assert_eq!(body, "# Title\n\nbody\n");
        assert_eq!(compose_doc(&fm, &body), text, "未改动 frontmatter 时必须字节还原");
    }

    #[test]
    fn doc_without_frontmatter_is_body_only() {
        let text = "# Just markdown\n";
        let (fm, body) = split_doc(text);
        assert!(fm.is_empty());
        assert_eq!(body, text);
        assert_eq!(compose_doc("", text), text, "没有 frontmatter 时不该凭空加一个");
    }

    #[test]
    fn reads_quoted_commented_and_block_scalar_fields() {
        let fm = "name: \"quoted: name\"\ndescription: plain text # 注释\nbanner: >\n  多行\n  折行\nnested:\n  a: 1\ntitle: after";
        assert_eq!(fm_field(fm, "name"), "quoted: name");
        assert_eq!(fm_field(fm, "description"), "plain text");
        assert_eq!(fm_field(fm, "banner"), "多行 折行");
        assert_eq!(fm_field(fm, "nested"), "");
        assert_eq!(fm_field(fm, "title"), "after");
    }

    #[test]
    fn scalar_quoting_keeps_generated_frontmatter_valid() {
        assert_eq!(yaml_scalar("demo"), "demo");
        assert_eq!(yaml_scalar("A: B"), "\"A: B\"");
        assert_eq!(yaml_scalar("- dash"), "\"- dash\"");
        assert_eq!(yaml_scalar("two\nlines"), "two lines", "多行压成空格后是合法的普通标量");
    }

    #[test]
    fn create_read_save_delete_cycle() {
        let root = tmp();
        let created = create(&root, "My Skill", "does things").unwrap();
        assert_eq!(created.dir_name, "my-skill");
        assert_eq!(created.name, "My Skill");
        assert_eq!(created.description, "does things");
        assert_eq!(list(&root).unwrap().len(), 1);

        let mut payload = TbSkillSave {
            dir_name: created.dir_name.clone(),
            frontmatter: "name: My Skill\ndescription: does things\nx-custom: 1".into(),
            body: "# Body\n".into(),
            tags: vec!["a".into()],
            publish: true,
            note: "首次发布".into(),
        };
        let meta = save(&root, payload.clone()).unwrap();
        assert_eq!(meta.tags, vec!["a".to_string()]);
        assert_eq!(meta.versions, 1);

        let doc = read(&root, &created.dir_name).unwrap();
        assert!(doc.frontmatter.contains("x-custom: 1"), "未识别字段按原文保留");
        assert_eq!(doc.body, "# Body\n");
        assert_eq!(doc.version_list.len(), 1);
        assert_eq!(doc.version_list[0].note, "首次发布");

        // 再发布一次同样内容不新增版本；标签更新仍生效
        payload.publish = true;
        payload.note = "再来".into();
        payload.tags = vec!["b".into()];
        let meta = save(&root, payload).unwrap();
        assert_eq!(meta.versions, 1);
        assert_eq!(meta.tags, vec!["b".to_string()]);

        delete(&root, &created.dir_name).unwrap();
        assert!(list(&root).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    /// 用户 sidecar 里的未知字段（源侧的 vetReport/summary）不能在保存时被抹掉
    #[test]
    fn unknown_sidecar_fields_survive_a_save() {
        let root = tmp();
        let meta = create(&root, "Keep", "").unwrap();
        let hub = root.join(&meta.dir_name).join(HUB);
        let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&hub).unwrap()).unwrap();
        value["vetReport"] = json!({ "verdict": "clean" });
        std::fs::write(&hub, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        save(
            &root,
            TbSkillSave {
                dir_name: meta.dir_name.clone(),
                frontmatter: "name: Keep".into(),
                body: "x".into(),
                tags: vec!["t".into()],
                publish: false,
                note: String::new(),
            },
        )
        .unwrap();

        let after: Value = serde_json::from_str(&std::fs::read_to_string(&hub).unwrap()).unwrap();
        assert_eq!(after["vetReport"]["verdict"], "clean");
        assert_eq!(after["tags"][0], "t");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn import_and_collect_record_origin() {
        let root = tmp();
        let outside = tmp().join("foreign-skill");
        std::fs::create_dir_all(outside.join("references")).unwrap();
        std::fs::write(outside.join(SKILL_MD), "---\nname: Foreign\n---\n\nbody").unwrap();
        std::fs::write(outside.join("references").join("a.md"), "note").unwrap();

        let meta = collect_from(&root, &outside, "claude-code").unwrap();
        assert_eq!(meta.name, "Foreign");
        assert_eq!(meta.file_count, 2, "资源文件应一并复制");
        assert_eq!(meta.origin.unwrap().harness, "claude-code");
        assert_eq!(meta.versions, 1, "收集进来时留一条基点版本");
        assert!(collect_from(&root, &outside, "claude-code").is_err(), "同名不该覆盖");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn push_to_a_foreign_skills_dir_then_remove_with_backup() {
        let root = tmp();
        let meta = create(&root, "Shared", "").unwrap();
        let foreign = tmp().join("tool-skills");

        let dest = push_to(&root, &meta.dir_name, &foreign).unwrap();
        assert!(Path::new(&dest).join(SKILL_MD).exists());
        assert!(push_to(&root, &meta.dir_name, &foreign).is_err(), "对方已有同名时不覆盖");

        let backup = remove_from(&meta.dir_name, &foreign).unwrap().unwrap();
        assert!(!foreign.join(&meta.dir_name).exists());
        assert!(Path::new(&backup).join(SKILL_MD).exists(), "删除前必须先留整目录备份");
        assert!(root.join(&meta.dir_name).join(SKILL_MD).exists(), "移除别家副本不该动本地源");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn restore_writes_back_the_published_bytes_without_burning_history() {
        let root = tmp();
        let created = create(&root, "Roll", "").unwrap();
        let mut payload = TbSkillSave {
            dir_name: created.dir_name.clone(),
            frontmatter: "name: Roll".into(),
            body: "# v1\n".into(),
            tags: Vec::new(),
            publish: true,
            note: String::new(),
        };
        save(&root, payload.clone()).unwrap();
        payload.body = "# v2\n".into();
        save(&root, payload).unwrap();

        let restored = restore(&root, &created.dir_name, 1).unwrap();
        assert_eq!(restored.body, "# v1\n");
        assert_eq!(restored.version_list.len(), 2, "回滚不该动历史");
        assert!(restore(&root, &created.dir_name, 99).is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn escaping_dir_names_are_rejected_before_touching_disk() {
        let root = tmp();
        assert!(read(&root, "../secrets").is_err());
        assert!(delete(&root, "..").is_err());
        assert!(push_to(&root, "a/b", &root).is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
