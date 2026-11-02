//! GitHub 的本地边界：token 取用（系统凭据管理器优先，环境变量兜底）与源码包下载。
//! 仓库、star、热榜、翻译都由前端走 tauri-plugin-http 直连，这里不代理那些请求。
use crate::credential_vault;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SERVICE: &str = "GitHub";
const ID: &str = "token";
/// 源码包上限：再大的仓库应该用 git clone，而不是整包落盘。
const MAX_ZIP: u64 = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: u64 = 120;
const UA: &str = "NimbusDesk/0.1 (+desktop)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    /// "vault" | "env" | "none"
    pub source: &'static str,
}

fn env_token() -> Option<String> {
    ["GITHUB_TOKEN", "GH_TOKEN"].iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// 只挡明显不对的输入：GitHub 自己会拒掉剩余情况，这里不做前缀白名单。
fn valid_token(token: &str) -> bool {
    (20..=255).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_graphic())
}

#[tauri::command]
pub fn github_token_status() -> Result<TokenStatus, String> {
    let stored = credential_vault::read(SERVICE, ID).map_err(|_| "GITHUB_CREDENTIAL_READ_FAILED")?;
    let source = if stored.is_some() {
        "vault"
    } else if env_token().is_some() {
        "env"
    } else {
        "none"
    };
    Ok(TokenStatus { source })
}

#[tauri::command]
pub fn github_token() -> Result<String, String> {
    if let Some(token) =
        credential_vault::read(SERVICE, ID).map_err(|_| "GITHUB_CREDENTIAL_READ_FAILED")?
    {
        return Ok(token);
    }
    env_token().ok_or_else(|| "GITHUB_TOKEN_MISSING".into())
}

#[tauri::command]
pub fn github_save_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if !valid_token(token) {
        return Err("GITHUB_INVALID_TOKEN".into());
    }
    credential_vault::save(SERVICE, ID, token).map_err(|code| {
        if code == credential_vault::INVALID {
            "GITHUB_INVALID_TOKEN".to_string()
        } else {
            "GITHUB_CREDENTIAL_WRITE_FAILED".to_string()
        }
    })
}

#[tauri::command]
pub fn github_forget_token() -> Result<(), String> {
    credential_vault::delete(SERVICE, ID).map_err(|_| "GITHUB_CREDENTIAL_DELETE_FAILED".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
}

/// 只接受 GitHub 允许的仓库名/分支片段：挡住 `..`、分隔符和控制字符，
/// 因为这段字符串会直接变成落盘路径。
fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 分支可以带 `/`（`release/2026`、`feature/x` 都是真实分支），
/// 但仍然要挡住 `..`、反斜杠、空段和控制字符——它也会变成文件名。
fn valid_branch(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 200
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
        && !value.contains('\\')
        && !value.contains("//")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
}

fn zip_file_name(repo: &str, branch: &str) -> String {
    // 分支里的 `/` 折成 `-`：文件系统里没有目录层级可言。
    format!("{repo}-{}.zip", branch.replace(['/', '\\'], "-"))
}

/// 同名文件已存在时加 `-2`、`-3`，绝不覆盖用户已有的目录内容。
fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = file_name.strip_suffix(".zip").unwrap_or(file_name);
    for index in 2..1000 {
        let next = dir.join(format!("{stem}-{index}.zip"));
        if !next.exists() {
            return next;
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    dir.join(format!("{stem}-{stamp}.zip"))
}

#[tauri::command]
pub fn github_default_download_dir() -> Result<String, String> {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .map(|dir| dir.to_string_lossy().into_owned())
        .ok_or_else(|| "GITHUB_NO_DOWNLOAD_DIR".to_string())
}

/// 用 codeload 的 zip 地址把源码包存成文件（不 clone、不装 git、不自动解压）。
#[tauri::command]
pub fn github_download_zip(
    owner: String,
    repo: String,
    branch: String,
    dir: Option<String>,
) -> Result<DownloadResult, String> {
    if !valid_segment(owner.trim()) || !valid_segment(repo.trim()) || !valid_branch(&branch)
    {
        return Err("GITHUB_INVALID_TARGET".into());
    }
    let (owner, repo, branch) = (owner.trim(), repo.trim(), branch.trim());
    let dir = match dir.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(github_default_download_dir()?),
    };
    fs::create_dir_all(&dir).map_err(|_| "GITHUB_DOWNLOAD_DIR_FAILED")?;

    let url = format!("https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT))
        .build();
    let response = agent
        .get(&url)
        .set("User-Agent", UA)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(404, _) => "GITHUB_REPO_NOT_FOUND".to_string(),
            ureq::Error::Status(code, _) => format!("GITHUB_DOWNLOAD_FAILED_HTTP_{code}"),
            _ => "GITHUB_DOWNLOAD_FAILED".to_string(),
        })?;
    if let Some(length) = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > MAX_ZIP {
            return Err("GITHUB_DOWNLOAD_TOO_LARGE".into());
        }
    }

    let dest = unique_path(&dir, &zip_file_name(repo, branch));
    let temp = dest.with_extension("zip.part");
    let mut reader = response.into_reader().take(MAX_ZIP + 1);
    let bytes = {
        let mut file = fs::File::create(&temp).map_err(|_| "GITHUB_DOWNLOAD_WRITE_FAILED")?;
        let written = std::io::copy(&mut reader, &mut file).map_err(|_| {
            let _ = fs::remove_file(&temp);
            "GITHUB_DOWNLOAD_WRITE_FAILED"
        })?;
        file.flush().map_err(|_| "GITHUB_DOWNLOAD_WRITE_FAILED")?;
        file.sync_all().map_err(|_| "GITHUB_DOWNLOAD_WRITE_FAILED")?;
        written
    };
    if bytes > MAX_ZIP {
        let _ = fs::remove_file(&temp);
        return Err("GITHUB_DOWNLOAD_TOO_LARGE".into());
    }
    fs::rename(&temp, &dest).map_err(|_| {
        let _ = fs::remove_file(&temp);
        "GITHUB_DOWNLOAD_WRITE_FAILED"
    })?;
    Ok(DownloadResult {
        path: dest.to_string_lossy().into_owned(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::{valid_branch, valid_segment, valid_token, zip_file_name};

    #[test]
    fn rejects_empty_and_multiline_tokens() {
        assert!(!valid_token(""));
        assert!(!valid_token("ghp_short"));
        assert!(!valid_token(&format!("ghp_{}\n", "a".repeat(36))));
        assert!(valid_token(&format!("ghp_{}", "a".repeat(36))));
    }

    #[test]
    fn download_segments_cannot_escape_the_target_folder() {
        assert!(valid_segment("nimbus-desk"));
        assert!(valid_segment("v0.1.2"));
        assert!(valid_segment("release_2026"));
        assert!(!valid_segment(".."));
        assert!(!valid_segment("."));
        assert!(!valid_segment("a/b"));
        assert!(!valid_segment("a\\b"));
        assert!(!valid_segment("C:"));
        assert!(!valid_segment(""));
        assert!(!valid_segment(&"a".repeat(101)));
        assert!(!valid_segment("sp ace"));
    }

    #[test]
    fn zip_names_flatten_branch_separators_but_segments_are_already_strict() {
        assert_eq!(zip_file_name("nimbus-desk", "main"), "nimbus-desk-main.zip");
        assert_eq!(zip_file_name("kit", "release/2026"), "kit-release-2026.zip");
    }

    #[test]
    fn branches_may_contain_slashes_but_never_escape_the_folder() {
        assert!(valid_branch("main"));
        assert!(valid_branch("release/2026"));
        assert!(valid_branch("feature/github-panel"));
        assert!(!valid_branch(""));
        assert!(!valid_branch(".."));
        assert!(!valid_branch("release/../etc"));
        assert!(!valid_branch("/main"));
        assert!(!valid_branch("main/"));
        assert!(!valid_branch("a//b"));
        assert!(!valid_branch("a\\b"));
        assert!(!valid_branch("a b"));
        assert!(!valid_branch(&"a".repeat(201)));
    }

    /// 需要本机凭据管理器：证明 token 真的落在 Windows 凭据里，而不是配置文件。
    #[cfg(windows)]
    #[test]
    #[ignore = "读写本机凭据管理器；手动跑 cargo test --lib -- --ignored github"]
    fn vault_roundtrip_under_the_github_service() {
        use super::{credential_vault, SERVICE};
        let id = format!("fixture-{}", std::process::id());
        let _ = credential_vault::delete(SERVICE, &id);
        assert!(credential_vault::read(SERVICE, &id).unwrap().is_none());
        credential_vault::save(SERVICE, &id, "ghp_fixturefixturefixturefixture").unwrap();
        assert_eq!(
            credential_vault::read(SERVICE, &id).unwrap().as_deref(),
            Some("ghp_fixturefixturefixturefixture")
        );
        credential_vault::delete(SERVICE, &id).unwrap();
        assert!(credential_vault::read(SERVICE, &id).unwrap().is_none());
    }

    /// 需要网络：真去 codeload 下一个 zip，证明整条落盘链路可用。
    #[test]
    #[ignore = "需要网络；手动跑 cargo test --lib -- --ignored github"]
    fn downloads_a_real_zip_into_the_target_folder() {
        let dir = std::env::temp_dir().join(format!("nimbusdesk-github-{}", std::process::id()));
        let result = super::github_download_zip(
            "octocat".into(),
            "Hello-World".into(),
            "master".into(),
            Some(dir.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert!(result.bytes > 0);
        let bytes = std::fs::read(&result.path).unwrap();
        assert_eq!(&bytes[..2], b"PK", "codeload must return a zip archive");
        assert!(result.path.ends_with("Hello-World-master.zip"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
