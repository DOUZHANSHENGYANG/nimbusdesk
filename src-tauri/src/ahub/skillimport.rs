//! Skills 批量导入（skills-import）：探查 / 程序修复 / AI 修复 / 来源识别 / 异步落库。
//!
//! 约束（见 docs/comet/changes/skills-import/specs/skills-import/spec.md）：
//! - 程序修复优先，AI 只在程序无法修复时介入（缺 description、frontmatter 损坏）
//! - 无法修复的目录汇总成 `unrepairable`，由用户决定继续或终止
//! - 来源识别只读 `SKILL.md` 与下一层文件，**不递归**
//! - 导入过程通过 `import-progress` 事件推流（stage/current/total/path/message）
//!
//! 与 `skills.rs` 的分工：本模块只负责「把不合规的源目录整理成合规形态」并编排流程，
//! 真正落库（copy-then-replace、`.hub.json`、版本历史）仍复用 `skills::import_skill_dir`。

use crate::ahub::skills::{self, FmValue};
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const SKILL_MD: &str = "SKILL.md";
/// description 少于该长度视为「过于简略」，交给 AI 补全
const MIN_DESC_CHARS: usize = 10;
/// AI 生成的 description 上限（字符数）
const MAX_DESC_CHARS: usize = 80;

// ---------------- DTO ----------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FixRecord {
    /// dir-rename | name-sync | md-case | name-normalize
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// url | local-path | manual | custom
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub value: String,
    /// high | low
    #[serde(default)]
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSkill {
    /// 用户认得**原始**目录的绝对路径。探查后不再改变（修复只动暂存副本），
    /// 前端展示与「无法修复」清单都用它。
    #[serde(default)]
    pub original_path: String,
    /// 暂存副本的绝对路径（`%TEMP%\agenthub-import-<uuid>\<目录名>`）。
    /// 所有修复都在这里执行，`import_batch` 也从这个路径落库；空表示未暂存（不可导入）。
    #[serde(default)]
    pub staged_path: String,
    /// 探查时看到的目录名（修复前的原样，用于展示改动）
    #[serde(default)]
    pub original_name: String,
    /// 修复后应落盘的目录名（`^[a-z0-9]+(-[a-z0-9]+)*$`）
    #[serde(default)]
    pub fixed_name: String,
    #[serde(default)]
    pub has_skill_md: bool,
    /// frontmatter 的 name
    #[serde(default)]
    pub skill_md_name: String,
    /// frontmatter 的 description
    #[serde(default)]
    pub skill_md_description: String,
    /// 程序修复记录（`apply_fixes` 之后是「已执行」的记录）
    #[serde(default)]
    pub fixes: Vec<FixRecord>,
    /// 需要 AI 补全 description
    #[serde(default)]
    pub needs_ai: bool,
    /// 程序无法修复时的原因（非空则该候选不可导入）
    #[serde(default)]
    pub problem: String,
    #[serde(default)]
    pub source: SourceInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnrepairableItem {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExploreReport {
    /// 暂存会话 id：暂存根目录是 `%TEMP%\agenthub-import-<session_id>\`。
    /// 前端在向导关闭/取消时用它调 `skill_import_cleanup`。
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub candidates: Vec<CandidateSkill>,
    #[serde(default)]
    pub unrepairable: Vec<UnrepairableItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcomeItem {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub dir_name: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ok: bool,
    /// 成功时的补充说明（如「已覆盖同名技能」）
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub fixes: Vec<FixRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchReport {
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub succeeded: usize,
    #[serde(default)]
    pub failed: usize,
    /// 用户选择「终止」时为 true（不导入任何候选）
    #[serde(default)]
    pub aborted: bool,
    #[serde(default)]
    pub outcomes: Vec<ImportOutcomeItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// exploring | fixing | ai-fixing | source-detecting | importing | done | aborted
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub current: usize,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub message: String,
}

fn emit(app: &AppH, stage: &str, current: usize, total: usize, path: &str, message: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "import-progress",
        ProgressEvent {
            stage: stage.to_string(),
            current,
            total,
            path: path.to_string(),
            message: message.to_string(),
        },
    );
}

/// 用户选择「终止」时推一条 `aborted` 结束事件（A8 的终止分支）。
pub fn emit_aborted(app: &AppH, root: &str) {
    emit(app, "aborted", 0, 0, root, "用户已终止导入");
}

/// 探查开始时推一条 `exploring` 事件（A8：导入全过程有阶段推送）。
pub fn emit_exploring(app: &AppH, path: &str) {
    emit(app, "exploring", 0, 0, path, "正在探查候选技能目录");
}

// ---------------- 名称规范化 ----------------

/// 目录名规范化：小写、空格/下划线/点/其它符号 → 连字符、合并连续连字符、去首尾连字符。
///
/// 结果可能为空（例如纯中文目录名），此时调用方应记为无法程序修复。
pub fn normalize_name(raw: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            // 空格、下划线、点、连字符、中文、标点 —— 一律折叠成一个连字符
            pending_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// 合规目录名：`^[a-z0-9]+(-[a-z0-9]+)*$`
pub fn is_valid_name(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut prev_dash = true; // 首字符不允许是连字符
    for c in s.chars() {
        if c == '-' {
            if prev_dash {
                return false;
            }
            prev_dash = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_dash = false;
        } else {
            return false;
        }
    }
    !prev_dash
}

// ---------------- 探查 ----------------

/// 大小写不敏感地找 `SKILL.md`（Windows 上常见 `skill.md` / `Skill.md`）
pub fn find_skill_md(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case(SKILL_MD) {
            let p = e.path();
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn is_skippable_dir(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules")
}

/// 复制到暂存区时要跳过的条目：版本库、依赖、macOS 垃圾文件。
fn is_skippable_on_copy(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git")
        || name.eq_ignore_ascii_case("node_modules")
        || name.eq_ignore_ascii_case(".DS_Store")
}

/// 递归复制目录，跳过 `.git` / `node_modules` / `.DS_Store`（其它隐藏文件保留）。
fn copy_dir_for_staging(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(store::es)?;
    for entry in std::fs::read_dir(src).map_err(store::es)? {
        let entry = entry.map_err(store::es)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_skippable_on_copy(&name) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_dir_for_staging(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(store::es)?;
        }
    }
    Ok(())
}

/// 暂存会话根目录：`%TEMP%\agenthub-import-<session_id>`。
///
/// 调用方必须先经 `sanitize_session_id` 校验（这个值来自前端，拼路径前是信任边界）。
pub fn session_root(session_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("agenthub-import-{session_id}"))
}

/// 会话 id 只允许字母数字与连字符（它会成为临时目录名的一部分）。
///
/// 这里必须严格：`session_id` 由前端回传，若带 `..` 或路径分隔符，
/// `agenthub-import-<id>` 会逃出 `%TEMP%`，清理时能删到临时目录之外的路径。
pub fn sanitize_session_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some(s.to_string())
}

/// 删除整个暂存会话目录（用户取消 / 终止 / 导入结束后清理）。
/// session_id 非法或目录不存在时返回 0，绝不删其它路径。
pub fn cleanup_session(session_id: &str) -> usize {
    let Some(sid) = sanitize_session_id(session_id) else {
        return 0;
    };
    let root = session_root(&sid);
    if !root.exists() {
        return 0;
    }
    let n = walk_count(&root);
    let _ = std::fs::remove_dir_all(&root);
    // 该会话在内存里的暂存根登记也一并清掉
    if let Some(map) = staged_roots().lock().ok().as_mut() {
        map.remove(&sid);
    }
    n
}

/// 进程内 session_id → 暂存根 的登记表（用于 `import_batch` 按路径反查会话）。
fn staged_roots() -> &'static Mutex<HashMap<String, PathBuf>> {
    static ROOTS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_session(session_id: &str, root: &Path) {
    if let Ok(mut map) = staged_roots().lock() {
        map.insert(session_id.to_string(), root.to_path_buf());
    }
}

/// 暂存一个候选目录，返回暂存副本路径。
///
/// 目标目录已存在时（同名候选）加序号后缀，保证一个候选一个暂存目录。
fn stage_candidate(src: &Path, session_dir: &Path) -> Result<PathBuf, String> {
    let base = src
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let mut dst = session_dir.join(&base);
    let mut n = 1usize;
    while dst.exists() {
        n += 1;
        dst = session_dir.join(format!("{base}-{n}"));
    }
    copy_dir_for_staging(src, &dst)?;
    Ok(dst)
}

/// 探查一个导入根目录：
/// - 自身含 `SKILL.md` → 唯一候选
/// - 否则枚举下一级子目录，每个子目录一个候选（跳过隐藏目录与 node_modules）
///
/// 每个候选都会**复制**到暂存区（`%TEMP%\agenthub-import-<session_id>\`），
/// 后续修复与落库都只动暂存副本，用户的原目录保持不变。
///
/// 便捷入口（自动生成 session_id）。命令层走 `explore_with_session` 以便复用会话，
/// 所以非测试构建里这里没有调用点。
#[cfg_attr(not(test), allow(dead_code))]
pub fn explore(root: &Path) -> ExploreReport {
    explore_with_session(root, None)
}

/// 同上，可指定 session_id（前端合并多路径探查时复用同一个暂存会话）。
pub fn explore_with_session(root: &Path, session_id: Option<&str>) -> ExploreReport {
    let sid = session_id
        .and_then(sanitize_session_id)
        .unwrap_or_else(crate::ahub::models::new_id);
    let session_dir = session_root(&sid);

    let mut report = ExploreReport {
        session_id: sid.clone(),
        root: root.to_string_lossy().to_string(),
        ..Default::default()
    };

    if !root.is_dir() {
        report.unrepairable.push(UnrepairableItem {
            path: report.root.clone(),
            reason: "路径不是目录".into(),
        });
        return report;
    }

    if let Err(e) = std::fs::create_dir_all(&session_dir) {
        report.unrepairable.push(UnrepairableItem {
            path: report.root.clone(),
            reason: format!("无法创建暂存目录：{e}"),
        });
        return report;
    }
    register_session(&sid, &session_dir);

    if find_skill_md(root).is_some() {
        let c = analyze_staged_candidate(root, &session_dir);
        push_candidate(&mut report, c);
        return report;
    }

    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .filter(|e| !is_skippable_dir(&e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();

    if dirs.is_empty() {
        report.unrepairable.push(UnrepairableItem {
            path: report.root.clone(),
            reason: "目录下既没有 SKILL.md，也没有可导入的子目录".into(),
        });
        return report;
    }

    for d in dirs {
        let c = analyze_staged_candidate(&d, &session_dir);
        push_candidate(&mut report, c);
    }
    report
}

/// 先复制到暂存区，再分析暂存副本（分析的是将要落库的那份）。
fn analyze_staged_candidate(original: &Path, session_dir: &Path) -> CandidateSkill {
    match stage_candidate(original, session_dir) {
        Ok(staged) => analyze_candidate_at(original, &staged),
        Err(e) => {
            let mut c = analyze_candidate(original);
            c.staged_path = String::new();
            if c.problem.is_empty() {
                c.problem = format!("复制到暂存目录失败：{e}");
            }
            c
        }
    }
}


fn push_candidate(report: &mut ExploreReport, c: CandidateSkill) {
    if !c.has_skill_md || !c.problem.is_empty() {
        report.unrepairable.push(UnrepairableItem {
            path: c.original_path.clone(),
            reason: if c.problem.is_empty() {
                "缺少 SKILL.md".into()
            } else {
                c.problem.clone()
            },
        });
    }
    report.candidates.push(c);
}

/// 分析单个候选目录（原地：暂存路径即自身）。
///
/// 供测试与「对已暂存目录再分析」的场景使用；正常导入流程走 `explore`，
/// 那里分析的是暂存副本。
pub fn analyze_candidate(dir: &Path) -> CandidateSkill {
    analyze_candidate_at(dir, dir)
}

/// 分析候选：身份（目录名 / 展示路径）来自 `original`，读写文件都发生在 `staged`。
pub fn analyze_candidate_at(original: &Path, staged: &Path) -> CandidateSkill {
    let dir = staged;
    let dir_name = original
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut c = CandidateSkill {
        original_path: original.to_string_lossy().to_string(),
        staged_path: staged.to_string_lossy().to_string(),
        original_name: dir_name.clone(),
        fixed_name: normalize_name(&dir_name),
        source: detect_source(dir),
        ..Default::default()
    };

    let Some(md) = find_skill_md(dir) else {
        c.has_skill_md = false;
        c.needs_ai = false;
        c.problem = "缺少 SKILL.md".into();
        return c;
    };
    c.has_skill_md = true;

    // 文件名大小写错误 → md-case
    let md_name = md
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    if md_name != SKILL_MD {
        c.fixes.push(FixRecord {
            kind: "md-case".into(),
            from: md_name.clone(),
            to: SKILL_MD.into(),
        });
    }

    let doc = match std::fs::read_to_string(&md) {
        Ok(t) => t,
        Err(e) => {
            c.problem = format!("SKILL.md 无法读取：{e}");
            return c;
        }
    };
    let (fm, body) = skills::split_doc(&doc);
    let name = skills::fm_get_str(&fm, "name").trim().to_string();
    let desc = skills::fm_get_str(&fm, "description").trim().to_string();
    c.skill_md_name = name.clone();
    c.skill_md_description = desc.clone();

    // frontmatter 声明了却解析不出来（`---` 开头 + map 为空）→ 交给 AI 重建
    let fm_broken = fm.is_empty() && doc.trim_start().starts_with("---");

    // 目录名 / name 的取舍：以 frontmatter name 为准（name 合法时直接用，不合法先规范化）
    let dir_norm = normalize_name(&dir_name);
    if !name.is_empty() {
        let name_valid = is_valid_name(&name);
        let target = if name_valid {
            name.clone()
        } else {
            normalize_name(&name)
        };
        if target.is_empty() {
            c.problem = format!("frontmatter name 无法规范化为合法名称：{name}");
            return c;
        }
        if name_valid {
            // A3：name 与目录名不一致 → 以 SKILL.md 的 name 为准重命名目录
            if target != dir_name {
                c.fixes.push(FixRecord {
                    kind: "name-sync".into(),
                    from: dir_name.clone(),
                    to: target.clone(),
                });
            }
        } else {
            // name 本身不合规：规范化后同时改写 frontmatter 与目录名
            c.fixes.push(FixRecord {
                kind: "name-normalize".into(),
                from: name.clone(),
                to: target.clone(),
            });
        }
        c.fixed_name = target;
    } else {
        if dir_norm.is_empty() {
            c.problem = format!("目录名无法规范化为合法名称：{dir_name}");
            return c;
        }
        if dir_norm != dir_name {
            c.fixes.push(FixRecord {
                kind: "dir-rename".into(),
                from: dir_name.clone(),
                to: dir_norm.clone(),
            });
        }
        // name 缺失时目录名即身份，落盘前补写 name（否则下游只能靠目录名兜底）
        c.fixes.push(FixRecord {
            kind: "name-sync".into(),
            from: String::new(),
            to: dir_norm.clone(),
        });
        c.fixed_name = dir_norm;
    }

    // description 缺失 / 过于简略 / frontmatter 损坏 → AI
    let desc_len = desc.chars().count();
    if fm_broken || desc_len == 0 || desc_len < MIN_DESC_CHARS {
        c.needs_ai = true;
    }

    // 正文完全为空时 AI 也没法推断（记原因，避免白跑一次接口）
    if c.needs_ai && body.trim().is_empty() && fm_broken {
        c.needs_ai = false;
        c.problem = "SKILL.md 既无可用 frontmatter 也无正文，无法推断描述".into();
    }

    c
}

// ---------------- 程序修复 ----------------

/// 实际执行重命名：`SKILL.md` 大小写、frontmatter `name` 改写、目录改名。
///
/// **只动暂存副本**（`staged_path`），用户原目录保持不变；改名后 `staged_path`
/// 同步为新位置。`original_path` 与 `original_name` 始终保留探查时的样子。
///
/// 返回**已执行**的修复记录。无法执行的（如目标目录已存在）写进候选的 `problem`，
/// 由前端在「无法修复」一步汇总展示。
pub fn apply_fixes(candidates: &mut Vec<CandidateSkill>) -> Vec<FixRecord> {
    let mut executed: Vec<FixRecord> = Vec::new();
    for c in candidates.iter_mut() {
        if !c.has_skill_md || !c.problem.is_empty() {
            continue;
        }
        // 没有暂存副本就绝不改动磁盘：原目录必须保持原样（决策 2 的硬约束）。
        if c.staged_path.trim().is_empty() {
            c.problem = "缺少暂存副本，未做任何修复".into();
            continue;
        }
        let mut dir = PathBuf::from(&c.staged_path);
        let mut done: Vec<FixRecord> = Vec::new();

        // 1) SKILL.md 文件名大小写（Windows 大小写不敏感，必须两段改名）
        if let Some(md) = find_skill_md(&dir) {
            let fname = md
                .file_name()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_default();
            if fname != SKILL_MD {
                let tmp = dir.join("SKILL.md.case-tmp");
                let _ = std::fs::remove_file(&tmp);
                let ok = std::fs::rename(&md, &tmp).is_ok()
                    && std::fs::rename(&tmp, dir.join(SKILL_MD)).is_ok();
                if ok {
                    done.push(FixRecord {
                        kind: "md-case".into(),
                        from: fname,
                        to: SKILL_MD.into(),
                    });
                } else {
                    let _ = std::fs::rename(&tmp, &md);
                    c.problem = "SKILL.md 大小写改名失败".into();
                    continue;
                }
            }
        }

        // 2) frontmatter name 与目标名不一致 → 以目标名为准改写
        let old_name = c.skill_md_name.clone();
        if !c.fixed_name.is_empty() && c.fixed_name != old_name {
            match write_frontmatter(&dir, Some(&c.fixed_name), None) {
                Ok(()) => {
                    done.push(FixRecord {
                        // name 缺失属于「补齐」；name 存在但不合规属于「规范化」
                        kind: if old_name.is_empty() {
                            "name-sync".into()
                        } else {
                            "name-normalize".into()
                        },
                        from: old_name.clone(),
                        to: c.fixed_name.clone(),
                    });
                    c.skill_md_name = c.fixed_name.clone();
                }
                Err(e) => {
                    c.problem = format!("改写 frontmatter name 失败：{e}");
                    continue;
                }
            }
        }

        // 3) 目录改名（放最后，改名后路径失效）
        let cur_name = dir
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        if !c.fixed_name.is_empty() && cur_name != c.fixed_name {
            let target = dir
                .parent()
                .map(|p| p.join(&c.fixed_name))
                .unwrap_or_else(|| PathBuf::from(&c.fixed_name));
            if target.exists() {
                c.problem = format!("目标目录已存在：{}", target.display());
                continue;
            }
            // 合法 name 驱动改名记为 name-sync（A3），否则是目录名规范化
            let kind = if is_valid_name(&old_name) {
                "name-sync"
            } else {
                "dir-rename"
            };
            match std::fs::rename(&dir, &target) {
                Ok(()) => {
                    done.push(FixRecord {
                        kind: kind.into(),
                        from: cur_name,
                        to: c.fixed_name.clone(),
                    });
                    dir = target;
                    c.staged_path = dir.to_string_lossy().to_string();
                }
                Err(e) => {
                    c.problem = format!("目录改名失败：{e}");
                    continue;
                }
            }
        }

        c.fixes = done.clone();
        executed.extend(done);
    }
    executed
}

/// 改写 `SKILL.md` 的 frontmatter 字段（保留正文与其它字段）。
/// 传 `None` 表示不改该字段。
pub(crate) fn write_frontmatter(
    dir: &Path,
    name: Option<&str>,
    description: Option<&str>,
) -> Result<(), String> {
    let md = find_skill_md(dir).ok_or_else(|| "缺少 SKILL.md".to_string())?;
    let doc = std::fs::read_to_string(&md).map_err(|e| e.to_string())?;
    let (mut fm, body) = skills::split_doc(&doc);
    if let Some(n) = name {
        if skills::fm_get_str(&fm, "name").trim() != n {
            fm.insert("name".into(), FmValue::Str(n.to_string()));
        }
    }
    if let Some(d) = description {
        if skills::fm_get_str(&fm, "description").trim() != d {
            fm.insert("description".into(), FmValue::Str(d.to_string()));
        }
    }
    std::fs::write(&md, skills::compose_doc(&fm, &body)).map_err(|e| e.to_string())
}

// ---------------- 来源识别 ----------------

/// 只读 `SKILL.md` 与下一层文件（不递归）判断来源。
pub fn detect_source(dir: &Path) -> SourceInfo {
    let mut text = String::new();
    if let Some(md) = find_skill_md(dir) {
        text = std::fs::read_to_string(&md).unwrap_or_default();
    }
    if let Some(url) = find_repo_url(&text) {
        return SourceInfo {
            kind: "url".into(),
            value: url,
            confidence: "high".into(),
        };
    }

    // 下一层的 meta.json / package.json
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut names: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.path())
            .collect();
        names.sort();
        for p in &names {
            let fname = p
                .file_name()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if fname != "meta.json" && fname != "package.json" {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(p) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            if let Some(url) = repo_from_json(&v) {
                return SourceInfo {
                    kind: "url".into(),
                    value: url,
                    confidence: "high".into(),
                };
            }
        }
    }

    if let Some(p) = find_local_path(&text) {
        return SourceInfo {
            kind: "local-path".into(),
            value: p,
            confidence: "low".into(),
        };
    }

    SourceInfo {
        kind: "manual".into(),
        value: String::new(),
        confidence: "low".into(),
    }
}

/// 在文本里找 github / gitlab 仓库 URL（不引入 regex 依赖，手工扫描）。
fn find_repo_url(text: &str) -> Option<String> {
    for host in ["https://github.com/", "https://gitlab.com/"] {
        let mut from = 0usize;
        while let Some(idx) = text[from..].find(host) {
            let start = from + idx;
            let rest = &text[start..];
            let end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\'' | '>' | '`' | '|'))
                .unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches(['.', ',', ';', ':']).to_string();
            // 至少要 owner/repo 两段
            let tail = url.trim_start_matches(host);
            if tail.split('/').filter(|s| !s.is_empty()).count() >= 2 {
                return Some(url);
            }
            from = start + host.len();
            if from >= text.len() {
                break;
            }
        }
    }
    None
}

/// `repository` 字段既可能是字符串，也可能是 `{ "url": ... }`（package.json 常见）
fn repo_from_json(v: &serde_json::Value) -> Option<String> {
    let repo = v.get("repository")?;
    if let Some(s) = repo.as_str() {
        return Some(s.trim().to_string()).filter(|s| !s.is_empty());
    }
    let url = repo.get("url").and_then(|u| u.as_str())?;
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}

/// 文本里可定位的本机绝对路径：`D:\a\b` 或 `/home/...`、`/Users/...`
fn find_local_path(text: &str) -> Option<String> {
    let has_unix_root = text.contains("/home/") || text.contains("/Users/");
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i + 3 < chars.len() {
        let drive = chars[i].is_ascii_alphabetic()
            && chars[i + 1] == ':'
            && (chars[i + 2] == '\\' || chars[i + 2] == '/');
        let unix = has_unix_root
            && chars[i] == '/'
            && chars.get(i + 1).map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
        if drive || unix {
            let start = i;
            let mut end = i;
            while end < chars.len() {
                let c = chars[end];
                if c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | ']' | '>' | '|' | '，' | '。') {
                    break;
                }
                end += 1;
            }
            let cand: String = chars[start..end].iter().collect();
            if cand.len() >= 4 {
                return Some(cand);
            }
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

// ---------------- AI 修复 ----------------

/// 读 `SKILL.md` 正文 + 下一层文件名，交给 AI 生成一句 description（≤80 字符，中文优先）。
pub fn ai_fix_description(app: &AppH, dir: &Path, current_desc: &str) -> Result<String, String> {
    let md = find_skill_md(dir).ok_or_else(|| "缺少 SKILL.md".to_string())?;
    let doc = std::fs::read_to_string(&md).map_err(|e| e.to_string())?;
    let (fm, body) = skills::split_doc(&doc);
    let name = {
        let n = skills::fm_get_str(&fm, "name").trim().to_string();
        if n.is_empty() {
            dir.file_name()
                .map(|x| x.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            n
        }
    };
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if e.path().is_dir() {
                        format!("{n}/")
                    } else {
                        n
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files.truncate(40);

    let body_excerpt: String = body.chars().take(3000).collect();
    let prompt = format!(
        "你是技能元信息助手。请阅读下面的技能文档，为它写一句 description（技能描述）。\n\
要求：\n\
1. 只输出这一句描述本身，不要引号、不要解释、不要换行；\n\
2. 不超过 {MAX_DESC_CHARS} 个字符，中文优先；\n\
3. 说清「做什么 / 什么时候用」，不要重复技能名。\n\n\
技能名：{name}\n\
目录内文件：{}\n\
现有描述（可能为空或过短）：{current_desc}\n\n\
技能文档：\n{body_excerpt}",
        files.join(", ")
    );

    let raw = ai_chat(app, &prompt)?;
    let desc = clean_ai_description(&raw);
    if desc.is_empty() {
        return Err("AI 未返回可用的描述".into());
    }
    Ok(desc)
}

/// 把 AI 生成的 description 写回 `SKILL.md`（只动 description，保留其它字段与正文）。
pub fn write_description(dir: &Path, desc: &str) -> Result<(), String> {
    write_frontmatter(dir, None, Some(desc))
}

/// 决策 3：AI 不可用时能否继续导入 —— 只有原本就有（哪怕很短）的描述才可以。
///
/// 原描述为空时没有任何可保留的内容，该候选只能记失败。
pub fn can_continue_without_ai(current_desc: &str) -> bool {
    !current_desc.trim().is_empty()
}

/// 去掉模型常见的包装：代码块、引号、前缀、多行只取第一句有效内容。
fn clean_ai_description(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    for fence in ["```text", "```markdown", "```md", "```"] {
        if let Some(rest) = s.strip_prefix(fence) {
            s = rest.trim().to_string();
        }
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.trim().to_string();
    }
    // 去掉「描述：」「description:」这类前缀
    for p in ["description:", "description：", "描述：", "描述:"] {
        if let Some(rest) = s.strip_prefix(p) {
            s = rest.trim().to_string();
        }
    }
    let line = s
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'' || c == '「' || c == '」')
        .trim()
        .to_string();
    line.chars().take(MAX_DESC_CHARS).collect()
}

/// OpenAI 兼容 chat/completions 调用（统一走 aihelper，与 MCP 标签、技能摘要同一套配置与错误语义）
fn ai_chat(app: &AppH, prompt: &str) -> Result<String, String> {
    crate::ahub::aihelper::chat(app, "", prompt)
}

// ---------------- 异步批量导入 ----------------

/// 本次导入是否生成摘要：勾选框显式给定则听勾选框（取消勾选时不生成，
/// 即使全局开关为开启）；未给定（None）时跟随全局设置。
fn should_generate_summary(requested: Option<bool>, global: bool) -> bool {
    requested.unwrap_or(global)
}

/// 批量导入：逐项「修复 → AI 补描述 → 识别来源 → 落库 → 写 SKILL.toml [source]」，
/// 每步通过 `import-progress` 事件推流。
///
/// `selected` 是用户认得的**原始**路径（`CandidateSkill::original_path`），
/// `staged` 是 `original_path → staged_path` 的映射：修复与落库都只动暂存副本。
/// `overwrite=true` 时同名技能覆盖，否则记为失败。
/// `generate_summary` 是本次导入的摘要勾选框：None = 跟随全局设置。
pub async fn import_batch(
    app: AppH,
    root: String,
    selected: Vec<String>,
    staged: HashMap<String, String>,
    sources: HashMap<String, SourceInfo>,
    overwrite: bool,
    session_id: String,
    generate_summary: Option<bool>,
) -> Result<ImportBatchReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_batch_blocking(
            &app,
            &root,
            &selected,
            &staged,
            &sources,
            overwrite,
            &session_id,
            generate_summary,
        )
    })
    .await
    .map_err(|e| format!("导入失败: {e}"))
}

fn import_batch_blocking(    app: &AppH,
    root: &str,
    selected: &[String],
    staged: &HashMap<String, String>,
    sources: &HashMap<String, SourceInfo>,
    overwrite: bool,
    session_id: &str,
    generate_summary: Option<bool>,
) -> ImportBatchReport {
    let mut report = ImportBatchReport {
        root: root.to_string(),
        total: selected.len(),
        ..Default::default()
    };

    // 用户在「无法修复」一步选择终止：不导入任何候选，只发 aborted 结束事件
    if selected.is_empty() {
        emit(app, "aborted", 0, 0, root, "已取消导入");
        report.aborted = true;
        return report;
    }

    let total = selected.len();
    // 本次导入是否生成摘要：显式勾选优先（取消勾选时不生成，即使全局开关为开启），
    // 未传（None）时跟随全局设置。
    let with_summary = should_generate_summary(
        generate_summary,
        store::load_settings(app).auto_summary_on_import,
    );
    // 导入成功的技能目录名，导入结束后统一补摘要
    let mut imported_names: Vec<String> = Vec::new();
    for (i, path) in selected.iter().enumerate() {
        let cur = i + 1;
        let original_dir = PathBuf::from(path);
        let staged_path = staged.get(path).cloned().unwrap_or_default();

        emit(app, "fixing", cur, total, path, "整理目录名与元信息");
        // 没有暂存副本就什么都不碰（原目录必须保持原样）；探查时已复制过一次，
        // 前端把 staged 映射传回来即可，缺失说明这一步不可导入。
        let mut candidates = if staged_path.trim().is_empty() {
            report.failed += 1;
            report.outcomes.push(ImportOutcomeItem {
                path: path.clone(),
                error: "缺少暂存副本（探查时的复制已失效，请重新导入）".into(),
                fixes: Vec::new(),
                ..Default::default()
            });
            continue;
        } else {
            vec![analyze_candidate_at(&original_dir, Path::new(&staged_path))]
        };
        let mut fixes = apply_fixes(&mut candidates);
        let mut c = candidates.pop().unwrap_or_default();

        if !c.has_skill_md || !c.problem.is_empty() || c.staged_path.trim().is_empty() {
            let reason = if !c.problem.is_empty() {
                c.problem.clone()
            } else if c.staged_path.trim().is_empty() {
                "无法复制到暂存目录".to_string()
            } else {
                "缺少 SKILL.md".to_string()
            };
            report.failed += 1;
            report.outcomes.push(ImportOutcomeItem {
                path: path.clone(),
                error: reason,
                fixes,
                ..Default::default()
            });
            continue;
        }
        let dir = PathBuf::from(&c.staged_path);

        // AI 补全 description（程序修复不了的才走这里）
        if c.needs_ai {
            emit(app, "ai-fixing", cur, total, path, "AI 补全 description");
            let cur_desc = c.skill_md_description.clone();
            match ai_fix_description(app, &dir, &cur_desc) {
                Ok(desc) => {
                    if let Err(e) = write_frontmatter(&dir, None, Some(&desc)) {
                        report.failed += 1;
                        report.outcomes.push(ImportOutcomeItem {
                            path: path.clone(),
                            error: format!("写入 AI 描述失败：{e}"),
                            fixes,
                            ..Default::default()
                        });
                        continue;
                    }
                    emit(
                        app,
                        "ai-fixing",
                        cur,
                        total,
                        path,
                        &format!("description 已补全：{desc}"),
                    );
                    // D3：AI 修复必须回调写明「改了哪个字段、值是什么」
                    fixes.push(FixRecord {
                        kind: "ai-description".into(),
                        from: cur_desc.clone(),
                        to: desc.clone(),
                    });
                    c.skill_md_description = desc;
                    c.needs_ai = false;
                }
                Err(e) => {
                    // 决策 3：AI 不可用不阻断已有描述的技能 —— 保留原描述继续导入，
                    // 只在修复记录里标注 ai-description-skipped；没有描述才记失败。
                    if !can_continue_without_ai(&c.skill_md_description) {
                        report.failed += 1;
                        report.outcomes.push(ImportOutcomeItem {
                            path: path.clone(),
                            error: format!("AI 修复失败：{e}"),
                            fixes,
                            ..Default::default()
                        });
                        continue;
                    }
                    fixes.push(FixRecord {
                        kind: "ai-description-skipped".into(),
                        from: c.skill_md_description.clone(),
                        to: c.skill_md_description.clone(),
                    });
                    emit(
                        app,
                        "ai-fixing",
                        cur,
                        total,
                        path,
                        "AI 不可用，保留原有 description 继续导入",
                    );
                }
            }
        }

        // 来源：前端确认的优先，否则重新识别（按原始路径取，前端用它做 key）
        emit(app, "source-detecting", cur, total, path, "识别来源");
        let src = sources
            .get(path)
            .cloned()
            .or_else(|| sources.get(&c.original_path).cloned())
            .unwrap_or_else(|| detect_source(&dir));

        emit(app, "importing", cur, total, path, "写入技能中枢");
        let mut message = String::new();
        // 同名技能：用户勾了「覆盖已存在」才覆盖，否则作为失败回报
        let imported = skills::import_skill_dir(app, &dir, overwrite).map_err(|e| {
            if let Some(n) = e.strip_prefix("exists:") {
                format!("技能中枢已存在同名技能 {}（未覆盖）", n.trim())
            } else {
                e
            }
        });

        match imported {
            Ok(name) => {
                if overwrite {
                    message = "已覆盖同名技能".to_string();
                }
                let hub_dir = store::data_root(app).join("skills").join(&name);
                if let Err(e) = write_source_toml(&hub_dir, &name, &src) {
                    message = format!("{message}；写入来源失败：{e}");
                }
                report.succeeded += 1;
                report.outcomes.push(ImportOutcomeItem {
                    path: path.clone(),
                    dir_name: name.clone(),
                    name: name.clone(),
                    ok: true,
                    message,
                    error: String::new(),
                    fixes,
                });
                imported_names.push(name);
                // 导入成功后删掉该候选的暂存副本（其余候选还要用同一暂存根）
                let _ = std::fs::remove_dir_all(&dir);
            }
            Err(e) => {
                report.failed += 1;
                report.outcomes.push(ImportOutcomeItem {
                    path: path.clone(),
                    error: e,
                    fixes,
                    ..Default::default()
                });
            }
        }
    }

    // 导入成功后按设置补摘要：失败只追加到该技能的 message（不阻断导入，也不改成功计数）
    if with_summary && !imported_names.is_empty() {
        let total_n = imported_names.len();
        for (i, name) in imported_names.iter().enumerate() {
            emit(app, "summarizing", i + 1, total_n, name, "生成 AI 摘要");
            match crate::ahub::skillsummary::generate(app, name) {
                Ok(_) => {}
                Err(e) => {
                    if let Some(o) = report.outcomes.iter_mut().find(|o| o.dir_name == *name) {
                        let head = if o.message.is_empty() {
                            String::new()
                        } else {
                            format!("{}；", o.message)
                        };
                        o.message = format!("{head}摘要生成失败：{e}");
                    }
                }
            }
        }
    }

    emit(
        app,
        "done",
        total,
        total,
        root,
        &format!("导入完成：成功 {} / 共 {}", report.succeeded, total),
    );
    // 本次导入的暂存根整个删掉（含失败候选的副本）
    cleanup_session(session_id);
    // zip 解压出的临时目录用完即删（只删自己建的那种）
    cleanup_for_paths(selected);
    report
}

/// 写入 SKILL.toml 的 `[source]`（A9），保留已有的 `[source.upstream]` 与其它 section。
fn write_source_toml(dir: &Path, name: &str, src: &SourceInfo) -> Result<(), String> {
    let mut doc = crate::ahub::skill_toml::load(dir).unwrap_or_else(|| {
        let mut t = toml::value::Table::new();
        t.insert("meta".into(), toml::Value::Table(toml::value::Table::new()));
        toml::Value::Table(t)
    });
    if !doc.is_table() {
        doc = toml::Value::Table(toml::value::Table::new());
    }
    let upstream = doc
        .get("source")
        .and_then(|s| s.get("upstream"))
        .cloned();

    // meta.name 与目录名保持同步（ensure_core 只在缺失时写入，这里强制对齐）
    {
        let root_t = doc.as_table_mut().ok_or("SKILL.toml 根不是表")?;
        let meta = root_t
            .entry("meta".to_string())
            .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
        if !meta.is_table() {
            *meta = toml::Value::Table(toml::value::Table::new());
        }
        meta.as_table_mut()
            .unwrap()
            .insert("name".into(), toml::Value::String(name.to_string()));
    }

    let kind = match src.kind.as_str() {
        "url" | "local-path" | "manual" | "custom" => src.kind.clone(),
        _ => "custom".to_string(),
    };
    let mut table = toml::value::Table::new();
    table.insert("kind".into(), toml::Value::String(kind.clone()));
    table.insert("ref".into(), toml::Value::String(src.value.clone()));
    table.insert(
        "confidence".into(),
        toml::Value::String(if src.confidence.is_empty() {
            "low".to_string()
        } else {
            src.confidence.clone()
        }),
    );
    table.insert(
        "fetched_at".into(),
        toml::Value::String(crate::ahub::models::now_iso()),
    );
    if let Some(up) = upstream {
        table.insert("upstream".into(), up);
    }
    // URL 来源顺带登记远端，便于后续「检查更新」；默认不自动追（watch=false）
    if kind == "url" && !src.value.trim().is_empty() && !table.contains_key("upstream") {
        let mut up = toml::value::Table::new();
        up.insert("watch".into(), toml::Value::Boolean(false));
        up.insert("mode".into(), toml::Value::String("manual".into()));
        up.insert("remote".into(), toml::Value::String(src.value.trim().to_string()));
        table.insert("upstream".into(), toml::Value::Table(up));
    }

    doc.as_table_mut()
        .ok_or("SKILL.toml 根不是表")?
        .insert("source".into(), toml::Value::Table(table));
    crate::ahub::skill_toml::save(dir, &doc)?;
    let note = format!("批量导入：来源 {} {}", kind, src.value.trim());
    let _ = crate::ahub::skill_toml::append_event(dir, "import", "", &note, "");
    Ok(())
}

// ---------------- zip 解压（rar 不支持） ----------------

/// 解压 zip 到临时目录，返回可作为探查根的路径。
///
/// 与 `skills::import_skill_zip` 同一套安全规则：拒绝 `..` / 绝对路径条目，
/// 限制解压后总大小与条目数。**不支持 rar**（Windows 无内置支持，提示用户先解压）。
pub fn extract_zip_root(zip_path: &str) -> Result<PathBuf, String> {
    use std::io::Read;

    const MAX_TOTAL: u64 = 256 * 1024 * 1024;
    const MAX_ENTRIES: usize = 5000;

    let zp = PathBuf::from(zip_path);
    if !zp.is_file() {
        return Err(format!("压缩包不存在：{zip_path}"));
    }
    let lower = zp
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if lower == "rar" {
        return Err("不支持 rar 压缩包，请先解压后再导入".into());
    }
    if lower != "zip" {
        return Err(format!("不支持的压缩格式：{lower}（仅支持 zip）"));
    }

    let file = std::fs::File::open(&zp).map_err(store::es)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取 ZIP：{e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("ZIP 条目过多（{}），拒绝解压", archive.len()));
    }

    // 临时目录名必须唯一：并行导入（或同一秒内两次导入）不能共用一个目录
    let tmp = std::env::temp_dir().join(format!(
        "agenthub-import-{}-{}",
        std::process::id(),
        crate::ahub::models::new_id()
    ));
    std::fs::create_dir_all(&tmp).map_err(store::es)?;

    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().unwrap_or_default().to_string();
        let Some(rel) = entry.enclosed_name() else {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("ZIP 含非法路径条目：{raw_name}"));
        };
        let out = tmp.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(store::es)?;
            continue;
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("ZIP 解压后体积过大，已中止".into());
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(store::es)?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(store::es)?;
        std::fs::write(&out, &buf).map_err(store::es)?;
    }

    // 「ZIP 里多包一层目录」的常见情形：只有一个顶层目录且自身没有 SKILL.md
    let mut top: Vec<PathBuf> = std::fs::read_dir(&tmp)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    if top.len() == 1
        && top[0].is_dir()
        && find_skill_md(&tmp).is_none()
        && find_skill_md(&top[0]).is_some()
    {
        return Ok(top.remove(0));
    }

    // 包内顶层就是 SKILL.md：临时目录名绝不能成为技能名，先按压缩包名建一层目录
    if find_skill_md(&tmp).is_some() {
        let stem = zp
            .file_stem()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir_name = normalize_name(&strip_version_suffix(&stem));
        if !dir_name.is_empty() {
            let inner = tmp.join(&dir_name);
            if std::fs::create_dir_all(&inner).is_ok() {
                let mut moved = true;
                for p in &top {
                    if std::fs::rename(p, inner.join(p.file_name().unwrap_or_default())).is_err() {
                        moved = false;
                    }
                }
                if moved {
                    return Ok(inner);
                }
            }
        }
    }
    Ok(tmp)
}

/// 去掉文件名尾部的版本号：`apple-design-skill-1.7.6` → `apple-design-skill`。
fn strip_version_suffix(stem: &str) -> String {
    let mut parts: Vec<&str> = stem.split('-').collect();
    while let Some(last) = parts.last() {
        let is_version = !last.is_empty()
            && last.chars().all(|c| c.is_ascii_digit() || c == '.')
            && last.chars().any(|c| c.is_ascii_digit());
        if is_version && parts.len() > 1 {
            parts.pop();
        } else {
            break;
        }
    }
    parts.join("-")
}

// ---------------- 临时目录清理 ----------------

/// 某个路径所属的「导入临时目录」（若在系统临时目录下的 `agenthub-import-*` 内）。
fn temp_root_of(path: &Path) -> Option<PathBuf> {
    let tmp = std::env::temp_dir().canonicalize().ok()?;
    let canon = path.canonicalize().ok()?;
    if !canon.starts_with(&tmp) {
        return None;
    }
    for anc in canon.ancestors() {
        let Some(name) = anc.file_name().map(|x| x.to_string_lossy().to_string()) else {
            break;
        };
        if name.starts_with("agenthub-import-") {
            return Some(anc.to_path_buf());
        }
        if anc == tmp {
            break;
        }
    }
    None
}

/// 导入/终止后清理这些候选路径所属的临时目录（同一个临时根只清一次）。
pub fn cleanup_for_paths(paths: &[String]) -> usize {
    let mut roots: Vec<PathBuf> = paths
        .iter()
        .filter_map(|p| temp_root_of(&PathBuf::from(p)))
        .collect();
    roots.sort();
    roots.dedup();
    roots
        .iter()
        .map(|r| {
            let n = walk_count(r);
            let _ = std::fs::remove_dir_all(r);
            n
        })
        .sum()
}

fn walk_count(dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                1 + walk_count(&p)
            } else {
                1
            }
        })
        .sum()
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-skillimport-{tag}-{}", crate::ahub::models::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_skill(dir: &Path, file: &str, name: &str, desc: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let fm = if name.is_empty() && desc.is_empty() {
            String::new()
        } else {
            format!("---\nname: {name}\ndescription: {desc}\n---\n\n正文内容\n")
        };
        std::fs::write(dir.join(file), fm).unwrap();
    }

    #[test]
    fn normalize_name_cases() {
        assert_eq!(normalize_name("My Skill"), "my-skill");
        assert_eq!(normalize_name("my_skill"), "my-skill");
        assert_eq!(normalize_name("my.skill"), "my-skill");
        assert_eq!(normalize_name("my--skill"), "my-skill");
        assert_eq!(normalize_name("--my-skill--"), "my-skill");
        assert_eq!(normalize_name("  My   Skill  "), "my-skill");
        assert_eq!(normalize_name("My.Skill_2"), "my-skill-2");
        assert_eq!(normalize_name("UPPER"), "upper");
        assert_eq!(normalize_name("中文目录"), "", "纯中文无法规范化为合法名");
    }

    #[test]
    fn is_valid_name_cases() {
        assert!(is_valid_name("code-reviewer"));
        assert!(is_valid_name("a1"));
        assert!(!is_valid_name("Code-Reviewer"));
        assert!(!is_valid_name("-lead"));
        assert!(!is_valid_name("trail-"));
        assert!(!is_valid_name("double--dash"));
        assert!(!is_valid_name("with space"));
        assert!(!is_valid_name(""));
    }

    /// 摘要开关：勾选框显式取消时即使全局开启也不生成；未给定才跟随全局。
    #[test]
    fn summary_flag_prefers_explicit_choice() {
        assert!(should_generate_summary(Some(true), false), "本次勾选 → 生成");
        assert!(!should_generate_summary(Some(false), true), "本次取消 → 不生成（全局开启也不生成）");
        assert!(should_generate_summary(None, true), "未给定 → 跟随全局（开）");
        assert!(!should_generate_summary(None, false), "未给定 → 跟随全局（关）");
    }

    #[test]
    fn explore_multiple_subdirs() {
        let root = tmpdir("multi");
        write_skill(&root.join("Alpha Skill"), "SKILL.md", "alpha-skill", "一个足够长的技能描述文本");
        std::fs::create_dir_all(root.join("no-md")).unwrap();
        std::fs::write(root.join("no-md").join("README.md"), "x").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();

        let r = explore(&root);
        assert_eq!(r.candidates.len(), 2, "隐藏目录应被跳过: {:?}", r.candidates);
        let alpha = r.candidates.iter().find(|c| c.original_name == "Alpha Skill").unwrap();
        assert!(alpha.has_skill_md);
        assert_eq!(alpha.fixed_name, "alpha-skill");
        assert!(alpha.fixes.iter().any(|f| f.kind == "name-sync"));
        assert!(!alpha.needs_ai, "描述足够长时不需要 AI");

        let nomd = r.candidates.iter().find(|c| c.original_name == "no-md").unwrap();
        assert!(!nomd.has_skill_md);
        assert!(!nomd.needs_ai);
        assert!(nomd.problem.contains("SKILL.md"));
        assert_eq!(r.unrepairable.len(), 1);
        assert!(r.unrepairable[0].path.ends_with("no-md"));

        cleanup_session(&r.session_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn explore_single_skill_root() {
        let base = tmpdir("single");
        // 合规的目录名：自身含 SKILL.md，应作为唯一候选且无需修复
        let root = base.join("single-skill");
        write_skill(&root, "SKILL.md", "single-skill", "单技能根目录的合规描述文本");
        let r = explore(&root);
        assert_eq!(r.candidates.len(), 1);
        let c = &r.candidates[0];
        assert!(c.has_skill_md);
        assert_eq!(c.fixed_name, "single-skill");
        assert!(c.fixes.is_empty(), "已合规不该有修复项: {:?}", c.fixes);
        assert!(r.unrepairable.is_empty());
        cleanup_session(&r.session_id);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn explore_missing_skill_md_marks_unrepairable() {
        let root = tmpdir("missing");
        std::fs::create_dir_all(root.join("broken")).unwrap();
        let r = explore(&root);
        assert_eq!(r.candidates.len(), 1);
        assert!(!r.candidates[0].has_skill_md);
        assert_eq!(r.unrepairable.len(), 1);
        assert_eq!(r.unrepairable[0].reason, "缺少 SKILL.md");
        cleanup_session(&r.session_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_source_github_url() {
        let dir = tmpdir("src-url");
        write_skill(
            &dir,
            "SKILL.md",
            "x",
            "见 https://github.com/anthropics/skills 仓库，描述足够长",
        );
        let s = detect_source(&dir);
        assert_eq!(s.kind, "url");
        assert_eq!(s.value, "https://github.com/anthropics/skills");
        assert_eq!(s.confidence, "high");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_source_package_json_repository() {
        let dir = tmpdir("src-pkg");
        write_skill(&dir, "SKILL.md", "x", "没有链接的技能描述文本，足够长了吧");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"x","repository":{"type":"git","url":"https://gitlab.com/g/x"}}"#,
        )
        .unwrap();
        let s = detect_source(&dir);
        assert_eq!(s.kind, "url");
        assert_eq!(s.value, "https://gitlab.com/g/x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_source_manual_when_nothing() {
        let dir = tmpdir("src-none");
        write_skill(&dir, "SKILL.md", "x", "没有任何来源信息的技能描述文本");
        let s = detect_source(&dir);
        assert_eq!(s.kind, "manual");
        assert_eq!(s.confidence, "low");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_source_local_path() {
        let dir = tmpdir("src-local");
        write_skill(
            &dir,
            "SKILL.md",
            "x",
            "整理自 D:\\书\\skill\\chapter1 的手稿，描述足够长",
        );
        let s = detect_source(&dir);
        assert_eq!(s.kind, "local-path");
        assert_eq!(s.value, "D:\\书\\skill\\chapter1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_fixes_renames_dir_and_md_case() {
        let root = tmpdir("fix");
        let dir = root.join("My Skill");
        write_skill(&dir, "skill.md", "my-skill", "足够长的描述文本内容");

        let mut cands = vec![analyze_candidate(&dir)];
        let c = &cands[0];
        assert!(c.has_skill_md, "skill.md 应被识别为 SKILL.md");
        assert!(c.fixes.iter().any(|f| f.kind == "md-case"));

        let done = apply_fixes(&mut cands);
        assert!(!done.is_empty());
        let new_dir = root.join("my-skill");
        assert!(new_dir.is_dir(), "目录应被改名为 my-skill");
        assert!(new_dir.join("SKILL.md").is_file(), "文件名应改为 SKILL.md");
        assert!(!dir.exists());
        // analyze_candidate（原地分析）时 staged_path 就是 original_path，
        // 修复改名后暂存路径随之更新，原始路径保持不变。
        assert_eq!(cands[0].staged_path, new_dir.to_string_lossy());
        assert_eq!(cands[0].original_path, dir.to_string_lossy());
        assert_eq!(cands[0].fixed_name, "my-skill");

        // 幂等：再跑一次不应产生新的修复
        let again = apply_fixes(&mut cands);
        assert!(again.is_empty(), "重复修复应为空: {again:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn name_sync_wins_over_dir_name() {
        let root = tmpdir("namesync");
        let dir = root.join("Wrong-Name");
        write_skill(&dir, "SKILL.md", "right-name", "足够长的描述文本内容");
        let mut cands = vec![analyze_candidate(&dir)];
        assert_eq!(cands[0].fixed_name, "right-name");
        apply_fixes(&mut cands);
        assert!(root.join("right-name").is_dir());
        assert!(!root.join("Wrong-Name").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn needs_ai_when_description_missing_or_short() {
        let root = tmpdir("needs-ai");
        let d1 = root.join("no-desc");
        write_skill(&d1, "SKILL.md", "no-desc", "");
        assert!(analyze_candidate(&d1).needs_ai);

        let d2 = root.join("short-desc");
        write_skill(&d2, "SKILL.md", "short-desc", "太短");
        assert!(analyze_candidate(&d2).needs_ai);

        let d3 = root.join("ok-desc");
        write_skill(&d3, "SKILL.md", "ok-desc", "这是一个足够长的技能描述");
        assert!(!analyze_candidate(&d3).needs_ai);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_name_is_filled_from_dir_name() {
        let root = tmpdir("noname");
        let dir = root.join("No Name Skill");
        write_skill(&dir, "SKILL.md", "", "一个足够长的技能描述文本");
        let mut cands = vec![analyze_candidate(&dir)];
        assert_eq!(cands[0].fixed_name, "no-name-skill");
        assert!(cands[0].fixes.iter().any(|f| f.kind == "dir-rename"));
        assert!(cands[0].fixes.iter().any(|f| f.kind == "name-sync" && f.from.is_empty()));
        assert!(!cands[0].needs_ai, "描述够长就不该走 AI");

        apply_fixes(&mut cands);
        let new_dir = root.join("no-name-skill");
        assert!(new_dir.join("SKILL.md").is_file());
        let doc = std::fs::read_to_string(new_dir.join("SKILL.md")).unwrap();
        let (fm, _) = skills::split_doc(&doc);
        assert_eq!(skills::fm_get_str(&fm, "name"), "no-name-skill");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A9：导入落库时写下 [source]（kind/ref/confidence），并保留已有 [source.upstream]
    #[test]
    fn write_source_toml_records_user_confirmed_source() {
        let dir = tmpdir("src-toml");
        std::fs::create_dir_all(&dir).unwrap();
        crate::ahub::skill_toml::ensure_core(&dir, "demo", "local", "D:\\p").unwrap();
        // 预置 upstream，确认写入 source 时不被抹掉
        let mut doc = crate::ahub::skill_toml::load(&dir).unwrap();
        let mut up = toml::value::Table::new();
        up.insert("watch".into(), toml::Value::Boolean(true));
        up.insert("mode".into(), toml::Value::String("git-scan".into()));
        up.insert("remote".into(), toml::Value::String("https://x".into()));
        doc.get_mut("source")
            .unwrap()
            .as_table_mut()
            .unwrap()
            .insert("upstream".into(), toml::Value::Table(up));
        crate::ahub::skill_toml::save(&dir, &doc).unwrap();

        write_source_toml(
            &dir,
            "demo",
            &SourceInfo {
                kind: "url".into(),
                value: "https://github.com/o/r".into(),
                confidence: "high".into(),
            },
        )
        .unwrap();

        let doc = crate::ahub::skill_toml::load(&dir).unwrap();
        assert_eq!(crate::ahub::skill_toml::get_str(&doc, "source.kind").unwrap(), "url");
        assert_eq!(
            crate::ahub::skill_toml::get_str(&doc, "source.ref").unwrap(),
            "https://github.com/o/r"
        );
        assert_eq!(
            crate::ahub::skill_toml::get_str(&doc, "source.confidence").unwrap(),
            "high"
        );
        assert_eq!(
            crate::ahub::skill_toml::get_str(&doc, "source.upstream.remote").unwrap(),
            "https://x",
            "已有 upstream 必须保留"
        );
        assert_eq!(crate::ahub::skill_toml::get_str(&doc, "meta.name").unwrap(), "demo");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_root_unwraps_single_top_dir() {
        use std::io::Write;
        let base = tmpdir("zip");
        let zp = base.join("pack.zip");
        let file = std::fs::File::create(&zp).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, '_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zw.start_file("my-skill/SKILL.md", opts).unwrap();
        zw.write_all("---\nname: my-skill\ndescription: 一个足够长的技能描述文本\n---\n\n正文\n".as_bytes())
            .unwrap();
        zw.start_file("my-skill/notes.md", opts).unwrap();
        zw.write_all(b"notes").unwrap();
        zw.finish().unwrap();

        let root = extract_zip_root(&zp.to_string_lossy()).unwrap();
        // 多包一层同名目录 → 应直接指向技能目录
        assert!(root.join("SKILL.md").is_file(), "{}", root.display());
        let r = explore(&root);
        assert_eq!(r.candidates.len(), 1);
        assert!(r.candidates[0].has_skill_md);
        assert!(r.unrepairable.is_empty());
        cleanup_session(&r.session_id);
        cleanup_for_paths(&[root.to_string_lossy().to_string()]);
        assert!(!root.exists(), "临时目录应被清理");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// zip 顶层直接是 SKILL.md：临时目录名不能成为技能名，应按压缩包名建一层
    #[test]
    fn extract_zip_root_names_root_after_zip() {
        use std::io::Write;
        let base = tmpdir("zipflat");
        let zp = base.join("My.Skill-1.2.0.zip");
        let file = std::fs::File::create(&zp).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, '_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zw.start_file("SKILL.md", opts).unwrap();
        zw.write_all("---\nname: my-skill\ndescription: 一个足够长的技能描述文本\n---\n\n正文\n".as_bytes())
            .unwrap();
        zw.finish().unwrap();

        let root = extract_zip_root(&zp.to_string_lossy()).unwrap();
        assert_eq!(
            root.file_name().unwrap().to_string_lossy(),
            "my-skill",
            "临时目录名不该成为技能名：{}",
            root.display()
        );
        let r = explore(&root);
        assert_eq!(r.candidates.len(), 1);
        assert_eq!(r.candidates[0].fixed_name, "my-skill");
        assert!(r.candidates[0].fixes.is_empty(), "{:?}", r.candidates[0].fixes);
        cleanup_session(&r.session_id);
        cleanup_for_paths(&[root.to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn extract_zip_root_rejects_rar() {
        let base = tmpdir("rar");
        let rp = base.join("pack.rar");
        std::fs::write(&rp, b"not a real rar").unwrap();
        let err = extract_zip_root(&rp.to_string_lossy()).unwrap_err();
        assert!(err.contains("rar"), "应明确提示不支持 rar: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clean_ai_description_strips_wrapping() {
        assert_eq!(clean_ai_description("描述：一句话说明用途"), "一句话说明用途");
        assert_eq!(clean_ai_description("```text\n技能描述\n```"), "技能描述");
        assert_eq!(clean_ai_description("\"带引号的描述\"\n第二行"), "带引号的描述");
        assert_eq!(clean_ai_description("   "), "");
    }

    // ---------------- 决策 2：暂存副本 ----------------

    /// 探查把候选复制到暂存区，原目录一个字节都不动。
    #[test]
    fn explore_stages_copies_and_leaves_originals_untouched() {
        let root = tmpdir("stage");
        let src = root.join("My Skill");
        write_skill(&src, "skill.md", "my-skill", "足够长的描述文本内容");
        std::fs::write(src.join("notes.md"), "notes").unwrap();

        let r = explore(&root);
        assert!(!r.session_id.is_empty(), "探查必须给出 session_id");
        let session_dir = session_root(&r.session_id);
        assert!(session_dir.is_dir(), "暂存根目录应存在");

        assert_eq!(r.candidates.len(), 1);
        let c = &r.candidates[0];
        // 身份仍是原始路径 / 原始目录名
        assert_eq!(c.original_path, src.to_string_lossy());
        assert_eq!(c.original_name, "My Skill");
        // 暂存副本在会话目录下，且带全部文件
        assert!(c.staged_path.starts_with(&session_dir.to_string_lossy().to_string()));
        assert!(Path::new(&c.staged_path).join("notes.md").is_file());

        // 修复只改暂存副本：原目录连大小写都没变
        let mut cands = r.candidates.clone();
        apply_fixes(&mut cands);
        assert!(src.join("skill.md").is_file(), "原目录的 SKILL.md 大小写不该被改");
        assert!(src.join("My Skill").exists() || src.is_dir());
        let staged_fixed = Path::new(&cands[0].staged_path);
        assert!(staged_fixed.join("SKILL.md").is_file(), "暂存副本应被改成 SKILL.md");
        assert_eq!(
            staged_fixed.file_name().unwrap().to_string_lossy(),
            "my-skill",
            "暂存副本应改名为 my-skill"
        );
        assert_eq!(cands[0].original_path, src.to_string_lossy(), "原始路径不随修复改变");

        cleanup_session(&r.session_id);
        assert!(!session_dir.exists(), "cleanup_session 应删掉整个暂存根");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 复制到暂存区时跳过 .git / node_modules / .DS_Store
    #[test]
    fn staging_copy_skips_heavy_dirs() {
        let root = tmpdir("stage-skip");
        let src = root.join("pack");
        write_skill(&src, "SKILL.md", "pack", "足够长的描述文本内容");
        std::fs::create_dir_all(src.join(".git").join("objects")).unwrap();
        std::fs::write(src.join(".git").join("objects").join("x"), "blob").unwrap();
        std::fs::create_dir_all(src.join("node_modules").join("dep")).unwrap();
        std::fs::write(src.join("node_modules").join("dep").join("i.js"), "1").unwrap();
        std::fs::write(src.join(".DS_Store"), "junk").unwrap();

        let r = explore(&root);
        let staged = PathBuf::from(&r.candidates[0].staged_path);
        assert!(staged.join("SKILL.md").is_file());
        assert!(!staged.join(".git").exists(), ".git 不该被复制");
        assert!(!staged.join("node_modules").exists(), "node_modules 不该被复制");
        assert!(!staged.join(".DS_Store").exists(), ".DS_Store 不该被复制");

        cleanup_session(&r.session_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 同名候选在暂存区各自独立（不会互相覆盖）
    #[test]
    fn staging_keeps_same_name_candidates_apart() {
        let base = tmpdir("stage-dup");
        let a = base.join("a");
        let b = base.join("b");
        write_skill(&a.join("dup"), "SKILL.md", "dup", "第一个技能的足够长描述");
        write_skill(&b.join("dup"), "SKILL.md", "dup", "第二个技能的足够长描述");
        let sid = crate::ahub::models::new_id();

        let ra = explore_with_session(&a, Some(&sid));
        let rb = explore_with_session(&b, Some(&sid));
        assert_eq!(ra.session_id, sid);
        assert_eq!(rb.session_id, sid);
        assert_ne!(
            ra.candidates[0].staged_path, rb.candidates[0].staged_path,
            "同名候选的暂存副本必须不同"
        );
        assert!(Path::new(&ra.candidates[0].staged_path).is_dir());
        assert!(Path::new(&rb.candidates[0].staged_path).is_dir());

        cleanup_session(&sid);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 暂存会话 id 来自前端：只接受字母数字与连字符，
    /// 否则 `..` / 路径分隔符会让清理删到 `%TEMP%` 之外的目录。
    #[test]
    fn session_id_rejects_path_escapes() {
        assert_eq!(sanitize_session_id("abc-123").as_deref(), Some("abc-123"));
        assert!(sanitize_session_id("  9f2c4e1a-0000-4000-8000-abcdefabcdef  ").is_some());
        assert!(sanitize_session_id("..").is_none(), ".. 必须被拒绝");
        assert!(sanitize_session_id("../..").is_none());
        assert!(sanitize_session_id("a/b").is_none());
        assert!(sanitize_session_id("a\\b").is_none());
        assert!(sanitize_session_id("C:\\Windows").is_none());
        assert!(sanitize_session_id("").is_none());
        assert!(sanitize_session_id("   ").is_none());
        assert!(sanitize_session_id(&"a".repeat(65)).is_none(), "过长 id 应被拒绝");

        // 非法 id 的清理必须是无操作（不删任何目录）
        assert_eq!(cleanup_session(".."), 0);
        assert_eq!(cleanup_session(""), 0);

        // 非法 session_id 不会逃出临时目录：探查改用新生成的 id
        let root = tmpdir("sid-escape");
        write_skill(&root.join("s"), "SKILL.md", "s", "足够长的描述文本内容");
        let r = explore_with_session(&root, Some("../.."));
        assert_ne!(r.session_id, "../..");
        assert!(sanitize_session_id(&r.session_id).is_some(), "应回退到合法 id");
        assert!(session_root(&r.session_id).starts_with(std::env::temp_dir()));
        cleanup_session(&r.session_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 端到端：多子目录探查 → 程序修复 → 清理，全程不动原目录。
    ///
    /// 覆盖 A1（多子目录枚举 / 无 SKILL.md 汇总）、A2（md 大小写 + 目录名）、
    /// A3（name 优先）、A4（缺描述标记 needs_ai）、A6（github URL 来源）、
    /// 以及决策 2 的「原目录不动」。
    #[test]
    fn e2e_explore_fix_cleanup_keeps_originals() {
        let root = std::env::temp_dir().join(format!("ah-probe-{}", crate::ahub::models::new_id()));
        let good = root.join("good-skill");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            good.join("SKILL.md"),
            "---\nname: good-skill\ndescription: 这是一个足够长的合规描述\n---\n\n正文\n",
        )
        .unwrap();
        let bad = root.join("My Bad Name");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            bad.join("skill.md"),
            "---\nname: real-name\ndescription: 这是一个足够长的描述文本\n---\n\n正文\n",
        )
        .unwrap();
        let nodesc = root.join("no-desc");
        std::fs::create_dir_all(&nodesc).unwrap();
        std::fs::write(nodesc.join("SKILL.md"), "---\nname: no-desc\n---\n\n正文内容\n").unwrap();
        std::fs::create_dir_all(root.join("no-md")).unwrap();
        std::fs::write(root.join("no-md").join("a.txt"), "x").unwrap();
        let src = root.join("with-src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("SKILL.md"),
            "---\nname: with-src\ndescription: 来源测试的足够长描述文本\n---\n\nhttps://github.com/o/r\n",
        )
        .unwrap();

        let r = explore(&root);
        assert_eq!(r.candidates.len(), 5, "5 个子目录各一个候选");
        assert_eq!(r.unrepairable.len(), 1, "只有 no-md 无法修复");
        assert!(r.unrepairable[0].path.ends_with("no-md"));

        let find = |name: &str| r.candidates.iter().find(|c| c.original_name == name).unwrap();

        // A3 + A2：以 name 为准，md 大小写要修
        let bad_c = find("My Bad Name");
        assert_eq!(bad_c.fixed_name, "real-name");
        assert!(bad_c.fixes.iter().any(|f| f.kind == "md-case"));
        assert!(bad_c.fixes.iter().any(|f| f.kind == "name-sync"));

        // A4：缺 description → 需要 AI
        assert!(find("no-desc").needs_ai);
        assert!(!find("good-skill").needs_ai, "合规技能不该走 AI");

        // A6：github URL → url 来源，高置信
        let src_c = find("with-src");
        assert_eq!(src_c.source.kind, "url");
        assert_eq!(src_c.source.value, "https://github.com/o/r");
        assert_eq!(src_c.source.confidence, "high");
        assert_eq!(find("good-skill").source.kind, "manual");

        // 决策 2：修复前原目录里是 skill.md
        assert!(bad.join("skill.md").is_file());

        let mut cands = r.candidates.clone();
        let done = apply_fixes(&mut cands);
        assert!(done.iter().any(|f| f.kind == "md-case"));

        // 修复后原目录一个字节都没动
        assert!(bad.is_dir(), "原目录不能被改名");
        assert!(bad.join("skill.md").is_file(), "原目录的 skill.md 不能被改名");
        assert!(!bad.join("real-name").exists());

        // 暂存副本被改成 real-name/SKILL.md
        let staged = cands
            .iter()
            .find(|c| c.original_name == "My Bad Name")
            .unwrap();
        let staged_dir = Path::new(&staged.staged_path);
        assert_eq!(staged_dir.file_name().unwrap().to_string_lossy(), "real-name");
        assert!(staged_dir.join("SKILL.md").is_file());
        assert_eq!(staged.original_path, bad.to_string_lossy(), "原始路径保持不变");

        // 清理整个会话目录
        let n = cleanup_session(&r.session_id);
        assert!(n > 0);
        assert!(!session_root(&r.session_id).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------------- 决策 3：AI 不可用不阻断已有描述 ----------------    /// needs_ai 三档：无描述 → 需 AI；过短 → 需 AI；够长 → 不需 AI。
    /// AI 不可用时的处置：原描述为空才失败，非空保留原描述继续（ai-description-skipped）。
    #[test]
    fn ai_unavailable_keeps_existing_description() {
        let root = tmpdir("ai-skip");
        // 描述为空 → 没有任何可保留的描述，AI 失败即失败
        let empty = root.join("empty-desc");
        write_skill(&empty, "SKILL.md", "empty-desc", "");
        let c_empty = analyze_candidate(&empty);
        assert!(c_empty.needs_ai);
        assert!(c_empty.skill_md_description.trim().is_empty());
        assert!(!can_continue_without_ai(&c_empty.skill_md_description));

        // 描述过短但非空 → AI 失败时应保留原描述继续导入
        let short = root.join("short-desc");
        write_skill(&short, "SKILL.md", "short-desc", "太短");
        let c_short = analyze_candidate(&short);
        assert!(c_short.needs_ai);
        assert!(!c_short.skill_md_description.trim().is_empty());
        assert!(can_continue_without_ai(&c_short.skill_md_description));
        // 原描述确实还写在磁盘上（保留语义的前提）
        let doc = std::fs::read_to_string(short.join("SKILL.md")).unwrap();
        let (fm, _) = skills::split_doc(&doc);
        assert_eq!(skills::fm_get_str(&fm, "description"), "太短");

        // 描述够长 → 根本不走 AI，自然不受 AI 不可用影响
        let ok = root.join("ok-desc");
        write_skill(&ok, "SKILL.md", "ok-desc", "这是一个足够长的技能描述");
        assert!(!analyze_candidate(&ok).needs_ai);
        let _ = std::fs::remove_dir_all(&root);
    }
}
