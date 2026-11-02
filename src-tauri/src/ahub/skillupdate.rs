//! 技能更新中心：AI 自动发现上游、候选下载到临时目录、置信度审校与落库。
//!
//! 分工：
//! - `probe` 只读本地 SKILL.toml，已有 [source.upstream].remote 的技能不调用 AI；
//! - `discover` 用 AI 生成检索词，跑 DeepSkill / GitHub / Web 三条渠道，把候选下载到
//!   用户指定的工作目录；AI 再对候选内容做一次同源审校，低于阈值直接拒绝；
//! - `apply` 把已通过审校的候选目录覆盖回原技能目录，并写回上游追踪信息。
//!
//! 这里不把 AI 选择结果直接落库：前端更新队列拿到 `localPath` 后才调用 apply，
//! 这样任务可以暂停、终止，且拒绝时技能目录完全不动。

use crate::ahub::{
    aihelper,
    models::new_id,
    skill_toml,
    skills,
    store::{self, AppH},
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_SEARCH_CANDIDATES: usize = 12;
const MAX_HTTP_BYTES: u64 = 24 * 1024 * 1024;
const MAX_REFERENCE_CHARS: usize = 18_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProbe {
    pub dir_name: String,
    pub name: String,
    /// 是否已经记录了上游（不论 watch 是否开启）。有值就不会再跑 AI 搜源。
    pub has_upstream: bool,
    /// [source.upstream].watch 是否为 true
    pub tracked: bool,
    pub remote: String,
    pub mode: String,
    pub source_kind: String,
    pub source_ref: String,
    pub source_confidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// deepskill | github | web
    pub channel: String,
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// DeepSkill 下载用的名称；其它渠道为空
    pub download_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverReport {
    /// existing | candidate | rejected | error
    pub status: String,
    pub confidence: f64,
    pub reason: String,
    pub source_kind: String,
    pub source_url: String,
    pub mode: String,
    /// 已通过审校的候选目录；rejected 时为空
    pub local_path: String,
    pub candidate_name: String,
    pub query: String,
    pub channels: Vec<String>,
    pub candidates: Vec<Candidate>,
    pub threshold: f64,
    pub work_dir: String,
}

/// 读本地技能的上游状态。没有 SKILL.toml 也返回一个可用的空状态。
pub fn probe(app: &AppH, dir_name: &str) -> Result<UpdateProbe, String> {
    let doc = skills::read_skill(app, dir_name)?;
    let root = store::data_root(app).join("skills").join(dir_name);
    let toml_doc = skill_toml::load(&root);
    let get = |path: &str| {
        toml_doc
            .as_ref()
            .and_then(|d| skill_toml::get_str(d, path))
            .unwrap_or_default()
    };
    let source_kind = get("source.kind");
    let source_ref = get("source.ref");
    let mut remote = get("source.upstream.remote");
    // 旧技能可能只有 [source] 没有 [source.upstream]：URL 来源同样视为已有上游，不再让 AI 重找。
    if remote.is_empty()
        && source_kind == "url"
        && (source_ref.starts_with("https://") || source_ref.starts_with("http://"))
    {
        remote = source_ref.clone();
    }
    // 从市场 / GitHub 导入的技能常常没写 SKILL.toml，但目录里的 _meta.json
    // 记着真实来源（updateSource 或 _update.source）。有就直接当上游，
    // 免得明明有仓库地址还去跑一遍 AI 搜源。
    if remote.trim().is_empty() {
        for file in ["_meta.json", "skill.json"] {
            let Ok(text) = std::fs::read_to_string(root.join(file)) else { continue };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let url = value
                .pointer("/_update/source")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("updateSource").and_then(|v| v.as_str()))
                .unwrap_or("");
            if url.starts_with("http") {
                remote = url.to_string();
                break;
            }
        }
    }
    let mut mode = get("source.upstream.mode");
    // 以地址为准：不是 git 仓库地址就一律按网页/文档走。
    // 旧记录里可能残留 "doc" 这类 mode，前端按「不是 web 就是 git」分流时会把
    // 一个 .md 地址丢给 git clone —— 这里先纠正，别让脏数据把流程带沟里。
    if !remote.is_empty() {
        mode = if is_git_repo_url(&remote) { "git-scan" } else { "web" }.to_string();
    }
    let tracked = toml_doc
        .as_ref()
        .and_then(|d| d.get("source"))
        .and_then(|s| s.get("upstream"))
        .and_then(|u| u.get("watch"))
        .and_then(|w| w.as_bool())
        .unwrap_or(false);
    Ok(UpdateProbe {
        dir_name: dir_name.to_string(),
        name: doc.meta.name,
        has_upstream: !remote.trim().is_empty(),
        tracked,
        remote,
        mode,
        source_kind,
        source_ref,
        source_confidence: get("source.confidence"),
    })
}

/// AI 搜源 + 下载 + 审校。`preferred_url` 非空时跳过搜索，直接审校这个上游地址。
pub fn discover(
    app: &AppH,
    dir_name: &str,
    work_dir: &str,
    threshold: f64,
    preferred_url: &str,
) -> Result<DiscoverReport, String> {
    let threshold = if threshold.is_finite() {
        threshold.clamp(0.0, 1.0)
    } else {
        0.75
    };
    let local = skills::read_skill(app, dir_name)?;
    let local_root = store::data_root(app).join("skills").join(dir_name);
    let local_text = std::fs::read_to_string(local_root.join("SKILL.md")).unwrap_or_default();
    // README 往往写着「安装与配置」而 SKILL.md 没写，一起交给 AI 判定
    let readme = ["README.md", "readme.md"]
        .iter()
        .find_map(|name| std::fs::read_to_string(local_root.join(name)).ok())
        .unwrap_or_default();
    let context = if readme.trim().is_empty() {
        local_text.clone()
    } else {
        format!("{local_text}\n\n===== README =====\n{readme}")
    };
    let work_root = if work_dir.trim().is_empty() {
        std::env::temp_dir().join("nimbusdesk-skill-update")
    } else {
        PathBuf::from(work_dir.trim())
    };
    std::fs::create_dir_all(&work_root).map_err(|e| format!("无法创建工作目录：{e}"))?;
    let task_dir = work_root.join(format!("task-{}", new_id()));
    std::fs::create_dir_all(&task_dir).map_err(|e| format!("无法创建任务目录：{e}"))?;

    let mut channels: Vec<String> = Vec::new();

    // 0) 先读本地文档（SKILL.md / README / _meta.json）里作者自己写的安装方式。
    //    `npx skills add <url>`、仓库地址、clawhub 页 —— 确定性事实，比搜索结果可信。
    let hints = local_upstream_hints(&local_root, &local_text);
    if !hints.is_empty() {
        append_channel(&mut channels, "doc");
        for hint in &hints {
            let mut trusted = false;
            let target = if hint.channel == "doc" {
                match resolve_wellknown(&hint.url, &local.meta.name) {
                    // 站点自己的 well-known 清单按名字列出了这个技能 = 权威来源，
                    // 不必等 AI 判断；内容随后按原文写进候选目录。
                    Some(url) => {
                        trusted = true;
                        Candidate { url, channel: "wellknown".into(), ..hint.clone() }
                    }
                    None => hint.clone(),
                }
            } else {
                hint.clone()
            };
            let Ok(prepared) = prepare_candidate(&task_dir, dir_name, &target, &local_text) else {
                continue;
            };
            if !trusted && !same_skill_text(&local_text, &prepared.text) {
                continue;
            }
            // 内容逐字一致 = 找到了确切的同一份上游，不需要 AI 判断
            let _ = std::fs::write(prepared.path.join("SKILL.md"), &prepared.text);
            let mut cands = vec![target.clone()];
            cands.extend(hints.iter().cloned());
            return Ok(DiscoverReport {
                status: "candidate".into(),
                confidence: 1.0,
                reason: format!("本地文档写明的上游，内容逐字一致（{}）", target.snippet),
                source_kind: target.channel.clone(),
                source_url: target.url.clone(),
                mode: "doc".into(),
                local_path: prepared.path.to_string_lossy().into_owned(),
                candidate_name: prepared.name,
                query: String::new(),
                channels,
                candidates: cands,
                threshold,
                work_dir: work_root.to_string_lossy().into_owned(),
            });
        }
    }

    let (mut candidates, query) = if !preferred_url.trim().is_empty() {
        let url = preferred_url.trim().to_string();
        (vec![candidate_from_url(&url)], String::new())
    } else {
        let queries = ai_queries(app, &local.meta.name, &local.meta.description, &context)?;
        let mut out = Vec::new();
        for q in queries.iter().take(3) {
            append_channel(&mut channels, "deepskill");
            out.extend(search_deepskill(q));
            append_channel(&mut channels, "skillhub");
            out.extend(search_skillhub(q));
            append_channel(&mut channels, "github");
            out.extend(search_github(q));
            append_channel(&mut channels, "github-code");
            out.extend(search_github_code(q));
            append_channel(&mut channels, "web");
            out.extend(search_web(q));
        }
        (dedupe_candidates(out), queries.join(" | "))
    };

    // 文档线索排在搜索结果前面：AI 决策时先看到作者自己写的那条
    if !hints.is_empty() {
        let mut merged = hints.clone();
        merged.extend(candidates);
        candidates = dedupe_candidates(merged);
    }

    if candidates.is_empty() {
        return Ok(DiscoverReport {
            status: "rejected".into(),
            confidence: 0.0,
            reason: "没有搜索到可用的上游候选".into(),
            source_kind: String::new(),
            source_url: String::new(),
            mode: String::new(),
            local_path: String::new(),
            candidate_name: String::new(),
            query,
            channels,
            candidates,
            threshold,
            work_dir: work_root.to_string_lossy().into_owned(),
        });
    }

    let choice = ai_choose(app, &local.meta.name, &local.meta.description, &context, &candidates)?;
    if choice.index < 0 || choice.confidence < threshold || !choice.same_skill {
        return Ok(DiscoverReport {
            status: "rejected".into(),
            confidence: choice.confidence,
            reason: if choice.reason.is_empty() {
                "AI 判断候选与本地技能不是同一来源".into()
            } else {
                choice.reason
            },
            source_kind: String::new(),
            source_url: String::new(),
            mode: String::new(),
            local_path: String::new(),
            candidate_name: String::new(),
            query,
            channels,
            candidates,
            threshold,
            work_dir: work_root.to_string_lossy().into_owned(),
        });
    }
    let candidate = candidates[choice.index as usize].clone();

    let prepared = prepare_candidate(&task_dir, dir_name, &candidate, &local_text)?;
    let verify = ai_verify(
        app,
        &local.meta.name,
        &local.meta.description,
        &context,
        &prepared.text,
        prepared.rewrite,
    )?;
    let confidence = verify.confidence.max(choice.confidence.min(0.99));
    if !verify.same_skill || confidence < threshold {
        return Ok(DiscoverReport {
            status: "rejected".into(),
            confidence,
            reason: if verify.reason.is_empty() {
                "AI 审校未通过：候选内容与本地技能差异过大".into()
            } else {
                verify.reason
            },
            source_kind: prepared.kind,
            source_url: candidate.url,
            mode: prepared.mode,
            local_path: String::new(),
            candidate_name: prepared.name,
            query,
            channels,
            candidates,
            threshold,
            work_dir: work_root.to_string_lossy().into_owned(),
        });
    }

    if prepared.rewrite {
        let body = verify
            .updated_body
            .filter(|s| !s.trim().is_empty())
            .ok_or("AI 没有返回可写入的更新正文")?;
        let doc = compose_skill(&local_text, &body);
        std::fs::write(prepared.path.join("SKILL.md"), doc).map_err(|e| e.to_string())?;
    }

    Ok(DiscoverReport {
        status: "candidate".into(),
        confidence,
        reason: verify.reason,
        source_kind: prepared.kind,
        source_url: candidate.url,
        mode: prepared.mode,
        local_path: prepared.path.to_string_lossy().into_owned(),
        candidate_name: prepared.name,
        query,
        channels,
        candidates,
        threshold,
        work_dir: work_root.to_string_lossy().into_owned(),
    })
}

/// 覆盖策略：本地被改过时由用户选。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyStrategy {
    /// 用上游覆盖
    UseRemote,
    /// 保留本地，不动
    KeepMine,
    /// 本地不动，上游另存为 `<dir>-upstream`
    KeepBoth,
}

pub fn parse_strategy(raw: &str) -> Result<ApplyStrategy, String> {
    match raw {
        "" | "use-remote" | "overwrite" => Ok(ApplyStrategy::UseRemote),
        "keep-mine" => Ok(ApplyStrategy::KeepMine),
        "keep-both" => Ok(ApplyStrategy::KeepBoth),
        other => Err(format!("未知的覆盖策略：{other}")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreview {
    /// 本地是否改过；`None` = 老技能没有安装指纹，判不了
    pub local_modified: Option<bool>,
    /// 候选内容与本地完全一致（一致就没必要覆盖）
    pub identical: bool,
    pub changed: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// 本地相对安装时改动 / 新增 / 删除的文件（来自安装指纹）
    pub local_changed: Vec<String>,
    pub skill_md_local: String,
    pub skill_md_remote: String,
}

/// 覆盖前的对账：本地改没改过、跟候选差在哪些文件、SKILL.md 两边各是什么样。
pub fn preview(app: &AppH, dir_name: &str, candidate_path: &str) -> Result<UpdatePreview, String> {
    let local_root = store::data_root(app).join("skills").join(dir_name);
    if !local_root.is_dir() {
        return Err(format!("技能不存在：{dir_name}"));
    }
    let candidate_root = PathBuf::from(candidate_path);
    if !candidate_root.join("SKILL.md").is_file() {
        return Err("候选目录缺少 SKILL.md".into());
    }
    let (changed, added, removed) = diff_dirs(&local_root, &candidate_root);
    Ok(UpdatePreview {
        local_modified: crate::ahub::upstream::local_modified(&local_root),
        identical: changed.is_empty() && added.is_empty() && removed.is_empty(),
        changed,
        added,
        removed,
        local_changed: crate::ahub::upstream::local_changed(&local_root).unwrap_or_default(),
        skill_md_local: std::fs::read_to_string(local_root.join("SKILL.md")).unwrap_or_default(),
        skill_md_remote: std::fs::read_to_string(candidate_root.join("SKILL.md")).unwrap_or_default(),
    })
}

/// 单个文件的正文：给冲突弹窗做逐行差异用。只读、限大小、拒绝跳出技能目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub local: String,
    pub remote: String,
    /// 任一版本不是文本 / 超出大小上限
    pub binary: bool,
}

const MAX_DIFF_BYTES: u64 = 256 * 1024;

pub fn preview_file(
    app: &AppH,
    dir_name: &str,
    candidate_path: &str,
    rel_path: &str,
) -> Result<FileDiff, String> {
    let rel = Path::new(rel_path);
    if rel_path.trim().is_empty() || rel.is_absolute() || rel_path.contains("..") {
        return Err("非法文件路径".into());
    }
    let local_root = store::data_root(app).join("skills").join(dir_name);
    let candidate_root = PathBuf::from(candidate_path);
    let read = |root: &Path| -> (String, bool) {
        let path = root.join(rel);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_DIFF_BYTES => (String::new(), true),
            Ok(_) => match std::fs::read(&path) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => (text, false),
                    Err(_) => (String::new(), true),
                },
                Err(_) => (String::new(), false),
            },
            Err(_) => (String::new(), false),
        }
    };
    let (local, local_binary) = read(&local_root);
    let (remote, remote_binary) = read(&candidate_root);
    Ok(FileDiff {
        path: rel_path.replace('\\', "/"),
        local,
        remote,
        binary: local_binary || remote_binary,
    })
}

/// 逐文件比：返回 (内容不同, 候选新增, 候选缺失)。跳过 `.git` 与应用自有元数据。
fn diff_dirs(local: &Path, candidate: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
    fn walk(root: &Path, dir: &Path, depth: u32, out: &mut std::collections::BTreeMap<String, String>) {
        if depth > 8 {
            return;
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".hub.json" || name == "SKILL.toml" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, depth + 1, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                let bytes = std::fs::read(&path).unwrap_or_default();
                out.insert(
                    rel.to_string_lossy().replace('\\', "/"),
                    content_fingerprint(&bytes),
                );
            }
        }
    }
    let mut a = std::collections::BTreeMap::new();
    let mut b = std::collections::BTreeMap::new();
    walk(local, local, 0, &mut a);
    walk(candidate, candidate, 0, &mut b);
    let mut changed = Vec::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for (path, hash) in &b {
        match a.get(path) {
            Some(old) if old == hash => {}
            Some(_) => changed.push(path.clone()),
            None => added.push(path.clone()),
        }
    }
    for path in a.keys() {
        if !b.contains_key(path) {
            removed.push(path.clone());
        }
    }
    (changed, added, removed)
}

/// 把候选目录覆盖回原技能，并写回 [source] / [source.upstream]（含安装指纹）。
pub fn apply(
    app: &AppH,
    dir_name: &str,
    candidate_path: &str,
    source_url: &str,
    mode: &str,
    confidence: f64,
    revision: &str,
    subtree_path: &str,
    subtree_sha: &str,
    strategy_raw: &str,
) -> Result<crate::ahub::models::SkillMeta, String> {
    let src = PathBuf::from(candidate_path);
    if !src.join("SKILL.md").is_file() {
        return Err("候选目录缺少 SKILL.md".into());
    }
    let target_before = store::data_root(app).join("skills").join(dir_name);
    if !target_before.is_dir() {
        return Err(format!("技能不存在：{dir_name}"));
    }
    let strategy = parse_strategy(strategy_raw)?;
    if strategy == ApplyStrategy::KeepMine {
        return skills::read_skill(app, dir_name).map(|d| d.meta);
    }
    let target = if strategy == ApplyStrategy::KeepBoth {
        let root = store::data_root(app).join("skills");
        let mut dir = root.join(format!("{dir_name}-upstream"));
        let mut n = 2;
        while dir.exists() {
            dir = root.join(format!("{dir_name}-upstream-{n}"));
            n += 1;
        }
        store::copy_dir_recursive(&src, &dir, false)?;
        dir
    } else {
        let name = skills::import_skill_dir(app, &src, true)?;
        store::data_root(app).join("skills").join(&name)
    };
    if !source_url.trim().is_empty() {
        write_source(&target, source_url.trim(), mode, confidence)?;
    }
    // AI 搜到的 git 来源没有克隆过程，拿不到 revision：这里补一次 ls-remote，
    // 否则更新完仍会被当成「未记录安装修订」，下一轮又按仓库 HEAD 误判。
    let mut resolved = revision.to_string();
    if resolved.is_empty() && mode == "git-scan" && !source_url.trim().is_empty() {
        resolved = crate::ahub::upstream::remote_head(source_url.trim()).unwrap_or_default();
    }
    // 落指纹：这一版内容对应哪个修订、哪个子目录、内容指纹是多少。
    crate::ahub::upstream::stamp(&target, source_url.trim(), mode, &resolved, subtree_path, subtree_sha)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir_name.to_string());
    skills::read_skill(app, &name).map(|d| d.meta)
}

/// 覆盖 [source] 里的识别来源，并登记可追踪的上游。保留其它 section。
fn write_source(dir: &Path, url: &str, mode: &str, confidence: f64) -> Result<(), String> {
    let mut doc = skill_toml::load(dir).unwrap_or_else(|| toml::Value::Table(Default::default()));
    {
        let root = doc
            .as_table_mut()
            .ok_or("SKILL.toml 根节点不是表")?;
        let src = root
            .entry("source".to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
        let src = src.as_table_mut().ok_or("source 不是表")?;
        src.insert("kind".into(), toml::Value::String("url".into()));
        src.insert("ref".into(), toml::Value::String(url.to_string()));
        src.insert(
            "confidence".into(),
            toml::Value::String(if confidence >= 0.8 { "high" } else { "low" }.into()),
        );
        let up = src
            .entry("upstream".to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
        let up = up.as_table_mut().ok_or("source.upstream 不是表")?;
        up.insert("watch".into(), toml::Value::Boolean(true));
        up.insert("mode".into(), toml::Value::String(mode.to_string()));
        up.insert("remote".into(), toml::Value::String(url.to_string()));
        // 新来源的旧指纹必须清掉，否则下一次检查会把刚应用的版本误判为“有更新”。
        up.remove("last_check");
        up.remove("remote_head");
    }
    let text = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(skill_toml::path_for(dir), text).map_err(|e| e.to_string())
}

// ───────────────────────── AI ─────────────────────────

struct Choice {
    index: i64,
    confidence: f64,
    same_skill: bool,
    reason: String,
}

struct Verify {
    confidence: f64,
    same_skill: bool,
    reason: String,
    updated_body: Option<String>,
}

/// 不依赖 AI 的检索词：名称、空格分词版、描述里的短语。
/// AI 经常只回一个名称，等于四个渠道拿同一个词去搜，什么都搜不到。
fn keyword_queries(name: &str, description: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "包括", "支持", "用于", "提供", "可以", "以及", "基于", "帮助", "一个", "我们", "你的",
        "身边", "这个", "通过", "使用", "实现", "能够", "进行", "相关", "所有",
    ];
    let mut out: Vec<String> = Vec::new();
    let name = name.trim();
    if !name.is_empty() {
        out.push(name.to_string());
        let spaced = name.replace(['-', '_'], " ");
        if spaced != name {
            out.push(spaced);
        }
    }

    let mut phrases: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut flush = |buffer: &mut String, phrases: &mut Vec<String>| {
        let value = buffer.trim().to_string();
        buffer.clear();
        let len = value.chars().count();
        if !(2..=16).contains(&len) || STOP.contains(&value.as_str()) {
            return;
        }
        if value.chars().all(|c| c.is_ascii_alphabetic()) && len < 4 {
            return;
        }
        if !phrases.iter().any(|existing| existing == &value) {
            phrases.push(value);
        }
    };
    for ch in description.chars() {
        let separator = matches!(
            ch,
            '，' | '。' | '、' | '；' | '：' | '与' | '和' | '及' | '并' | ',' | '.' | ';' | ':'
                | '\n' | ' ' | '\t' | '(' | ')' | '（' | '）' | '/' | '|'
        );
        if separator {
            flush(&mut current, &mut phrases);
        } else {
            current.push(ch);
        }
    }
    flush(&mut current, &mut phrases);

    // 中文短语优先（领域词更可能是中文），其次按长度短的优先
    phrases.sort_by_key(|phrase| {
        let has_cjk = phrase.chars().any(|c| ('\u{4e00}'..='\u{9fa5}').contains(&c));
        (!has_cjk, phrase.chars().count())
    });
    for phrase in phrases {
        if out.len() >= 4 {
            break;
        }
        if !out.iter().any(|query| query.eq_ignore_ascii_case(&phrase)) {
            out.push(phrase);
        }
    }
    out.truncate(4);
    out
}

fn ai_queries(app: &AppH, name: &str, description: &str, body: &str) -> Result<Vec<String>, String> {
    let system = "你是技能上游检索助手。根据本地技能的名称、描述和正文，生成最多 3 条搜索词，用来找它的原始仓库 / 发布页 / 作者页。\n要求：\n1. 一条是名称本身（如果是 english-slug 这种连字符写法，再给一条空格分词版）；\n2. 一条是核心功能（中文技能给中文领域词，如「法律咨询」「合同审查」）；\n3. 一条是「名称 + github」或「名称 + skill」这类定位词。\n不要复读名称三次，每条都要能独立搜出不同结果。只输出 JSON，不要解释：{\"queries\":[\"…\"]}。";
    let user = format!(
        "技能名：{name}\n描述：{description}\n正文节选：\n{}",
        truncate_chars(body, 6000)
    );
    let value = chat_json(app, system, &user, aihelper::DEFAULT_MAX_TOKENS)
        .map_err(|e| format!("AI 生成检索词失败：{e}"))?;
    let mut queries = value
        .get("queries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .take(3)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // 把确定性检索词补进来（AI 常只回一个名称），再去重、限 4 条
    for extra in keyword_queries(name, description) {
        if !queries.iter().any(|q| q.eq_ignore_ascii_case(&extra)) {
            queries.push(extra);
        }
    }
    queries.truncate(4);
    if queries.is_empty() {
        Ok(vec![name.to_string()])
    } else {
        Ok(queries)
    }
}

fn ai_choose(
    app: &AppH,
    name: &str,
    description: &str,
    body: &str,
    candidates: &[Candidate],
) -> Result<Choice, String> {
    let list = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "[{i}] 渠道={} 标题={}\nURL={}\n摘要={}",
                c.channel,
                c.title,
                c.url,
                truncate_chars(&c.snippet, 220)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system = "你是技能来源判定器。判断搜索结果中哪一个最可能是本地技能的原始上游，而不是同名或相似技能。只输出 JSON：{\"index\":数字,\"confidence\":0到1,\"sameSkill\":true/false,\"reason\":\"一句话理由\"}。没有可靠来源时 index=-1、confidence=0。";
    let user = format!(
        "本地技能：{name}\n描述：{description}\n正文节选：\n{}\n\n搜索结果：\n{list}",
        truncate_chars(body, 6000)
    );
    let value = chat_json(app, system, &user, aihelper::DEFAULT_MAX_TOKENS)
        .map_err(|e| format!("AI 判定候选失败：{e}"))?;
    let index = value
        .get("index")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(-1);
    let confidence = read_confidence(&value);
    let same_skill = value
        .get("sameSkill")
        .and_then(|v| v.as_bool())
        .unwrap_or(index >= 0);
    let reason = value
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let index = if (index as usize) < candidates.len() { index } else { -1 };
    Ok(Choice { index, confidence, same_skill, reason })
}

fn ai_verify(
    app: &AppH,
    name: &str,
    description: &str,
    local: &str,
    candidate: &str,
    rewrite: bool,
) -> Result<Verify, String> {
    let system = if rewrite {
        "你是技能更新审校器。比较本地技能与候选网页/文档，判断它们是否描述同一个技能或同一份资料来源。只在确认同源时，基于候选资料重写本地 SKILL.md 的正文，保留本地原有结构和有效内容，只吸收候选里可验证的更新，不得编造。只输出 JSON：{\"sameSkill\":true/false,\"confidence\":0到1,\"reason\":\"一句话理由\",\"updatedBody\":\"重写后的 Markdown 正文，不含 frontmatter\"}。"
    } else {
        "你是技能更新审校器。比较本地技能与候选上游内容，判断候选是否就是本地技能的同一上游版本。只输出 JSON：{\"sameSkill\":true/false,\"confidence\":0到1,\"reason\":\"一句话理由\"}。confidence 要保守：名称相似但内容不一致时不得高于 0.5。"
    };
    let user = format!(
        "本地技能：{name}\n描述：{description}\n本地正文：\n{}\n\n候选内容：\n{}",
        truncate_chars(local, 9000),
        truncate_chars(candidate, MAX_REFERENCE_CHARS)
    );
    let value = chat_json(app, system, &user, aihelper::LONG_FORM_MAX_TOKENS)
        .map_err(|e| format!("AI 审校候选失败：{e}"))?;
    let confidence = read_confidence(&value);
    let same_skill = value.get("sameSkill").and_then(|v| v.as_bool()).unwrap_or(false);
    let reason = value
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_body = value
        .get("updatedBody")
        .and_then(|v| v.as_str())
        .map(|s| strip_frontmatter(s).trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(Verify { confidence, same_skill, reason, updated_body })
}

fn read_confidence(value: &Value) -> f64 {
    let raw = value
        .get("confidence")
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0.0);
    if raw > 1.0 {
        (raw / 100.0).clamp(0.0, 1.0)
    } else {
        raw.clamp(0.0, 1.0)
    }
}

/// 调 AI 并解析 JSON：模型偶尔包代码围栏、加解释、或把正文里的花括号写坏。
/// 先宽松提取，失败再纠一次；仍然失败才报错。
fn chat_json(app: &AppH, system: &str, user: &str, max_tokens: u32) -> Result<Value, String> {
    let raw = aihelper::chat_with_budget(app, system, user, max_tokens)
        .map_err(|e| format!("AI 调用失败：{e}"))?;
    let first = match parse_json(&raw) {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    let repair = format!(
        "{user}\n\n上一次的输出不是合法 JSON（{first}）。请只输出一个 JSON 对象：不要解释、不要代码围栏；\
         字符串里的换行写成 \\n，正文里的双引号写成 \\\"。上一次输出如下（仅供你修正）：\n{}",
        truncate_chars(&raw, 1500)
    );
    let retried = aihelper::chat_with_budget(app, system, &repair, max_tokens)
        .map_err(|e| format!("AI 调用失败：{e}"))?;
    parse_json(&retried).map_err(|e| format!("{first}；重试一次后仍失败：{e}"))
}

/// 从模型回复里取出 JSON。容忍：代码围栏、前后解释、字符串内的花括号与转义。
fn parse_json(raw: &str) -> Result<Value, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("AI 返回内容为空".into());
    }

    // 1) 整段、或围栏里的内容本身就是 JSON
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Ok(v);
    }
    if let Some(start) = text.find("```") {
        let rest = &text[start + 3..];
        let rest = rest
            .strip_prefix("json")
            .or_else(|| rest.strip_prefix("JSON"))
            .unwrap_or(rest)
            .trim_start();
        let end = rest.find("```").unwrap_or(rest.len());
        if let Ok(v) = serde_json::from_str::<Value>(rest[..end].trim()) {
            return Ok(v);
        }
    }

    // 2) 从每个 { 或 [ 起做括号配对（跳过字符串与转义），取第一个能解析的片段
    for (open, close) in [('{', '}'), ('[', ']')] {
        for (i, ch) in text.char_indices() {
            if ch != open {
                continue;
            }
            if let Some(end) = balanced_end(text, i, open, close) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..end]) {
                    return Ok(v);
                }
            }
        }
    }

    // 3) 括号没闭合 = 输出被截断，给可行动的文案，别让用户以为是模型乱答
    if text.matches('{').count() > text.matches('}').count() || text.matches('"').count() % 2 == 1 {
        return Err("AI 输出被截断（JSON 没闭合，多半是要写回的正文太长）".into());
    }
    Err("AI 返回内容不是 JSON".into())
}

/// 从 `start`（`open` 的位置）找配对的 `close`，返回其后的字节下标。
fn balanced_end(text: &str, start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaping = false;
    for (i, ch) in text[start..].char_indices() {
        if in_str {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        if ch == '"' {
            in_str = true;
        } else if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                return Some(start + i + ch.len_utf8());
            }
        }
    }
    None
}


// ───────────────────────── 本地文档溯源 ─────────────────────────

/// 从技能自己的文档里抽上游线索。
///
/// 很多技能的 SKILL.md / README 的「安装与配置」就写着官方安装命令
/// （`npx skills add https://agent.qq.com --skill -g -y`）、仓库地址或 clawhub 页。
/// 这些是作者自己写下的确定性事实，比搜索结果可信得多，必须先跑。
fn local_upstream_hints(root: &Path, body: &str) -> Vec<Candidate> {
    let mut docs: Vec<(String, String)> = vec![("SKILL.md".into(), body.to_string())];
    for f in ["README.md", "readme.md", "_meta.json", "skill.json"] {
        if let Ok(text) = std::fs::read_to_string(root.join(f)) {
            docs.push((f.to_string(), text));
        }
    }

    let mut out: Vec<Candidate> = Vec::new();
    for (file, text) in &docs {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.len() > 400 {
                continue;
            }
            let evidence = format!("{file}: {}", truncate_chars(line, 120));
            let mut urls = urls_in(line);
            if let Some(pos) = line.find("npx skills add ") {
                let rest = &line[pos + "npx skills add ".len()..];
                if let Some(first) = rest.split_whitespace().next() {
                    urls.push(normalize_hint_url(first));
                }
            }
            for url in urls {
                let url = url.trim_end_matches(['.', ',', ';', ')', ']', '>']).to_string();
                if !url.starts_with("http")
                    || out.iter().any(|c| c.url.eq_ignore_ascii_case(&url))
                {
                    continue;
                }
                let channel = if url.contains("github.com") {
                    "github"
                } else if url.contains("clawhub.ai") {
                    "web"
                } else {
                    "doc"
                };
                out.push(Candidate {
                    channel: channel.into(),
                    title: truncate_chars(line, 60),
                    url,
                    snippet: evidence.clone(),
                    download_name: String::new(),
                });
            }
        }
    }
    out.truncate(8);
    out
}

/// 只保留 http(s) 开头的 URL 片段。
pub(crate) fn urls_in(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(pos) = rest.find("http") {
        let tail = &rest[pos..];
        if !(tail.starts_with("http://") || tail.starts_with("https://")) {
            rest = &tail[4..];
            continue;
        }
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | ']' | '>' | ','))
            .unwrap_or(tail.len());
        out.push(tail[..end].to_string());
        rest = &tail[end..];
    }
    out
}

/// `npx skills add <x>` 里的 x 可能不带协议（如 `agent.qq.com`），补成 https。
pub(crate) fn normalize_hint_url(raw: &str) -> String {
    let v = raw.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'');
    if v.starts_with("http://") || v.starts_with("https://") {
        v.to_string()
    } else if v.contains('.') {
        format!("https://{v}")
    } else {
        v.to_string()
    }
}

/// 站点根（或没指向具体技能页的地址）→ 问它的 well-known 清单里有没有这个技能。
/// 命中就返回具体 SKILL.md 地址，这是精确来源，不需要 AI 猜。
fn resolve_wellknown(url: &str, skill: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let host = rest.split('/').next().filter(|h| h.contains('.'))?;
    let index = format!("{scheme}://{host}/.well-known/skills/index.json");
    let value = http_json(&index).ok()?;
    let items = value.get("skills")?.as_array()?;
    let hit = items.iter().find(|s| {
        s.get("name")
            .and_then(|v| v.as_str())
            .map(|n| n.eq_ignore_ascii_case(skill))
            .unwrap_or(false)
    })?;
    let name = hit.get("name")?.as_str()?;
    Some(format!("{scheme}://{host}/.well-known/skills/{name}/SKILL.md"))
}

/// 正文逐字比对（忽略 frontmatter 与行尾空白）。
fn same_skill_text(local: &str, candidate: &str) -> bool {
    let a = normalize_body(local);
    let b = normalize_body(candidate);
    !a.is_empty() && a == b
}

fn normalize_body(text: &str) -> String {
    strip_frontmatter(text)
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

// ───────────────────────── 搜索渠道 ─────────────────────────

fn append_channel(channels: &mut Vec<String>, channel: &str) {
    if !channels.iter().any(|c| c == channel) {
        channels.push(channel.to_string());
    }
}

fn dedupe_candidates(items: Vec<Candidate>) -> Vec<Candidate> {
    // 每个渠道先各留 4 条再合并。原来是纯按插入顺序取前 12 条，
    // 排在后面的 github-code 永远被 deepskill / skillhub 挤掉——
    // 明明代码搜索能命中，候选里却一条都不剩。
    const PER_CHANNEL: usize = 4;
    let mut out: Vec<Candidate> = Vec::new();
    let mut per_channel: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();

    for item in items.iter() {
        if item.url.trim().is_empty() || out.iter().any(|c| c.url.eq_ignore_ascii_case(&item.url)) {
            continue;
        }
        let used = per_channel.entry(item.channel.as_str()).or_insert(0);
        if *used >= PER_CHANNEL {
            continue;
        }
        *used += 1;
        out.push(item.clone());
    }

    // 还有名额就把刚才压掉的补回来（保持原顺序）
    if out.len() < MAX_SEARCH_CANDIDATES {
        for item in items {
            if out.len() >= MAX_SEARCH_CANDIDATES {
                break;
            }
            if item.url.trim().is_empty() || out.iter().any(|c| c.url.eq_ignore_ascii_case(&item.url)) {
                continue;
            }
            out.push(item);
        }
    }
    out.truncate(MAX_SEARCH_CANDIDATES);
    out
}

fn candidate_from_url(url: &str) -> Candidate {
    Candidate {
        channel: if is_git_repo_url(url) { "github" } else { "web" }.into(),
        title: url.to_string(),
        url: url.to_string(),
        snippet: "用户指定的上游地址".into(),
        download_name: String::new(),
    }
}

/// SkillHub（腾讯）走官方 CLI：`skillhub search <q> --json --no-select`。
/// 返回里带 repo_url，正好能落回 git 坐标（形如 .../repo#skills~name，取 # 前那段）。
/// GitHub 代码搜索：技能多半是某个大仓库里的子目录（skills/<name>/SKILL.md），
/// 按仓库搜永远搜不到，必须搜代码内容 + filename:SKILL.md。
fn search_github_code(query: &str) -> Vec<Candidate> {
    let q = url_encode(&format!("{query} filename:SKILL.md"));
    let out = crate::ahub::store::silent_command("gh")
        .args(["api", &format!("search/code?q={q}&per_page=5")])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for item in value.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let repo = item.pointer("/repository/full_name").and_then(|v| v.as_str()).unwrap_or("");
        let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let dir = path.strip_suffix("/SKILL.md").unwrap_or(path);
        if repo.is_empty() || dir.is_empty() {
            continue;
        }
        found.push(Candidate {
            channel: "github-code".into(),
            title: repo.to_string(),
            url: format!("https://github.com/{repo}/tree/HEAD/{dir}"),
            snippet: format!("代码命中：{path}"),
            download_name: String::new(),
        });
    }
    found
}

fn search_skillhub(query: &str) -> Vec<Candidate> {
    // skillhub 在 Windows 上是 .cmd 垫片，CreateProcess 直接起不来，
    // 必须经由 cmd /C。之前这里静默返回空，SkillHub 渠道等于从没生效过。
    #[cfg(windows)]
    let mut command = {
        let mut cmd = crate::ahub::store::silent_command("cmd");
        cmd.args(["/C", "skillhub"]);
        cmd
    };
    #[cfg(not(windows))]
    let mut command = crate::ahub::store::silent_command("skillhub");
    let out = command
        .args(["search", query, "--limit", "5", "--json", "--no-select"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for item in items {
        let slug = item.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or(slug);
        let repo = item.get("repo_url").and_then(|v| v.as_str()).unwrap_or("");
        let url = repo.split('#').next().unwrap_or("").trim();
        if url.is_empty() {
            continue;
        }
        let author = item.get("author").and_then(|v| v.as_str()).unwrap_or("");
        let category = item.get("category").and_then(|v| v.as_str()).unwrap_or("");
        found.push(Candidate {
            channel: "skillhub".into(),
            title: name.to_string(),
            url: url.to_string(),
            snippet: format!("SkillHub · {author} · {category}"),
            download_name: slug.to_string(),
        });
    }
    found
}

fn search_deepskill(query: &str) -> Vec<Candidate> {
    let url = format!(
        "https://www.deepskill.market/api/v1/skills/search/deep?query={}&ref=skillhub",
        url_encode(query)
    );
    let Ok(value) = http_json(&url) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Some(groups) = value.pointer("/data/items").and_then(|v| v.as_array()) else {
        return out;
    };
    for group in groups {
        let skills = group
            .get("skills")
            .and_then(|v| v.as_array())
            .cloned()
            .or_else(|| group.as_array().cloned())
            .unwrap_or_default();
        for skill in skills {
            let name = skill.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let description = skill.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let downloads = skill.get("downloadCount").and_then(|v| v.as_i64()).unwrap_or(0);
            out.push(Candidate {
                channel: "deepskill".into(),
                title: name.to_string(),
                url: format!(
                    "https://www.deepskill.market/skill/skill?name={}",
                    url_encode(name)
                ),
                snippet: format!("{description} · 下载 {downloads}"),
                download_name: name.to_string(),
            });
        }
    }
    out
}

fn search_github(query: &str) -> Vec<Candidate> {
    let url = format!(
        "https://api.github.com/search/repositories?q={}&per_page=5",
        url_encode(&format!("{query} skill"))
    );
    let Ok(value) = http_json(&url) else {
        return Vec::new();
    };
    value
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item.get("html_url").and_then(|v| v.as_str())?;
                    Some(Candidate {
                        channel: "github".into(),
                        title: item
                            .get("full_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(url)
                            .to_string(),
                        url: url.to_string(),
                        snippet: item
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        download_name: String::new(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn search_web(query: &str) -> Vec<Candidate> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        url_encode(query)
    );
    let Ok(html) = http_text(&url) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = html.as_str();
    let marker = "class=\"result__a\" href=\"";
    while let Some(pos) = rest.find(marker) {
        let after = &rest[pos + marker.len()..];
        let Some(end) = after.find('"') else { break };
        let href = decode_entities(&after[..end]);
        let target = duck_target(&href);
        let tail = &after[end + 1..];
        let title = tail
            .find('>')
            .and_then(|s| tail[s + 1..].find("</a>").map(|e| &tail[s + 1..s + 1 + e]))
            .map(|s| clean_html_text(s))
            .unwrap_or_default();
        if target.starts_with("http") {
            out.push(Candidate {
                channel: "web".into(),
                title: if title.is_empty() { target.clone() } else { title },
                url: target,
                snippet: String::new(),
                download_name: String::new(),
            });
        }
        rest = &after[end + 1..];
        if out.len() >= 5 {
            break;
        }
    }
    out
}

fn duck_target(href: &str) -> String {
    if let Some(pos) = href.find("uddg=") {
        let rest = &href[pos + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        return percent_decode(&rest[..end]);
    }
    if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    }
}

// ───────────────────────── 下载与准备 ─────────────────────────

struct Prepared {
    path: PathBuf,
    text: String,
    name: String,
    kind: String,
    mode: String,
    rewrite: bool,
}

fn prepare_candidate(
    task_dir: &Path,
    dir_name: &str,
    candidate: &Candidate,
    local_text: &str,
) -> Result<Prepared, String> {
    let dest = task_dir.join(dir_name);
    let _ = std::fs::remove_dir_all(&dest);

    if candidate.channel == "deepskill" {
        let name = if candidate.download_name.is_empty() {
            candidate.title.as_str()
        } else {
            candidate.download_name.as_str()
        };
        download_deepskill(name, task_dir, &dest)?;
        let text = std::fs::read_to_string(dest.join("SKILL.md")).unwrap_or_default();
        return Ok(Prepared {
            path: dest,
            text,
            name: name.to_string(),
            kind: "deepskill".into(),
            mode: "web".into(),
            rewrite: false,
        });
    }

    if let Some(repo) = git_repo_root(&candidate.url) {
        let raw = task_dir.join("repo");
        let _ = std::fs::remove_dir_all(&raw);
        let out = store::silent_command("git")
            .args(["clone", "--depth", "1", &repo])
            .arg(&raw)
            .output();
        let out = out.map_err(|_| "git 不可用（未安装或不在 PATH）".to_string())?;
        if !out.status.success() {
            return Err(format!(
                "git clone 失败：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let skill_dir = find_skill_dir(&raw, dir_name)
            .ok_or_else(|| "上游仓库里没有找到含 SKILL.md 的技能目录".to_string())?;
        copy_dir_all(&skill_dir, &dest)?;
        let text = std::fs::read_to_string(dest.join("SKILL.md")).unwrap_or_default();
        return Ok(Prepared {
            path: dest,
            text,
            name: dir_name.to_string(),
            kind: "github".into(),
            mode: "git-scan".into(),
            rewrite: false,
        });
    }

    // 网页 / 单文件 SKILL.md / 书籍 URI：交给 AI 读取并重写正文。
    let url = normalize_raw_url(&candidate.url);
    let text = fetch_reference(&url)?;
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let original = if local_text.trim().is_empty() {
        "# ".to_string() + &candidate.title
    } else {
        local_text.to_string()
    };
    std::fs::write(dest.join("SKILL.md"), &original).map_err(|e| e.to_string())?;
    Ok(Prepared {
        path: dest,
        text,
        name: candidate.title.clone(),
        kind: "web".into(),
        mode: "web".into(),
        rewrite: true,
    })
}

fn download_deepskill(name: &str, task_dir: &Path, dest: &Path) -> Result<(), String> {
    let url = format!(
        "https://www.deepskill.market/api/v1/skills/download/public?name={}",
        url_encode(name)
    );
    let bytes = http_bytes(&url)?;
    if bytes.starts_with(b"PK\x03\x04") {
        let raw = task_dir.join("deepskill-raw");
        let _ = std::fs::remove_dir_all(&raw);
        extract_zip(&bytes, &raw)?;
        let skill_dir = find_skill_dir(&raw, name)
            .ok_or_else(|| "下载包中没有找到 SKILL.md".to_string())?;
        copy_dir_all(&skill_dir, dest)?;
    } else {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        std::fs::write(dest.join("SKILL.md"), bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec()))
        .map_err(|e| format!("无法读取下载包：{e}"))?;
    if archive.len() > 3000 {
        return Err("下载包条目过多，已拒绝".into());
    }
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file
            .name()
            .map_err(|e| e.to_string())?
            .replace('\\', "/");
        if name.starts_with('/') || name.contains(':') || name.split('/').any(|p| p == "..") {
            return Err("下载包包含非法路径，已拒绝".into());
        }
        total += file.size();
        if total > 64 * 1024 * 1024 {
            return Err("下载包解压后过大，已拒绝".into());
        }
        let out = dest.join(&name);
        if name.ends_with('/') {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn find_skill_dir(root: &Path, expected: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        if depth > 5 || out.len() >= 100 {
            return;
        }
        if dir.join("SKILL.md").is_file() {
            out.push(dir.to_path_buf());
            return;
        }
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if path.is_dir() {
                walk(&path, depth + 1, out);
            }
        }
    }
    walk(root, 0, &mut dirs);
    let want = normalize_name(expected);
    let name_of = |d: &PathBuf| normalize_name(&d.file_name().unwrap_or_default().to_string_lossy());
    dirs.iter()
        .find(|d| name_of(d) == want)
        // 目录名常被加工过：baozheng-skills ↔ baozheng，允许前缀互相包含
        .or_else(|| dirs.iter().find(|d| {
            let have = name_of(d);
            !have.is_empty() && (want.starts_with(&have) || have.starts_with(&want))
        }))
        .cloned()
        .or_else(|| dirs.first().cloned())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy() == ".git" {
            continue;
        }
        let path = entry.path();
        let target = dst.join(&name);
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if path.is_dir() {
            copy_dir_all(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn compose_skill(original: &str, body: &str) -> String {
    let norm = original.replace("\r\n", "\n");
    let clean_body = strip_frontmatter(body);
    let body = clean_body.trim();
    if norm.starts_with("---\n") {
        if let Some(rel) = norm[4..].find("\n---") {
            let end = 4 + rel + 4;
            return format!("{}\n\n{}\n", &norm[..end], body);
        }
    }
    format!("{body}\n")
}

fn strip_frontmatter(text: &str) -> String {
    let norm = text.replace("\r\n", "\n");
    if norm.starts_with("---\n") {
        if let Some(rel) = norm[4..].find("\n---") {
            let end = 4 + rel + 4;
            return norm[end..].trim_start_matches('\n').to_string();
        }
    }
    norm
}

// ───────────────────────── HTTP / URL ─────────────────────────

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(35))
        .user_agent("NimbusDesk/0.1 (Skill Update)")
        .build()
}

fn http_json(url: &str) -> Result<Value, String> {
    let resp = agent().get(url).call().map_err(|e| e.to_string())?;
    resp.into_json::<Value>().map_err(|e| e.to_string())
}

fn http_text(url: &str) -> Result<String, String> {
    let resp = agent().get(url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader().take(4 * 1024 * 1024);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn http_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = agent().get(url).call().map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader().take(MAX_HTTP_BYTES);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("下载内容为空".into());
    }
    Ok(bytes)
}

fn fetch_reference(url: &str) -> Result<String, String> {
    let bytes = http_bytes(url)?;
    if bytes.starts_with(b"%PDF") {
        let mut document = lopdf::Document::load_mem(&bytes)
            .map_err(|_| "PDF 无法读取，文件可能损坏或使用不支持的结构".to_string())?;
        if document.is_encrypted() {
            document
                .decrypt("")
                .map_err(|_| "PDF 已加密，无法读取正文".to_string())?;
        }
        let pages: Vec<u32> = document.get_pages().keys().copied().collect();
        let text = document
            .extract_text(&pages)
            .map_err(|_| "PDF 无法提取正文，可能是扫描件".to_string())?;
        if text.trim().is_empty() {
            return Err("PDF 没有可提取的文本层".into());
        }
        return Ok(text);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.trim().is_empty() {
        return Err("上游地址没有返回内容".into());
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("<html") || lower.contains("<body") {
        Ok(clean_html_text(&text))
    } else {
        Ok(text)
    }
}

fn normalize_raw_url(url: &str) -> String {
    // github.com/{owner}/{repo}/blob/{branch}/{path} → raw.githubusercontent.com/...
    if let Some(rest) = url.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 5 && parts[2] == "blob" {
            let owner = parts[0];
            let repo = parts[1];
            let branch = parts[3];
            let path = parts[4..].join("/");
            return format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}");
        }
    }
    url.to_string()
}

fn git_repo_root(url: &str) -> Option<String> {
    let clean = url.trim().trim_end_matches('/');
    if clean.starts_with("git@") {
        return Some(clean.to_string());
    }
    let lower = clean.to_ascii_lowercase();
    if !(lower.starts_with("https://github.com/") || lower.starts_with("https://gitlab.com/")) {
        return None;
    }
    let parts: Vec<&str> = clean.split('/').collect();
    // https: / '' / host / owner / repo / ...
    if parts.len() < 5 {
        return None;
    }
    if parts.len() > 5 && parts[5] == "blob" {
        return None; // 单文件页面交给 web 抓取，避免为一份 SKILL.md clone 整个仓库
    }
    Some(parts[..5].join("/"))
}

fn is_git_repo_url(url: &str) -> bool {
    git_repo_root(url).is_some()
}

fn normalize_name(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .replace(' ', "-")
        .replace('_', "-")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || ('\u{4e00}'..='\u{9fa5}').contains(c))
        .collect()
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn clean_html_text(value: &str) -> String {
    let mut text = value.to_string();
    for (open, close) in [("<script", "</script>"), ("<style", "</style>")] {
        while let Some(start) = text.to_ascii_lowercase().find(open) {
            let Some(end) = text[start..].to_ascii_lowercase().find(close) else {
                break;
            };
            text.replace_range(start..start + end + close.len(), " ");
        }
    }
    let mut out = String::new();
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect::<String>() + "…"
}

/// 供上游检查记录网页型来源的指纹（同一套哈希也用于 web 模式）。
pub fn content_fingerprint(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_reports_changed_added_removed_and_ignores_own_files() {
        let base = std::env::temp_dir().join(format!(
            "ah-preview-diff-{}-{}",
            std::process::id(),
            crate::ahub::models::new_id()
        ));
        let local = base.join("local");
        let candidate = base.join("remote");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&candidate).unwrap();
        std::fs::write(local.join("SKILL.md"), "body v1").unwrap();
        std::fs::write(candidate.join("SKILL.md"), "body v2").unwrap();
        std::fs::write(local.join("gone.md"), "old").unwrap();
        std::fs::write(candidate.join("new.md"), "fresh").unwrap();
        // 应用自己维护的元数据不参与比较
        std::fs::write(local.join(".hub.json"), "{\"versions\":1}").unwrap();
        std::fs::write(candidate.join("SKILL.toml"), "[source]\n").unwrap();

        let (changed, added, removed) = diff_dirs(&local, &candidate);
        assert_eq!(changed, vec!["SKILL.md".to_string()]);
        assert_eq!(added, vec!["new.md".to_string()]);
        assert_eq!(removed, vec!["gone.md".to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn strategy_names_are_stable() {
        assert_eq!(parse_strategy("").unwrap(), ApplyStrategy::UseRemote);
        assert_eq!(parse_strategy("keep-mine").unwrap(), ApplyStrategy::KeepMine);
        assert_eq!(parse_strategy("keep-both").unwrap(), ApplyStrategy::KeepBoth);
        assert!(parse_strategy("nonsense").is_err());
    }

    #[test]
    fn normalizes_git_urls() {
        assert_eq!(
            git_repo_root("https://github.com/acme/skills/tree/main/pdf").as_deref(),
            Some("https://github.com/acme/skills")
        );
        assert!(git_repo_root("https://example.com/book").is_none());
    }

    #[test]
    fn keeps_frontmatter_when_rewriting_body() {
        let old = "---\nname: pdf\ndescription: x\n---\n\nold";
        assert_eq!(compose_skill(old, "new body"), "---\nname: pdf\ndescription: x\n---\n\nnew body\n");
    }

    #[test]
    fn keyword_queries_expand_slug_and_description() {
        let q = keyword_queries("baozheng-skills", "包括 Skills 你身边的专家律师团，专业法律咨询与合同审查");
        assert!(q.iter().any(|x| x == "baozheng skills"), "要有空格分词版：{q:?}");
        assert!(q.iter().any(|x| x.contains("法律咨询")), "要有中文领域词：{q:?}");
        assert!(q.len() <= 4, "最多 4 条：{q:?}");
    }

    #[test]
    #[ignore = "需要 gh 已登录与网络；用 --ignored 手动跑"]
    fn github_code_finds_subdirectory_skill() {
        let hits = search_github_code("baozheng");
        assert!(!hits.is_empty(), "GitHub 代码搜索没命中");
        assert!(
            hits.iter().any(|c| c.url.contains("legal-skillhub") || c.url.contains("baozheng")),
            "应命中子目录技能：{hits:?}"
        );
    }

    #[test]
    fn parses_fenced_json() {
        let v = parse_json("```json\n{\"confidence\":0.8}\n```").unwrap();
        assert_eq!(v["confidence"], 0.8);
    }

    #[test]
    fn parses_json_with_prose_and_braces_in_body() {
        // 模型把正文里的花括号写进字符串，且前后夹解释 —— 旧的 rfind('}') 会切错位置
        let raw = "好的，结果如下：\n{\"sameSkill\":true,\"confidence\":0.9,\"updatedBody\":\"# 标题\\n\\n```rust\\nfn main() {}\\n```\"}\n希望有帮助。";
        let v = parse_json(raw).unwrap();
        assert_eq!(v["sameSkill"], true);
        assert_eq!(v["confidence"], 0.9);
    }

    #[test]
    fn parses_unfenced_json_between_noise() {
        let v = parse_json("前言 {\"index\":2} 后记").unwrap();
        assert_eq!(v["index"], 2);
    }

    #[test]
    fn reports_truncation_instead_of_generic_error() {
        let err = parse_json("{\"updatedBody\":\"# 标题\\n未闭合").unwrap_err();
        assert!(err.contains("截断"), "应指出截断而不是笼统的格式错误：{err}");
    }

    #[test]
    fn finds_install_hint_in_local_docs() {
        let dir = std::env::temp_dir().join(format!("dz-hint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let body = "# 邮件\n\n## 安装和配置\n\n### 第 2 步 - 安装/更新 skill\n\n```bash\nnpx skills add https://agent.qq.com --skill -g -y\n```\n";
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
        let hints = local_upstream_hints(&dir, body);
        assert!(
            hints.iter().any(|h| h.url == "https://agent.qq.com"),
            "应认出 npx skills add 里的地址：{hints:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compares_bodies_ignoring_frontmatter() {
        let a = "---\nname: x\n---\n\n# 标题\n\n正文";
        let b = "---\nname: x\nversion: 2\n---\n\n# 标题\n\n正文\n";
        assert!(same_skill_text(a, b));
        assert!(!same_skill_text(a, "---\nname: x\n---\n\n# 别的"));
    }
}
