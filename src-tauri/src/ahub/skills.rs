use crate::ahub::models::*;
use crate::ahub::store::{self, AppH, es};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Frontmatter 值：只保留三种语义（字符串 / 字符串列表 / 嵌套结构）。
/// 解析交给 serde_yaml_ng，这里只做「归一化」，不再手写 YAML 子集解析。
#[derive(Debug, Clone)]
pub enum FmValue {
    Str(String),
    List(Vec<String>),
    /// 非字符串的 YAML 值：嵌套映射/序列、bool、number，统一以 JSON 保留
    Nested(Value),
}

impl FmValue {
    pub fn to_json(&self) -> Value {
        match self {
            FmValue::Str(s) => Value::String(s.clone()),
            FmValue::List(l) => Value::Array(l.iter().map(|x| Value::String(x.clone())).collect()),
            FmValue::Nested(v) => v.clone(),
        }
    }
    pub fn from_json(v: &Value) -> Option<FmValue> {
        match v {
            Value::String(s) => Some(FmValue::Str(s.clone())),
            Value::Array(a) => Some(FmValue::List(
                a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
            )),
            Value::Object(_) | Value::Number(_) | Value::Bool(_) => Some(FmValue::Nested(v.clone())),
            _ => None,
        }
    }
}

/// 从任意 YAML 值归一化为 FmValue。
fn yaml_to_fm(v: &serde_yaml_ng::Value) -> Option<FmValue> {
    use serde_yaml_ng::Value as Y;
    match v {
        Y::Null => None,
        Y::String(s) => Some(FmValue::Str(s.clone())),
        // bool / number 走 Nested（= 非字符串 YAML 值），保留原生类型。
        // 若降级成 Str，回写时会被加引号：agent_created: true → 'true'，语义失真。
        Y::Bool(_) | Y::Number(_) => Some(FmValue::Nested(yaml_to_json(v))),
        Y::Sequence(seq) => {
            // 全是标量 → 字符串列表；否则保留为嵌套结构
            let mut out: Vec<String> = Vec::new();
            let mut all_scalar = true;
            for it in seq {
                match yaml_to_fm(it) {
                    Some(FmValue::Str(s)) => out.push(s),
                    _ => {
                        all_scalar = false;
                        break;
                    }
                }
            }
            if all_scalar {
                Some(FmValue::List(out))
            } else {
                serde_json::to_value(yaml_to_json(v)).ok().map(FmValue::Nested)
            }
        }
        Y::Mapping(_) => serde_json::to_value(yaml_to_json(v)).ok().map(FmValue::Nested),
        Y::Tagged(t) => yaml_to_fm(&t.value),
    }
}

/// serde_yaml_ng::Value → serde_json::Value（键统一为字符串）
fn yaml_to_json(v: &serde_yaml_ng::Value) -> Value {
    use serde_yaml_ng::Value as Y;
    match v {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(*b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                Value::Number(u.into())
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        Y::String(s) => Value::String(s.clone()),
        Y::Sequence(seq) => Value::Array(seq.iter().map(yaml_to_json).collect()),
        Y::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (k, val) in map {
                let key = match k {
                    Y::String(s) => s.clone(),
                    other => serde_yaml_ng::to_string(other).unwrap_or_default().trim().to_string(),
                };
                obj.insert(key, yaml_to_json(val));
            }
            Value::Object(obj)
        }
        Y::Tagged(t) => yaml_to_json(&t.value),
    }
}

/// JSON → YAML 值（用于回写 frontmatter）
fn json_to_yaml(v: &Value) -> serde_yaml_ng::Value {
    use serde_yaml_ng::Value as Y;
    match v {
        Value::Null => Y::Null,
        Value::Bool(b) => Y::Bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Y::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                Y::Number(u.into())
            } else {
                Y::Number(n.as_f64().unwrap_or(0.0).into())
            }
        }
        Value::String(s) => Y::String(s.clone()),
        Value::Array(a) => Y::Sequence(a.iter().map(json_to_yaml).collect()),
        Value::Object(o) => {
            let mut map = serde_yaml_ng::Mapping::new();
            for (k, val) in o {
                map.insert(Y::String(k.clone()), json_to_yaml(val));
            }
            Y::Mapping(map)
        }
    }
}

/// 规范化 frontmatter 文本，使其成为合法 YAML。
///
/// 现实中的 SKILL.md 常见写法：`description: A: B`（值里带冒号但没加引号），
/// 这在 YAML 里非法（mapping values are not allowed here），严格解析器会整段失败。
/// 这里只对**顶层未缩进行**做最小干预：给需要引号的值加双引号。
/// 返回 (规范化文本, 是否有改动)。
fn sanitize_fm_text(fm: &str) -> (String, bool) {
    let mut out: Vec<String> = Vec::new();
    let mut changed = false;
    for line in fm.split('\n') {
        // 只处理顶层 key（列 0 起），缩进行属于块标量/嵌套结构，不碰
        let is_top = !line.is_empty() && !line.starts_with(' ') && !line.starts_with('\t');
        if !is_top || line.trim_start().starts_with('#') {
            out.push(line.to_string());
            continue;
        }
        let Some(colon) = line.find(':') else {
            out.push(line.to_string());
            continue;
        };
        let key = &line[..colon];
        let rest = line[colon + 1..].trim();
        // key 必须像标识符，否则可能是纯文本行
        let key_ok = !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.');
        if !key_ok || rest.is_empty() {
            out.push(line.to_string());
            continue;
        }
        // 已合法/无需干预的形态：引号、流式集合、块标量指示符
        let needs_quote = rest.contains(": ")
            || rest.ends_with(':')
            || rest.starts_with('*')
            || rest.starts_with('&')
            || rest.starts_with('%')
            || rest.starts_with('@')
            || rest.starts_with('`');
        let already_ok = rest.starts_with('"')
            || rest.starts_with('\'')
            || rest.starts_with('[')
            || rest.starts_with('{')
            || rest == ">"
            || rest == "|"
            || rest.starts_with(">-")
            || rest.starts_with("|-")
            || rest.starts_with(">+")
            || rest.starts_with("|+");
        if needs_quote && !already_ok {
            let escaped = rest.replace('\\', "\\\\").replace('"', "\\\"");
            out.push(format!("{key}: \"{escaped}\""));
            changed = true;
        } else {
            out.push(line.to_string());
        }
    }
    (out.join("\n"), changed)
}

/// Split a SKILL.md document into (frontmatter map, body).
///
/// 使用 serde_yaml_ng 完整解析 YAML frontmatter —— 支持行内数组、
/// 多行块标量（> / |）、引号、嵌套结构等全部 YAML 语法。
pub fn split_doc(doc: &str) -> (BTreeMap<String, FmValue>, String) {
    let mut map = BTreeMap::new();
    let norm = doc.replace("\r\n", "\n");
    let t = norm.trim_start_matches('\u{feff}');
    let trimmed = t.trim_start_matches('\n');

    // 必须以 --- 开头才是 frontmatter
    if !trimmed.starts_with("---") {
        return (map, trimmed.to_string());
    }
    let after = &trimmed[3..];
    // 找结束的 --- 行
    let mut off = 0usize;
    let mut close: Option<usize> = None;
    for line in after.split_inclusive('\n') {
        if line.trim_end() == "---" {
            close = Some(off);
            break;
        }
        off += line.len();
    }
    let (fm_text, body) = match close {
        Some(idx) => {
            let fm = &after[..idx];
            let rest = &after[idx..];
            let body = rest.splitn(2, '\n').nth(1).unwrap_or("");
            (fm, body)
        }
        // 没有闭合 ---：整篇当作正文，避免误吞内容
        None => ("", trimmed),
    };

    if !fm_text.trim().is_empty() {
        let parsed = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(fm_text).or_else(|_| {
            // 非法 YAML（如值里含未加引号的冒号）：规范化后重试，兼容历史文件
            let (fixed, _) = sanitize_fm_text(fm_text);
            serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&fixed)
        });
        if let Ok(serde_yaml_ng::Value::Mapping(m)) = parsed {
            for (k, v) in m {
                let key = match k {
                    serde_yaml_ng::Value::String(s) => s,
                    other => serde_yaml_ng::to_string(&other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                };
                if key.is_empty() {
                    continue;
                }
                if let Some(fv) = yaml_to_fm(&v) {
                    map.insert(key, fv);
                }
            }
        }
        // 两次都失败：map 留空，正文照常返回，绝不破坏原文件
    }

    (map, body.to_string())
}

/// 序列化 frontmatter 为 YAML 文本（含首尾 ---），再拼上正文。
pub fn compose_doc(map: &BTreeMap<String, FmValue>, body: &str) -> String {
    if map.is_empty() {
        return body.to_string();
    }
    let mut ymap = serde_yaml_ng::Mapping::new();
    for (k, v) in map {
        let yv = match v {
            FmValue::Str(s) => serde_yaml_ng::Value::String(s.clone()),
            FmValue::List(l) => serde_yaml_ng::Value::Sequence(
                l.iter().map(|x| serde_yaml_ng::Value::String(x.clone())).collect(),
            ),
            FmValue::Nested(j) => json_to_yaml(j),
        };
        ymap.insert(serde_yaml_ng::Value::String(k.clone()), yv);
    }
    let fm = serde_yaml_ng::to_string(&serde_yaml_ng::Value::Mapping(ymap)).unwrap_or_default();
    // split_doc 返回的 body 已含 frontmatter 结束行之后的换行，
    // 这里只补一个分隔空行，避免每次保存都累积空行。
    let body = body.strip_prefix('\n').unwrap_or(body);
    format!("---\n{}---\n\n{}", fm, body)
}

pub fn fm_get_str(map: &BTreeMap<String, FmValue>, key: &str) -> String {
    match map.get(key) {
        Some(FmValue::Str(s)) => s.clone(),
        // 数字 / bool 也返回文本形式（如 version 被写成裸数字时仍可读）
        Some(FmValue::Nested(Value::Bool(b))) => b.to_string(),
        Some(FmValue::Nested(Value::Number(n))) => n.to_string(),
        _ => String::new(),
    }
}

/// 把一个 tag 字符串归一化为若干干净标签。
///
/// 历史坏数据自愈：早期版本会把行内数组 `["自习"]` 整串存成一个 tag，
/// 这里用 YAML 解析把它还原；解析不出则当作普通单标签。
fn clean_tag(t: &str) -> Vec<String> {
    let t = t.trim();
    if t.is_empty() {
        return Vec::new();
    }
    // 形如 [ ... ] 的旧脏值：交给 YAML 还原（比手写 split 更可靠，能处理引号/逗号）
    if t.starts_with('[') && t.ends_with(']') {
        if let Ok(serde_yaml_ng::Value::Sequence(seq)) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(t) {
            let out: Vec<String> = seq
                .iter()
                .filter_map(|v| match v {
                    serde_yaml_ng::Value::String(s) => Some(s.trim().to_string()),
                    serde_yaml_ng::Value::Bool(b) => Some(b.to_string()),
                    serde_yaml_ng::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    // 去掉包裹引号
    let unquoted = t.trim_matches('"').trim_matches('\'').trim().to_string();
    if unquoted.is_empty() {
        Vec::new()
    } else {
        vec![unquoted]
    }
}

pub fn fm_get_tags(map: &BTreeMap<String, FmValue>) -> Vec<String> {
    match map.get("tags") {
        Some(FmValue::List(l)) => l.iter().flat_map(|x| clean_tag(x)).collect(),
        // 兜底：YAML 库正常会把 tags 解析成 List；万一遇到字符串形态也能救回来
        Some(FmValue::Str(s)) if !s.is_empty() => s.split(',').flat_map(clean_tag).collect(),
        _ => Vec::new(),
    }
}

fn skills_root(app: &AppH) -> std::path::PathBuf {
    store::data_root(app).join("skills")
}

fn hub_path(dir: &Path) -> std::path::PathBuf {
    dir.join(".hub.json")
}

pub fn meta_for_dir(dir: &Path) -> Result<SkillMeta, String> {
    let doc_path = dir.join("SKILL.md");
    let text = std::fs::read_to_string(&doc_path).map_err(es)?;
    let (fm, _) = split_doc(&text);
    let name = {
        let n = fm_get_str(&fm, "name");
        if n.is_empty() {
            dir.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            n
        }
    };
    let description = fm_get_str(&fm, "description");
    let mut tags = Vec::new();
    let mut origin = None;
    let mut versions = 0u32;
    let mut summary = None;
    let hp = hub_path(dir);
    if let Ok(mut hub) = store::read_json::<SkillHub>(&hp) {
        // 历史坏数据自愈：'["自习"]' 这类值在这里被还原成 ['自习']
        let before = hub.tags.clone();
        tags = hub
            .tags
            .iter()
            .flat_map(|t| clean_tag(t))
            .collect::<Vec<String>>();
        tags.sort();
        tags.dedup();
        // 顺手把清洗结果写回，让侧车文件里的脏值也随之消失。
        // 幂等：只有「原值本身就不规范」时才写盘。
        let already_clean = before.len() == tags.len() && before.iter().eq(tags.iter());
        if !already_clean {
            hub.tags = tags.clone();
            let _ = store::write_json(&hp, &hub);
        }
        origin = hub.origin;
        versions = hub.versions.len() as u32;
        summary = hub.summary;
    }
    let mut has_assets = false;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n != "SKILL.md" && n != ".hub.json" {
                has_assets = true;
                break;
            }
        }
    }
    let (created_at, updated_at) = skill_times(dir);
    // SSEP v1.1：读 SKILL.toml（渐进增强；缺失 = 最小态）
    let toml_doc = crate::ahub::skill_toml::load(dir);
    let has_toml = toml_doc.is_some();
    let version = toml_doc
        .as_ref()
        .and_then(|d| crate::ahub::skill_toml::get_str(d, "meta.version"))
        .unwrap_or_else(|| "0.0.0".into());
    let status = toml_doc
        .as_ref()
        .and_then(|d| crate::ahub::skill_toml::get_str(d, "meta.status"))
        .unwrap_or_else(|| "draft".into());
    let stale = crate::ahub::skill_toml::is_stale(dir);

    // 审查结论：机器结论来自 SKILL.toml [vet]；人工复审痕迹来自 .hub.json
    let vet_verdict = toml_doc
        .as_ref()
        .and_then(|d| crate::ahub::skill_toml::get_str(d, "vet.verdict"))
        .unwrap_or_default();
    let vet_get_u32 = |path: &str| -> u32 {
        toml_doc
            .as_ref()
            .and_then(|d| d.get("vet"))
            .and_then(|v| v.get(path))
            .and_then(|v| v.as_integer())
            .unwrap_or(0) as u32
    };
    let vet_critical = vet_get_u32("critical");
    let vet_high = vet_get_u32("high");
    let vet_medium = vet_get_u32("medium");
    let vet_checked_at = toml_doc
        .as_ref()
        .and_then(|d| crate::ahub::skill_toml::get_str(d, "vet.checked_at"))
        .unwrap_or_default();
    // 待复核 / 已忽略：只有落盘的 findings 明细才能算准
    let (vet_pending, vet_ignored) = {
        let hub_vet = store::read_json::<SkillHub>(&hub_path(dir)).ok().and_then(|h| h.vet_report);
        match hub_vet {
            Some(r) => {
                let ignored = r.findings.iter().filter(|f| f.ignored).count() as u32;
                let pending = r.findings.iter().filter(|f| !f.ignored).count() as u32;
                (pending, ignored)
            }
            None => (vet_critical + vet_high + vet_medium, 0),
        }
    };

    Ok(SkillMeta {
        name,
        dir_name: dir.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        description,
        tags,
        versions,
        has_assets,
        content_len: text.len(),
        origin,
        created_at,
        updated_at,
        version,
        status,
        stale,
        has_toml,
        vet_verdict,
        vet_critical,
        vet_high,
        vet_medium,
        vet_checked_at,
        vet_pending,
        vet_ignored,
        summary,
    })
}

fn fmt_time(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 技能的创建 / 更新时间。
///
/// 主来源是 SKILL.md。仅当它的时间不可信（DOS 纪元或缺失）时，才回退到
/// SKILL.toml 与 .hub.json —— 这两个都是工具自身写的，时间真实。
/// 这样既修掉 1980，又不改变其它技能的既有语义。
fn skill_times(dir: &Path) -> (String, String) {
    let read = |name: &str| -> (Option<std::time::SystemTime>, Option<std::time::SystemTime>) {
        match std::fs::metadata(dir.join(name)) {
            Ok(m) => (
                m.created().ok().and_then(crate::ahub::store::valid_time),
                m.modified().ok().and_then(crate::ahub::store::valid_time),
            ),
            Err(_) => (None, None),
        }
    };
    let (mut created, mut modified) = read("SKILL.md");
    for name in ["SKILL.toml", ".hub.json"] {
        if created.is_some() && modified.is_some() {
            break;
        }
        let (c, m) = read(name);
        if created.is_none() {
            created = c;
        }
        if modified.is_none() {
            modified = m;
        }
    }
    (
        created.map(fmt_time).unwrap_or_default(),
        modified.map(fmt_time).unwrap_or_default(),
    )
}

pub fn list_skills(app: &AppH) -> Result<Vec<SkillMeta>, String> {
    let root = skills_root(app);
    std::fs::create_dir_all(&root).map_err(es)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(es)? {
        let entry = entry.map_err(es)?;
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").exists() {
            if let Ok(meta) = meta_for_dir(&path) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn read_skill(app: &AppH, dir_name: &str) -> Result<SkillDoc, String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    let text = std::fs::read_to_string(dir.join("SKILL.md")).map_err(es)?;
    let (fm, body) = split_doc(&text);
    let mut fm_json = BTreeMap::new();
    for (k, v) in &fm {
        fm_json.insert(k.clone(), v.to_json());
    }
    let versions = store::read_json::<SkillHub>(&hub_path(&dir))
        .map(|h| h.versions)
        .unwrap_or_default();
    Ok(SkillDoc {
        meta: meta_for_dir(&dir)?,
        frontmatter: fm_json,
        body,
        versions,
    })
}

pub fn save_skill(app: &AppH, payload: SkillSavePayload) -> Result<SkillMeta, String> {
    let root = skills_root(app);
    std::fs::create_dir_all(&root).map_err(es)?;
    save_skill_at(&root, payload)
}

/// save_skill 的落地实现：只依赖技能根目录，便于测试直接驱动真实的读写路径。
pub fn save_skill_at(root: &Path, payload: SkillSavePayload) -> Result<SkillMeta, String> {
    let dir_name = if payload.dir_name.is_empty() {
        let mut slug = store::slugify(&payload.name);
        let mut i = 2;
        while root.join(&slug).exists() {
            slug = format!("{}-{i}", store::slugify(&payload.name));
            i += 1;
        }
        slug
    } else {
        payload.dir_name.clone()
    };
    let dir = root.join(&dir_name);
    std::fs::create_dir_all(&dir).map_err(es)?;

    // rebuild frontmatter map: keep existing entries, override name/description
    let mut fm: BTreeMap<String, FmValue> = BTreeMap::new();
    for (k, v) in &payload.frontmatter {
        if let Some(fv) = FmValue::from_json(v) {
            fm.insert(k.clone(), fv);
        }
    }
    fm.insert("name".into(), FmValue::Str(payload.name.clone()));
    fm.insert("description".into(), FmValue::Str(payload.description.clone()));

    let new_doc = compose_doc(&fm, &payload.body);
    let doc_path = dir.join("SKILL.md");
    let old_doc = std::fs::read_to_string(&doc_path).unwrap_or_default();

    // hub sidecar
    let mut hub: SkillHub = store::read_json(&hub_path(&dir)).unwrap_or_default();
    // 版本快照只在「发布」时写入，且写的是本次落盘后的新内容。
    // 旧实现每次保存都 push 改动前的旧内容 —— 时间轴会混进大量未发布的中间态，
    // 用户也无法从时间轴看出「哪些是正式版本」。与提示词编辑器保持同一语义。
    let mut published: Option<u32> = None;
    // 清洗后落盘：兼容历史畸形值（如 '["自习"]'），避免脏数据继续传播
    hub.tags = payload
        .tags
        .iter()
        .flat_map(|t| clean_tag(t))
        .collect::<Vec<String>>();
    hub.tags.sort();
    hub.tags.dedup();
    let hp = hub_path(&dir);
    let existing_origin = store::read_json::<SkillHub>(&hp).ok().and_then(|h| h.origin);
    hub.origin = existing_origin;

    // hub 里的 tags/versions 要在文档落盘之后再写，才能保证版本快照与磁盘一致；
    // 但 tags 先落一份，避免后续步骤失败时标签改动丢失。
    store::write_json(&hp, &hub)?;

    std::fs::write(&doc_path, &new_doc).map_err(es)?;

    // SSEP v1.1：CORE 生成/同步 + 变更事件 + 版本 bump
    crate::ahub::skill_toml::ensure_core(&dir, &payload.name, "manual", "")?;
    let is_new = old_doc.is_empty();
    let changed = !is_new && old_doc != new_doc;
    if is_new {
        let _ = crate::ahub::skill_toml::append_event(&dir, "create", "", "由 AgentHub 创建", "");
        // 新建技能本身就是第一个正式版本，记下来时间轴才有起点
        published = store::push_published(&mut hub.versions, &new_doc).then(|| last_v(&hub.versions));
    } else if payload.publish {
        // 发布：以落盘后的新内容为快照，内容未变则不新增节点（push_published 去重）
        if store::push_published(&mut hub.versions, &new_doc) {
            published = Some(last_v(&hub.versions));
        }
    }
    if changed {
        // 版本号递增只属于「发布」与普通编辑保存的既有行为，级别由前端传入
        let level = payload.level.clone().unwrap_or_else(|| "L1".into());
        let cur = crate::ahub::skill_toml::load(&dir)
            .and_then(|d| crate::ahub::skill_toml::get_str(&d, "meta.version"))
            .unwrap_or_else(|| "0.0.0".into());
        let nv = match level.as_str() {
            "L3" => crate::ahub::skill_toml::bump_minor(&cur),
            "L4" | "L5" => crate::ahub::skill_toml::bump_major(&cur),
            _ => crate::ahub::skill_toml::bump_patch(&cur),
        };
        let _ = crate::ahub::skill_toml::set_version(&dir, &nv);
        if let Ok(h) = crate::ahub::skill_toml::tree_hash(&dir) {
            let action = if payload.publish { "release" } else { "update" };
            let note = if payload.note.trim().is_empty() { "保存于 AgentHub" } else { payload.note.trim() };
            let _ = crate::ahub::skill_toml::append_event(&dir, action, &level, note, &h);
        }
    }
    if published.is_some() {
        // 发布后 hub 的 versions 变了，补写一次
        store::write_json(&hp, &hub)?;
    }
    meta_for_dir(&dir)
}

/// 取时间轴里最新一条版本号（没有则 0）
fn last_v(versions: &[crate::ahub::models::VersionEntry]) -> u32 {
    versions.iter().map(|x| x.v).max().unwrap_or(0)
}

/// 为已导入但未接入 SKILL.toml 的技能生成协议档案（CORE + create 事件）。
/// 已存在则原样返回。
pub fn ensure_protocol(app: &AppH, dir_name: &str) -> Result<(bool, String), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let existed = crate::ahub::skill_toml::load(&dir).is_some();
    let meta = meta_for_dir(&dir)?;
    crate::ahub::skill_toml::ensure_core(&dir, &meta.name, "import", "")?;
    if !existed {
        let _ = crate::ahub::skill_toml::append_event(&dir, "create", "", "接入 SSEP 协议（AgentHub 生成）", "");
    }
    let version = crate::ahub::skill_toml::load(&dir)
        .and_then(|d| crate::ahub::skill_toml::get_str(&d, "meta.version"))
        .unwrap_or_else(|| "0.0.0".into());
    Ok((!existed, version))
}

/// 发布新版本：把**磁盘上已有的** SKILL.md 存为一条带备注的版本快照，
/// 按变更级别递增版本号，并写入事件。返回 (新版本号, 快照序号)。
///
/// 注意：这个入口不会带上编辑器里尚未保存的草稿。界面上「发布」走的是
/// `save_skill(publish=true)`——先落盘再按新内容记版本，避免快照到旧内容。
/// 这个方法保留给不需要携带草稿的场景（脚本、批量操作）。
pub fn release_version(app: &AppH, dir_name: &str, level: &str, note: &str) -> Result<(String, u32), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let doc_path = dir.join("SKILL.md");
    let text = std::fs::read_to_string(&doc_path).map_err(es)?;

    // 1) 版本快照（记录当前内容 + 备注）
    let mut hub: SkillHub = store::read_json(&hub_path(&dir)).unwrap_or_default();
    let v = hub.versions.iter().map(|x| x.v).max().unwrap_or(0) + 1;
    hub.versions.push(crate::ahub::models::VersionEntry {
        v,
        saved_at: crate::ahub::models::now_iso(),
        note: if note.trim().is_empty() {
            format!("发布 v{}", v)
        } else {
            note.trim().to_string()
        },
        content: text.clone(),
    });
    let len = hub.versions.len();
    if len > 50 {
        hub.versions.drain(0..len - 50);
    }
    store::write_json(&hub_path(&dir), &hub)?;

    // 2) 按级别递增协议版本号
    let cur = crate::ahub::skill_toml::load(&dir)
        .and_then(|d| crate::ahub::skill_toml::get_str(&d, "meta.version"))
        .unwrap_or_else(|| "0.0.0".into());
    let nv = match level {
        "L3" => crate::ahub::skill_toml::bump_minor(&cur),
        "L4" | "L5" => crate::ahub::skill_toml::bump_major(&cur),
        _ => crate::ahub::skill_toml::bump_patch(&cur),
    };
    crate::ahub::skill_toml::set_version(&dir, &nv)?;

    // 3) 事件
    let h = crate::ahub::skill_toml::tree_hash(&dir).unwrap_or_default();
    let _ = crate::ahub::skill_toml::append_event(&dir, "release", level, note, &h);

    Ok((nv, v))
}

/// 解压 ZIP 到临时目录，再作为技能目录导入。
///
/// 安全要点：
/// - 拒绝含 `..` / 绝对路径 / 盘符 的条目（zip-slip 防护）
/// - 限制解压后总大小与条目数，避免 zip bomb
/// - 自动处理「ZIP 里多一层根目录」的常见打包方式
pub fn import_skill_zip(app: &AppH, zip_path: &str, overwrite: bool) -> Result<String, String> {
    use std::io::Read;

    const MAX_TOTAL: u64 = 256 * 1024 * 1024; // 解压后总大小上限
    const MAX_ENTRIES: usize = 5000;

    let zp = std::path::PathBuf::from(zip_path);
    if !zp.is_file() {
        return Err(format!("ZIP 文件不存在: {zip_path}"));
    }

    let file = std::fs::File::open(&zp).map_err(es)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取 ZIP: {e}"))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!("ZIP 条目过多（{}），拒绝解压", archive.len()));
    }

    // 临时解压目录
    let stamp = crate::ahub::models::now_iso().replace([':', '-', '.'], "");
    let tmp = std::env::temp_dir().join(format!("agenthub-zip-{}-{}", std::process::id(), stamp));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(es)?;

    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name() 会拒绝绝对路径与 .. 穿越
        let raw_name = entry.name().unwrap_or_default().to_string();
        let Some(rel) = entry.enclosed_name() else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("ZIP 含非法路径条目: {raw_name}"));
        };
        let out = tmp.join(&rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(es)?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("ZIP 解压后体积过大，已中止".into());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(es)?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(es)?;
        std::fs::write(&out, &buf).map_err(es)?;
    }

    // 定位真正的技能根：可能是 tmp 本身，也可能是 tmp 下唯一的顶层目录
    let skill_root = locate_skill_root(&tmp);

    // 压缩包文件名作为名字兜底：`apple-design-skill-1.7.6.zip` → `apple-design-skill-1-7-6`
    // 仅当解压根是临时目录（包内顶层就是 SKILL.md）时才会用到。
    let stem = zp
        .file_stem()
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = strip_version_suffix(&stem);

    let result = match skill_root {
        Some(dir) => import_skill_dir_as(app, &dir, overwrite, Some(stem.as_str())),
        None => Err("ZIP 中未找到 SKILL.md（不是有效的技能包）".into()),
    };

    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// 在解压目录里找含 SKILL.md 的根：优先自身，其次向下最多两层。
/// 处理「ZIP 里包了一层同名目录」的常见情形。
fn locate_skill_root(tmp: &std::path::Path) -> Option<std::path::PathBuf> {
    if tmp.join("SKILL.md").is_file() {
        return Some(tmp.to_path_buf());
    }
    // 收集顶层目录
    let dirs: Vec<std::path::PathBuf> = std::fs::read_dir(tmp)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    // 顶层唯一目录：进入一层再看
    for d in &dirs {
        if d.join("SKILL.md").is_file() {
            return Some(d.clone());
        }
    }
    // 再深一层（如 repo-main/skills/xxx）
    for d in &dirs {
        if let Ok(sub) = std::fs::read_dir(d) {
            for e in sub.flatten() {
                let p = e.path();
                if p.is_dir() && p.join("SKILL.md").is_file() {
                    return Some(p);
                }
            }
        }
    }
    // 兜底：任意深度第一个 SKILL.md 的父目录（限制深度 4）
    fn deep(p: &std::path::Path, depth: usize) -> Option<std::path::PathBuf> {
        if depth > 4 {
            return None;
        }
        if p.join("SKILL.md").is_file() {
            return Some(p.to_path_buf());
        }
        for e in std::fs::read_dir(p).ok()?.flatten() {
            let c = e.path();
            if c.is_dir() {
                if let Some(r) = deep(&c, depth + 1) {
                    return Some(r);
                }
            }
        }
        None
    }
    deep(tmp, 0)
}

/// 批量打包为规范 .skillpack，并在输出目录生成仓库索引 index.json（SSEP §7.2）。
/// 单个失败不阻断其余；返回逐项结果。
pub fn pack_many(app: &AppH, dir_names: &[String], out_dir: &str) -> Result<crate::ahub::models::PackBatchReport, String> {
    use crate::ahub::models::{PackBatchReport, PackOutcome};

    let out = std::path::PathBuf::from(out_dir);
    if !out.is_dir() {
        return Err("输出目录不存在".into());
    }
    let root = skills_root(app);
    let mut outcomes: Vec<PackOutcome> = Vec::new();

    for dir_name in dir_names {
        let dir = root.join(dir_name);
        if !dir.is_dir() {
            outcomes.push(PackOutcome {
                dir_name: dir_name.clone(),
                name: String::new(),
                version: String::new(),
                ok: false,
                path: String::new(),
                warnings: Vec::new(),
                error: format!("技能不存在: {dir_name}"),
            });
            continue;
        }

        // 规范校验（硬性不合规 → 记录失败，继续下一个）
        let (name, version, warnings) = match crate::ahub::skill_toml::check_pack_ready(&dir) {
            Ok(v) => v,
            Err(e) => {
                outcomes.push(PackOutcome {
                    dir_name: dir_name.clone(),
                    name: String::new(),
                    version: String::new(),
                    ok: false,
                    path: String::new(),
                    warnings: Vec::new(),
                    error: e,
                });
                continue;
            }
        };

        match crate::ahub::skill_toml::pack(&dir, &out) {
            Ok(p) => outcomes.push(PackOutcome {
                dir_name: dir_name.clone(),
                name,
                version,
                ok: true,
                path: p.to_string_lossy().into_owned(),
                warnings,
                error: String::new(),
            }),
            Err(e) => outcomes.push(PackOutcome {
                dir_name: dir_name.clone(),
                name,
                version,
                ok: false,
                path: String::new(),
                warnings,
                error: e,
            }),
        }
    }

    // 生成 index.json（无中心服务的发布源，SSEP §7.2）
    let index_path = write_repo_index(&out, &outcomes)?;

    let succeeded = outcomes.iter().filter(|o| o.ok).count();
    let failed = outcomes.len() - succeeded;
    let warned = outcomes.iter().filter(|o| o.ok && !o.warnings.is_empty()).count();

    Ok(PackBatchReport {
        out_dir: out.to_string_lossy().into_owned(),
        total: outcomes.len(),
        succeeded,
        failed,
        warned,
        index_path: index_path.to_string_lossy().into_owned(),
        outcomes,
    })
}

/// 写仓库索引 index.json：{ skills: [ { name, versions: { "<ver>": { hash, ref, vet } } } ] }
fn write_repo_index(out: &std::path::Path, outcomes: &[crate::ahub::models::PackOutcome]) -> Result<std::path::PathBuf, String> {
    // 读既有索引并合并，避免重复打包时抹掉历史版本
    let idx_path = out.join("index.json");
    let mut root: serde_json::Value = if idx_path.exists() {
        std::fs::read_to_string(&idx_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| serde_json::json!({ "skills": [] }))
    } else {
        serde_json::json!({ "skills": [] })
    };

    let skills = root
        .as_object_mut()
        .and_then(|o| o.get_mut("skills"))
        .and_then(|v| v.as_array_mut());

    let Some(skills) = skills else {
        return Err("index.json 结构异常（缺 skills 数组）".into());
    };

    for o in outcomes.iter().filter(|o| o.ok) {
        // 包目录的 CHECKSUMS 哈希作为版本 hash
        let pack_dir = std::path::PathBuf::from(&o.path);
        let (hash, vet_verdict) = read_pack_meta(&pack_dir);

        let entry = skills.iter_mut().find(|e| {
            e.get("name").and_then(|v| v.as_str()) == Some(o.name.as_str())
        });
        match entry {
            Some(e) => {
                if let Some(versions) = e.get_mut("versions").and_then(|v| v.as_object_mut()) {
                    versions.insert(
                        o.version.clone(),
                        serde_json::json!({ "hash": hash, "ref": format!("{}@{}", o.name, o.version), "vet": { "verdict": vet_verdict } }),
                    );
                }
            }
            None => {
                skills.push(serde_json::json!({
                    "name": o.name,
                    "versions": {
                        o.version.clone(): { "hash": hash, "ref": format!("{}@{}", o.name, o.version), "vet": { "verdict": vet_verdict } }
                    }
                }));
            }
        }
    }

    // 稳定排序，便于 diff
    skills.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });

    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&idx_path, text).map_err(|e| e.to_string())?;
    Ok(idx_path)
}

/// 从打包产物读取 CHECKSUMS 汇总哈希与 [vet].verdict
fn read_pack_meta(pack_dir: &std::path::Path) -> (String, String) {
    use sha2::{Digest, Sha256};
    let mut hash = String::new();
    if let Ok(text) = std::fs::read_to_string(pack_dir.join("CHECKSUMS")) {
        let mut h = Sha256::new();
        h.update(text.as_bytes());
        hash = format!("{:x}", h.finalize());
    }
    let verdict = crate::ahub::skill_toml::load(pack_dir)
        .and_then(|d| crate::ahub::skill_toml::get_str(&d, "vet.verdict"))
        .unwrap_or_default();
    (hash, verdict)
}

/// 一次性修复历史遗留的 frontmatter 问题：
/// 1) `.hub.json` 的 tags 洗净（`'["a"]'` → `['a']`，去空、去重、排序）
/// 2) `SKILL.md` 的 frontmatter 规范化为合法 YAML
///    （值里含未加引号的冒号、行内数组写法等，都会在这一步统一）
///
/// 现在解析走 serde_yaml_ng，整体重写是安全的：结构由真 YAML 库往返，
/// 不会像早期手写解析器那样把多行标量写坏。
/// 返回 (修好的技能数, 技能目录名列表)。
pub fn repair_tags(app: &AppH) -> Result<(u32, Vec<String>), String> {
    let root = skills_root(app);
    std::fs::create_dir_all(&root).map_err(es)?;
    let mut fixed = 0u32;
    let mut detail: Vec<String> = Vec::new();

    for entry in std::fs::read_dir(&root).map_err(es)? {
        let entry = entry.map_err(es)?;
        let dir = entry.path();
        if !dir.is_dir() || !dir.join("SKILL.md").exists() {
            continue;
        }
        let dir_name = dir
            .file_name()
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut changed = false;

        // 1) .hub.json 的 tags 清洗
        let hp = hub_path(&dir);
        if let Ok(mut hub) = store::read_json::<SkillHub>(&hp) {
            let before = hub.tags.clone();
            let mut cleaned: Vec<String> = hub.tags.iter().flat_map(|t| clean_tag(t)).collect();
            cleaned.sort();
            cleaned.dedup();
            if cleaned != before {
                hub.tags = cleaned;
                store::write_json(&hp, &hub)?;
                changed = true;
            }
        }

        // 2) SKILL.md 的 frontmatter 规范化
        let doc_path = dir.join("SKILL.md");
        if let Ok(text) = std::fs::read_to_string(&doc_path) {
            let norm = text.replace("\r\n", "\n");
            if let Some(fm_text) = extract_fm_text(&norm) {
                let (_, needs_fix) = sanitize_fm_text(fm_text);
                // 额外检查：原始文本能否被严格解析
                let strict_ok = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(fm_text).is_ok();
                if needs_fix || !strict_ok {
                    // 解析 → 规范化重写（结构由 YAML 库往返，保真）
                    let (map, body) = split_doc(&norm);
                    if !map.is_empty() {
                        let out = compose_doc(&map, &body);
                        std::fs::write(&doc_path, out).map_err(es)?;
                        changed = true;
                    }
                }
            }
        }

        if changed {
            fixed += 1;
            detail.push(dir_name);
        }
    }

    Ok((fixed, detail))
}

/// 取出 frontmatter 文本（不含首尾 --- 行）；无 frontmatter 返回 None
fn extract_fm_text(doc: &str) -> Option<&str> {
    let t = doc.trim_start_matches('\u{feff}').trim_start_matches('\n');
    if !t.starts_with("---") {
        return None;
    }
    let after = &t[3..];
    let mut off = 0usize;
    for line in after.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(&after[..off]);
        }
        off += line.len();
    }
    None
}

/// 扩展名 → 预览类别
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

/// 技能目录树（用于「文件」页签展示结构）。
/// 跳过内部文件：.hub.json、*.agenthub-*。
/// 预览一个「尚未导入」的技能目录：返回 SKILL.md 正文 + 文件清单 + 是否已在中枢。
///
/// 用于导入前确认内容（从文件夹 / ZIP / Git 选中候选时）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub name: String,
    pub description: String,
    /// SKILL.md 正文（已剥离 frontmatter）
    pub body: String,
    /// frontmatter 原文
    pub frontmatter: String,
    /// 文件清单（相对路径 + 字节数），最多 200 条
    pub files: Vec<PreviewFile>,
    /// 中枢里是否已有同名技能（同名导入会走覆盖流程）
    pub exists_in_hub: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    pub size: u64,
}

/// 收集文件清单（跳过 .git 与内部 sidecar），上限 200 条避免超大目录拖垮界面
fn collect_preview_files(root: &Path) -> Vec<PreviewFile> {
    fn walk(cur: &Path, rel: &str, out: &mut Vec<PreviewFile>) {
        if out.len() >= 200 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(cur) else {
            return;
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            if out.len() >= 200 {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".hub.json" || name.starts_with(".agenthub-") {
                continue;
            }
            let p = e.path();
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            match e.metadata() {
                Ok(md) if md.is_dir() => walk(&p, &child, out),
                Ok(md) => out.push(PreviewFile {
                    path: child,
                    size: md.len(),
                }),
                Err(_) => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

/// 预览导入候选。`path` 指向含 SKILL.md 的技能目录。
pub fn preview_skill_dir(app: &AppH, path: &str) -> Result<ImportPreview, String> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err(format!("目录不存在: {path}"));
    }
    let doc = dir.join("SKILL.md");
    if !doc.is_file() {
        return Err("该目录没有 SKILL.md，不是技能目录".into());
    }
    let text = std::fs::read_to_string(&doc).map_err(es)?;
    let (fm, body) = split_doc(&text);
    let fm_text = compose_doc(&fm, "");
    let name = {
        let n = fm_get_str(&fm, "name");
        if n.is_empty() {
            dir.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            n
        }
    };
    let exists_in_hub = skills_root(app).join(&name).is_dir();
    Ok(ImportPreview {
        name,
        description: fm_get_str(&fm, "description"),
        body: body.to_string(),
        frontmatter: fm_text,
        files: collect_preview_files(&dir),
        exists_in_hub,
    })
}

pub fn list_skill_files(app: &AppH, dir_name: &str) -> Result<crate::ahub::models::SkillFileNode, String> {
    use crate::ahub::models::SkillFileNode;

    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }

    fn walk(base: &Path, cur: &Path, rel: &str) -> Result<Vec<SkillFileNode>, String> {
        let mut out: Vec<SkillFileNode> = Vec::new();
        let entries = std::fs::read_dir(cur).map_err(es)?;
        for e in entries {
            let e = e.map_err(es)?;
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".hub.json" || name.starts_with(".agenthub-") {
                continue;
            }
            let p = e.path();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let md = e.metadata().map_err(es)?;
            if md.is_dir() {
                let children = walk(base, &p, &child_rel)?;
                out.push(SkillFileNode {
                    path: child_rel,
                    name,
                    is_dir: true,
                    size: 0,
                    ext: String::new(),
                    kind: "dir".into(),
                    children,
                });
            } else {
                let ext = p
                    .extension()
                    .map(|x| x.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                out.push(SkillFileNode {
                    path: child_rel,
                    name,
                    is_dir: false,
                    size: md.len(),
                    kind: file_kind(&ext).to_string(),
                    ext,
                    children: Vec::new(),
                });
            }
        }
        // 目录优先，其次按名称
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    let children = walk(&dir, &dir, "")?;
    Ok(SkillFileNode {
        path: String::new(),
        name: dir_name.to_string(),
        is_dir: true,
        size: 0,
        ext: String::new(),
        kind: "dir".into(),
        children,
    })
}

/// 把「技能 + 相对路径」解析为绝对路径，并做目录穿越校验。
/// 供读取与「用系统程序打开」共用。
pub fn resolve_skill_file(app: &AppH, dir_name: &str, rel_path: &str) -> Result<std::path::PathBuf, String> {
    let root = skills_root(app).join(dir_name);
    resolve_within(&root, rel_path)
}

/// 路径解析核心（与 AppH 解耦，便于测试）。
///
/// 防护要点：
/// 1. 拒绝含空字节的路径（某些系统调用会截断）
/// 2. 拒绝绝对路径与盘符（`C:\x`、`/etc/passwd`）
/// 3. 拒绝任何 `..` 组件（在拼接前就拦掉，不依赖 canonicalize 兜底）
/// 4. 拼接后 canonicalize，再做前缀校验（兜住符号链接等间接跳转）
pub fn resolve_within(root: &Path, rel_path: &str) -> Result<std::path::PathBuf, String> {
    if !root.is_dir() {
        return Err("技能目录不存在".into());
    }
    if rel_path.contains('\0') {
        return Err("非法路径：含空字节".into());
    }
    // 统一分隔符后检查
    let normalized = rel_path.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err("非法路径：为空".into());
    }
    // 绝对路径 / 盘符 / UNC
    if trimmed.starts_with('/')
        || trimmed.starts_with("//")
        || trimmed.starts_with("\\\\")
        || trimmed.contains(":/")
    {
        return Err("路径越界：不允许绝对路径".into());
    }
    // 任何 .. 组件一律拒绝
    if trimmed.split('/').any(|seg| seg == "..") {
        return Err("路径越界：不允许上级目录".into());
    }

    let target = root.join(trimmed.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canon_root = root.canonicalize().map_err(es)?;
    let canon = target
        .canonicalize()
        .map_err(|_| format!("文件不存在: {rel_path}"))?;

    // 前缀校验：canonicalize 之后必须仍在技能根内
    if canon == canon_root || !canon.starts_with(&canon_root) {
        return Err("路径越界：只能访问该技能目录内的文件".into());
    }
    if !canon.is_file() {
        return Err(format!("不是文件: {rel_path}"));
    }
    Ok(canon)
}

/// 读取技能目录内某个文件用于实时阅读。
/// - 文本类（markdown/text/code）：直接返回 UTF-8 文本
/// - 图片 / PDF：返回 base64（前端内联渲染）
/// - word/sheet/archive：不可内联，返回 note 提示用系统程序打开
pub fn read_skill_file(app: &AppH, dir_name: &str, rel_path: &str) -> Result<crate::ahub::models::SkillFileContent, String> {
    use crate::ahub::models::SkillFileContent;

    let root = skills_root(app).join(dir_name);
    if !root.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }

    let canon = resolve_skill_file(app, dir_name, rel_path)?;

    let name = canon.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = canon
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = file_kind(&ext).to_string();
    let size = std::fs::metadata(&canon).map(|m| m.len()).unwrap_or(0);

    const TEXT_LIMIT: u64 = 2 * 1024 * 1024; // 2MB
    const BIN_LIMIT: u64 = 24 * 1024 * 1024; // 24MB（PDF/图片）

    let mut note = String::new();
    let mut text = String::new();
    let mut data_base64 = String::new();
    let mut truncated = false;

    match kind.as_str() {
        "markdown" | "text" | "code" => {
            if size > TEXT_LIMIT {
                truncated = true;
                note = format!("文件较大（{:.1} MB），仅显示前 2 MB", size as f64 / 1048576.0);
            }
            let bytes = std::fs::read(&canon).map_err(es)?;
            let take = if truncated { TEXT_LIMIT as usize } else { bytes.len() };
            // 非 UTF-8 时用 lossy，避免直接报错
            text = String::from_utf8_lossy(&bytes[..take.min(bytes.len())]).into_owned();
        }
        "image" | "pdf" => {
            if size > BIN_LIMIT {
                note = format!("文件较大（{:.1} MB），超过内联预览上限", size as f64 / 1048576.0);
            } else {
                let bytes = std::fs::read(&canon).map_err(es)?;
                data_base64 = base64_encode(&bytes);
            }
        }
        "word" => {
            note = "Word 文档无法内联预览，请用系统程序打开".into();
        }
        "sheet" => {
            note = "表格文件无法内联预览，请用系统程序打开".into();
        }
        "archive" => {
            note = "压缩包无法预览，请用系统程序打开".into();
        }
        _ => {
            note = "该类型不支持预览".into();
        }
    }

    Ok(SkillFileContent {
        path: rel_path.to_string(),
        name,
        ext,
        kind,
        size,
        text,
        data_base64,
        truncated,
        note,
    })
}

/// 标准 base64（不引入额外依赖）
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 为技能补一条初始版本快照（内容 = 当前 SKILL.md 全文）。
/// 仅在版本记录为空时写入，用于把历史导入的技能纳入版本管理。
/// 返回 true 表示新建了记录。
pub fn seed_version(app: &AppH, dir_name: &str, note: &str) -> Result<bool, String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let text = std::fs::read_to_string(dir.join("SKILL.md")).map_err(es)?;
    if text.is_empty() {
        return Ok(false);
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    if !hub.versions.is_empty() {
        return Ok(false);
    }
    hub.versions.push(crate::ahub::models::VersionEntry {
        v: 1,
        saved_at: crate::ahub::models::now_iso(),
        note: note.to_string(),
        content: text,
    });
    store::write_json(&hp, &hub)?;
    Ok(true)
}

/// 批量接入 SSEP 协议并运行安全审查。
/// 每个技能：缺 SKILL.toml 则先生成 CORE，然后执行审查并把结果写回 [vet]。
/// overwrite_vet=false 时，已有审查结果且内容哈希未变则跳过审查（省时间）。
pub fn onboard_many(
    app: &AppH,
    dir_names: &[String],
    only_missing: bool,
    vet: bool,
) -> crate::ahub::models::OnboardReport {
    use crate::ahub::models::{OnboardOutcome, OnboardReport};

    let mut outcomes: Vec<OnboardOutcome> = Vec::new();

    for dir_name in dir_names {
        let dir = skills_root(app).join(dir_name);
        if !dir.is_dir() {
            outcomes.push(OnboardOutcome {
                dir_name: dir_name.clone(),
                ok: false,
                created_toml: false,
                version: String::new(),
                verdict: String::new(),
                level: String::new(),
                critical: 0,
                high: 0,
                medium: 0,
                error: format!("技能不存在: {dir_name}"),
            });
            continue;
        }

        let had_toml = crate::ahub::skill_toml::load(&dir).is_some();
        if only_missing && had_toml {
            continue; // 只处理未接入的
        }

        let created = ensure_protocol(app, dir_name).map(|(c, _)| c).unwrap_or(false);
        // 顺带把技能纳入版本管理：无版本记录时补一条初始快照（幂等，不影响已有记录）
        let _ = seed_version(app, dir_name, "纳入 AgentHub 管理时的原始内容");
        let version = crate::ahub::skill_toml::load(&dir)
            .and_then(|d| crate::ahub::skill_toml::get_str(&d, "meta.version"))
            .unwrap_or_else(|| "0.0.0".into());

        if !vet {
            outcomes.push(OnboardOutcome {
                dir_name: dir_name.clone(),
                ok: true,
                created_toml: created,
                version,
                verdict: String::new(),
                level: String::new(),
                critical: 0,
                high: 0,
                medium: 0,
                error: String::new(),
            });
            continue;
        }

        match crate::ahub::vet::run(&dir).and_then(|report| {
            crate::ahub::vet::write_vet(&dir, &report)?;
            // 明细落盘到 .hub.json，供后续人工复审逐条处置
            let _ = save_vet_report(app, dir_name, &report);
            Ok(report)
        }) {
            Ok(report) => outcomes.push(OnboardOutcome {
                dir_name: dir_name.clone(),
                ok: true,
                created_toml: created,
                version,
                verdict: report.verdict.clone(),
                level: report.level.clone(),
                critical: report.critical,
                high: report.high,
                medium: report.medium,
                error: String::new(),
            }),
            Err(e) => outcomes.push(OnboardOutcome {
                dir_name: dir_name.clone(),
                ok: false,
                created_toml: created,
                version,
                verdict: String::new(),
                level: String::new(),
                critical: 0,
                high: 0,
                medium: 0,
                error: e,
            }),
        }
    }

    let succeeded = outcomes.iter().filter(|o| o.ok).count();
    let failed = outcomes.len() - succeeded;
    let created = outcomes.iter().filter(|o| o.created_toml).count();
    let rejected = outcomes.iter().filter(|o| o.verdict == "REJECT").count();
    let review = outcomes.iter().filter(|o| o.verdict == "REVIEW").count();
    let install = outcomes.iter().filter(|o| o.verdict == "INSTALL").count();

    OnboardReport {
        total: outcomes.len(),
        succeeded,
        failed,
        created,
        rejected,
        review,
        install,
        outcomes,
    }
}

/// 把审查报告（含逐条发现）落盘到 .hub.json，供「人工复审」界面使用。
/// 保留既有的人工复审痕迹：同一 (rule,file,line) 若先前被忽略，则延续 ignored。
pub fn save_vet_report(app: &AppH, dir_name: &str, report: &crate::ahub::vet::VetReport) -> Result<(), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();

    let prev_ignored: std::collections::HashSet<(String, String, usize)> = hub
        .vet_report
        .as_ref()
        .map(|r| {
            r.findings
                .iter()
                .filter(|f| f.ignored)
                .map(|f| (f.rule.clone(), f.file.clone(), f.line))
                .collect()
        })
        .unwrap_or_default();

    let findings = report
        .findings
        .iter()
        .map(|f| {
            let key = (f.rule.clone(), f.file.clone(), f.line);
            let was_ignored = prev_ignored.contains(&key);
            crate::ahub::models::VetFindingRow {
                rule: f.rule.clone(),
                severity: f.severity.clone(),
                file: f.file.clone(),
                line: f.line,
                excerpt: f.excerpt.clone(),
                ignored: was_ignored,
                ignored_at: if was_ignored {
                    hub.vet_report
                        .as_ref()
                        .and_then(|r| {
                            r.findings
                                .iter()
                                .find(|x| x.rule == f.rule && x.file == f.file && x.line == f.line)
                                .map(|x| x.ignored_at.clone())
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                },
            }
        })
        .collect();

    hub.vet_report = Some(crate::ahub::models::VetReportRow {
        verdict: report.verdict.clone(),
        level: report.level.clone(),
        critical: report.critical,
        high: report.high,
        medium: report.medium,
        content_hash: report.content_hash.clone(),
        checked_at: report.checked_at.clone(),
        checked_by: report.checked_by.clone(),
        findings,
        // 重新审查后，旧的人工结论作废（内容可能已变）
        review: String::new(),
        reviewed_at: String::new(),
        review_note: String::new(),
    });
    store::write_json(&hp, &hub)
}

/// 读取某技能的审查报告（含逐条发现与人工复审状态）
pub fn read_vet_report(app: &AppH, dir_name: &str) -> Result<Option<crate::ahub::models::VetReportRow>, String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    Ok(store::read_json::<SkillHub>(&hub_path(&dir))
        .ok()
        .and_then(|h| h.vet_report))
}

/// 人工复审：忽略/恢复某一条发现。
/// key = (rule, file, line)；返回处理后的 (待复核数, 已忽略数)。
pub fn review_finding(
    app: &AppH,
    dir_name: &str,
    rule: &str,
    file: &str,
    line: usize,
    ignored: bool,
) -> Result<(u32, u32), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    let Some(report) = hub.vet_report.as_mut() else {
        return Err("该技能尚无审查记录".into());
    };

    let mut hit = false;
    for f in report.findings.iter_mut() {
        if f.rule == rule && f.file == file && f.line == line {
            f.ignored = ignored;
            f.ignored_at = if ignored { crate::ahub::models::now_iso() } else { String::new() };
            hit = true;
        }
    }
    if !hit {
        return Err("未找到该条发现（内容可能已重新审查）".into());
    }

    let ignored_n = report.findings.iter().filter(|f| f.ignored).count() as u32;
    let pending = report.findings.iter().filter(|f| !f.ignored).count() as u32;
    let verdict = report.verdict.clone();
    let h = report.content_hash.clone();
    store::write_json(&hp, &hub)?;

    // 协议事件：人工复审是可审计动作，写入 lifecycle（SSEP 允许工具追加事件）
    let _ = crate::ahub::skill_toml::append_event(
        &dir,
        "vet",
        &verdict,
        &if ignored {
            format!("人工复审：忽略 {rule} @ {file}:{line}")
        } else {
            format!("人工复审：恢复 {rule} @ {file}:{line}")
        },
        &h,
    );

    Ok((pending, ignored_n))
}

/// 人工复审：批量忽略全部未忽略的发现。
pub fn ignore_all_findings(app: &AppH, dir_name: &str) -> Result<u32, String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    let Some(report) = hub.vet_report.as_mut() else {
        return Err("该技能尚无审查记录".into());
    };
    let now = crate::ahub::models::now_iso();
    let mut n = 0u32;
    for f in report.findings.iter_mut() {
        if !f.ignored {
            f.ignored = true;
            f.ignored_at = now.clone();
            n += 1;
        }
    }
    let verdict = report.verdict.clone();
    let h = report.content_hash.clone();
    store::write_json(&hp, &hub)?;
    if n > 0 {
        let _ = crate::ahub::skill_toml::append_event(&dir, "vet", &verdict, &format!("人工复审：忽略全部 {n} 条"), &h);
    }
    Ok(n)
}

/// 人工复审：给出整体复核结论（approved / rejected / 清空）。
pub fn set_review_verdict(app: &AppH, dir_name: &str, verdict: &str, note: &str) -> Result<(), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    let Some(report) = hub.vet_report.as_mut() else {
        return Err("该技能尚无审查记录".into());
    };
    report.review = verdict.to_string();
    report.reviewed_at = if verdict.is_empty() { String::new() } else { crate::ahub::models::now_iso() };
    report.review_note = note.to_string();
    let machine = report.verdict.clone();
    let h = report.content_hash.clone();
    store::write_json(&hp, &hub)?;

    if !verdict.is_empty() {
        let _ = crate::ahub::skill_toml::append_event(
            &dir,
            "vet",
            &machine,
            &format!("人工复核结论：{verdict}{}", if note.trim().is_empty() { String::new() } else { format!("（{note}）") }),
            &h,
        );
    }
    Ok(())
}

/// 清空某技能的版本记录（只删 .hub.json 里的 versions，不动技能内容与 tags/origin）
pub fn clear_skill_versions(app: &AppH, dir_name: &str) -> Result<u32, String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    let hp = hub_path(&dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    let n = hub.versions.len() as u32;
    hub.versions.clear();
    store::write_json(&hp, &hub)?;
    Ok(n)
}

pub fn delete_skill(app: &AppH, dir_name: &str) -> Result<(), String> {
    let dir = skills_root(app).join(dir_name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(es)?;
    }
    Ok(())
}

/// Import a skill folder into hub storage using copy-then-replace (先复制后替换):
/// copy source → staging dir → swap with existing (old moved to backup) →
/// delete backup on success / auto-restore on failure. Keeps existing hub
/// metadata (origin + version history).
pub fn import_skill_dir(app: &AppH, src: &Path, overwrite: bool) -> Result<String, String> {
    import_skill_dir_as(app, src, overwrite, None)
}

/// 记录技能来源（从某个 harness 收集而来）。
///
/// 为什么必须单独写：`origin` 只存在于 `.hub.json`，而导入流程（文件夹 / ZIP /
/// 市场 / Git）并不知道来源是哪个工具。原先只有读取方（list_skills）而没有写入方，
/// 导致所有技能的 origin 恒为 None，界面上的「按来源筛选」计数全部落到本机一档，
/// 与右侧实际列表对不上。
pub fn set_skill_origin(app: &AppH, dir_name: &str, harness: &str, file: &str) -> Result<(), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    write_skill_origin(&dir, harness, file)
}

/// 纯路径版本，便于单元测试（不依赖 AppHandle）。
/// 保留 `.hub.json` 里已有的 tags / versions / vet_report，只替换 origin。
fn write_skill_origin(dir: &Path, harness: &str, file: &str) -> Result<(), String> {
    let hp = hub_path(dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    hub.origin = Some(Origin {
        harness: harness.to_string(),
        file: file.to_string(),
        imported_at: now_iso(),
    });
    store::write_json(&hp, &hub)
}

/// 把 AI 摘要写回 `.hub.json`（保留 tags / versions / origin / vet_report）。
///
/// 摘要只是旁路元数据，写失败不应影响技能本身的可用性，但调用方需要知道结果，
/// 因此错误原样返回。
pub fn write_summary(app: &AppH, dir_name: &str, summary: &SkillSummary) -> Result<(), String> {
    let dir = skills_root(app).join(dir_name);
    if !dir.is_dir() {
        return Err(format!("技能不存在: {dir_name}"));
    }
    write_summary_at(&dir, summary)
}

/// 纯路径版本，便于单元测试（不依赖 AppHandle）。
pub fn write_summary_at(dir: &Path, summary: &SkillSummary) -> Result<(), String> {
    let hp = hub_path(dir);
    let mut hub: SkillHub = store::read_json(&hp).unwrap_or_default();
    hub.summary = Some(summary.clone());
    store::write_json(&hp, &hub)
}

/// 读取技能已存的摘要（无 `.hub.json` 或其中无 `summary` 时返回 None，不报错）。
/// 目前只有测试用到；保留为对称的读取入口（与 write_summary_at 配对）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_summary_at(dir: &Path) -> Option<SkillSummary> {
    store::read_json::<SkillHub>(&hub_path(dir)).ok().and_then(|h| h.summary)
}

/// 判断目录名是否为本工具自己生成的临时解压目录名。
/// 这种名字绝不能被当成技能目录名落盘（否则会出现 `agenthub-zip-1234-20261017010203` 这样的技能）。
fn is_generated_tmp_name(folder: &str) -> bool {
    folder.starts_with("agenthub-zip-")
        || folder.starts_with("agenthub-skillhub-")
        || folder.starts_with("agenthub-import-")
}

/// 取 SKILL.md frontmatter 里的 `name`（仅字符串形态）。
fn frontmatter_name(src: &Path) -> Option<String> {
    let doc = std::fs::read_to_string(src.join("SKILL.md")).ok()?;
    let (fm, _) = split_doc(&doc);
    match fm.get("name") {
        Some(FmValue::Str(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// 解析落盘用的目录名：
/// - 正常文件夹（用户选的）→ 用文件夹名，保持「文件夹名即身份」的既有语义
/// - 临时解压目录（ZIP / 市场安装）→ 依次退到 frontmatter `name`、ZIP 文件名，最后才用目录名
fn resolve_dir_name(src: &Path, fallback_name: Option<&str>) -> Result<String, String> {
    let folder = src
        .file_name()
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_default();

    let name = if is_generated_tmp_name(&folder) {
        frontmatter_name(src)
            .map(|n| store::slugify(&n))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                fallback_name
                    .map(store::slugify)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(folder)
    } else {
        folder
    };


    if name.is_empty() || name.starts_with('.') {
        return Err("invalid skill folder".into());
    }
    Ok(name)
}

/// 去掉文件名尾部的版本号：`apple-design-skill-1.7.6` → `apple-design-skill`。
/// 只剥「纯数字与点号」组成的尾段，避免误伤 `tauri-2-capsule-window` 这类正常名字。
fn strip_version_suffix(stem: &str) -> String {
    let mut parts: Vec<&str> = stem.split('-').collect();
    while let Some(last) = parts.last() {
        let pure_version = !last.is_empty()
            && last.chars().all(|c| c.is_ascii_digit() || c == '.')
            && last.chars().any(|c| c.is_ascii_digit());
        // 至少留一段，且最后一段确实是纯版本号时才剥
        if pure_version && parts.len() > 1 {
            parts.pop();
        } else {
            break;
        }
    }
    parts.join("-")
}
/// 与 `import_skill_dir` 相同，但可指定名字兜底（ZIP 导入传压缩包文件名）。
pub fn import_skill_dir_as(
    app: &AppH,
    src: &Path,
    overwrite: bool,
    fallback_name: Option<&str>,
) -> Result<String, String> {
    let src_doc = src.join("SKILL.md");
    if !src_doc.exists() {
        return Err(format!("no SKILL.md in {}", src.display()));
    }
    let name = resolve_dir_name(src, fallback_name)?;
    let root = skills_root(app);
    std::fs::create_dir_all(&root).map_err(es)?;
    let dst = root.join(&name);
    if dst.exists() && !overwrite {
        return Err(format!("exists: {name}"));
    }
    let new_text = std::fs::read_to_string(&src_doc).unwrap_or_default();

    // 1) 先复制：copy source into a staging folder
    let ts = chrono::Local::now().format("%Y%m%d%H%M%S");
    let staging = root.join(format!("{name}.agenthub-staging-{ts}"));
    let _ = std::fs::remove_dir_all(&staging);
    store::copy_dir_recursive(src, &staging, false)?;

    // 2) 再替换：move existing to backup, then move staging into place
    let mut backup: Option<std::path::PathBuf> = None;
    if dst.exists() {
        let bak = root.join(format!("{name}.agenthub-bak-{ts}"));
        std::fs::rename(&dst, &bak).map_err(es)?;
        backup = Some(bak);
    }
    match std::fs::rename(&staging, &dst) {
        Ok(()) => {
            // merge hub metadata: keep origin + versions, take tags from the source frontmatter
            let mut hub: SkillHub = store::read_json(&dst.join(".hub.json")).unwrap_or_default();
            if let Some(bak) = &backup {
                if let Ok(old_hub) = store::read_json::<SkillHub>(&bak.join(".hub.json")) {
                    hub.versions = old_hub.versions;
                    hub.origin = old_hub.origin;
                }
                let old_doc = std::fs::read_to_string(bak.join("SKILL.md")).unwrap_or_default();
                if !old_doc.is_empty() && old_doc != new_text {
                    store::push_version(&mut hub.versions, &old_doc);
                }
            }
            // 首次导入（无历史版本）时记录一条初始版本，保证版本列表从一开始就有记录
            if hub.versions.is_empty() && !new_text.is_empty() {
                hub.versions.push(crate::ahub::models::VersionEntry {
                    v: 1,
                    saved_at: crate::ahub::models::now_iso(),
                    note: "导入时的原始版本".into(),
                    content: new_text.clone(),
                });
            }
            let (fm, _) = split_doc(&new_text);
            hub.tags = {
                let mut t = fm_get_tags(&fm);
                t.sort();
                t.dedup();
                t
            };
            store::write_json(&dst.join(".hub.json"), &hub)?;
            if let Some(bak) = backup {
                let _ = std::fs::remove_dir_all(&bak);
            }
            let _ = crate::ahub::skill_toml::ensure_core(&dst, &name, "local", &src.to_string_lossy());
            let _ = crate::ahub::skill_toml::append_event(&dst, "import", "", "复制导入（先复制后替换）", "");
            Ok(name)
        }
        Err(e) => {
            // restore original on failure
            if let Some(bak) = backup {
                let _ = std::fs::rename(&bak, &dst);
            }
            let _ = std::fs::remove_dir_all(&staging);
            Err(e.to_string())
        }
    }
}

/// frontmatter 解析回归测试。
/// 覆盖历史上真实出过问题的写法（行内数组被当字符串、多行标量丢描述、
/// 值里含冒号导致 YAML 非法），以及常规 YAML 语法与往返一致性。
#[cfg(test)]
mod frontmatter_tests {
    use super::*;

    fn fm(doc: &str) -> BTreeMap<String, FmValue> {
        split_doc(doc).0
    }

    /// 曾经出 bug 的两种写法
    #[test]
    fn regression_inline_array_and_folded_scalar() {
        // 行内数组 → 必须是 List，不能是 '["自习"]' 字符串
        let a = fm("---
name: x
tags: [\"自习\", \"工具\"]
---

body
");
        assert!(matches!(a.get("tags"), Some(FmValue::List(_))), "{:?}", a.get("tags"));
        assert_eq!(fm_get_tags(&a), vec!["自习".to_string(), "工具".to_string()]);

        // 折叠标量 → 完整文本，且不能产生垃圾 key
        let b = fm("---
name: lyco
description: >
  line one: has colon
  line two
tags: [\"x\"]
---

b
");
        assert_eq!(fm_get_str(&b, "description").trim_end(), "line one: has colon line two");
        let keys: Vec<&String> = b.keys().collect();
        assert_eq!(keys, vec!["description", "name", "tags"], "{keys:?}");
    }

    /// 完整 YAML 语法覆盖
    #[test]
    fn full_yaml_syntax() {
        // 字面标量保留换行
        let a = fm("---
description: |
  first
  second
name: x
---

b
");
        assert_eq!(fm_get_str(&a, "description").trim_end(), "first
second");

        // 单引号 / 双引号 / 冒号在值里
        let b = fm("---
title: 'a: b'
note: \"x: y\"
---

b
");
        assert_eq!(fm_get_str(&b, "title"), "a: b");
        assert_eq!(fm_get_str(&b, "note"), "x: y");

        // 布尔 / 数字 / null
        let c = fm("---
flag: true
num: 42
nothing: null
---

b
");
        assert_eq!(fm_get_str(&c, "flag"), "true");
        assert_eq!(fm_get_str(&c, "num"), "42");
        assert!(c.get("nothing").is_none(), "null 不应产生条目");

        // 注释行
        let d = fm("---
name: x  # 行尾注释
# 整行注释
ver: 1
---

b
");
        assert_eq!(fm_get_str(&d, "name"), "x");
        assert_eq!(fm_get_str(&d, "ver"), "1");

        // 块列表
        let e = fm("---
tags:
  - a
  - b
---

b
");
        assert_eq!(fm_get_tags(&e), vec!["a".to_string(), "b".to_string()]);

        // 中文键值
        let f = fm("---
名称: 测试
tags: [\"中文\"]
---

b
");
        assert_eq!(fm_get_str(&f, "名称"), "测试");
    }

    /// 嵌套结构保留（不再是 Raw 文本，而是结构化 Nested）
    #[test]
    fn nested_structure_preserved() {
        let a = fm("---
name: x
deps:
  item:
    - name: y
      semver: '>=1.0'
---

b
");
        let v = a.get("deps").expect("deps 应存在");
        let j = v.to_json();
        assert_eq!(j["item"][0]["name"], "y");
        assert_eq!(j["item"][0]["semver"], ">=1.0");
    }

    /// 往返：compose → split 语义不变
    #[test]
    fn roundtrip_semantics() {
        let doc = "---
name: demo
tags: [\"a\", \"b\"]
description: >
  多行
  描述
flag: true
---

# Body

content
";
        let (fm1, body1) = split_doc(doc);
        let out = compose_doc(&fm1, &body1);
        let (fm2, body2) = split_doc(&out);

        assert_eq!(fm_get_str(&fm2, "name"), "demo");
        assert_eq!(fm_get_tags(&fm2), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(fm_get_str(&fm2, "description").trim_end(), fm_get_str(&fm1, "description").trim_end());
        assert_eq!(fm_get_str(&fm2, "flag"), "true");
        assert_eq!(body1, body2, "正文应完全一致");
        assert!(body2.contains("# Body"));
    }

    /// 正文里的 --- 不应被当成 frontmatter 结束（只认紧随 key 区的那个）
    #[test]
    fn body_with_dashes_safe() {
        let doc = "---
name: x
---

# Title

---

more
";
        let (m, body) = split_doc(doc);
        assert_eq!(fm_get_str(&m, "name"), "x");
        assert!(body.contains("---"), "正文里的分隔线应保留");
    }

    /// 无 frontmatter / 损坏 frontmatter：正文照常返回，不 panic
    #[test]
    fn no_or_broken_frontmatter() {
        let (m, b) = split_doc("# Just a body
");
        assert!(m.is_empty());
        assert_eq!(b, "# Just a body
");

        // 未闭合
        let (m2, b2) = split_doc("---
name: x
body without close
");
        assert!(b2.contains("body without close"));

        // 非法 YAML：不应 panic，正文保留
        let (_, b3) = split_doc("---
name: [unclosed
---

body
");
        assert!(b3.contains("body"));
        let _ = m2;
    }

    /// 标量类型保真：bool / number 往返不被引号化
    #[test]
    fn scalar_types_preserved() {
        let doc = "---
name: x
agent_created: true
count: 42
ratio: 1.5
---

b
";
        let (fm, body) = split_doc(doc);
        let out = compose_doc(&fm, &body);
        // 不应出现被引号化的标量
        assert!(out.contains("agent_created: true"), "输出:
{out}");
        assert!(!out.contains("'true'"), "bool 被引号化:
{out}");
        assert!(out.contains("count: 42"), "输出:
{out}");
        assert!(!out.contains("'42'"), "数字被引号化:
{out}");
        // 再解析回来类型仍然正确
        let (fm2, _) = split_doc(&out);
        assert_eq!(fm_get_str(&fm2, "agent_created"), "true");
        assert_eq!(fm_get_str(&fm2, "count"), "42");
        assert_eq!(fm2.get("agent_created").map(|v| v.to_json()), Some(serde_json::Value::Bool(true)));
        assert_eq!(fm2.get("count").map(|v| v.to_json()), Some(serde_json::json!(42)));
    }

    /// 含冒号的值往返后仍合法、且内容不变
    #[test]
    fn colon_value_roundtrip() {
        let doc = "---
name: x
description: 'A: B, C: D'
---

b
";
        let (fm, body) = split_doc(doc);
        assert_eq!(fm_get_str(&fm, "description"), "A: B, C: D");
        let out = compose_doc(&fm, &body);
        let (fm2, _) = split_doc(&out);
        assert_eq!(fm_get_str(&fm2, "description"), "A: B, C: D");
    }

    /// 历史脏值自愈（clean_tag）
    #[test]
    fn legacy_garbage_healed() {
        assert_eq!(clean_tag("[\"自习\"]"), vec!["自习".to_string()]);
        assert_eq!(clean_tag("[\"a\", \"b\"]"), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(clean_tag("正常"), vec!["正常".to_string()]);
        assert_eq!(clean_tag(""), Vec::<String>::new());
        // 逗号分隔的兜底
        let m = fm("---
tags: a, b
---

b
");
        assert_eq!(fm_get_tags(&m), vec!["a".to_string(), "b".to_string()]);
    }
}

#[cfg(test)]
mod file_access_tests {
    use super::*;

    /// base64 编码正确性（与标准实现对齐）
    #[test]
    fn base64_matches_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 中文 UTF-8 字节
        assert_eq!(base64_encode("中文".as_bytes()), "5Lit5paH");
        // 覆盖所有 0..=255 字节，长度符合 base64 规则
        let all: Vec<u8> = (0u8..=255).collect();
        let enc = base64_encode(&all);
        assert_eq!(enc.len() % 4, 0);
        assert!(enc.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    /// 扩展名 → 预览类别
    #[test]
    fn kind_mapping() {
        assert_eq!(file_kind("md"), "markdown");
        assert_eq!(file_kind("txt"), "text");
        assert_eq!(file_kind("py"), "code");
        assert_eq!(file_kind("json"), "code");
        assert_eq!(file_kind("png"), "image");
        assert_eq!(file_kind("pdf"), "pdf");
        assert_eq!(file_kind("docx"), "word");
        assert_eq!(file_kind("xlsx"), "sheet");
        assert_eq!(file_kind("zip"), "archive");
        assert_eq!(file_kind("weird"), "other");
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;

    #[test]
    fn collects_files_but_skips_internal() {
        let d = std::env::temp_dir().join(format!("ah-preview-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(d.join("references")).unwrap();
        std::fs::write(d.join("SKILL.md"), "x").unwrap();
        std::fs::write(d.join("references/a.md"), "y").unwrap();
        std::fs::write(d.join(".hub.json"), "{}").unwrap();
        let files = collect_preview_files(&d);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"SKILL.md"));
        assert!(paths.contains(&"references/a.md"), "子目录应递归收集");
        assert!(!paths.iter().any(|p| p.contains(".hub.json")), "内部 sidecar 不应出现");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cap_at_200_files() {
        let d = std::env::temp_dir().join(format!("ah-preview-cap-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..260 {
            std::fs::write(d.join(format!("f{i}.txt")), "x").unwrap();
        }
        assert_eq!(collect_preview_files(&d).len(), 200, "应有上限");
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;

    fn tmp_skill(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-origin-{tag}-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), "---
name: x
---
body").unwrap();
        d
    }

    #[test]
    fn records_origin_harness() {
        let d = tmp_skill("rec");
        write_skill_origin(&d, "claude-code", "C:/x/.claude/skills").unwrap();
        let hub: SkillHub = store::read_json(&hub_path(&d)).unwrap();
        let o = hub.origin.expect("应写入 origin");
        assert_eq!(o.harness, "claude-code");
        assert_eq!(o.file, "C:/x/.claude/skills");
        assert!(!o.imported_at.is_empty(), "应记录导入时间");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 关键：不能覆盖掉 .hub.json 里已有的 tags / versions / vet_report
    #[test]
    fn keeps_existing_hub_fields() {
        let d = tmp_skill("keep");
        let hp = hub_path(&d);
        let mut hub = SkillHub::default();
        hub.tags = vec!["设计".into(), "UI".into()];
        hub.versions = vec![crate::ahub::models::VersionEntry {
            v: 1,
            saved_at: "2026-10-17T00:00:00Z".into(),
            note: "初版".into(),
            content: "body".into(),
        }];
        store::write_json(&hp, &hub).unwrap();

        write_skill_origin(&d, "opencode", "C:/x/skills").unwrap();

        let after: SkillHub = store::read_json(&hp).unwrap();
        assert_eq!(after.tags, vec!["设计", "UI"], "tags 不能被清掉");
        assert_eq!(after.versions.len(), 1, "版本历史不能被清掉");
        assert_eq!(after.origin.unwrap().harness, "opencode");
        std::fs::remove_dir_all(&d).ok();
    }

    /// 覆盖收集：第二次收集应更新来源，而不是保留旧值
    #[test]
    fn overwrites_previous_origin() {
        let d = tmp_skill("over");
        write_skill_origin(&d, "claude-code", "C:/a").unwrap();
        write_skill_origin(&d, "pi-agent", "C:/b").unwrap();
        let hub: SkillHub = store::read_json(&hub_path(&d)).unwrap();
        assert_eq!(hub.origin.unwrap().harness, "pi-agent");
        std::fs::remove_dir_all(&d).ok();
    }
}


/// 保存 / 发布语义：暂存不写版本，发布才写；快照必须是落盘后的新内容。
/// 这组测试直接驱动 save_skill_at 的真实读写路径，不做任何桩替换。
#[cfg(test)]
mod publish_tests {
    use super::*;

    fn root(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-pub-{tag}-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn payload(root: &std::path::Path, name: &str, body: &str, publish: bool) -> SkillSavePayload {
        // 目录名直接取 name 的小写形式，测试里好定位
        let _ = root;
        SkillSavePayload {
            dir_name: name.to_string(),
            name: name.to_string(),
            description: String::new(),
            tags: Vec::new(),
            body: body.to_string(),
            frontmatter: Default::default(),
            level: None,
            publish,
            note: String::new(),
        }
    }

    fn versions(root: &std::path::Path, name: &str) -> Vec<crate::ahub::models::VersionEntry> {
        store::read_json::<SkillHub>(&hub_path(&root.join(name)))
            .map(|h| h.versions)
            .unwrap_or_default()
    }

    /// 新建技能：本身就是第一个正式版本，时间轴必须有起点
    #[test]
    fn create_publishes_initial_version() {
        let r = root("create");
        save_skill_at(&r, payload(&r, "alpha", "首版正文", false)).unwrap();
        let vs = versions(&r, "alpha");
        assert_eq!(vs.len(), 1, "新建技能应留下一条初始版本");
        assert!(vs[0].content.contains("首版正文"), "快照必须是新内容");
        std::fs::remove_dir_all(&r).ok();
    }

    // ---- AI 摘要写入 .hub.json（spec summary-storage） ----

    fn sample_summary() -> SkillSummary {
        SkillSummary {
            domain: "开发".into(),
            one_liner: "生成提交信息".into(),
            kind: "tool".into(),
            script_count: 2,
            reference_count: 1,
            generated_at: "2026-10-21T10:00:00+08:00".into(),
            model: "gpt-4o-mini".into(),
        }
    }

    #[test]
    fn writes_summary_to_hub_json() {
        let r = root("sum-write");
        save_skill_at(&r, payload(&r, "gamma", "正文", false)).unwrap();
        let dir = r.join("gamma");
        write_summary_at(&dir, &sample_summary()).unwrap();

        let hub: SkillHub = store::read_json(&hub_path(&dir)).unwrap();
        let s = hub.summary.expect("summary 应写入 .hub.json");
        assert_eq!(s.domain, "开发");
        assert_eq!(s.kind, "tool");
        assert_eq!(s.script_count, 2);
        assert_eq!(s.reference_count, 1);
        assert!(!s.generated_at.is_empty());
        assert_eq!(s.model, "gpt-4o-mini");
        std::fs::remove_dir_all(&r).ok();
    }

    /// 写摘要不能碰已有的 tags / versions / origin
    #[test]
    fn summary_write_keeps_other_hub_fields() {
        let r = root("sum-keep");
        save_skill_at(&r, payload(&r, "delta", "正文", false)).unwrap();
        let dir = r.join("delta");
        write_skill_origin(&dir, "claude-code", "C:/x").unwrap();
        let before: SkillHub = store::read_json(&hub_path(&dir)).unwrap();

        write_summary_at(&dir, &sample_summary()).unwrap();

        let after: SkillHub = store::read_json(&hub_path(&dir)).unwrap();
        assert_eq!(after.tags, before.tags, "tags 不能被摘要覆盖");
        assert_eq!(after.versions.len(), before.versions.len(), "版本历史不能被摘要覆盖");
        assert_eq!(after.origin.unwrap().harness, "claude-code");
        assert!(after.summary.is_some());
        std::fs::remove_dir_all(&r).ok();
    }

    /// 重复生成覆盖旧摘要（spec：重新生成覆盖）
    #[test]
    fn summary_write_overwrites_previous() {
        let r = root("sum-over");
        save_skill_at(&r, payload(&r, "eps", "正文", false)).unwrap();
        let dir = r.join("eps");
        write_summary_at(&dir, &sample_summary()).unwrap();
        let mut second = sample_summary();
        second.domain = "办公".into();
        write_summary_at(&dir, &second).unwrap();

        let hub: SkillHub = store::read_json(&hub_path(&dir)).unwrap();
        assert_eq!(hub.summary.unwrap().domain, "办公");
        std::fs::remove_dir_all(&r).ok();
    }

    /// 没有 .hub.json / 其中没有 summary → 视为「尚无摘要」，不报错
    #[test]
    fn missing_summary_is_not_an_error() {
        let r = root("sum-none");
        save_skill_at(&r, payload(&r, "zeta", "正文", false)).unwrap();
        let dir = r.join("zeta");
        assert!(read_summary_at(&dir).is_none());
        // 列表照常可用
        let meta = meta_for_dir(&dir).unwrap();
        assert!(meta.summary.is_none());
        std::fs::remove_dir_all(&r).ok();
    }

    /// 列表与详情读到的 summary 与 .hub.json 一致（打开界面不触发 AI）
    #[test]
    fn meta_exposes_stored_summary() {
        let r = root("sum-meta");
        save_skill_at(&r, payload(&r, "eta", "正文", false)).unwrap();
        let dir = r.join("eta");
        write_summary_at(&dir, &sample_summary()).unwrap();

        let meta = meta_for_dir(&dir).unwrap();
        assert_eq!(meta.summary.map(|s| s.one_liner), Some("生成提交信息".to_string()));
        std::fs::remove_dir_all(&r).ok();
    }

    /// 暂存：内容变了但不写版本 —— 时间轴只记已发布
    #[test]
    fn stash_does_not_add_version() {
        let r = root("stash");
        save_skill_at(&r, payload(&r, "beta", "第一版", false)).unwrap();
        let before = versions(&r, "beta").len();

        save_skill_at(&r, payload(&r, "beta", "改过但未发布", false)).unwrap();
        let vs = versions(&r, "beta");
        assert_eq!(vs.len(), before, "暂存不能新增版本记录");
        assert!(vs.iter().all(|v| !v.content.contains("改过但未发布")), "暂存内容不该进时间轴");

        // 但正文确实落盘了
        let doc = std::fs::read_to_string(r.join("beta").join("SKILL.md")).unwrap();
        assert!(doc.contains("改过但未发布"), "暂存必须写入磁盘");
        std::fs::remove_dir_all(&r).ok();
    }

    /// 发布：新增一条版本，且快照是落盘后的新内容（不是改动前的旧内容）
    #[test]
    fn publish_snapshots_new_content() {
        let r = root("pub");
        save_skill_at(&r, payload(&r, "gamma", "第一版", false)).unwrap();
        let before = versions(&r, "gamma").len();

        save_skill_at(&r, payload(&r, "gamma", "第二版内容", true)).unwrap();
        let vs = versions(&r, "gamma");
        assert_eq!(vs.len(), before + 1, "发布应新增一条版本");
        let latest = vs.iter().max_by_key(|v| v.v).unwrap();
        assert!(latest.content.contains("第二版内容"), "快照必须是发布时的新内容");
        std::fs::remove_dir_all(&r).ok();
    }

    /// 内容没变就再点发布：去重，不该多出一个节点
    #[test]
    fn publish_same_content_is_deduped() {
        let r = root("dedup");
        save_skill_at(&r, payload(&r, "delta", "同样的正文", false)).unwrap();
        let before = versions(&r, "delta").len();
        save_skill_at(&r, payload(&r, "delta", "同样的正文", true)).unwrap();
        assert_eq!(versions(&r, "delta").len(), before, "内容未变不该新增版本");
        std::fs::remove_dir_all(&r).ok();
    }
}
mod time_tests {
    use super::*;
    use crate::ahub::store::valid_time;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn rejects_dos_epoch() {
        // ZIP 无日期时的哨兵值
        let epoch_1980 = UNIX_EPOCH + Duration::from_secs(315_532_800);
        assert!(valid_time(epoch_1980).is_none(), "1980-01-01 应被判为无效");
        // 实测有时显示成 1979-12-31（时区偏移），也要挡住
        let epoch_minus = UNIX_EPOCH + Duration::from_secs(315_532_800 - 86_400);
        assert!(valid_time(epoch_minus).is_none(), "1979-12-31 应被判为无效");
        // 纪元本身
        assert!(valid_time(UNIX_EPOCH).is_none(), "1970 应被判为无效");
    }

    /// 回退链：SKILL.md 时间不可信时，用工具自身写的 .hub.json / SKILL.toml
    #[test]
    fn falls_back_to_hub_json() {
        let dir = std::env::temp_dir().join(format!("ah-time-test-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 只有 .hub.json（模拟 SKILL.md 缺失或时间不可信）
        std::fs::write(dir.join(".hub.json"), b"{}").unwrap();
        let (_, updated) = skill_times(&dir);
        assert!(!updated.is_empty(), "SKILL.md 不可信时应回退到 .hub.json 的时间");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 三个候选都不可用时应返回空，而不是编一个日期
    #[test]
    fn empty_when_nothing_usable() {
        let dir = std::env::temp_dir().join(format!("ah-time-empty-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(skill_times(&dir), (String::new(), String::new()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepts_real_times() {
        let t2026 = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(valid_time(t2026).is_some(), "2027 年的正常时间应被接受");
        // 边界：1980-01-02 当天之后即视为有效
        let just_after = UNIX_EPOCH + Duration::from_secs(315_619_200);
        assert!(valid_time(just_after).is_some());
    }
}

#[cfg(test)]
mod path_traversal_tests {
    use super::*;

    /// 建一个真实的技能目录沙箱，旁边放一个「机密」文件作为攻击目标。
    fn sandbox(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!("ah_traversal_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("skills").join("demo");
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("SKILL.md"), "# demo\n").unwrap();
        std::fs::write(root.join("scripts/a.py"), "print(1)\n").unwrap();
        // 技能目录之外的机密文件（与 root 同级）
        let secret = base.join("skills").join("SECRET.txt");
        std::fs::write(&secret, "TOP SECRET\n").unwrap();
        let outside = base.join("outside.txt");
        std::fs::write(&outside, "OUTSIDE\n").unwrap();
        (root, base)
    }

    /// 正常路径必须放行
    #[test]
    fn allows_legitimate_paths() {
        let (root, _b) = sandbox("ok");
        assert!(resolve_within(&root, "SKILL.md").is_ok());
        assert!(resolve_within(&root, "scripts/a.py").is_ok());
        // 反斜杠分隔也应可用（Windows 习惯写法）
        assert!(resolve_within(&root, r"scripts\a.py").is_ok());
    }

    /// 各种穿越/越权写法必须全部拒绝
    #[test]
    fn blocks_traversal_attempts() {
        let (root, base) = sandbox("block");
        let secret = base.join("skills").join("SECRET.txt");
        let outside = base.join("outside.txt");
        let secret_s = secret.to_string_lossy().replace('\\', "/");
        let outside_s = outside.to_string_lossy().replace('\\', "/");

        let attacks: Vec<String> = vec![
            // 相对穿越
            "../SECRET.txt".into(),
            "../../outside.txt".into(),
            "./../SECRET.txt".into(),
            "scripts/../../SECRET.txt".into(),
            "scripts/../../../outside.txt".into(),
            // 多层与混合分隔符
            // 反斜杠穿越（Windows 写法）
            r"..\SECRET.txt".into(),
            r"scripts\..\..\SECRET.txt".into(),
            r"scripts/..\../SECRET.txt".into(),
            // 绝对路径
            "/etc/passwd".into(),
            "C:/Windows/win.ini".into(),
            r"c:\Windows\win.ini".into(),
            // UNC
            "//server/share/x".into(),
            r"\\server\share\x".into(),
            // 绝对形式的机密文件路径
            secret_s.clone(),
            outside_s.clone(),
            // 空字节截断
            "SKILL.md\0.png".into(),
            // 空路径
            "".into(),
            "   ".into(),
        ];

        for a in &attacks {
            let r = resolve_within(&root, a);
            assert!(r.is_err(), "❌ 未拦截的穿越尝试: {a:?} → {r:?}");
        }
    }

    /// 目录本身不是文件，应拒绝
    #[test]
    fn rejects_directory() {
        let (root, _b) = sandbox("dir");
        let r = resolve_within(&root, "scripts");
        assert!(r.is_err(), "目录不应被当作文件: {r:?}");
    }

    /// 不存在的文件报错（而非 panic）
    #[test]
    fn missing_file_errors() {
        let (root, _b) = sandbox("missing");
        assert!(resolve_within(&root, "nope.txt").is_err());
    }

    /// 符号链接跳出技能目录时，canonicalize 后的前缀校验必须拦住。
    /// Windows 上创建符号链接需要权限，失败则跳过（不误报）。
    #[cfg(windows)]
    #[test]
    fn blocks_symlink_escape() {
        let (root, base) = sandbox("symlink");
        let outside = base.join("outside.txt");
        let link = root.join("escape.txt");
        // 用 std::os::windows::fs::symlink_file；无权限时跳过
        let created = std::os::windows::fs::symlink_file(&outside, &link).is_ok();
        if !created {
            eprintln!("skip: 无法创建符号链接（需要开发者模式/管理员）");
            return;
        }
        let r = resolve_within(&root, "escape.txt");
        assert!(r.is_err(), "❌ 符号链接跳出了技能目录却未被拦截: {r:?}");
    }
}

#[cfg(test)]
mod zip_tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("ah_zip_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_zip(path: &std::path::Path, entries: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<'_, '_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            w.start_file(*name, opts).unwrap();
            use std::io::Write;
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    /// 根目录直接就是技能 → 能定位到
    #[test]
    fn locates_root_level_skill() {
        let d = tmpdir("root");
        std::fs::write(d.join("SKILL.md"), "# s\n").unwrap();
        std::fs::create_dir_all(d.join("references")).unwrap();
        assert_eq!(locate_skill_root(&d), Some(d.clone()));
    }

    /// ZIP 内多一层目录（常见打包方式）→ 应向下找到
    #[test]
    fn locates_nested_skill() {
        let d = tmpdir("nested");
        let inner = d.join("apple-design-skill-1.7.6");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("SKILL.md"), "# s\n").unwrap();
        assert_eq!(locate_skill_root(&d), Some(inner));
    }

    /// 再深一层（repo-main/skills/xxx）也要能找到
    #[test]
    fn locates_deep_skill() {
        let d = tmpdir("deep");
        let inner = d.join("repo").join("skills").join("foo");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("SKILL.md"), "# s\n").unwrap();
        assert_eq!(locate_skill_root(&d), Some(inner));
    }

    /// 没有 SKILL.md → None（不是技能包）
    #[test]
    fn no_skill_returns_none() {
        let d = tmpdir("none");
        std::fs::create_dir_all(d.join("docs")).unwrap();
        std::fs::write(d.join("README.md"), "x").unwrap();
        assert_eq!(locate_skill_root(&d), None);
    }

    /// zip-slip：含 ../ 的条目必须被 enclosed_name 拒绝
    #[test]
    fn rejects_zip_slip_entries() {
        let d = tmpdir("slip");
        let z = d.join("evil.zip");
        make_zip(&z, &[("../evil.txt", "pwned"), ("SKILL.md", "# s\n")]);
        let f = std::fs::File::open(&z).unwrap();
        let mut ar = zip::ZipArchive::new(f).unwrap();
        let mut blocked = false;
        for i in 0..ar.len() {
            let e = ar.by_index(i).unwrap();
            if e.enclosed_name().is_none() {
                blocked = true;
            }
        }
        assert!(blocked, "含 ../ 的条目应被 enclosed_name 拒绝");
    }

    /// 含绝对路径的条目：enclosed_name() 会剥离根前缀，使其落到解压根之内
    /// （`/etc/passwd` → `etc/passwd`）。这不会逃出解压目录，因此是安全的；
    /// 真正危险的 `..` 穿越由上一个用例覆盖。
    #[test]
    fn absolute_entries_are_confined() {
        let d = tmpdir("abs");
        let z = d.join("abs.zip");
        make_zip(&z, &[("/etc/passwd", "x"), ("C:/Windows/win.ini", "y")]);
        let f = std::fs::File::open(&z).unwrap();
        let mut ar = zip::ZipArchive::new(f).unwrap();
        for i in 0..ar.len() {
            let e = ar.by_index(i).unwrap();
            let rel = e.enclosed_name().expect("绝对路径应被规范化为相对路径");
            assert!(!rel.is_absolute(), "规范化后不应是绝对路径: {rel:?}");
            assert!(
                !rel.components().any(|c| matches!(c, std::path::Component::ParentDir)),
                "规范化后不应含 ..: {rel:?}"
            );
            assert!(
                !rel.to_string_lossy().starts_with(['/', '\\']) && !rel.to_string_lossy().contains(':'),
                "规范化后不应含盘符/根前缀: {rel:?}"
            );
        }
    }

    /// 正常 ZIP 解压后内容完整
    #[test]
    fn extracts_content_correctly() {
        let d = tmpdir("ok");
        let z = d.join("ok.zip");
        make_zip(&z, &[("SKILL.md", "# demo\n"), ("references/a.md", "ref\n")]);
        let f = std::fs::File::open(&z).unwrap();
        let mut ar = zip::ZipArchive::new(f).unwrap();
        let mut names: Vec<String> = Vec::new();
        for i in 0..ar.len() {
            let e = ar.by_index(i).unwrap();
            names.push(e.enclosed_name().unwrap().to_string_lossy().replace('\\', "/"));
        }
        assert!(names.contains(&"SKILL.md".to_string()));
        assert!(names.contains(&"references/a.md".to_string()));
    }
}
