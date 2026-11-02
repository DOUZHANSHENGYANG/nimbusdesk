//! SSEP 上游漂移检测：[source.upstream] watch=true
//!
//! 判定依据分三层，越靠后越贵：
//! 1. 本地装的是哪一版 —— `revision`（安装/更新时记下的 commit）；
//! 2. 远端现在是什么版本 —— 同一个 remote 一批技能只跑一次 `ls-remote`；
//! 3. 仓库动了、本技能子目录动没动 —— `subtree_sha` 对比，靠一次无 blob 克隆取树对象。
//!
//! `content_hash` 是本地文件内容指纹，回答的是「用户改过没有」，跟「上游变没变」不是一回事。
use crate::ahub::skill_toml;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 一次检查最多同时连几个远端。
const MAX_CONCURRENT_REMOTES: usize = 6;

/// 应用自己维护、不算「技能内容」的文件：写它们不算用户改动。
const OWN_FILES: [&str; 2] = [".hub.json", "SKILL.toml"];

/// 逐文件指纹最多记这么多；超了只留聚合指纹，免得 SKILL.toml 被写成一部清单。
const MAX_TRACKED_FILES: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamReport {
    pub watched: bool,
    pub mode: String,
    pub remote: String,
    pub remote_head: String,
    pub last_head: String,
    /// 本地这份内容对应的上游修订（安装/更新时记下的）
    pub installed_revision: String,
    pub changed: bool,
    /// 仓库有新提交，但本技能所在子目录没变
    pub subtree_unchanged: bool,
    /// 未跟踪时：本地文档里能推出一个上游地址（可一键补全）
    pub hint_remote: String,
    pub hint_mode: String,
    /// 证据强（安装说明 / frontmatter / 本地 git 远端）还是弱（正文里顺手提到的链接）
    pub hint_strong: bool,
    pub hint_evidence: String,
    pub note: String,
    pub checked_at: String,
}

/// 从本地证据推出来的上游候选。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    /// 归一化后的远端地址（github tree URL 会折回仓库根）
    pub remote: String,
    pub mode: String,
    /// 技能在仓库里的子目录
    pub subpath: String,
    /// tree/<ref> 里的 ref（分支/标签），可能为空
    pub ref_hint: String,
    /// 本地 git 能直接给出的提交
    pub revision: String,
    /// 本地 git 能直接给出的子树 sha（没有则为空）
    pub subtree_sha: String,
    /// 证据出处，形如 "README.md: git clone …"
    pub evidence: String,
    pub strong: bool,
}

/// 目录内容指纹：按相对路径排序逐个文件 SHA-256，跳过 `.git` 与应用自己的元数据。
/// 跳过自有文件是必须的 —— 否则每次写 .hub.json 都会让指纹变，永远显示「被改过」。
pub fn fingerprint(dir: &Path) -> String {
    let mut hasher = Sha256::new();
    for (rel, hash) in file_hashes(dir) {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update(hash.as_bytes());
        hasher.update([b'\n']);
    }
    format!("{:x}", hasher.finalize())
}

/// 逐个文件的 SHA-256（相对路径 → 十六进制）。装了多少文件都记，用来回答
/// 「我到底改了哪几个」；超过 `MAX_TRACKED_FILES` 就只记聚合指纹。
fn file_hashes(dir: &Path) -> std::collections::BTreeMap<String, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect(dir, dir, 0, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = std::collections::BTreeMap::new();
    for (rel, path) in files {
        let bytes = std::fs::read(&path).unwrap_or_default();
        out.insert(rel, format!("{:x}", Sha256::digest(&bytes)));
    }
    out
}

fn collect(root: &Path, dir: &Path, depth: u32, out: &mut Vec<(String, PathBuf)>) {
    if depth > 8 || out.len() >= 4000 {
        return;
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || OWN_FILES.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, depth + 1, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}

/// 安装/更新落盘后记账：这版内容来自哪个修订、哪个子目录、内容指纹是多少。
pub fn stamp(
    dir: &Path,
    remote: &str,
    mode: &str,
    revision: &str,
    subtree_path: &str,
    subtree_sha: &str,
) -> Result<(), String> {
    let mut doc = skill_toml::load(dir).unwrap_or_else(|| toml::Value::Table(Default::default()));
    let root = doc.as_table_mut().ok_or("SKILL.toml 根节点不是表")?;
    let src = root
        .entry("source".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let src = src.as_table_mut().ok_or("source 不是表")?;
    let up = src
        .entry("upstream".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let up = up.as_table_mut().ok_or("source.upstream 不是表")?;
    up.insert("watch".into(), toml::Value::Boolean(true));
    up.insert("mode".into(), toml::Value::String(mode.to_string()));
    up.insert("remote".into(), toml::Value::String(remote.to_string()));
    up.insert("revision".into(), toml::Value::String(revision.to_string()));
    up.insert("subtree_path".into(), toml::Value::String(subtree_path.to_string()));
    up.insert("subtree_sha".into(), toml::Value::String(subtree_sha.to_string()));
    up.insert("content_hash".into(), toml::Value::String(fingerprint(dir)));
    // 逐文件指纹：回答「我改了哪几个文件」，也给「保留我的」留出精确依据。
    let files = file_hashes(dir);
    if files.len() <= MAX_TRACKED_FILES {
        let mut table = toml::value::Table::new();
        for (rel, hash) in files {
            table.insert(rel, toml::Value::String(hash));
        }
        up.insert("files".into(), toml::Value::Table(table));
    } else {
        up.remove("files");
    }
    // 换了内容，旧的核验记录作废，下一次检查重新算。
    up.remove("remote_head");
    up.remove("checked_head");
    up.remove("last_check");
    let text = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(skill_toml::path_for(dir), text).map_err(|e| e.to_string())
}

/// 本地内容是否被改过：优先按逐文件指纹判，老技能退回聚合指纹。
/// 没记账时返回 `None` —— 不知道就别硬判。
pub fn local_modified(dir: &Path) -> Option<bool> {
    if let Some(changed) = local_changed(dir) {
        return Some(!changed.is_empty());
    }
    let doc = skill_toml::load(dir)?;
    let stored = skill_toml::get_str(&doc, "source.upstream.content_hash")?;
    if stored.trim().is_empty() {
        return None;
    }
    Some(fingerprint(dir) != stored)
}

/// 本地相对安装时改动 / 新增 / 删除的文件。没有逐文件记录时返回 `None`。
pub fn local_changed(dir: &Path) -> Option<Vec<String>> {
    let doc = skill_toml::load(dir)?;
    let stored = doc
        .get("source")
        .and_then(|s| s.get("upstream"))
        .and_then(|u| u.get("files"))
        .and_then(|f| f.as_table())?;
    if stored.is_empty() {
        return None;
    }
    let current = file_hashes(dir);
    let mut out: Vec<String> = Vec::new();
    for (path, hash) in &current {
        match stored.get(path).and_then(|value| value.as_str()) {
            Some(old) if old == hash => {}
            _ => out.push(path.clone()),
        }
    }
    for path in stored.keys() {
        if !current.contains_key(path) {
            out.push(path.clone());
        }
    }
    out.sort();
    out.dedup();
    Some(out)
}

/// 从本地证据推上游：本地 git 远端 > 安装说明/frontmatter 里的仓库地址 > 正文里提到的链接。
/// 一律只读，不改任何文件。
pub fn detect(dir: &Path) -> Vec<Hint> {
    let mut out: Vec<Hint> = Vec::new();
    let mut push = |hint: Hint| {
        if hint.remote.is_empty() || out.iter().any(|h| h.remote.eq_ignore_ascii_case(&hint.remote)) {
            return;
        }
        out.push(hint);
    };

    if let Some(hint) = local_repo_hint(dir) {
        push(hint);
    }

    let mut docs: Vec<(String, String)> = Vec::new();
    for name in ["SKILL.md", "README.md", "readme.md", "_meta.json", "skill.json"] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            docs.push((name.to_string(), text));
        }
    }
    for (file, text) in &docs {
        let fm_end = frontmatter_end(text);
        let mut offset = 0usize;
        for line in text.lines() {
            let start = offset;
            offset += line.len() + 1;
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.len() > 400 {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            let in_frontmatter = fm_end > 0 && start < fm_end;
            let mut urls = crate::ahub::skillupdate::urls_in(trimmed);
            if let Some(pos) = lower.find("npx skills add ") {
                let rest = &trimmed[pos + "npx skills add ".len()..];
                if let Some(first) = rest.split_whitespace().next() {
                    let token = first.trim_matches(|c: char| matches!(c, '`' | '"' | '\''));
                    urls.push(crate::ahub::skillupdate::normalize_hint_url(token));
                }
            }
            let declared = in_frontmatter
                && ["source", "repository", "repo", "homepage", "url", "git"]
                    .iter()
                    .any(|key| lower.starts_with(key));
            let install_section = ["npx skills add", "git clone", "install", "安装", "来源", "仓库", "repository", "source:"]
                .iter()
                .any(|needle| lower.contains(needle));
            for url in urls {
                let evidence = format!("{file}: {}", truncate(trimmed, 90));
                let hint = match split_repo_url(&url) {
                    Some((remote, subpath, ref_hint)) => Hint {
                        remote,
                        mode: "git-scan".into(),
                        subpath,
                        ref_hint,
                        revision: String::new(),
                        subtree_sha: String::new(),
                        evidence,
                        strong: declared || install_section,
                    },
                    None => Hint {
                        remote: url.clone(),
                        mode: "web".into(),
                        subpath: String::new(),
                        ref_hint: String::new(),
                        revision: String::new(),
                        subtree_sha: String::new(),
                        evidence,
                        // 普通网页链接（文档、博客、示例）只当线索：正文里提到不等于它是上游
                        strong: lower.contains("npx skills add"),
                    },
                };
                push(hint);
            }
        }
    }
    out.sort_by(|a, b| b.strong.cmp(&a.strong));
    out
}

/// 技能目录本身就是 git 仓库、或它记录的导入来源目录在 git 仓库里时，远端 + 修订是确定的事实。
///
/// 刻意**不**往上找最近的仓库根：开发时数据目录常常正好落在某个项目仓库里
///（`src-tauri/target/debug/data/...`），那样会把本项目当成所有技能的上游。
fn local_repo_hint(dir: &Path) -> Option<Hint> {
    let (root, subpath) = if dir.join(".git").exists() {
        (dir.to_path_buf(), String::new())
    } else {
        // 只认「导入来源路径」往上找仓库根，最多 4 层；绝不对技能目录本身这么干
        let doc = skill_toml::load(dir)?;
        let src = skill_toml::get_str(&doc, "source.ref")?;
        let anchor = PathBuf::from(src.trim());
        if !anchor.is_dir() {
            return None;
        }
        let root = nearest_repo(&anchor, 4)?;
        let subpath = anchor
            .strip_prefix(&root)
            .ok()
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        (root, subpath)
    };
    let remote = git_out(&root, &["remote", "get-url", "origin"])?;
    let (remote, _, _) = split_repo_url(&remote)?;
    let revision = git_out(&root, &["rev-parse", "HEAD"]).unwrap_or_default();
    let subtree_sha = if revision.is_empty() || subpath.is_empty() {
        String::new()
    } else {
        git_out(&root, &["rev-parse", &format!("{revision}:{subpath}")]).unwrap_or_default()
    };
    Some(Hint {
        remote,
        mode: "git-scan".into(),
        subpath,
        ref_hint: String::new(),
        revision,
        subtree_sha,
        evidence: format!("本地 git 工作区：{}", root.to_string_lossy()),
        strong: true,
    })
}

fn nearest_repo(path: &Path, max_up: usize) -> Option<PathBuf> {
    let mut current = Some(path);
    for _ in 0..=max_up {
        let dir = current?;
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn git_out(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::ahub::store::silent_command("git")
        .args(["-C"])
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// `https://github.com/o/r/tree/main/skills/x` → (`https://github.com/o/r`, `skills/x`, `main`)
fn split_repo_url(url: &str) -> Option<(String, String, String)> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    let host = ["github.com", "gitlab.com", "gitee.com", "codeberg.org"]
        .into_iter()
        .find(|host| lower.contains(&format!("//{host}/")))?;
    let start = lower.find(&format!("//{host}/"))? + host.len() + 3;
    let path = url[start..].split(['?', '#']).next().unwrap_or("");
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    let owner = segs[0];
    let repo = segs[1].trim_end_matches(".git");
    if repo.is_empty() {
        return None;
    }
    let mut subpath = String::new();
    let mut ref_hint = String::new();
    if segs.len() > 3 && (segs[2] == "tree" || segs[2] == "blob") {
        ref_hint = segs[3].to_string();
        subpath = segs[4..].join("/");
    }
    Some((format!("https://{host}/{owner}/{repo}"), subpath, ref_hint))
}

fn frontmatter_end(text: &str) -> usize {
    if !text.starts_with("---") {
        return 0;
    }
    let mut offset = 3;
    for line in text.lines().skip(1) {
        offset += line.len() + 1;
        if line.trim() == "---" {
            return offset;
        }
    }
    0
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect::<String>() + "…"
}

/// 腾讯 SkillHub 上架过的技能带着 `_skillhub_meta.json`（或 `_meta.json` 里的 ownerId+slug）。
/// 用官方 CLI 搜一次就能拿到 git 坐标（repo + 仓库内子目录），比猜正文链接准得多。
fn skillhub_hint(dir: &Path) -> Option<Hint> {
    let mut slug = String::new();
    let mut name = String::new();
    if let Ok(text) = std::fs::read_to_string(dir.join("_skillhub_meta.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            slug = value.get("slug").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            name = value.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        }
    }
    if slug.is_empty() {
        if let Ok(text) = std::fs::read_to_string(dir.join("_meta.json")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if value.get("ownerId").is_some() {
                    slug = value.get("slug").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                }
            }
        }
    }
    if slug.trim().is_empty() {
        return None;
    }

    #[cfg(windows)]
    let mut command = {
        let mut cmd = crate::ahub::store::silent_command("cmd");
        cmd.args(["/C", "skillhub"]);
        cmd
    };
    #[cfg(not(windows))]
    let mut command = crate::ahub::store::silent_command("skillhub");
    let out = command
        .args(["search", &slug, "--limit", "20", "--json", "--no-select"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let start = text.find('[')?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&text[start..]).ok()?;
    let dir_name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let wanted = [slug.as_str(), name.as_str(), dir_name.as_str()];
    let hit = items.iter().find(|item| {
        let item_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let item_slug = item.get("slug").and_then(|v| v.as_str()).unwrap_or("");
        wanted.iter().any(|want| {
            !want.is_empty() && (item_name.eq_ignore_ascii_case(want) || item_slug.eq_ignore_ascii_case(want))
        })
    })?;
    let repo_url = hit.get("repo_url").and_then(|v| v.as_str()).unwrap_or("");
    let repo = repo_url.split('#').next().unwrap_or("").trim();
    let (remote, _, _) = split_repo_url(repo)?;
    // `...#skills~author~dir` → 仓库内路径 skills/author/dir
    let subpath = repo_url
        .split_once('#')
        .map(|(_, fragment)| fragment.replace('~', "/"))
        .unwrap_or_default();
    Some(Hint {
        remote,
        mode: "git-scan".into(),
        subpath,
        ref_hint: String::new(),
        revision: String::new(),
        subtree_sha: String::new(),
        evidence: format!("SkillHub 市场：{slug}"),
        strong: true,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillItem {
    pub dir_name: String,
    pub remote: String,
    pub mode: String,
    pub subpath: String,
    pub evidence: String,
    pub applied: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReport {
    pub filled: usize,
    pub weak: usize,
    pub items: Vec<BackfillItem>,
}

/// 给一批技能补上可推导的上游。已有上游的跳过；`apply_weak` 为假时只挂强证据，
/// `resolve_marketplace` 为真时允许联网问一次 SkillHub（单行点「补全」才这么做）。
pub fn backfill(root: &Path, names: &[String], apply_weak: bool, resolve_marketplace: bool) -> BackfillReport {
    let mut report = BackfillReport { filled: 0, weak: 0, items: Vec::new() };
    for name in names {
        let dir = root.join(name);
        if !dir.is_dir() {
            continue;
        }
        let existing = skill_toml::load(&dir)
            .and_then(|doc| skill_toml::get_str(&doc, "source.upstream.remote"))
            .unwrap_or_default();
        if !existing.trim().is_empty() {
            continue;
        }
        let hints = detect(&dir);
        let market = if resolve_marketplace { skillhub_hint(&dir) } else { None };
        let chosen = hints
            .iter()
            .find(|hint| hint.strong)
            .cloned()
            .or(market)
            .or_else(|| if apply_weak { hints.first().cloned() } else { None });
        let Some(hint) = chosen else {
            if let Some(first) = hints.first() {
                report.weak += 1;
                report.items.push(BackfillItem {
                    dir_name: name.clone(),
                    remote: first.remote.clone(),
                    mode: first.mode.clone(),
                    subpath: first.subpath.clone(),
                    evidence: first.evidence.clone(),
                    applied: false,
                    note: "只有弱证据（正文里提到的链接），需要人工确认".into(),
                });
            }
            continue;
        };
        match stamp(&dir, &hint.remote, &hint.mode, &hint.revision, &hint.subpath, &hint.subtree_sha) {
            Ok(()) => {
                report.filled += 1;
                report.items.push(BackfillItem {
                    dir_name: name.clone(),
                    remote: hint.remote.clone(),
                    mode: hint.mode.clone(),
                    subpath: hint.subpath.clone(),
                    evidence: hint.evidence.clone(),
                    applied: true,
                    note: String::new(),
                });
            }
            Err(error) => report.items.push(BackfillItem {
                dir_name: name.clone(),
                remote: hint.remote.clone(),
                mode: hint.mode.clone(),
                subpath: hint.subpath.clone(),
                evidence: hint.evidence.clone(),
                applied: false,
                note: error,
            }),
        }
    }
    report
}

pub fn check(dir: &Path) -> Result<UpstreamReport, String> {
    match check_batch(vec![dir.to_path_buf()]).pop() {
        Some((_, Ok(report))) => Ok(report),
        Some((_, Err(error))) => Err(error),
        None => Err("没有可检查的技能".into()),
    }
}

struct Target {
    dir: PathBuf,
    cfg: Result<Cfg, String>,
}

struct Cfg {
    watched: bool,
    mode: String,
    remote: String,
    last_head: String,
    checked_head: String,
    installed: String,
    subtree_path: String,
    subtree_sha: String,
}

impl Cfg {
    fn load(dir: &Path) -> Result<Cfg, String> {
        let doc = skill_toml::load(dir).ok_or("该技能未接入 SKILL.toml 协议")?;
        let get = |path: &str| skill_toml::get_str(&doc, path).unwrap_or_default();
        Ok(Cfg {
            watched: doc
                .get("source")
                .and_then(|s| s.get("upstream"))
                .and_then(|u| u.get("watch"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false),
            mode: get("source.upstream.mode"),
            remote: get("source.upstream.remote"),
            last_head: get("source.upstream.remote_head"),
            checked_head: get("source.upstream.checked_head"),
            installed: get("source.upstream.revision"),
            subtree_path: get("source.upstream.subtree_path"),
            subtree_sha: get("source.upstream.subtree_sha"),
        })
    }

    /// 只看本地信息就能断定「不用再联网」的情形。
    fn needs_remote(&self) -> bool {
        self.watched && !self.remote.is_empty() && self.mode == "git-scan"
    }
}

/// 批量检查：同一个 remote 只连一次；返回顺序与入参一致，单条失败不影响其它条。
pub fn check_batch(dirs: Vec<PathBuf>) -> Vec<(PathBuf, Result<UpstreamReport, String>)> {
    let targets: Vec<Target> = dirs
        .into_iter()
        .map(|dir| {
            let cfg = Cfg::load(&dir);
            Target { dir, cfg }
        })
        .collect();

    let mut remotes: Vec<String> = targets
        .iter()
        .filter_map(|t| t.cfg.as_ref().ok())
        .filter(|cfg| cfg.needs_remote())
        .map(|cfg| cfg.remote.clone())
        .collect();
    remotes.sort();
    remotes.dedup();

    // 第一层：每个远端一次 ls-remote。
    let mut heads: HashMap<String, Result<String, String>> = HashMap::new();
    for chunk in remotes.chunks(MAX_CONCURRENT_REMOTES) {
        let resolved: Vec<(String, Result<String, String>)> = std::thread::scope(|scope| {
            chunk
                .iter()
                .map(|remote| {
                    let remote = remote.clone();
                    scope.spawn(move || {
                        let head = ls_remote_head(&remote);
                        (remote, head)
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect()
        });
        for (remote, head) in resolved {
            heads.insert(remote, head);
        }
    }

    // 第二层：HEAD 变了、且本地记了子树指纹的，才去取远端子树 sha（每个远端一次无 blob 克隆）。
    let mut wanted: HashMap<String, Vec<String>> = HashMap::new();
    for target in &targets {
        let Ok(cfg) = &target.cfg else { continue };
        if !cfg.needs_remote() || cfg.subtree_sha.is_empty() || cfg.subtree_path.is_empty() {
            continue;
        }
        let Some(head) = heads.get(&cfg.remote).and_then(|r| r.as_ref().ok()) else {
            continue;
        };
        if *head == cfg.installed || *head == cfg.last_head || *head == cfg.checked_head {
            continue;
        }
        wanted.entry(cfg.remote.clone()).or_default().push(cfg.subtree_path.clone());
    }
    let mut trees: HashMap<(String, String), Result<String, String>> = HashMap::new();
    let wanted: Vec<(String, Vec<String>)> = wanted.into_iter().collect();
    for chunk in wanted.chunks(MAX_CONCURRENT_REMOTES) {
        let resolved: Vec<((String, String), Result<String, String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(remote, paths)| {
                    let remote = remote.clone();
                    let paths = paths.clone();
                    let head = heads.get(remote.as_str()).and_then(|r| r.clone().ok()).unwrap_or_default();
                    scope.spawn(move || (remote, head, paths))
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .flat_map(|(remote, head, paths)| {
                    let sha = subtree_shas(&remote, &head, &paths);
                    paths
                        .into_iter()
                        .map(move |path| {
                            let value = sha
                                .get(&path)
                                .cloned()
                                .unwrap_or_else(|| Err("未取到子树指纹".into()));
                            ((remote.clone(), path), value)
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        });
        for (key, value) in resolved {
            trees.insert(key, value);
        }
    }

    let checked_at = crate::ahub::models::now_iso();
    targets
        .into_iter()
        .map(|target| {
            let report = match &target.cfg {
                Err(error) => Err(error.clone()),
                Ok(cfg) => evaluate(&target.dir, cfg, &heads, &trees, &checked_at),
            };
            (target.dir, report)
        })
        .collect()
}

fn evaluate(
    dir: &Path,
    cfg: &Cfg,
    heads: &HashMap<String, Result<String, String>>,
    trees: &HashMap<(String, String), Result<String, String>>,
    checked_at: &str,
) -> Result<UpstreamReport, String> {
    let mut report = UpstreamReport {
        watched: cfg.watched,
        mode: cfg.mode.clone(),
        remote: cfg.remote.clone(),
        remote_head: String::new(),
        last_head: cfg.last_head.clone(),
        installed_revision: cfg.installed.clone(),
        changed: false,
        subtree_unchanged: false,
        hint_remote: String::new(),
        hint_mode: String::new(),
        hint_strong: false,
        hint_evidence: String::new(),
        note: String::new(),
        checked_at: checked_at.to_string(),
    };
    // 没配置上游时，顺手把本地能推出来的地址带上，界面就能给「补全上游」而不是干瞪眼
    if cfg.remote.is_empty() {
        if let Some(hint) = detect(dir).into_iter().next() {
            report.hint_remote = hint.remote;
            report.hint_mode = hint.mode;
            report.hint_strong = hint.strong;
            report.hint_evidence = hint.evidence;
        }
    }
    if !cfg.watched {
        report.note = "未开启上游追踪（[source.upstream].watch = false）".into();
        return Ok(report);
    }
    if cfg.remote.is_empty() {
        report.note = "未配置上游地址（[source.upstream].remote）".into();
        return Ok(report);
    }

    match cfg.mode.as_str() {
        "git-scan" => {
            let head = match heads.get(&cfg.remote) {
                Some(Ok(head)) => head.clone(),
                Some(Err(note)) => {
                    report.note = note.clone();
                    return Ok(report);
                }
                None => {
                    report.note = "未解析远端版本".into();
                    return Ok(report);
                }
            };
            report.remote_head = head.clone();
            let mut verified_head = false;
            if !cfg.installed.is_empty() && cfg.installed == head {
                report.note = "上游无更新（与安装版本一致）".into();
                verified_head = true;
            } else if !cfg.last_head.is_empty() && cfg.last_head == head {
                report.note = "上游无更新（与上次检查同一提交）".into();
                verified_head = true;
            } else if cfg.checked_head == head {
                report.note = "上游无更新（上次核验过这个提交）".into();
                verified_head = true;
            } else if !cfg.subtree_sha.is_empty() && !cfg.subtree_path.is_empty() {
                match trees.get(&(cfg.remote.clone(), cfg.subtree_path.clone())) {
                    Some(Ok(sha)) if *sha == cfg.subtree_sha => {
                        report.subtree_unchanged = true;
                        report.note = "仓库有新提交，本技能目录未变".into();
                        verified_head = true;
                    }
                    Some(Ok(_)) => {
                        report.changed = true;
                        report.note = "本技能目录已更新".into();
                    }
                    _ => {
                        report.changed = true;
                        report.note = "无法比对子目录，按仓库 HEAD 判定".into();
                    }
                }
            } else {
                report.changed = true;
                report.note = "未记录安装修订，按仓库 HEAD 判定".into();
            }
            write_check(dir, &head, checked_at, verified_head)?;
        }
        "web" => {
            let head = match web_head(&cfg.remote) {
                Ok(head) => head,
                Err(note) => {
                    report.note = note;
                    return Ok(report);
                }
            };
            if head.is_empty() {
                report.note = "无法解析上游指纹".into();
                return Ok(report);
            }
            report.remote_head = head.clone();
            report.changed = !cfg.last_head.is_empty() && cfg.last_head != head;
            report.note = if cfg.last_head.is_empty() {
                "首次记录网页内容指纹".into()
            } else if report.changed {
                "上游页面内容已变化".into()
            } else {
                "上游无更新".into()
            };
            write_check(dir, &head, checked_at, !report.changed)?;
        }
        other => {
            report.note = format!("mode={other}：支持 git-scan / web + remote");
        }
    }
    Ok(report)
}

/// 写回检查结果。只有「确认过这份内容就是最新」时才更新 remote_head ——
/// 发现更新却不改它，下一轮才不会把「有新版本」误报成「已是最新」。
fn write_check(dir: &Path, head: &str, checked_at: &str, verified_head: bool) -> Result<(), String> {
    let Some(mut doc) = skill_toml::load(dir) else {
        return Ok(());
    };
    if let Some(up) = doc
        .get_mut("source")
        .and_then(|s| s.as_table_mut())
        .and_then(|s| s.get_mut("upstream"))
        .and_then(|u| u.as_table_mut())
    {
        up.insert("last_check".into(), toml::Value::String(checked_at.to_string()));
        if verified_head {
            up.insert("remote_head".into(), toml::Value::String(head.to_string()));
            up.insert("checked_head".into(), toml::Value::String(head.to_string()));
        } else {
            up.remove("checked_head");
        }
    }
    let text = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(skill_toml::path_for(dir), text).map_err(|e| e.to_string())
}

/// 解析远端 HEAD。AI 搜到的 git 来源没有克隆过程，用它补齐安装指纹。
pub fn remote_head(remote: &str) -> Result<String, String> {
    ls_remote_head(remote)
}

fn ls_remote_head(remote: &str) -> Result<String, String> {    let out = crate::ahub::store::silent_command("git")
        .args(["ls-remote", remote, "HEAD"])
        .output();
    let Ok(out) = out else {
        return Err("git 不可用（未安装或不在 PATH）".into());
    };
    if !out.status.success() {
        return Err(format!(
            "git ls-remote 失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let head = stdout.split_whitespace().next().unwrap_or_default().to_string();
    if head.is_empty() {
        return Err("远端没有返回 HEAD".into());
    }
    Ok(head)
}

/// 取远端某个子目录的树 sha。无 blob 浅克隆只拉提交与树对象，代价比整仓小得多。
fn subtree_shas(remote: &str, head: &str, paths: &[String]) -> HashMap<String, Result<String, String>> {
    let mut out: HashMap<String, Result<String, String>> = HashMap::new();
    let tmp = std::env::temp_dir().join(format!(
        "agenthub-tree-{}-{}",
        std::process::id(),
        crate::ahub::models::new_id()
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    let clone = crate::ahub::store::silent_command("git")
        .args(["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", remote])
        .arg(&tmp)
        .output();
    let cloned = matches!(&clone, Ok(out) if out.status.success());
    if !cloned {
        let note = match &clone {
            Ok(out) => format!("取远端树失败: {}", String::from_utf8_lossy(&out.stderr).trim()),
            Err(_) => "git 不可用（未安装或不在 PATH）".into(),
        };
        for path in paths {
            out.insert(path.clone(), Err(note.clone()));
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return out;
    }
    for path in paths {
        let spec = if path.is_empty() || path == "." {
            format!("{head}^{{tree}}")
        } else {
            format!("{head}:{path}")
        };
        let sha = crate::ahub::store::silent_command("git")
            .args(["-C"])
            .arg(&tmp)
            .args(["rev-parse", &spec])
            .output();
        let value = match sha {
            Ok(out) if out.status.success() => {
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
            Ok(out) => Err(format!("子目录不存在: {}", String::from_utf8_lossy(&out.stderr).trim())),
            Err(_) => Err("git 不可用（未安装或不在 PATH）".into()),
        };
        out.insert(path.clone(), value);
    }
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

fn web_head(remote: &str) -> Result<String, String> {
    use std::io::Read;
    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("NimbusDesk/0.1 (Upstream check)")
        .build()
        .get(remote)
        .call()
        .map_err(|e| format!("抓取网页型上游失败: {e}"))?;
    let mut reader = resp.into_reader().take(8 * 1024 * 1024);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取网页型上游失败: {e}"))?;
    if bytes.is_empty() {
        return Err("网页型上游没有返回内容".into());
    }
    Ok(crate::ahub::skillupdate::content_fingerprint(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ah-upstream-{tag}-{}-{}",
            std::process::id(),
            crate::ahub::models::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fingerprint_ignores_app_metadata_but_sees_content() {
        let dir = temp_dir("fp");
        std::fs::write(dir.join("SKILL.md"), "hello").unwrap();
        let first = fingerprint(&dir);
        // 应用自己写的元数据不该让指纹变
        std::fs::write(dir.join(".hub.json"), "{}").unwrap();
        std::fs::write(dir.join("SKILL.toml"), "[source]\nkind = 'url'\n").unwrap();
        assert_eq!(fingerprint(&dir), first);
        // 正文改了必须变
        std::fs::write(dir.join("SKILL.md"), "hello world").unwrap();
        assert_ne!(fingerprint(&dir), first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_then_local_modified_roundtrip() {
        let dir = temp_dir("stamp");
        std::fs::write(dir.join("SKILL.md"), "v1").unwrap();
        stamp(&dir, "https://example.com/r.git", "git-scan", "abc123", "skills/demo", "tree1").unwrap();
        let doc = skill_toml::load(&dir).unwrap();
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.revision").unwrap(), "abc123");
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.subtree_path").unwrap(), "skills/demo");
        assert_eq!(local_modified(&dir), Some(false));
        std::fs::write(dir.join("SKILL.md"), "v2").unwrap();
        assert_eq!(local_modified(&dir), Some(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_file_fingerprint_says_which_file_changed() {
        let dir = temp_dir("files");
        std::fs::create_dir_all(dir.join("refs")).unwrap();
        std::fs::write(dir.join("SKILL.md"), "v1").unwrap();
        std::fs::write(dir.join("refs/a.md"), "a1").unwrap();
        stamp(&dir, "https://example.com/r.git", "git-scan", "aaa", "demo", "t1").unwrap();
        assert_eq!(local_changed(&dir), Some(Vec::new()));

        std::fs::write(dir.join("refs/a.md"), "a2").unwrap();
        assert_eq!(local_changed(&dir), Some(vec!["refs/a.md".to_string()]));

        std::fs::write(dir.join("refs/b.md"), "b1").unwrap();
        assert_eq!(
            local_changed(&dir),
            Some(vec!["refs/a.md".to_string(), "refs/b.md".to_string()])
        );

        std::fs::remove_file(dir.join("SKILL.md")).unwrap();
        let changed = local_changed(&dir).unwrap();
        assert!(changed.contains(&"SKILL.md".to_string()), "{changed:?}");
        // 应用的元数据不该出现在「你改过」的清单里
        assert!(!changed.iter().any(|path| path.starts_with('.') || path == "SKILL.toml"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unverified_check_does_not_mark_upstream_as_seen() {
        let dir = temp_dir("unverified");
        std::fs::write(dir.join("SKILL.md"), "v1").unwrap();
        stamp(&dir, "https://example.com/r.git", "git-scan", "aaa", "demo", "t1").unwrap();
        // 发现更新（未确认）：不能把 remote_head 写成新 HEAD，否则下一轮会误报「已最新」
        write_check(&dir, "bbb", "2026-01-01T00:00:00Z", false).unwrap();
        let doc = skill_toml::load(&dir).unwrap();
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.remote_head").unwrap_or_default(), "");
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.checked_head").unwrap_or_default(), "");
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.last_check").unwrap(), "2026-01-01T00:00:00Z");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-C"])
            .arg(repo)
            .args(args)
            .output()
            .expect("git 不可用");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// 真实仓库回归：同一仓库改了别的目录，我这一个不该报更新。
    /// 这是「按子树判定」存在的唯一理由，必须用真 git 验一次，不能只测纯函数。
    #[test]
    fn splits_repo_urls_and_keeps_subpath() {
        assert_eq!(
            split_repo_url("https://github.com/acme/skills/tree/main/skills/pdf"),
            Some(("https://github.com/acme/skills".into(), "skills/pdf".into(), "main".into()))
        );
        assert_eq!(
            split_repo_url("https://gitlab.com/acme/skills.git"),
            Some(("https://gitlab.com/acme/skills".into(), String::new(), String::new()))
        );
        assert_eq!(split_repo_url("https://example.com/book"), None);
    }

    #[test]
    fn detect_prefers_install_hint_and_skips_weak_mentions() {
        let dir = temp_dir("detect-hint");
        std::fs::write(dir.join("SKILL.md"), "# demo\n\n参考实现见 https://github.com/other/thing\n").unwrap();
        std::fs::write(
            dir.join("README.md"),
            "## 安装\n\n```bash\nnpx skills add https://github.com/acme/skills/tree/main/skills/demo\n```\n",
        )
        .unwrap();
        let hints = detect(&dir);
        assert_eq!(hints[0].remote, "https://github.com/acme/skills", "{hints:?}");
        assert_eq!(hints[0].subpath, "skills/demo");
        assert!(hints[0].strong);
        let weak = hints.iter().find(|h| h.remote.contains("other/thing")).expect("弱证据应保留");
        assert!(!weak.strong);

        // 强证据会被补上，弱证据（正文里顺手提到的链接）不会
        let report = backfill(
            &dir.parent().unwrap().to_path_buf(),
            &[dir.file_name().unwrap().to_string_lossy().into_owned()],
            false,
            false,
        );
        assert_eq!(report.filled, 1, "{report:?}");
        assert_eq!(report.items[0].remote, "https://github.com/acme/skills");

        let weak_dir = temp_dir("detect-weak");
        std::fs::write(weak_dir.join("SKILL.md"), "# demo\n\n参考 https://github.com/other/thing\n").unwrap();
        let weak_report = backfill(
            &weak_dir.parent().unwrap().to_path_buf(),
            &[weak_dir.file_name().unwrap().to_string_lossy().into_owned()],
            false,
            false,
        );
        assert_eq!(weak_report.filled, 0, "{weak_report:?}");
        assert_eq!(weak_report.weak, 1, "{weak_report:?}");
        let _ = std::fs::remove_dir_all(&weak_dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backfill_stamps_strong_hint_into_upstream_table() {
        let base = temp_dir("backfill");
        let dir = base.join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "# demo\n").unwrap();
        std::fs::write(dir.join("README.md"), "git clone https://github.com/acme/skills\n").unwrap();
        let report = backfill(&base, &["demo".to_string()], false, false);
        assert_eq!(report.filled, 1, "{report:?}");
        let doc = skill_toml::load(&dir).unwrap();
        assert_eq!(
            skill_toml::get_str(&doc, "source.upstream.remote").unwrap(),
            "https://github.com/acme/skills"
        );
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.mode").unwrap(), "git-scan");
        let again = backfill(&base, &["demo".to_string()], false, false);
        assert_eq!(again.filled, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn detect_uses_import_source_git_dir_but_never_enclosing_repo() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = temp_dir("local-git");
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "t"]);
        git(&repo, &["remote", "add", "origin", "https://github.com/acme/mono"]);
        std::fs::create_dir_all(repo.join("skills/demo")).unwrap();
        std::fs::write(repo.join("skills/demo/SKILL.md"), "# demo\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        let skill = temp_dir("local-git-skill");
        std::fs::write(skill.join("SKILL.md"), "# demo\n").unwrap();
        std::fs::write(
            skill.join("SKILL.toml"),
            format!("[source]\nkind = \"local\"\nref = '{}'\n", repo.join("skills/demo").display()),
        )
        .unwrap();
        let hints = detect(&skill);
        assert_eq!(hints[0].remote, "https://github.com/acme/mono", "{hints:?}");
        assert_eq!(hints[0].subpath, "skills/demo");
        assert!(!hints[0].revision.is_empty());
        assert!(!hints[0].subtree_sha.is_empty());

        // 技能目录只是**躺在**某个仓库里（开发时的 data 目录就是这样）→ 不能把那个仓库当上游
        let outer = temp_dir("enclosing");
        git(&outer, &["init", "-q", "-b", "main"]);
        let nested = outer.join("data/modules/skills/demo");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("SKILL.md"), "# demo\n").unwrap();
        assert!(detect(&nested).is_empty(), "不该把外层仓库认成上游");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&skill);
        let _ = std::fs::remove_dir_all(&outer);
    }

    /// 拿真实数据体检：`AH_SKILLS_ROOT=<技能根目录> [AH_BACKFILL=1]`
    /// `cargo test --lib audit_live_skills -- --ignored --nocapture`
    #[test]
    #[ignore = "手动审计真实技能目录"]
    fn audit_live_skills() {
        let Ok(root) = std::env::var("AH_SKILLS_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let mut names: Vec<String> = std::fs::read_dir(&root)
            .expect("技能根目录不存在")
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        println!("技能 {} 个：{}", names.len(), root.display());
        for name in &names {
            let dir = root.join(name);
            let tracked = skill_toml::load(&dir)
                .and_then(|doc| skill_toml::get_str(&doc, "source.upstream.remote"))
                .unwrap_or_default();
            let hints = detect(&dir);
            let best = match hints.first() {
                Some(hint) => format!(
                    "{} [{}] {}",
                    hint.remote,
                    if hint.strong { "强" } else { "弱" },
                    hint.evidence
                ),
                None => "无证据".to_string(),
            };
            println!("{name} | {} | {best}", if tracked.is_empty() { "未跟踪" } else { "已跟踪" });
        }
        if std::env::var("AH_BACKFILL").is_ok() {
            let report = backfill(&root, &names, false, true);
            println!("补全 {} 个，弱证据 {} 个", report.filled, report.weak);
            for item in &report.items {
                println!(
                    "  {} | {} | {} | {}",
                    item.dir_name,
                    if item.applied { "已补全" } else { "跳过" },
                    item.remote,
                    item.evidence
                );
            }
            let dirs: Vec<PathBuf> = report
                .items
                .iter()
                .filter(|item| item.applied)
                .map(|item| root.join(&item.dir_name))
                .collect();
            for (path, result) in check_batch(dirs) {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                match result {
                    Ok(report) => println!(
                        "检查 {name} | changed={} | head={} | {}",
                        report.changed, report.remote_head, report.note
                    ),
                    Err(error) => println!("检查 {name} | 失败 | {error}"),
                }
            }
        }
    }

    #[test]
    fn repo_moved_but_my_subdir_did_not() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = temp_dir("repo");
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "t"]);
        std::fs::create_dir_all(repo.join("a")).unwrap();
        std::fs::create_dir_all(repo.join("b")).unwrap();
        std::fs::write(repo.join("a/SKILL.md"), "a1").unwrap();
        std::fs::write(repo.join("b/SKILL.md"), "b1").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let rev = git(&repo, &["rev-parse", "HEAD"]);
        let remote = format!("file://{}", repo.to_string_lossy().replace('\\', "/"));

        let skills = temp_dir("batch");
        for name in ["a", "b"] {
            let dir = skills.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!("{name}1")).unwrap();
            let sha = git(&repo, &["rev-parse", &format!("HEAD:{name}")]);
            stamp(&dir, &remote, "git-scan", &rev, name, &sha).unwrap();
        }

        // 只动 b
        std::fs::write(repo.join("b/SKILL.md"), "b2").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "touch b"]);

        let reports = check_batch(vec![skills.join("a"), skills.join("b")]);
        let a = reports[0].1.as_ref().unwrap();
        assert!(!a.changed, "a 的子目录没变，不该报更新：{}", a.note);
        assert!(a.subtree_unchanged, "a 应标成「仓库动了、本目录没动」：{}", a.note);
        let b = reports[1].1.as_ref().unwrap();
        assert!(b.changed, "b 变了必须报更新：{}", b.note);

        // 同一个 remote 第二次检查应命中「上次核验过这个提交」，不再重算子树
        let again = check_batch(vec![skills.join("a")]);
        let a2 = again[0].1.as_ref().unwrap();
        assert!(!a2.changed);

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&skills);
    }

    #[test]
    fn re_stamp_clears_previous_verification() {
        let dir = temp_dir("restamp");
        std::fs::write(dir.join("SKILL.md"), "v1").unwrap();
        stamp(&dir, "https://example.com/r.git", "git-scan", "aaa", "demo", "t1").unwrap();
        write_check(&dir, "bbb", "2026-01-01T00:00:00Z", true).unwrap();
        let doc = skill_toml::load(&dir).unwrap();
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.checked_head").unwrap(), "bbb");
        stamp(&dir, "https://example.com/r.git", "git-scan", "ccc", "demo", "t2").unwrap();
        let doc = skill_toml::load(&dir).unwrap();
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.checked_head").unwrap_or_default(), "");
        assert_eq!(skill_toml::get_str(&doc, "source.upstream.remote_head").unwrap_or_default(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
