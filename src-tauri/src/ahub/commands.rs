use crate::ahub::harness::{self, ApplyResult, HarnessReport, ImportResult, ImportSelection, PreImportResult};
use crate::ahub::items;
use crate::ahub::models::*;
use crate::ahub::skills;
use crate::ahub::store::{self, AppH};
use serde_json::Value;

#[tauri::command]
pub fn get_settings(app: AppH) -> Result<SettingsInfo, String> {
    // 首次加载时把旧三字段迁移为「自定义」提供商（幂等：已有提供商时不动）
    if let Err(e) = crate::ahub::aiprovider::migrate_legacy(&app) {
        eprintln!("[agenthub] AI 提供商迁移失败：{e}");
    }
    Ok(store::settings_info(&app))
}

// 命令名冲突：云台已有 `set_data_dir`（改云台自己的数据目录）。
// 这里改名，前端 lib/api.ts 的调用点同步改名。
#[tauri::command]
pub fn ahub_set_data_dir(app: AppH, path: String) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    s.data_dir = path.trim().to_string();
    store::save_settings(&app, &s)?;
    store::ensure_layout(&store::data_root(&app))?;
    Ok(store::settings_info(&app))
}

#[tauri::command]
pub fn set_prefs(app: AppH, language: Option<String>, theme: Option<String>) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    if let Some(l) = language {
        s.language = l;
    }
    if let Some(t) = theme {
        s.theme = t;
    }
    store::save_settings(&app, &s)?;
    Ok(store::settings_info(&app))
}

#[tauri::command]
pub fn set_harness_order(app: AppH, order: Vec<String>) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    s.harness_order = order;
    store::save_settings(&app, &s)?;
    Ok(store::settings_info(&app))
}

#[tauri::command]
pub fn add_skill_source_dir(app: AppH, path: String) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    if !s.skill_source_dirs.contains(&path) {
        s.skill_source_dirs.push(path);
        store::save_settings(&app, &s)?;
    }
    Ok(store::settings_info(&app))
}

#[tauri::command]
pub fn remove_skill_source_dir(app: AppH, path: String) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    s.skill_source_dirs.retain(|x| x != &path);
    store::save_settings(&app, &s)?;
    Ok(store::settings_info(&app))
}

#[tauri::command]
pub fn list_prompts(app: AppH) -> Result<Vec<Prompt>, String> {
    items::list_prompts(&app)
}

#[tauri::command]
pub fn save_prompt(app: AppH, prompt: Prompt, publish: Option<bool>) -> Result<Prompt, String> {
    items::save_prompt(&app, prompt, publish.unwrap_or(false))
}

#[tauri::command]
pub fn delete_prompt(app: AppH, id: String) -> Result<(), String> {
    items::delete_prompt(&app, &id)
}

#[tauri::command]
pub fn list_mcp(app: AppH) -> Result<Vec<McpServer>, String> {
    items::list_mcp(&app)
}

#[tauri::command]
pub fn save_mcp(app: AppH, server: McpServer) -> Result<McpServer, String> {
    items::save_mcp(&app, server)
}

#[tauri::command]
pub fn delete_mcp(app: AppH, id: String) -> Result<(), String> {
    items::delete_mcp(&app, &id)
}

#[tauri::command]
pub fn export_mcp_config(app: AppH, ids: Vec<String>) -> Result<Value, String> {
    let all = items::list_mcp(&app)?;
    let selected: Vec<McpServer> = if ids.is_empty() {
        all
    } else {
        all.into_iter().filter(|s| ids.contains(&s.id)).collect()
    };
    Ok(items::export_config(&selected))
}

#[tauri::command]
pub fn list_skills(app: AppH) -> Result<Vec<SkillMeta>, String> {
    skills::list_skills(&app)
}

#[tauri::command]
pub fn read_skill(app: AppH, dir_name: String) -> Result<SkillDoc, String> {
    skills::read_skill(&app, &dir_name)
}

#[tauri::command]
pub fn save_skill(app: AppH, payload: SkillSavePayload) -> Result<SkillMeta, String> {
    skills::save_skill(&app, payload)
}

/// 从 ZIP 包导入技能（自动解压，支持内含一层根目录）
#[tauri::command]
pub async fn import_skill_zip(app: AppH, path: String, overwrite: bool) -> Result<SkillMeta, String> {
    let name = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let path = path.clone();
        move || skills::import_skill_zip(&app, &path, overwrite)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    let meta = skills::read_skill(&app, &name)?;
    Ok(meta.meta)
}

#[tauri::command]
pub fn import_skill_folder(app: AppH, path: String, overwrite: bool) -> Result<SkillMeta, String> {
    let src = std::path::PathBuf::from(&path);
    if !src.is_dir() {
        return Err("所选路径不是文件夹".into());
    }
    let name = skills::import_skill_dir(&app, &src, overwrite)?;
    let meta = skills::read_skill(&app, &name)?;
    Ok(meta.meta)
}

#[tauri::command]
pub fn delete_skill(app: AppH, dir_name: String) -> Result<(), String> {
    skills::delete_skill(&app, &dir_name)
}

#[tauri::command]
pub fn clear_skill_versions(app: AppH, dir_name: String) -> Result<u32, String> {
    skills::clear_skill_versions(&app, &dir_name)
}

#[tauri::command]
pub fn release_skill_version(
    app: AppH,
    dir_name: String,
    level: String,
    note: String,
) -> Result<serde_json::Value, String> {
    let (version, snapshot) = skills::release_version(&app, &dir_name, &level, &note)?;
    Ok(serde_json::json!({ "version": version, "snapshot": snapshot }))
}

#[tauri::command]
pub fn ensure_skill_protocol(app: AppH, dir_name: String) -> Result<serde_json::Value, String> {
    let (created, version) = skills::ensure_protocol(&app, &dir_name)?;
    Ok(serde_json::json!({ "created": created, "version": version }))
}

#[tauri::command]
pub async fn scan_harnesses(app: AppH) -> Result<Vec<HarnessReport>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(harness::scan(&app)))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}
#[tauri::command]
pub fn import_from_harness(
    app: AppH,
    harness: String,
    kind: String,
    selections: Vec<ImportSelection>,
) -> Result<ImportResult, String> {
    Ok(harness::import(&app, &harness, &kind, &selections))
}

#[tauri::command]
pub fn pre_import(app: AppH, harness: String, kind: String, names: Vec<String>) -> Result<PreImportResult, String> {
    Ok(harness::pre_import(&app, &harness, &kind, &names))
}

#[tauri::command]
pub fn apply_to_harness(app: AppH, harness: String, kind: String, names: Vec<String>) -> Result<ApplyResult, String> {
    Ok(harness::apply(&app, &harness, &kind, &names))
}

#[tauri::command]
pub fn read_harness_config(app: AppH, harness: String) -> Result<Value, String> {
    harness::read_config(&app, &harness)
}

#[tauri::command]
pub fn write_harness_config(app: AppH, harness: String, text: String) -> Result<Value, String> {
    harness::write_config(&app, &harness, &text)
}

#[tauri::command]
pub fn merge_harness_config(app: AppH, harness: String, text: String, json: String) -> Result<String, String> {
    harness::merge_mcp_json(&app, &harness, &text, &json)
}

#[tauri::command]
pub fn remove_from_harness(app: AppH, harness: String, kind: String, names: Vec<String>) -> Result<ApplyResult, String> {
    if kind != "mcp" {
        return Err("仅支持 MCP 条目移除".into());
    }
    Ok(harness::remove_mcp(&app, &harness, &names))
}

/// 技能目录树
#[tauri::command]
pub fn list_skill_files(app: AppH, dir_name: String) -> Result<crate::ahub::models::SkillFileNode, String> {
    skills::list_skill_files(&app, &dir_name)
}

/// 读取技能内的文件（实时阅读）
#[tauri::command]
pub fn read_skill_file(app: AppH, dir_name: String, rel_path: String) -> Result<crate::ahub::models::SkillFileContent, String> {
    skills::read_skill_file(&app, &dir_name, &rel_path)
}

/// 用系统默认程序打开技能内的某个文件（PDF / Word / 表格等无法内联预览的类型）。
/// 由后端拼绝对路径并做目录穿越校验，避免前端依赖本机路径分隔符。
#[tauri::command]
pub fn open_skill_file(app: AppH, dir_name: String, rel_path: String) -> Result<(), String> {
    let p = skills::resolve_skill_file(&app, &dir_name, &rel_path)?;
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())
}

/// 用系统默认程序打开任意路径（用于打开导出目录等）
// 命令名冲突：云台已有 `open_path`（sys）。这里改名，前端调用点同步改名。
#[tauri::command]
pub fn ahub_open_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
    } else if let Some(parent) = p.parent() {
        crate::ahub::store::silent_command("explorer")
            .arg(parent)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        Err("路径不存在".into())
    }
}

#[tauri::command]
pub fn storage_stats(app: AppH) -> Result<StorageStats, String> {
    let root = store::data_root(&app);
    let count_json = |dir: std::path::PathBuf| -> usize {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
                    .count()
            })
            .unwrap_or(0)
    };
    let count_dirs = |dir: std::path::PathBuf| -> usize {
        std::fs::read_dir(dir)
            .map(|entries| entries.flatten().filter(|e| e.path().is_dir()).count())
            .unwrap_or(0)
    };
    Ok(StorageStats {
        prompts: count_json(root.join("prompts")),
        mcp: count_json(root.join("mcp")),
        skills: count_dirs(root.join("skills")),
        total_bytes: store::dir_size(&root),
    })
}

#[tauri::command]
pub fn skill_extension(app: AppH, dir_name: String) -> Result<serde_json::Value, String> {
    use crate::ahub::skill_toml;
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    let doc = skill_toml::load(&dir).map(|v| serde_json::to_value(&v).unwrap_or(serde_json::Value::Null));
    let violations = skill_toml::validate(&dir)?;
    let tree_hash = skill_toml::tree_hash(&dir).unwrap_or_default();
    Ok(serde_json::json!({
        "doc": doc,
        "stale": skill_toml::is_stale(&dir),
        "treeHash": tree_hash,
        "violations": violations,
        "hasToml": doc.is_some(),
    }))
}

#[tauri::command]
pub fn set_skill_status(app: AppH, dir_name: String, status: String, superseded_by: String) -> Result<SkillMeta, String> {
    use crate::ahub::skill_toml;
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    skill_toml::set_status(&dir, &status, &superseded_by)?;
    skills::read_skill(&app, &dir_name).map(|d| d.meta)
}

/// 批量打包为规范 .skillpack，并在输出目录生成 index.json。
#[tauri::command]
pub async fn pack_skills_batch(
    app: AppH,
    dir_names: Vec<String>,
    out_dir: String,
) -> Result<crate::ahub::models::PackBatchReport, String> {
    tauri::async_runtime::spawn_blocking(move || skills::pack_many(&app, &dir_names, &out_dir))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 打包前的规范性预检（不写盘），用于前端提前提示
// ---------------- Skills 预设（skill-presets） ----------------

#[tauri::command]
pub fn preset_list(app: AppH) -> Result<Vec<crate::ahub::presets::Preset>, String> {
    crate::ahub::presets::list(&app)
}

#[tauri::command]
pub fn preset_create(
    app: AppH,
    name: String,
    description: String,
    skill_dir_names: Vec<String>,
) -> Result<crate::ahub::presets::Preset, String> {
    crate::ahub::presets::create(&app, &name, &description, skill_dir_names)
}

#[tauri::command]
pub fn preset_update(
    app: AppH,
    id: String,
    name: Option<String>,
    description: Option<String>,
    skill_dir_names: Option<Vec<String>>,
) -> Result<crate::ahub::presets::Preset, String> {
    crate::ahub::presets::update(&app, &id, name, description, skill_dir_names)
}

#[tauri::command]
pub fn preset_delete(app: AppH, id: String) -> Result<(), String> {
    crate::ahub::presets::delete(&app, &id)
}

#[tauri::command]
pub async fn preset_export(
    app: AppH,
    id: String,
    target_dir: String,
) -> Result<crate::ahub::presets::ExportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::presets::export(&app, &id, &target_dir))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub fn check_pack_ready(app: AppH, dir_name: String) -> Result<Vec<String>, String> {
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    crate::ahub::skill_toml::check_pack_ready(&dir).map(|(_, _, w)| w)
}

#[tauri::command]
pub fn pack_skill(app: AppH, dir_name: String, out_dir: String) -> Result<String, String> {
    use crate::ahub::skill_toml;
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    let out = std::path::PathBuf::from(&out_dir);
    if !out.is_dir() {
        return Err("输出目录不存在".into());
    }
    skill_toml::pack(&dir, &out).map(|p| p.to_string_lossy().into_owned())
}

/// 读取某技能的审查报告（含逐条发现 + 人工复审状态）。
#[tauri::command]
pub fn read_vet_report(app: AppH, dir_name: String) -> Result<Option<crate::ahub::models::VetReportRow>, String> {
    skills::read_vet_report(&app, &dir_name)
}

/// 人工复审：忽略 / 恢复单条发现。返回 (待复核数, 已忽略数)。
#[tauri::command]
pub fn review_vet_finding(
    app: AppH,
    dir_name: String,
    rule: String,
    file: String,
    line: usize,
    ignored: bool,
) -> Result<(u32, u32), String> {
    skills::review_finding(&app, &dir_name, &rule, &file, line, ignored)
}

/// 人工复审：忽略全部未忽略的发现。返回忽略条数。
#[tauri::command]
pub fn ignore_all_vet_findings(app: AppH, dir_name: String) -> Result<u32, String> {
    skills::ignore_all_findings(&app, &dir_name)
}

/// 人工复审：给出整体复核结论（approved / rejected / 空 = 清除）。
#[tauri::command]
pub fn set_vet_review(app: AppH, dir_name: String, verdict: String, note: String) -> Result<(), String> {
    skills::set_review_verdict(&app, &dir_name, &verdict, &note)
}

/// 一键为技能生成 SKILL.toml 并自动安全审查（批量）。
#[tauri::command]
pub async fn onboard_skills_batch(
    app: AppH,
    dir_names: Vec<String>,
    only_missing: bool,
    vet: bool,
) -> Result<crate::ahub::models::OnboardReport, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(skills::onboard_many(&app, &dir_names, only_missing, vet)))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 为技能补一条初始版本快照（用于把历史技能纳入版本管理）。
/// 一次性修复历史遗留的 tags 畸形数据（如 '["自习"]'）。
#[tauri::command]
pub fn repair_skill_tags(app: AppH) -> Result<serde_json::Value, String> {
    let (fixed, detail) = skills::repair_tags(&app)?;
    Ok(serde_json::json!({ "fixed": fixed, "skills": detail }))
}

#[tauri::command]
pub fn seed_skill_version(app: AppH, dir_name: String, note: String) -> Result<bool, String> {
    skills::seed_version(&app, &dir_name, &note)
}

#[tauri::command]
pub fn vet_skill(app: AppH, dir_name: String) -> Result<serde_json::Value, String> {
    use crate::ahub::{skill_toml, vet};
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    let report = vet::run(&dir)?;
    skill_toml::load(&dir)  // 仅当已接入协议时写回 [vet]
        .ok_or("该技能尚未接入 SKILL.toml 协议：请先在编辑中保存一次")?;
    vet::write_vet(&dir, &report)?;
    // 明细落盘，供人工复审逐条处置
    let _ = skills::save_vet_report(&app, &dir_name, &report);
    Ok(serde_json::to_value(&report).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn install_skillpack(app: AppH, path: String, overwrite: bool) -> Result<crate::ahub::install::InstallReport, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::install::install_skillpack(std::path::Path::new(&path), &crate::ahub::store::data_root(&app).join("skills"), overwrite))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

#[allow(dead_code)]
fn install_skillpack_blocking(app: AppH, path: String, overwrite: bool) -> Result<crate::ahub::install::InstallReport, String> {
    let pack = std::path::PathBuf::from(&path);
    if !pack.is_dir() {
        return Err("所选路径不是文件夹".into());
    }
    let hub = store::data_root(&app).join("skills");
    crate::ahub::install::install_skillpack(&pack, &hub, overwrite)
}

#[tauri::command]
pub fn parse_skill_index(path: String) -> Result<crate::ahub::registry::ResolvedIndex, String> {
    crate::ahub::registry::parse_index(std::path::Path::new(&path))
}

#[tauri::command]
pub fn install_from_index(
    app: AppH,
    path: String,
    name: String,
    version: String,
    overwrite: bool,
) -> Result<crate::ahub::install::InstallReport, String> {
    let hub = store::data_root(&app).join("skills");
    crate::ahub::registry::install_from_index(std::path::Path::new(&path), &name, &version, &hub, overwrite)
}

#[tauri::command]
pub fn check_upstream(app: AppH, dir_name: String) -> Result<crate::ahub::upstream::UpstreamReport, String> {
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    crate::ahub::upstream::check(&dir)
}

#[tauri::command]
pub fn update_skill_ext(
    app: AppH,
    dir_name: String,
    deps: Option<Vec<crate::ahub::skill_toml::DepItem>>,
    runtime: Option<crate::ahub::skill_toml::RuntimeCfg>,
    upstream: Option<crate::ahub::skill_toml::UpstreamCfg>,
) -> Result<SkillMeta, String> {
    let dir = store::data_root(&app).join("skills").join(&dir_name);
    if !dir.is_dir() {
        return Err(format!("skill not found: {dir_name}"));
    }
    crate::ahub::skill_toml::update_ext(&dir, deps, runtime, upstream)?;
    skills::read_skill(&app, &dir_name).map(|d| d.meta)
}

// ---------------- 腾讯 SkillHub 市场（skillhub.cn） ----------------

/// 搜索 / 浏览市场。网络请求是阻塞的，放后台线程池避免冻结 UI。
#[tauri::command]
pub async fn skillhub_search(
    keyword: String,
    category: String,
    source: String,
    sort: String,
    page: u32,
    page_size: u32,
) -> Result<crate::ahub::skillhub::MarketPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ahub::skillhub::search(&keyword, &category, &source, &sort, page, page_size)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub async fn skillhub_categories() -> Result<Vec<crate::ahub::skillhub::MarketCategory>, String> {
    tauri::async_runtime::spawn_blocking(crate::ahub::skillhub::categories)
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 批量安装所选技能：逐个下载 ZIP → 复用 `import_skill_zip`（同一套 zip-slip / zip-bomb 防护）
#[tauri::command]
pub async fn skillhub_install(
    app: AppH,
    targets: Vec<crate::ahub::skillhub::InstallTarget>,
    overwrite: bool,
) -> Result<Vec<crate::ahub::skillhub::MarketInstallReport>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::skillhub::install(&app, &targets, overwrite))
        .await
        .map_err(|e| format!("任务失败: {e}"))
}
#[tauri::command]
pub async fn git_fetch_skills(url: String) -> Result<serde_json::Value, String> {
    // git clone 是阻塞操作，放到后台线程池，避免冻结 UI
    tauri::async_runtime::spawn_blocking(move || git_fetch_skills_blocking(url))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

fn git_fetch_skills_blocking(url: String) -> Result<serde_json::Value, String> {
    let url = url.trim().to_string();
    if url.is_empty() || !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@")) {
        return Err("请输入有效的 https:// 或 git@ 仓库地址".into());
    }
    let id = crate::ahub::models::new_id();
    let tmp = std::env::temp_dir().join(format!("agenthub-git-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let out = crate::ahub::store::silent_command("git")
        .args(["clone", "--depth", "1", &url])
        .arg(&tmp)
        .output();
    let Ok(out) = out else {
        return Err("git 不可用（未安装或不在 PATH）".into());
    };
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "clone 失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // 自动发现技能目录（含 SKILL.md；跳过 .git；限制深度与数量）
    fn walk(dir: &std::path::Path, base: &std::path::Path, depth: u32, out: &mut Vec<serde_json::Value>) {
        if depth > 5 || out.len() >= 200 {
            return;
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name.starts_with('.') {
                continue;
            }
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            if p.join("SKILL.md").exists() {
                let text = std::fs::read_to_string(p.join("SKILL.md")).unwrap_or_default();
                let (fm, _) = crate::ahub::skills::split_doc(&text);
                let skill_name = {
                    let n = crate::ahub::skills::fm_get_str(&fm, "name");
                    if n.is_empty() {
                        p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
                    } else {
                        n
                    }
                };
                out.push(serde_json::json!({
                    "path": p.to_string_lossy(),
                    "name": skill_name,
                    "description": crate::ahub::skills::fm_get_str(&fm, "description"),
                }));
            } else {
                walk(&p, &base.join(&name), depth + 1, out);
            }
        }
    }
    let mut skills: Vec<serde_json::Value> = Vec::new();
    walk(&tmp, std::path::Path::new(""), 0, &mut skills);
    Ok(serde_json::json!({
        "tempDir": tmp.to_string_lossy(),
        "skills": skills,
    }))
}

#[tauri::command]
pub fn cleanup_git_temp(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let allowed = std::env::temp_dir();
    let is_temp = p.starts_with(&allowed)
        && p.file_name()
            .map(|n| n.to_string_lossy().starts_with("agenthub-git-"))
            .unwrap_or(false);
    if !is_temp {
        return Err("路径不在允许的临时目录内".into());
    }
    if p.exists() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_status(app: AppH) -> Result<crate::ahub::gitsync::SyncStatus, String> {
    crate::ahub::gitsync::status(&app)
}

#[tauri::command]
pub fn sync_set_remote(app: AppH, url: String) -> Result<(), String> {
    crate::ahub::gitsync::set_remote(&app, &url)
}

#[tauri::command]
pub async fn sync_push(app: AppH, message: String, authed: bool, provider: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::gitsync::push(&app, &message, authed, &provider))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}


#[tauri::command]
pub async fn sync_pull(app: AppH, authed: bool, provider: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::gitsync::pull(&app, authed, &provider))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

// ---------------- 提示词变量 ----------------

/// 解析正文里的占位符：返回变量清单（已合并定义）、未使用定义、未闭合诊断。
/// `forEditor = true` 时会为正文里尚未定义的占位符补建默认定义。
#[tauri::command]
pub fn parse_prompt_vars(
    content: String,
    defined: Vec<crate::ahub::prompt_vars::PromptVariable>,
    for_editor: bool,
) -> crate::ahub::prompt_vars::Reconciled {
    if for_editor {
        crate::ahub::prompt_vars::reconcile_for_editor(&content, &defined)
    } else {
        crate::ahub::prompt_vars::reconcile(&content, &defined)
    }
}

/// 用给定值填充占位符。`missing` 非空时由界面决定是否拦截（后端不擅自阻断）。
#[tauri::command]
pub fn render_prompt_vars(
    content: String,
    defined: Vec<crate::ahub::prompt_vars::PromptVariable>,
    values: std::collections::BTreeMap<String, String>,
) -> crate::ahub::prompt_vars::Rendered {
    crate::ahub::prompt_vars::render(&content, &defined, &values)
}

/// 重命名变量：只改写占位符，不动正文其它同名文本。
#[tauri::command]
pub fn rename_prompt_var(content: String, from: String, to: String) -> String {
    crate::ahub::prompt_vars::rename_variable(&content, &from, &to)
}

/// 删除变量的所有占位符。
#[tauri::command]
pub fn remove_prompt_var(content: String, name: String) -> String {
    crate::ahub::prompt_vars::remove_variable(&content, &name)
}

/// 变量名校验：返回 None 表示合法，否则返回错误码（required / invalid / duplicate）。
#[tauri::command]
pub fn validate_prompt_var_name(
    name: String,
    defined: Vec<crate::ahub::prompt_vars::PromptVariable>,
    current: Option<String>,
) -> Option<String> {
    crate::ahub::prompt_vars::validate_name(&name, &defined, current.as_deref()).map(|s| s.to_string())
}

// ---------------- AI 工具版本管理 ----------------

#[tauri::command]
pub async fn tool_list() -> Result<crate::ahub::toolmgr::ToolList, String> {
    tauri::async_runtime::spawn_blocking(crate::ahub::toolmgr::list)
        .await
        .map_err(|e| format!("任务失败: {e}"))
}

#[tauri::command]
pub async fn tool_check_latest() -> Result<crate::ahub::toolmgr::ToolList, String> {
    // 逐个包查询 registry，属网络阻塞操作
    tauri::async_runtime::spawn_blocking(crate::ahub::toolmgr::check_latest)
        .await
        .map_err(|e| format!("任务失败: {e}"))
}

/// 批量更新所选工具（npm i -g）。`npm install` 可能耗时数分钟，必须在后台线程。
#[tauri::command]
pub async fn tool_update(ids: Vec<String>) -> Result<Vec<crate::ahub::toolmgr::UpdateOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::toolmgr::update(&ids))
        .await
        .map_err(|e| format!("任务失败: {e}"))
}


#[tauri::command]
pub fn auth_status(app: AppH) -> Result<serde_json::Value, String> {
    crate::ahub::auth::has_auth(&app)
}

#[tauri::command]
pub fn auth_github_start() -> Result<crate::ahub::auth::DeviceCodeSession, String> {
    crate::ahub::auth::github_start()
}

#[tauri::command]
pub fn auth_github_poll(app: AppH, device_code: String) -> Result<crate::ahub::auth::AuthResult, String> {
    crate::ahub::auth::github_poll(&app, &device_code)
}

#[tauri::command]
pub fn auth_save_pat(app: AppH, provider: String, pat: String) -> Result<crate::ahub::auth::AuthResult, String> {
    crate::ahub::auth::save_pat(&app, &provider, &pat)
}

#[tauri::command]
pub fn auth_logout(app: AppH) -> Result<(), String> {
    crate::ahub::auth::logout(&app)
}

#[tauri::command]
pub fn auth_create_repo(app: AppH, provider: String) -> Result<String, String> {
    crate::ahub::auth::create_backup_repo(&app, &provider)
}

/// 预览尚未导入的技能目录：正文 + 文件清单 + 是否已在中枢
#[tauri::command]
pub fn preview_skill_dir(app: AppH, path: String) -> Result<crate::ahub::skills::ImportPreview, String> {
    crate::ahub::skills::preview_skill_dir(&app, &path)
}

#[tauri::command]
pub fn read_import_file(path: String) -> Result<std::collections::HashMap<String, String>, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("file not found".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "json" && ext != "jsonc" {
        return Err("only .json files are supported".into());
    }
    let text = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    let text = text.trim_start_matches('\u{feff}').to_string();
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config.json")
        .to_string();
    let mut m = std::collections::HashMap::new();
    m.insert("name".to_string(), name);
    m.insert("text".to_string(), text);
    Ok(m)
}

// ---------------- 配置版本库（Config Vault） ----------------

#[tauri::command]
pub fn vault_status(app: AppH) -> Result<Vec<crate::ahub::configvault::VaultStatus>, String> {
    Ok(crate::ahub::configvault::status(&app))
}

#[tauri::command]
pub fn vault_installed_count(app: AppH) -> Result<usize, String> {
    Ok(crate::ahub::configvault::installed_count(&app))
}

#[tauri::command]
pub fn vault_index(app: AppH) -> Result<crate::ahub::configvault::VaultIndex, String> {
    Ok(crate::ahub::configvault::index(&app))
}

#[tauri::command]
pub fn vault_set_watched(app: AppH, watched: Vec<String>) -> Result<crate::ahub::configvault::VaultIndex, String> {
    crate::ahub::configvault::set_watched(&app, watched)
}

#[tauri::command]
pub fn vault_set_daily(app: AppH, daily: bool) -> Result<crate::ahub::configvault::VaultIndex, String> {
    crate::ahub::configvault::set_daily(&app, daily)
}

#[tauri::command]
pub fn vault_snapshot(app: AppH, harnesses: Vec<String>, kind: String) -> Result<Vec<crate::ahub::configvault::ConfigVersion>, String> {
    crate::ahub::configvault::snapshot(&app, &harnesses, &kind)
}

#[tauri::command]
pub fn vault_maybe_daily(app: AppH) -> Result<usize, String> {
    crate::ahub::configvault::maybe_daily(&app)
}

#[tauri::command]
pub fn vault_read_version(app: AppH, harness: String, v: u32) -> Result<String, String> {
    crate::ahub::configvault::read_version(&app, &harness, v)
}

#[tauri::command]
pub fn vault_restore(app: AppH, harness: String, v: u32) -> Result<String, String> {
    crate::ahub::configvault::restore(&app, &harness, v)
}

#[tauri::command]
pub fn vault_clear(app: AppH, harnesses: Vec<String>) -> Result<(), String> {
    crate::ahub::configvault::clear(&app, &harnesses)
}

// ---------------- CLI 环境中心 ----------------

/// 扫描本机 CLI。全程只读，放后台线程避免阻塞 UI。
#[tauri::command]
pub async fn cli_scan() -> Result<crate::ahub::models::CliScanReport, String> {
    tauri::async_runtime::spawn_blocking(crate::ahub::cliscan::scan)
        .await
        .map_err(|e| format!("扫描失败: {e}"))
}

/// 解释一个 CLI 的用途（tldr 优先，--help 兜底）。
#[tauri::command]
pub async fn cli_explain(
    app: AppH,
    name: String,
    install_path: String,
) -> Result<crate::ahub::models::CliExplain, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::cliexplain::explain(&app, &name, &install_path))
        .await
        .map_err(|e| format!("读取用途失败: {e}"))
}

/// 批量补齐版本号：只探测没有版本的条目。
#[tauri::command]
pub async fn cli_explain_versions(
    app: AppH,
    items: Vec<(String, String)>,
) -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ahub::cliexplain::explain_versions(&app, &items, 40)
    })
    .await
    .map_err(|e| format!("探测版本失败: {e}"))
}

/// tldr 缓存状态。
#[tauri::command]
pub fn cli_tldr_status(app: AppH) -> Result<serde_json::Value, String> {
    let meta = crate::ahub::cliexplain::cache_meta(&app);
    Ok(serde_json::json!({
        "ready": crate::ahub::cliexplain::cache_ready(&app),
        "languages": meta.languages,
        "updatedAt": meta.updated_at,
    }))
}

/// 下载 / 刷新 tldr 缓存。失败不代表功能不可用（会退到兜底探测）。
#[tauri::command]
pub async fn cli_tldr_ensure(app: AppH) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = crate::ahub::cliexplain::ensure_cache(&app)?;
        Ok::<_, String>(serde_json::json!({
            "ready": crate::ahub::cliexplain::cache_ready(&app),
            "languages": meta.languages,
            "updatedAt": meta.updated_at,
        }))
    })
    .await
    .map_err(|e| format!("下载 tldr 缓存失败: {e}"))?
}

/// 清空 tldr 缓存。
#[tauri::command]
pub fn cli_tldr_clear(app: AppH) -> Result<(), String> {
    crate::ahub::cliexplain::clear_cache(&app)
}

// ---------------- 镜像配置 ----------------

#[tauri::command]
pub fn mirror_list(app: AppH) -> Result<Vec<crate::ahub::models::MirrorTool>, String> {
    Ok(crate::ahub::mirrorcfg::list(&app))
}

/// 生成变更计划（仅预览，不落盘）。
#[tauri::command]
pub fn mirror_plan(app: AppH, ids: Vec<String>) -> Result<crate::ahub::models::ChangePlan, String> {
    crate::ahub::mirrorcfg::plan(&app, &ids)
}

/// 执行写入：先备份，再写，再读回校验，失败自动回滚。
#[tauri::command]
pub async fn mirror_apply(
    app: AppH,
    ids: Vec<String>,
) -> Result<Vec<crate::ahub::models::ApplyOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::mirrorcfg::apply(&app, &ids))
        .await
        .map_err(|e| format!("写入镜像失败: {e}"))
}

#[tauri::command]
pub fn mirror_rollback(app: AppH, id: String) -> Result<String, String> {
    crate::ahub::mirrorcfg::rollback(&app, &id)
}

// ---------------- 环境设置与一键安装 ----------------

#[tauri::command]
pub fn get_env_root(app: AppH) -> Result<String, String> {
    Ok(crate::ahub::envsetup::get_env_root(&app))
}

#[tauri::command]
pub fn set_env_root(app: AppH, path: String) -> Result<(), String> {
    crate::ahub::envsetup::set_env_root(&app, &path)
}

/// 一键安装：下载 zip → 解压 → 移入环境根目录 → 追加用户 PATH。放后台线程避免阻塞 UI。
#[tauri::command]
pub async fn install_tool(
    app: AppH,
    tool_id: String,
    download_url: String,
    tool_name: String,
) -> Result<crate::ahub::models::InstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ahub::envsetup::install_tool(&app, &tool_id, &download_url, &tool_name)
    })
    .await
    .map_err(|e| format!("安装失败: {e}"))?
}

/// 全盘扫描（只读，可能耗时数秒）：放后台线程。
#[tauri::command]
pub async fn disk_scan(app: AppH) -> Result<Vec<crate::ahub::models::DiscoveredCli>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::diskscan::scan(&app))
        .await
        .map_err(|e| format!("全盘扫描失败: {e}"))?
}

#[tauri::command]
pub fn disk_scan_cached(app: AppH) -> Result<Option<Vec<crate::ahub::models::DiscoveredCli>>, String> {
    Ok(crate::ahub::diskscan::get_cached(&app))
}

#[tauri::command]
pub fn restore_path_backup(app: AppH) -> Result<String, String> {
    crate::ahub::envsetup::restore_path(&app)
}

// ---------------- MCP 连通性测试 / AI 标签（mcp-enhance） ----------------

/// 连通性测试：stdio 跑 `command args --help`（5s 超时，退出码 0 = 连通）；
/// http/sse GET url（状态码 < 500 = 连通）。子进程可能久挂，放后台线程避免阻塞 UI。
#[tauri::command]
pub async fn test_mcp_connectivity(
    mcp: McpServer,
) -> Result<crate::ahub::mcpconnect::McpTestResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::mcpconnect::test_connectivity(&mcp))
        .await
        .map_err(|e| format!("连通性测试失败: {e}"))
}

/// AI 建议标签（OpenAI 兼容接口；只发送 name + description，不发送命令与环境变量）
#[tauri::command]
pub async fn ai_suggest_tags(app: AppH, name: String, description: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ahub::mcpconnect::suggest_tags(&app, &name, &description)
    })
    .await
    .map_err(|e| format!("AI 标签失败: {e}"))?
}

// ---------------- AI 提供商（ai-provider） ----------------

/// 提供商列表（含 masked key，不含明文 key）
#[tauri::command]
pub fn ai_provider_list(app: AppH) -> Result<Vec<crate::ahub::aiprovider::AiProvider>, String> {
    crate::ahub::aiprovider::list(&app)
}

/// 内置厂商预设（前端下拉用）
#[tauri::command]
pub fn ai_provider_presets() -> Vec<crate::ahub::aiprovider::PresetInfo> {
    crate::ahub::aiprovider::presets()
}

#[tauri::command]
pub fn ai_provider_create(
    app: AppH,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    api_key: String,
) -> Result<crate::ahub::aiprovider::AiProvider, String> {
    crate::ahub::aiprovider::create(&app, name, kind, base_url, model, api_key)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_provider_update(
    app: AppH,
    id: String,
    name: Option<String>,
    kind: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<crate::ahub::aiprovider::AiProvider, String> {
    crate::ahub::aiprovider::update(&app, &id, name, kind, base_url, model, api_key)
}

#[tauri::command]
pub fn ai_provider_delete(app: AppH, id: String) -> Result<(), String> {
    crate::ahub::aiprovider::delete(&app, &id)
}

#[tauri::command]
pub fn ai_provider_set_default(app: AppH, id: String) -> Result<(), String> {
    crate::ahub::aiprovider::set_default(&app, &id)
}

#[tauri::command]
pub fn ai_provider_set_enabled(
    app: AppH,
    id: String,
    enabled: bool,
) -> Result<crate::ahub::aiprovider::AiProvider, String> {
    crate::ahub::aiprovider::set_enabled(&app, &id, enabled)
}

/// 测试连接：发最小请求（max_tokens 1），15 秒超时。
/// `draft` 允许用表单当前值覆盖已保存配置，用户不必先保存（spec `connectivity-test`）。
#[tauri::command]
pub async fn ai_provider_test(
    app: AppH,
    id: String,
    draft: Option<crate::ahub::aiprovider::ProviderDraft>,
) -> Result<crate::ahub::aiprovider::TestResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::aiprovider::test_connection(&app, &id, draft))
        .await
        .map_err(|e| format!("连通性测试失败: {e}"))?
}

// ---------------- 技能 AI 摘要（skills-summary） ----------------

/// 生成单个技能的 AI 摘要，写入 `.hub.json` 并返回。
/// AI 未配置或返回不可解析时返回明确错误（不写部分摘要）。
#[tauri::command]
pub async fn skill_generate_summary(
    app: AppH,
    dir_name: String,
) -> Result<SkillSummary, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::skillsummary::generate(&app, &dir_name))
        .await
        .map_err(|e| format!("生成摘要失败: {e}"))?
}

/// 批量生成摘要：逐个串行，进度走 `skill-summary-progress` 事件。
/// 单个技能失败不中断其余技能，结果里带上每项的成功/失败原因。
#[tauri::command]
pub async fn skill_generate_summary_batch(
    app: AppH,
    dir_names: Vec<String>,
) -> Result<Vec<crate::ahub::skillsummary::BatchOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ahub::skillsummary::generate_batch(&app, dir_names))
        .await
        .map_err(|e| format!("批量生成摘要失败: {e}"))?
}

/// 「导入时自动生成摘要」全局开关（默认关闭，持久化到 settings.json）
#[tauri::command]
pub fn set_auto_summary_on_import(app: AppH, enabled: bool) -> Result<SettingsInfo, String> {
    let mut s = store::load_settings(&app);
    s.auto_summary_on_import = enabled;
    store::save_settings(&app, &s)?;
    Ok(store::settings_info(&app))
}

// ---------------- Skills 批量导入（skills-import） ----------------

/// 探查导入根目录：自身含 SKILL.md → 唯一候选；否则每个下一级子目录一个候选。
/// 传入 zip 时先解压到临时目录再探查（不支持 rar）。
///
/// 每个候选会复制到暂存会话目录（`session_id` 为空时新建一个），
/// 之后所有修复与落库都只动暂存副本。
#[tauri::command]
pub async fn skill_import_explore(
    app: AppH,
    path: String,
    session_id: Option<String>,
) -> Result<crate::ahub::skillimport::ExploreReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::ahub::skillimport::emit_exploring(&app, &path);
        let sid = session_id.unwrap_or_default();
        let sid = if sid.trim().is_empty() { None } else { Some(sid) };
        let p = std::path::PathBuf::from(&path);
        if !p.is_dir() {
            let root = crate::ahub::skillimport::extract_zip_root(&path)?;
            return Ok(crate::ahub::skillimport::explore_with_session(&root, sid.as_deref()));
        }
        Ok(crate::ahub::skillimport::explore_with_session(&p, sid.as_deref()))
    })
    .await
    .map_err(|e| format!("探查失败: {e}"))?
}

/// 执行程序修复（目录改名 / SKILL.md 大小写 / frontmatter name），返回修复后的报告。
#[tauri::command]
pub async fn skill_import_apply_fixes(
    app: AppH,
    report: crate::ahub::skillimport::ExploreReport,
) -> Result<crate::ahub::skillimport::ExploreReport, String> {
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        let mut r = report;
        crate::ahub::skillimport::apply_fixes(&mut r.candidates);
        // 修复后重新算无法修复清单（problem 可能因改名失败而新增）
        r.unrepairable = r
            .candidates
            .iter()
            .filter(|c| !c.has_skill_md || !c.problem.is_empty())
            .map(|c| crate::ahub::skillimport::UnrepairableItem {
                path: c.original_path.clone(),
                reason: if c.problem.is_empty() {
                    "缺少 SKILL.md".into()
                } else {
                    c.problem.clone()
                },
            })
            .collect();
        Ok(r)
    })
    .await
    .map_err(|e| format!("修复失败: {e}"))?
}

/// 对单个候选目录调 AI 补全 description，返回更新后的候选（已写回暂存副本）。
#[tauri::command]
pub async fn skill_import_ai_fix(
    app: AppH,
    path: String,
    staged_path: Option<String>,
) -> Result<crate::ahub::skillimport::CandidateSkill, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original = std::path::PathBuf::from(&path);
        let staged = staged_path
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| original.clone());
        let mut c = crate::ahub::skillimport::analyze_candidate_at(&original, &staged);
        if !c.has_skill_md || !c.problem.is_empty() {
            return Err(if c.problem.is_empty() {
                "缺少 SKILL.md".into()
            } else {
                c.problem
            });
        }
        let dir = std::path::PathBuf::from(&c.staged_path);
        let desc = crate::ahub::skillimport::ai_fix_description(&app, &dir, &c.skill_md_description)?;
        crate::ahub::skillimport::write_description(&dir, &desc)?;
        c.skill_md_description = desc;
        c.needs_ai = false;
        Ok(c)
    })
    .await
    .map_err(|e| format!("AI 修复失败: {e}"))?
}

/// 执行批量导入：修复 → AI 补描述 → 来源 → 落库 → 写 SKILL.toml [source]，进度走 import-progress 事件。
///
/// `staged` 是 `original_path → staged_path` 的映射（来自探查报告）；
/// `overwrite=true` 覆盖同名技能，`false` 则把同名冲突记为失败。
#[tauri::command]
pub async fn skill_import_execute(
    app: AppH,
    root: String,
    selected: Vec<String>,
    staged: std::collections::HashMap<String, String>,
    sources: std::collections::HashMap<String, crate::ahub::skillimport::SourceInfo>,
    overwrite: bool,
    session_id: String,
    generate_summary: Option<bool>,
) -> Result<crate::ahub::skillimport::ImportBatchReport, String> {
    crate::ahub::skillimport::import_batch(
        app,
        root,
        selected,
        staged,
        sources,
        overwrite,
        session_id,
        generate_summary,
    )
    .await
}

/// 用户选择「终止」：推一条 aborted 结束事件并清理解压出的临时目录（A8/A5）。
#[tauri::command]
pub fn skill_import_abort(app: AppH, root: String, paths: Vec<String>) -> Result<usize, String> {
    crate::ahub::skillimport::emit_aborted(&app, &root);
    Ok(crate::ahub::skillimport::cleanup_for_paths(&paths))
}

/// 清理整个暂存会话目录（向导关闭 / 取消时调用），原目录不受影响。
#[tauri::command]
pub fn skill_import_cleanup(session_id: String) -> Result<usize, String> {
    Ok(crate::ahub::skillimport::cleanup_session(&session_id))
}