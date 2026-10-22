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

// ---------------- 文件树 / 单文件读取（只读） ----------------

/// 目录树的深度与条目上限。超出就停下并把根节点标 `truncated`，
/// 既不让一棵被塞满的目录拖住界面，也不静默地把文件藏起来。
const TREE_MAX_DEPTH: usize = 6;
const TREE_MAX_ENTRIES: usize = 2000;
/// 单个文本文件的读取上限。超限**报错**而不是截断 —— 看一半的正文比看不了
/// 更容易被当成完整内容（源侧是截断 + 提示条，这里改成明确失败）。
const FILE_READ_LIMIT: u64 = 2 * 1024 * 1024;

/// 扩展名 → 预览类别（与源侧同一张表）。
fn file_kind(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" | "mdx" => "markdown",
        "txt" | "log" | "text" => "text",
        "json" | "toml" | "yaml" | "yml" | "ini" | "cfg" | "conf" | "env" => "code",
        "py" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "rs" | "go" | "java" | "c" | "h"
        | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "bash" | "ps1" | "bat" | "cmd" | "sql"
        | "html" | "htm" | "css" | "scss" | "less" | "vue" | "svelte" | "xml" | "svg" => "code",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" => "image",
        "pdf" => "pdf",
        "doc" | "docx" | "rtf" | "odt" => "word",
        "xls" | "xlsx" | "csv" | "ods" => "sheet",
        "zip" | "gz" | "tar" | "7z" | "rar" | "skillpack" => "archive",
        _ => "other",
    }
}

/// 能按 UTF-8 当文本读给人看的类别。其余只列在树里。
fn is_text_kind(kind: &str) -> bool {
    matches!(kind, "markdown" | "text" | "code")
}

/// 错误码前缀。界面按码查 `toolbox.files.err<Code>`，码后的细节只给日志看。
///
/// `escaped` 路径越界 · `not_found` 不存在 · `is_dir` 目录 · `not_text` 非文本
/// · `too_large` 超出读取上限 · `read_failed` 磁盘读失败
fn node(
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    ext: String,
    kind: &str,
    children: Vec<TbSkillFileNode>,
) -> TbSkillFileNode {
    TbSkillFileNode {
        path,
        name,
        is_dir,
        is_text: !is_dir && is_text_kind(kind),
        size,
        ext,
        kind: kind.to_string(),
        truncated: false,
        children,
    }
}

/// 遍历技能目录的树。跳过工具自己的 `.hub.json` 与 `*.agenthub-*` 备份，
/// **绝不跟随**符号链接 / junction（只在树里标出来），以免顺着重解析点
/// 走进技能目录之外。`budget`（剩余条目数）与 `max_depth` 由调用方给：
/// 生产走常量，测试用很小的值就能验证截断而不必造两千个文件。
fn walk_tree(
    cur: &Path,
    rel: &str,
    depth: usize,
    max_depth: usize,
    budget: &mut usize,
    truncated: &mut bool,
) -> Result<Vec<TbSkillFileNode>, String> {
    let mut out: Vec<TbSkillFileNode> = Vec::new();
    if depth >= max_depth {
        // 到此为止；目录里确实还有东西时如实标记截断，不假装已经列全
        if std::fs::read_dir(cur).map(|mut i| i.next().is_some()).unwrap_or(false) {
            *truncated = true;
        }
        return Ok(out);
    }
    let entries = std::fs::read_dir(cur).map_err(|e| format!("read_failed: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_failed: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == HUB || name.starts_with(".agenthub-") {
            continue;
        }
        if *budget == 0 {
            *truncated = true;
            break;
        }
        *budget -= 1;
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        // `file_type()` 不跟随链接：junction 能把自己挂成技能目录下的一个
        // 「普通子目录」，跟随它就会把外面的树当成本技能的文件列出来。
        let file_type = entry.file_type().map_err(|e| format!("read_failed: {e}"))?;
        if file_type.is_symlink() {
            out.push(node(child_rel, name, false, 0, String::new(), "symlink", Vec::new()));
        } else if file_type.is_dir() {
            let children = walk_tree(&entry.path(), &child_rel, depth + 1, max_depth, budget, truncated)?;
            out.push(node(child_rel, name, true, 0, String::new(), "dir", children));
        } else {
            let ext = entry
                .path()
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let kind = file_kind(&ext);
            // 已经确认不是符号链接，这里跟随后取大小不会走出技能目录
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(node(child_rel, name, false, size, ext, kind, Vec::new()));
        }
    }
    // 目录在前，其次按名字（与源侧一致）
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub fn list_files(skills_root: &Path, dir_name: &str) -> Result<TbSkillFileNode, String> {
    let dir_name = safe_dir_name(dir_name)?;
    let dir = skills_root.join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("not_found: 技能不存在: {dir_name}"));
    }
    let mut truncated = false;
    let mut budget = TREE_MAX_ENTRIES;
    let children = walk_tree(&dir, "", 0, TREE_MAX_DEPTH, &mut budget, &mut truncated)?;
    Ok(TbSkillFileNode {
        path: String::new(),
        name: dir_name,
        is_dir: true,
        is_text: false,
        size: 0,
        ext: String::new(),
        kind: "dir".into(),
        truncated,
        children,
    })
}

/// 把「技能目录 + 相对路径」解析成绝对路径，并做目录穿越校验。
///
/// 防护要点：
/// 1. 拒绝含空字节的路径（某些系统调用会截断）
/// 2. 拒绝绝对路径与盘符（`C:\x`、`/etc/passwd`、UNC）
/// 3. 任何 `..` 组件在拼接前就拦掉，不依赖 canonicalize 兜底
/// 4. 拼接后 canonicalize 再做前缀校验，兜住符号链接 / junction 的间接跳转
/// 5. 目录不当文件返回（`is_dir`），而不是让它掉进「读文件失败」
pub fn resolve_within(root: &Path, rel_path: &str) -> Result<std::path::PathBuf, String> {
    if !root.is_dir() {
        return Err("not_found: 技能目录不存在".into());
    }
    if rel_path.contains('\0') {
        return Err("escaped: 路径含空字节".into());
    }
    let normalized = rel_path.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err("escaped: 路径为空".into());
    }
    // 绝对路径 / 盘符 / UNC（`\\server\share` 归一化后以 `/` 开头）
    if trimmed.starts_with('/') || trimmed.contains(":/") {
        return Err("escaped: 不允许绝对路径".into());
    }
    if trimmed.split('/').any(|seg| seg == "..") {
        return Err("escaped: 不允许上级目录".into());
    }

    let target = root.join(trimmed.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canon_root = root.canonicalize().map_err(|e| format!("read_failed: 技能目录无法解析: {e}"))?;
    // 走链接解析：链接指向技能目录之外时，下面这次前缀校验会发现
    let canon = target
        .canonicalize()
        .map_err(|_| format!("not_found: {rel_path}"))?;
    if canon == canon_root || !canon.starts_with(&canon_root) {
        return Err("escaped: 只能访问该技能目录内的文件".into());
    }
    if canon.is_dir() {
        return Err(format!("is_dir: {rel_path}"));
    }
    Ok(canon)
}

/// 读技能目录内的一个文本文件。二进制、非 UTF-8、超限、越界一律报错，
/// **不截断、不 lossy** —— 前端按错误码给一条明确的说明。
pub fn read_file(skills_root: &Path, dir_name: &str, rel_path: &str) -> Result<TbSkillFileContent, String> {
    let dir_name = safe_dir_name(dir_name)?;
    let dir = skills_root.join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("not_found: 技能不存在: {dir_name}"));
    }
    let canon = resolve_within(&dir, rel_path)?;

    let name = canon.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = canon
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = file_kind(&ext);
    if !is_text_kind(kind) {
        return Err(format!("not_text: {rel_path} 是 {kind}"));
    }

    let size = std::fs::metadata(&canon).map_err(|e| format!("read_failed: {e}"))?.len();
    if size > FILE_READ_LIMIT {
        return Err(format!("too_large: {rel_path} 为 {size} 字节，上限 {FILE_READ_LIMIT}"));
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("read_failed: {e}"))?;
    // UTF-16 之类的「文本」含 NUL，是合法 UTF-8 却读不出人话，一起按非文本拒掉
    if bytes.contains(&0) {
        return Err(format!("not_text: {rel_path} 含空字节"));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("not_text: {rel_path} 不是 UTF-8"))?;

    Ok(TbSkillFileContent {
        path: normalized_rel(rel_path),
        name,
        ext,
        kind: kind.to_string(),
        size,
        text,
    })
}

/// 展示用的相对路径：统一成 `/`，去掉首尾空白与开头的 `./`。
pub fn normalized_rel(rel_path: &str) -> String {
    let slashed = rel_path.replace('\\', "/");
    slashed.trim().trim_start_matches("./").to_string()
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

    // ---------------- 文件树 / 单文件读取 ----------------

    /// 造一个带资源的技能：SKILL.md + references/ + notes.txt + 一张图
    fn skill_with_assets() -> (PathBuf, String) {
        let root = tmp();
        let meta = create(&root, "Files", "").unwrap();
        let dir = root.join(&meta.dir_name);
        std::fs::create_dir_all(dir.join("references").join("deep")).unwrap();
        std::fs::write(dir.join("references").join("a.md"), "# note\n").unwrap();
        std::fs::write(dir.join("references").join("deep").join("b.txt"), "deep").unwrap();
        std::fs::write(dir.join("notes.txt"), "hello").unwrap();
        std::fs::write(dir.join("pic.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        (root, meta.dir_name)
    }

    #[test]
    fn lists_the_skill_tree_and_reads_a_text_file() {
        let (root, dir_name) = skill_with_assets();

        let tree = list_files(&root, &dir_name).unwrap();
        assert_eq!(tree.name, dir_name);
        assert!(tree.is_dir && !tree.truncated);
        assert!(
            tree.children.iter().all(|n| n.name != HUB),
            "工具自己的 .hub.json 不该出现在用户的文件树里"
        );
        let names: Vec<&str> = tree.children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["references", "notes.txt", "pic.png", "SKILL.md"], "目录在前，其次按名字");

        let refs = &tree.children[0];
        assert!(refs.is_dir && refs.path == "references");
        assert!(refs.children.iter().any(|n| n.path == "references/deep"));

        let txt = tree.children.iter().find(|n| n.name == "notes.txt").unwrap();
        assert!(txt.is_text && !txt.is_dir && txt.size == 5 && txt.kind == "text");

        let png = tree.children.iter().find(|n| n.name == "pic.png").unwrap();
        assert!(!png.is_text, "图片只列出来，不作为文本读");
        assert_eq!(png.kind, "image");

        let content = read_file(&root, &dir_name, "references/a.md").unwrap();
        assert_eq!(content.text, "# note\n");
        assert_eq!(content.kind, "markdown");
        assert_eq!(content.path, "references/a.md");
        assert_eq!(content.size, 7);

        // 分隔符归一化：Windows 风格的 `\` 也认
        assert!(read_file(&root, &dir_name, r"references\deep\b.txt").is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn escaping_paths_are_rejected_on_read() {
        let (root, dir_name) = skill_with_assets();
        std::fs::write(root.join("outside.txt"), "外面的文件").unwrap();

        for bad in [
            "../outside.txt",
            "references/../../outside.txt",
            r"..\outside.txt",
            "C:/Windows/win.ini",
            "/etc/passwd",
            r"\\server\share\x",
            "",
            "  ",
        ] {
            let err = read_file(&root, &dir_name, bad).unwrap_err();
            assert!(err.starts_with("escaped"), "{bad} 应被越界防护拦住，实际: {err}");
        }
        // 含空字节的路径也拦（某些系统调用会在这里截断）
        assert!(read_file(&root, &dir_name, "notes.txt\0.png").is_err());
        // 技能目录名本身也要挡住
        assert!(read_file(&root, "..", "notes.txt").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_directory_cannot_be_read_as_a_text_file() {
        let (root, dir_name) = skill_with_assets();
        let err = read_file(&root, &dir_name, "references").unwrap_err();
        assert!(err.starts_with("is_dir"), "目录当文件读要给出可区分的码，实际: {err}");
        // 不存在的文件是 not_found，与越界区分开
        let err = read_file(&root, &dir_name, "nope.txt").unwrap_err();
        assert!(err.starts_with("not_found"), "实际: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn oversized_and_binary_files_are_refused_instead_of_truncated() {
        let (root, dir_name) = skill_with_assets();
        let dir = root.join(&dir_name);

        let big = dir.join("big.log");
        std::fs::write(&big, vec![b'a'; FILE_READ_LIMIT as usize + 1]).unwrap();
        let err = read_file(&root, &dir_name, "big.log").unwrap_err();
        assert!(err.starts_with("too_large"), "超限要报错而不是截断塞回来，实际: {err}");

        // 非 UTF-8（GBK 一段）与含 NUL 的「文本」
        std::fs::write(dir.join("gbk.txt"), [0xd6u8, 0xd0, 0xce, 0xc4]).unwrap();
        let err = read_file(&root, &dir_name, "gbk.txt").unwrap_err();
        assert!(err.starts_with("not_text"), "实际: {err}");
        std::fs::write(dir.join("nul.txt"), b"a\0b").unwrap();
        assert!(read_file(&root, &dir_name, "nul.txt").unwrap_err().starts_with("not_text"));

        // 按扩展名就不是文本的一律不读
        assert!(read_file(&root, &dir_name, "pic.png").unwrap_err().starts_with("not_text"));

        // 边界值本身要能读（上限是「超过才拒」）
        std::fs::write(dir.join("exact.txt"), vec![b'a'; FILE_READ_LIMIT as usize]).unwrap();
        assert_eq!(read_file(&root, &dir_name, "exact.txt").unwrap().size, FILE_READ_LIMIT);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tree_honours_entry_and_depth_caps() {
        let root = tmp();
        let meta = create(&root, "Caps", "").unwrap();
        let dir = root.join(&meta.dir_name);
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::write(dir.join("a").join("one.md"), "x").unwrap();
        std::fs::write(dir.join("a").join("b").join("two.md"), "x").unwrap();

        // 条目上限：名额是全树共用的，恰好用完两个就停，并如实标记截断
        fn count(nodes: &[TbSkillFileNode]) -> usize {
            nodes.iter().map(|n| 1 + count(&n.children)).sum()
        }
        let mut budget = 2usize;
        let mut truncated = false;
        let cut = walk_tree(&dir, "", 0, TREE_MAX_DEPTH, &mut budget, &mut truncated).unwrap();
        assert_eq!(count(&cut), 2, "预算用完就停");
        assert!(truncated, "被上限挡住时必须标出来，不能假装列全了");

        // 深度上限：从根算起只走一层
        let mut budget = TREE_MAX_ENTRIES;
        let mut truncated = false;
        let shallow = walk_tree(&dir, "", 0, 1, &mut budget, &mut truncated).unwrap();
        assert!(truncated);
        let a = shallow.iter().find(|n| n.name == "a").unwrap();
        assert!(a.children.is_empty(), "深度上限之外的子目录不再展开");
        std::fs::remove_dir_all(&root).ok();
    }

    /// junction 挂在技能目录里，看着像一个普通子目录 —— 不能顺着它列到外面，
    /// 也不能顺着它读到外面的文件。
    #[cfg(windows)]
    #[test]
    fn a_junction_inside_a_skill_is_not_followed() {
        let (root, dir_name) = skill_with_assets();
        let outside = tmp();
        std::fs::write(outside.join("secret.md"), "机密").unwrap();
        let link = root.join(&dir_name).join("outside-link");
        // mklink /J 建 junction 不需要管理员；建不出来（权限或策略）就跳过
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !made {
            eprintln!("跳过：本机不允许创建 junction");
            std::fs::remove_dir_all(&root).ok();
            std::fs::remove_dir_all(&outside).ok();
            return;
        }

        let tree = list_files(&root, &dir_name).unwrap();
        let node = tree.children.iter().find(|n| n.name == "outside-link").expect("链接要在树里可见");
        assert_eq!(node.kind, "symlink");
        assert!(!node.is_text);
        assert!(node.children.is_empty(), "junction 不能被展开成子树");

        let err = read_file(&root, &dir_name, "outside-link/secret.md").unwrap_err();
        assert!(err.starts_with("escaped"), "顺着链接走出去必须拒，实际: {err}");

        // 只删链接本身，别把外面的目录一起删了
        std::fs::remove_dir(&link).ok();
        assert!(outside.join("secret.md").exists(), "拒绝之后外部文件必须原样还在");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
