//! SSEP 分发：Git 同步（publish/pull）
//! 将数据目录初始化为 git 仓库，绑定 remote，一键 push（自动 .gitignore + commit）
//! 全部调用系统 git，零额外依赖。

use crate::ahub::store::AppH;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub initialized: bool,
    pub has_remote: bool,
    pub remote_url: String,
    pub branch: String,
    pub dirty_files: Vec<String>,
    pub last_commit: String,
    pub ahead: u32,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::ahub::store::silent_command("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|_| "git 不可用（未安装或不在 PATH）".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // 让调用方按需处理特定错误
        return Err(if err.is_empty() {
            format!("git {:?} 执行失败", args)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

const GITIGNORE: &str = "# AgentHub 数据同步\n*.agenthub-bak-*\n*.agenthub-staging-*\n*.agenthub-git-*\nThumbs.db\n.DS_Store\n";

/// 确保数据目录已初始化为 git 仓库（幂等）
fn ensure_repo(root: &Path) -> Result<(), String> {
    if !root.join(".git").exists() {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        git(root, &["init"])?;
        std::fs::write(root.join(".gitignore"), GITIGNORE).map_err(|e| e.to_string())?;
    } else {
        // .gitignore 保障（老仓库补齐）
        let gi = root.join(".gitignore");
        if !gi.exists() {
            std::fs::write(&gi, GITIGNORE).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn status(app: &AppH) -> Result<SyncStatus, String> {
    let root = crate::ahub::store::data_root(app);
    if !root.join(".git").exists() {
        return Ok(SyncStatus {
            initialized: false,
            has_remote: false,
            remote_url: String::new(),
            branch: String::new(),
            dirty_files: vec![],
            last_commit: String::new(),
            ahead: 0,
        });
    }
    let remote_url = git(&root, &["remote", "get-url", "origin"]).unwrap_or_default();
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let last_commit = git(&root, &["log", "-1", "--format=%h %s (%cr)"]).unwrap_or_default();
    let dirty = git(&root, &["status", "--porcelain"]).unwrap_or_default();
    let dirty_files: Vec<String> = dirty
        .lines()
        .map(|l| l.trim_start()[3.min(l.trim_start().len())..].trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let ahead = git(&root, &["rev-list", "--count", "@{upstream}..HEAD"])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(SyncStatus {
        initialized: true,
        has_remote: !remote_url.is_empty(),
        remote_url,
        branch,
        dirty_files,
        last_commit,
        ahead,
    })
}

pub fn set_remote(app: &AppH, url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() || !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@") || url.starts_with("file://")) {
        return Err("请输入有效的远程仓库地址（https:// 或 git@）".into());
    }
    let root = crate::ahub::store::data_root(app);
    ensure_repo(&root)?;
    // upsert remote
    let _ = git(&root, &["remote", "remove", "origin"]);
    git(&root, &["remote", "add", "origin", url])?;
    Ok(())
}

/// 推送：stage 全部 → commit（如有变更）→ push（首次 -u origin）
/// authed=true 时使用 auth.rs 的 token URL（一次一构造，不落盘）
pub fn push(app: &AppH, message: &str, authed: bool, provider: &str) -> Result<String, String> {
    let root = crate::ahub::store::data_root(app);
    ensure_repo(&root)?;
    let remote_url = if authed {
        crate::ahub::auth::authenticated_url(app, provider)?.0
    } else {
        git(&root, &["remote", "get-url", "origin"])
            .map_err(|_| "未绑定远程仓库，请先在设置中填写".to_string())?
    };

    git(&root, &["add", "-A"])?;
    let staged = git(&root, &["status", "--porcelain"])?;
    if staged.trim().is_empty() {
        // 无变更：仍尝试 push（可能有本地未推提交）
    } else {
        let msg = if message.trim().is_empty() {
            format!("AgentHub 同步 · {}", crate::ahub::models::now_iso())
        } else {
            message.trim().to_string()
        };
        let _ = git(&root, &["-c", "user.name=AgentHub", "-c", "user.email=agenthub@local", "commit", "-m", &msg])?;
    }

    // 统一 push <url> refspec：与临时 URL 兼容，不把凭据写进 git config
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    let out = git(&root, &["push", &remote_url, &format!("{branch}:{branch}")]);
    match out {
        Ok(s) => {
            let detail = if s.is_empty() { String::new() } else { format!("
{}", s.chars().take(400).collect::<String>()) };
            Ok(format!("已推送到远端{detail}"))
        }
        Err(e) => {
            let hint = if e.contains("rejected") || e.contains("fetch first") {
                "远端有新提交，请先「拉取同步」合并后再推送"
            } else if e.contains("Authentication") || e.contains("auth") || e.contains("403") {
                "认证失败：请在本机配置 git 凭据（HTTPS 用凭据管理器 / token，SSH 用密钥）"
            } else {
                ""
            };
            Err(if hint.is_empty() { e } else { format!("{e}\n提示：{hint}") })
        }
    }
}

/// 拉取合并（--no-rebase，冲突时中止并提示手动处理）
pub fn pull(app: &AppH, authed: bool, provider: &str) -> Result<String, String> {
    let root = crate::ahub::store::data_root(app);
    ensure_repo(&root)?;
    let remote_url = if authed {
        crate::ahub::auth::authenticated_url(app, provider)?.0
    } else {
        git(&root, &["remote", "get-url", "origin"])
            .map_err(|_| "未绑定远程仓库，请先在设置中填写".to_string())?
    };
    let dirty = git(&root, &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        // 本地有未提交变更 → 先提交再拉，避免冲突丢失
        git(&root, &["add", "-A"])?;
        let _ = git(&root, &[
            "-c",
            "user.name=AgentHub",
            "-c",
            "user.email=agenthub@local",
            "commit",
            "-m",
            &format!("AgentHub 本地变更（拉取前自动提交）· {}", crate::ahub::models::now_iso()),
        ])?;
    }
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    let has_upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_ok();
    // fetch + merge（等价 pull，但与临时 URL 兼容）
    git(&root, &["fetch", &remote_url, &branch])?;
    let has_upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_ok();
    if !has_upstream {
        // 建立跟踪分支
        git(&root, &["branch", "--set-upstream-to=FETCH_HEAD", &branch]).ok();
    }
    let out = git(&root, &["merge", "FETCH_HEAD"]);
    match out {
        Ok(s) => {
            // 冲突检测：pull 失败时上面已 Err；成功则检查未合并文件
            let unmerged = git(&root, &["status", "--porcelain"]).unwrap_or_default();
            if unmerged.lines().any(|l| l.starts_with("UU") || l.starts_with("AA")) {
                git(&root, &["merge", "--abort"]).ok();
                return Err("合并冲突：已中止合并。两边都改了同名文件，请手动处理（或先备份后强制覆盖）。".into());
            }
            Ok(if s.trim().is_empty() { "已是最新".into() } else { s })
        }
        Err(e) => {
            git(&root, &["merge", "--abort"]).ok();
            Err(format!("{e}\n提示：合并冲突已自动中止，本地与远端内容均已保留。"))
        }
    }
}
