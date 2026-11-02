use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/**
 * 本地 git 仓库的**只读**状态：分支、未提交改动数、最近一次提交。
 *
 * 为什么直接调 `git` 而不是自己解析 `.git`：解析 object/ref 格式等于重写一半 git，
 * 而且 submodule、worktree、detached HEAD 这些边界会一件件冒出来。代价是要求机器上
 * 有 git —— 没有时返回 `noGit`，前端照实说明，不假装仓库是干净的。
 *
 * 一律 `-C <path>`、`--no-pager`，并关掉终端交互与可选锁：
 * 用户可能把一个**没有 upstream** 的仓库挂进来，任何一次 git 都不该弹窗或写锁。
 */
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    /// 短 hash
    pub short: String,
    /// 提交标题（subject）
    pub subject: String,
    /// 提交时间，RFC3339
    pub date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoStatus {
    pub path: String,
    /// 目录名，前端列表里当标题
    pub name: String,
    /// 分支名；分离头指针时是短 hash
    pub branch: String,
    pub dirty: bool,
    /// 有改动（含未跟踪）的文件数
    pub changed: u32,
    /// 还没有任何提交时为 None
    pub commit: Option<GitCommit>,
}

/**
 * 错误带 `kind`，让前端按种类出双语文案，而不是把英文/中文错误串直接怼到界面上。
 * kind: notFound（路径不在）| noGit（机器上没有 git）| notRepo（不是仓库）| failed（其它）
 */
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoError {
    pub kind: String,
    pub message: String,
}

impl GitRepoError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into() }
    }
}

/// 跑一条 git 子命令，回 stdout。失败时把 stderr 一并带回，便于排查。
fn git(path: &Path, args: &[&str]) -> Result<String, GitRepoError> {
    let output = Command::new("git")
        .arg("--no-pager")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitRepoError::new("noGit", "git executable not found"),
            _ => GitRepoError::new("failed", error.to_string()),
        })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(GitRepoError::new("failed", if detail.is_empty() { "git command failed".into() } else { detail }))
}

/// porcelain 里一行一个文件（含未跟踪），只数非空行。
fn count_changed(porcelain: &str) -> u32 {
    porcelain.lines().filter(|line| !line.trim().is_empty()).count() as u32
}

/// `%h%x1f%cI%x1f%s` —— 三个字段用不可见分隔符拼在一行里，避免标题里的空格干扰。
fn parse_commit(line: &str) -> Option<GitCommit> {
    let mut parts = line.trim().split('\u{1f}');
    let short = parts.next()?.trim();
    let date = parts.next()?.trim();
    let subject = parts.next()?.trim();
    if short.is_empty() {
        return None;
    }
    Some(GitCommit { short: short.into(), subject: subject.into(), date: date.into() })
}

#[tauri::command]
pub fn git_repo_status(path: String) -> Result<GitRepoStatus, GitRepoError> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(GitRepoError::new("notFound", format!("not a directory: {path}")));
    }
    // 先问一句「是不是仓库」：失败一定是 notRepo，不必让调用方去分辨错误串
    if git(&dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err(GitRepoError::new("notRepo", format!("not a git repository: {path}")));
    }

    let mut branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    // 分离头指针：git 回 "HEAD"，此时用短 hash 更有信息量
    if branch == "HEAD" {
        branch = git(&dir, &["rev-parse", "--short", "HEAD"]).map(|out| out.trim().to_string()).unwrap_or(branch);
    }

    let changed = count_changed(&git(&dir, &["status", "--porcelain"])?);
    // 新仓库还没有提交：log 会失败，这不是错误，按「无提交」呈现
    let commit = git(&dir, &["log", "-1", "--pretty=%h\u{1f}%cI\u{1f}%s"])
        .ok()
        .and_then(|out| parse_commit(out.lines().next().unwrap_or("")));

    Ok(GitRepoStatus {
        path,
        name: dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        branch,
        dirty: changed > 0,
        changed,
        commit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_changed_files_including_untracked() {
        assert_eq!(count_changed(""), 0);
        assert_eq!(count_changed("\n  \n"), 0);
        assert_eq!(count_changed(" M src/a.ts\n?? src/b.ts\n"), 2);
        // porcelain 在 Windows 上是 CRLF，按行切不能多算
        assert_eq!(count_changed(" M a\r\n?? b\r\n"), 2);
    }

    #[test]
    fn parses_commit_line() {
        let parsed = parse_commit("1a2b3c4\u{1f}2026-11-02T10:00:00+08:00\u{1f}fix: 一行说明里有 空格 也无妨").unwrap();
        assert_eq!(parsed.short, "1a2b3c4");
        assert_eq!(parsed.date, "2026-11-02T10:00:00+08:00");
        assert_eq!(parsed.subject, "fix: 一行说明里有 空格 也无妨");
        assert!(parse_commit("").is_none());
        assert!(parse_commit("\u{1f}2026-11-02\u{1f}只有日期").is_none());
    }

    #[test]
    fn missing_path_reports_kind() {
        let error = git_repo_status("Z:\\definitely\\missing\\dir".into()).unwrap_err();
        assert_eq!(error.kind, "notFound");
    }
}
