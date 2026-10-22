//! Skills 预设（skill-presets）：命名 skills 集合的存储、CRUD 与按预设导出 zip。
//!
//! 存储：`data_root()/presets.json`，结构 `{ "presets": Preset[] }`。
//! 写入一律「读-改-写 + 临时文件后替换」；读取失败（JSON 损坏/结构不符）直接报错，
//! 绝不静默重置为空 —— 损坏时任何写入都会被拒绝，原文件保持不变。
//!
//! 导出口径：不做规范化校验（不调用 `check_pack_ready`），直接按目录复制内容；
//! 仅当成员技能目录不存在时跳过，并在结果里汇总原因。

use crate::ahub::models::{new_id, now_iso};
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 预设：命名的 skills 集合（引用 `data_root()/skills/<dirName>`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub skill_dir_names: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// presets.json 的整体结构。`presets` 故意不给 `#[serde(default)]`：
/// 缺这个键属于「结构不符」，必须报错而不是当成空列表。
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PresetFile {
    presets: Vec<Preset>,
}

/// 一次导出的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    /// 生成的 zip 路径；全部成员失效时为空串（不生成压缩包）
    pub zip_path: String,
    /// 成功导出的技能目录名
    pub exported: Vec<String>,
    /// 跳过的失效成员
    pub skipped: Vec<SkippedMember>,
}

/// 一个被跳过的成员。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedMember {
    pub dir_name: String,
    /// 机器可读原因：`missing`（技能目录不存在）/ `invalid`（目录名非法）
    pub reason: String,
}

// ---------------- 错误码 ----------------
//
// 后端错误统一以「码: 人话」形式返回，前端按码翻成当前界面语言；
// 没有对应码的（IO 等）原样展示。

fn err(code: &str, detail: &str) -> String {
    if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}: {detail}")
    }
}

fn err_name_required() -> String {
    err("preset.nameRequired", "预设名称不能为空")
}

fn err_name_dup(name: &str) -> String {
    err("preset.nameDuplicate", &format!("预设名称已存在：{name}"))
}

fn err_not_found(id: &str) -> String {
    err("preset.notFound", &format!("预设不存在：{id}"))
}

fn err_corrupt(path: &Path, detail: &str) -> String {
    // 前端按 `path|原因` 拆开：路径要展示给用户，原因（serde 报错）原样附在后面
    err("preset.corrupt", &format!("{}|{detail}", path.display()))
}

// ---------------- 路径与读写 ----------------

fn presets_path(root: &Path) -> PathBuf {
    root.join("presets.json")
}

fn norm_name(n: &str) -> String {
    n.trim().to_lowercase()
}

fn read_at(root: &Path) -> Result<Vec<Preset>, String> {
    let path = presets_path(root);
    if !path.is_file() {
        // 首次使用：没有文件 = 没有预设，不报错也不创建文件
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| err("preset.io", &e.to_string()))?;
    let file: PresetFile =
        serde_json::from_str(&text).map_err(|e| err_corrupt(&path, &e.to_string()))?;
    Ok(file.presets)
}

fn write_at(root: &Path, presets: &[Preset]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(store::es)?;
    let path = presets_path(root);
    // 先写临时文件再替换：写入中途失败时原文件不受影响
    let tmp = root.join(format!("presets.json.tmp-{}", new_id()));
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

/// 名称唯一性：忽略大小写、去首尾空格；`exclude` 用于重命名时排除自身。
fn ensure_unique(presets: &[Preset], name: &str, exclude: Option<&str>) -> Result<(), String> {
    let target = norm_name(name);
    let hit = presets.iter().any(|p| {
        Some(p.id.as_str()) != exclude && norm_name(&p.name) == target
    });
    if hit {
        return Err(err_name_dup(name.trim()));
    }
    Ok(())
}

/// 成员去重（去首尾空格、丢弃空项、保持首次出现顺序）
fn dedupe(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && seen.insert(n.clone()))
        .collect()
}

// ---------------- 公开 API（挂在 AppHandle 上） ----------------

pub fn list(app: &AppH) -> Result<Vec<Preset>, String> {
    list_at(&store::data_root(app))
}

pub fn create(
    app: &AppH,
    name: &str,
    description: &str,
    skill_dir_names: Vec<String>,
) -> Result<Preset, String> {
    create_at(
        &store::data_root(app),
        name,
        description,
        skill_dir_names,
    )
}

pub fn update(
    app: &AppH,
    id: &str,
    name: Option<String>,
    description: Option<String>,
    skill_dir_names: Option<Vec<String>>,
) -> Result<Preset, String> {
    update_at(
        &store::data_root(app),
        id,
        name,
        description,
        skill_dir_names,
    )
}

pub fn delete(app: &AppH, id: &str) -> Result<(), String> {
    delete_at(&store::data_root(app), id)
}

pub fn export(app: &AppH, id: &str, target_dir: &str) -> Result<ExportOutcome, String> {
    export_at(&store::data_root(app), id, target_dir)
}

// ---------------- 以 root 为参数的实现（便于在临时目录上测试） ----------------

fn list_at(root: &Path) -> Result<Vec<Preset>, String> {
    read_at(root)
}

fn create_at(
    root: &Path,
    name: &str,
    description: &str,
    skill_dir_names: Vec<String>,
) -> Result<Preset, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(err_name_required());
    }
    let mut presets = read_at(root)?;
    ensure_unique(&presets, name, None)?;
    let ts = now_iso();
    let preset = Preset {
        id: new_id(),
        name: name.to_string(),
        description: description.trim().to_string(),
        skill_dir_names: dedupe(skill_dir_names),
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
    skill_dir_names: Option<Vec<String>>,
) -> Result<Preset, String> {
    let mut presets = read_at(root)?;
    let idx = presets
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| err_not_found(id))?;

    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() {
            return Err(err_name_required());
        }
        // 重命名：排除自身再判重，否则「只改描述」会被误判
        ensure_unique(&presets, &n, Some(id))?;
        presets[idx].name = n;
    }
    if let Some(d) = description {
        presets[idx].description = d.trim().to_string();
    }
    if let Some(m) = skill_dir_names {
        presets[idx].skill_dir_names = dedupe(m);
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
        return Err(err_not_found(id));
    }
    write_at(root, &presets)
}

/// 预设名 → 安全的文件名 / zip 内根目录名。
/// Windows 非法字符（`\ / : * ? " < > |`）替换为 `_`。
fn sanitize_name(name: &str) -> String {
    const BAD: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let mut out: String = name
        .chars()
        .map(|c| if BAD.contains(&c) { '_' } else { c })
        .collect();
    // Windows 不接受结尾的空格与点
    out = out.trim().trim_end_matches('.').trim().to_string();
    if out.is_empty() {
        out = "preset".into();
    }
    out
}

/// 目标目录里已有同名文件时追加序号：`name-2.zip`、`name-3.zip`…
fn free_zip_path(target: &Path, base: &str) -> PathBuf {
    let first = target.join(format!("{base}.zip"));
    if !first.exists() {
        return first;
    }
    for n in 2..10_000 {
        let p = target.join(format!("{base}-{n}.zip"));
        if !p.exists() {
            return p;
        }
    }
    first
}

fn valid_dir_name(n: &str) -> bool {
    !n.is_empty()
        && n != "."
        && n != ".."
        && !n.contains('/')
        && !n.contains('\\')
        && !n.contains(':')
}

fn export_at(root: &Path, id: &str, target_dir: &str) -> Result<ExportOutcome, String> {
    let presets = read_at(root)?;
    let preset = presets
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| err_not_found(id))?
        .clone();

    let target = PathBuf::from(target_dir.trim());
    if !target.is_dir() {
        return Err(err("preset.targetMissing", "导出目标目录不存在"));
    }

    let skills_root = root.join("skills");
    let zip_root = sanitize_name(&preset.name);

    // 先确定成员：目录不存在的进 skipped，其余进入待打包列表
    let mut exported: Vec<String> = Vec::new();
    let mut skipped: Vec<SkippedMember> = Vec::new();
    let mut members: Vec<&String> = Vec::new();
    for dir_name in &preset.skill_dir_names {
        if !valid_dir_name(dir_name) {
            skipped.push(SkippedMember {
                dir_name: dir_name.clone(),
                reason: "invalid".into(),
            });
            continue;
        }
        if !skills_root.join(dir_name).is_dir() {
            skipped.push(SkippedMember {
                dir_name: dir_name.clone(),
                reason: "missing".into(),
            });
            continue;
        }
        members.push(dir_name);
    }

    // 全部成员失效：不生成压缩包，把原因汇总回前端
    if members.is_empty() {
        return Ok(ExportOutcome {
            zip_path: String::new(),
            exported,
            skipped,
        });
    }

    let zip_path = free_zip_path(&target, &zip_root);
    let opts: zip::write::FileOptions<'_, '_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    if let Err(e) = write_preset_zip(&zip_path, &zip_root, &preset, &members, &skipped, &skills_root, opts) {
        // 半成品压缩包不留下
        let _ = std::fs::remove_file(&zip_path);
        return Err(e);
    }
    exported.extend(members.iter().map(|d| (*d).clone()));

    Ok(ExportOutcome {
        zip_path: zip_path.to_string_lossy().into_owned(),
        exported,
        skipped,
    })
}

/// 写出一个预设压缩包：`<zip-root>/preset.json` + `<zip-root>/<skill-dir>/...`
fn write_preset_zip(
    zip_path: &Path,
    zip_root: &str,
    preset: &Preset,
    members: &[&String],
    skipped: &[SkippedMember],
    skills_root: &Path,
    opts: zip::write::FileOptions<'_, '_, ()>,
) -> Result<(), String> {
    use std::io::Write as _;

    let file = std::fs::File::create(zip_path).map_err(|e| err("preset.io", &e.to_string()))?;
    let mut zip = zip::ZipWriter::new(file);

    // 1) preset.json：预设元信息 + 成员清单
    let mut member_rows: Vec<serde_json::Value> = Vec::new();
    for d in members {
        member_rows.push(serde_json::json!({
            "dirName": d,
            "exported": true,
        }));
    }
    for s in skipped {
        member_rows.push(serde_json::json!({
            "dirName": s.dir_name,
            "exported": false,
            "reason": s.reason,
        }));
    }
    let meta = serde_json::json!({
        "id": preset.id,
        "name": preset.name,
        "description": preset.description,
        "skillDirNames": preset.skill_dir_names,
        "createdAt": preset.created_at,
        "updatedAt": preset.updated_at,
        "exportedAt": now_iso(),
        "members": member_rows,
    });
    let meta_text = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    zip.start_file(format!("{zip_root}/preset.json"), opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(meta_text.as_bytes()).map_err(store::es)?;

    // 2) 成员技能目录（直接复制，不做规范化校验）
    for dir_name in members {
        let src = skills_root.join(dir_name);
        let prefix = format!("{zip_root}/{dir_name}");
        add_dir_to_zip(&mut zip, &src, &prefix, opts)?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// 递归把一个目录的内容写进 zip（zip 内路径统一用 `/`）。
fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    src: &Path,
    zip_prefix: &str,
    opts: zip::write::FileOptions<'_, '_, ()>,
) -> Result<(), String> {
    use std::io::Write as _;

    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(src)
        .map_err(store::es)?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let zip_name = format!("{zip_prefix}/{name}");
        if path.is_dir() {
            add_dir_to_zip(zip, &path, &zip_name, opts)?;
        } else if path.is_file() {
            let data = std::fs::read(&path).map_err(store::es)?;
            zip.start_file(zip_name, opts).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(store::es)?;
        }
    }
    Ok(())
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ah_presets_{}_{}", tag, new_id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed(root: &Path, name: &str) -> Preset {
        create_at(root, name, "", Vec::new()).unwrap()
    }

    #[test]
    fn missing_file_means_no_presets() {
        let d = tmpdir("empty");
        assert!(list_at(&d).unwrap().is_empty());
        assert!(!d.join("presets.json").exists(), "不应自动创建文件");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn create_writes_file_with_all_fields() {
        let d = tmpdir("create");
        let p = create_at(&d, "  前端  ", "常用前端技能", vec!["a".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(p.name, "前端", "名称应 trim");
        assert_eq!(p.description, "常用前端技能");
        assert_eq!(p.skill_dir_names, vec!["a".to_string(), "b".to_string()], "成员应去重");
        assert!(!p.created_at.is_empty() && !p.updated_at.is_empty());

        let text = std::fs::read_to_string(d.join("presets.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let arr = v.get("presets").and_then(|x| x.as_array()).unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0].get("id").and_then(|x| x.as_str()), Some(p.id.as_str()));
        assert_eq!(arr[0].get("skillDirNames").and_then(|x| x.as_array()).unwrap().len(), 2);
        assert!(arr[0].get("createdAt").is_some() && arr[0].get("updatedAt").is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn duplicate_name_rejected_case_and_space_insensitive() {
        let d = tmpdir("dup");
        seed(&d, "Frontend");
        // 大小写不同
        assert!(create_at(&d, "frontend", "", Vec::new()).is_err());
        // 前后空格不同
        assert!(create_at(&d, "  Frontend  ", "", Vec::new()).is_err());
        // 原预设未被覆盖
        let all = list_at(&d).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Frontend");
        // 不同名可创建
        assert!(create_at(&d, "Backend", "", Vec::new()).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rename_dedupes_but_excludes_self() {
        let d = tmpdir("rename");
        let a = seed(&d, "前端");
        let b = seed(&d, "后端");

        // 只改描述：名称与自身相同不算重复
        let u = update_at(&d, &a.id, Some("前端".into()), Some("新描述".into()), None).unwrap();
        assert_eq!(u.name, "前端");
        assert_eq!(u.description, "新描述");

        // 改成别人的名字 → 报错
        let e = update_at(&d, &b.id, Some(" 前端 ".into()), None, None).unwrap_err();
        assert!(e.starts_with("preset.nameDuplicate"), "{e}");
        // 名字没被改掉
        assert_eq!(list_at(&d).unwrap().iter().find(|p| p.id == b.id).unwrap().name, "后端");

        // 大小写变化但仍是自己的名字 → 允许
        assert!(update_at(&d, &b.id, Some("BACKEND".into()), None, None).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_name_rejected() {
        let d = tmpdir("noname");
        assert!(create_at(&d, "   ", "", Vec::new()).is_err());
        assert!(!d.join("presets.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn update_members_and_delete() {
        let d = tmpdir("members");
        let p = create_at(&d, "组", "", vec!["a".into()]).unwrap();
        let u = update_at(&d, &p.id, None, None, Some(vec!["b".into(), "c".into()])).unwrap();
        assert_eq!(u.skill_dir_names, vec!["b".to_string(), "c".to_string()]);
        // 允许清空成员
        let u = update_at(&d, &p.id, None, None, Some(Vec::new())).unwrap();
        assert!(u.skill_dir_names.is_empty());
        // 删除
        delete_at(&d, &p.id).unwrap();
        assert!(list_at(&d).unwrap().is_empty());
        // 再删一次 → 不存在
        assert!(delete_at(&d, &p.id).unwrap_err().starts_with("preset.notFound"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_file_errors_and_stays_untouched() {
        let d = tmpdir("corrupt");
        let path = d.join("presets.json");
        std::fs::write(&path, "{ not json").unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        let e = list_at(&d).unwrap_err();
        assert!(e.starts_with("preset.corrupt"), "{e}");
        assert!(e.contains("presets.json"), "错误里要带路径：{e}");

        // 写入必须被拒绝，且文件内容不变
        assert!(create_at(&d, "任意", "", Vec::new()).is_err());
        assert!(delete_at(&d, "x").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // 修复后恢复正常读取，无需重启
        std::fs::write(&path, r#"{ "presets": [] }"#).unwrap();
        assert!(list_at(&d).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_presets_key_is_corrupt() {
        let d = tmpdir("nokey");
        std::fs::write(d.join("presets.json"), r#"{ "items": [] }"#).unwrap();
        assert!(list_at(&d).unwrap_err().starts_with("preset.corrupt"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sanitize_replaces_windows_illegal_chars() {
        assert_eq!(sanitize_name("a/b:c*d?e\"f<g>h|i\\j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_name("前端 / 后端"), "前端 _ 后端");
        assert_eq!(sanitize_name("  "), "preset");
        assert_eq!(sanitize_name("名字."), "名字");
    }

    #[test]
    fn export_skips_missing_members_and_builds_zip() {
        let d = tmpdir("export");
        let skills = d.join("skills");
        for name in ["skill-a", "skill-b"] {
            std::fs::create_dir_all(skills.join(name).join("references")).unwrap();
            std::fs::write(skills.join(name).join("SKILL.md"), format!("# {name}\n")).unwrap();
            std::fs::write(skills.join(name).join("references/x.md"), "x").unwrap();
        }
        let p = create_at(
            &d,
            "前端组",
            "描述",
            vec!["skill-a".into(), "ghost".into(), "skill-b".into()],
        )
        .unwrap();

        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let r = export_at(&d, &p.id, &out.to_string_lossy()).unwrap();

        assert_eq!(r.exported, vec!["skill-a".to_string(), "skill-b".to_string()]);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].dir_name, "ghost");
        assert_eq!(r.skipped[0].reason, "missing");
        assert!(r.zip_path.ends_with("前端组.zip"), "{}", r.zip_path);
        assert!(PathBuf::from(&r.zip_path).is_file());

        // zip 结构：<preset-name>/preset.json + <preset-name>/<skill-dir>/...
        let f = std::fs::File::open(&r.zip_path).unwrap();
        let mut ar = zip::ZipArchive::new(f).unwrap();
        let mut names: Vec<String> = (0..ar.len())
            .map(|i| ar.by_index(i).unwrap().name().unwrap_or_default().to_string())
            .collect();
        names.sort();
        assert!(names.contains(&"前端组/preset.json".to_string()), "{names:?}");
        assert!(names.contains(&"前端组/skill-a/SKILL.md".to_string()), "{names:?}");
        assert!(names.contains(&"前端组/skill-a/references/x.md".to_string()), "{names:?}");
        assert!(names.contains(&"前端组/skill-b/SKILL.md".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("ghost")), "失效成员不该进包");

        // preset.json 元信息
        let mut meta = String::new();
        {
            use std::io::Read as _;
            ar.by_name("前端组/preset.json").unwrap().read_to_string(&mut meta).unwrap();
        }
        let v: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(v["name"], "前端组");
        assert_eq!(v["description"], "描述");
        assert!(v["exportedAt"].as_str().unwrap().len() > 0);
        assert_eq!(v["members"].as_array().unwrap().len(), 3);
        let ghost = v["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["dirName"] == "ghost")
            .unwrap();
        assert_eq!(ghost["exported"], false);
        assert_eq!(ghost["reason"], "missing");

        // 预设本身未被导出改动
        assert_eq!(list_at(&d).unwrap()[0].skill_dir_names.len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn export_all_members_missing_writes_no_zip() {
        let d = tmpdir("export-none");
        std::fs::create_dir_all(d.join("skills")).unwrap();
        let p = create_at(&d, "空组", "", vec!["nope".into()]).unwrap();
        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();

        let r = export_at(&d, &p.id, &out.to_string_lossy()).unwrap();
        assert!(r.zip_path.is_empty(), "不该生成压缩包");
        assert!(r.exported.is_empty());
        assert_eq!(r.skipped.len(), 1);
        assert!(std::fs::read_dir(&out).unwrap().next().is_none(), "目标目录应保持空");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn export_sanitizes_name_and_avoids_overwrite() {
        let d = tmpdir("export-name");
        std::fs::create_dir_all(d.join("skills/a")).unwrap();
        std::fs::write(d.join("skills/a/SKILL.md"), "# a\n").unwrap();
        let p = create_at(&d, "a/b:c", "", vec!["a".into()]).unwrap();
        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();

        let r1 = export_at(&d, &p.id, &out.to_string_lossy()).unwrap();
        assert!(r1.zip_path.ends_with("a_b_c.zip"), "{}", r1.zip_path);
        // 再导一次：同名文件已存在 → 追加序号
        let r2 = export_at(&d, &p.id, &out.to_string_lossy()).unwrap();
        assert!(r2.zip_path.ends_with("a_b_c-2.zip"), "{}", r2.zip_path);

        // zip 内根目录同样用 sanitize 后的名字
        let f = std::fs::File::open(&r1.zip_path).unwrap();
        let mut ar = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..ar.len())
            .map(|i| ar.by_index(i).unwrap().name().unwrap_or_default().to_string())
            .collect();
        assert!(names.contains(&"a_b_c/preset.json".to_string()), "{names:?}");
        assert!(names.contains(&"a_b_c/a/SKILL.md".to_string()), "{names:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn export_unknown_preset_errors() {
        let d = tmpdir("export-404");
        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let e = export_at(&d, "no-such-id", &out.to_string_lossy()).unwrap_err();
        assert!(e.starts_with("preset.notFound"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
