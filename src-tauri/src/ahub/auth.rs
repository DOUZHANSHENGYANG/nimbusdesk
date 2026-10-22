//! OAuth 授权（GitHub Device Flow）+ 自动建私有仓库 + PAT 通用支持
//!
//! GitHub Device Flow：官方公开端点，桌面应用免注册使用。
//! Gitee：无公开 device flow，走 PAT。

use crate::ahub::store::AppH;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeSession {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub ok: bool,
    pub login: String,
    pub provider: String, // github
    pub error: String,
}

const CLIENT_ID: &str = "178c6fc778ccc68e1d6a"; // GitHub CLI 公共 client_id（官方 OAuth App，device flow 通用）
const REPO_NAME: &str = "agenthub-backup";

fn store_token_path(app: &AppH) -> std::path::PathBuf {
    crate::ahub::store::config_dir(app).join("auth.json")
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenStore {
    github_token: String,
    gitee_token: String,
    login: String,
    repo_url: String,
}

fn load_store(app: &AppH) -> TokenStore {
    std::fs::read_to_string(store_token_path(app))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_store(app: &AppH, s: &TokenStore) -> Result<(), String> {
    let p = store_token_path(app);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    // 权限最小化提示：Windows 下依赖用户目录 ACL
    std::fs::write(p, text).map_err(|e| e.to_string())
}

pub fn has_auth(app: &AppH) -> Result<serde_json::Value, String> {
    let s = load_store(app);
    Ok(serde_json::json!({
        "github": !s.github_token.is_empty(),
        "gitee": !s.gitee_token.is_empty(),
        "login": s.login,
        "repoUrl": s.repo_url,
    }))
}

pub fn logout(app: &AppH) -> Result<(), String> {
    save_store(app, &TokenStore::default())?;
    // 解绑 remote
    let root = crate::ahub::store::data_root(app);
    if root.join(".git").exists() {
        let _ = crate::ahub::store::silent_command("git")
            .current_dir(&root)
            .args(["remote", "remove", "origin"])
            .output();
    }
    Ok(())
}

// ---------------- GitHub Device Flow ----------------

/// 第一步：获取设备码
pub fn github_start() -> Result<DeviceCodeSession, String> {
    let resp = ureq::post("https://github.com/login/device/code")
        .set("Accept", "application/json")
        .send_form(&[("client_id", CLIENT_ID), ("scope", "repo")])
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    Ok(DeviceCodeSession {
        user_code: v["user_code"].as_str().unwrap_or("").into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://github.com/login/device").into(),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
        interval: v["interval"].as_u64().unwrap_or(5),
    })
}

/// 第二步：轮询换取 token（前端按 interval 轮询；authorization_pending = 继续等）
pub fn github_poll(app: &AppH, device_code: &str) -> Result<AuthResult, String> {
    let resp = ureq::post("https://github.com/login/oauth/access_token")
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    if let Some(err) = v["error"].as_str() {
        return Ok(AuthResult {
            ok: false,
            login: String::new(),
            provider: "github".into(),
            error: err.into(), // authorization_pending / slow_down / expired_token / denied
        });
    }
    let token = v["access_token"].as_str().unwrap_or("").to_string();
    if token.is_empty() {
        return Ok(AuthResult {
            ok: false,
            login: String::new(),
            provider: "github".into(),
            error: "empty_token".into(),
        });
    }

    // 获取用户名
    let login: String = github_api_get(&token, "https://api.github.com/user")
        .ok()
        .and_then(|u| u["login"].as_str().map(String::from))
        .unwrap_or_default();

    let mut s = load_store(app);
    s.github_token = token;
    s.login = login.clone();
    save_store(app, &s)?;

    Ok(AuthResult { ok: true, login, provider: "github".into(), error: String::new() })
}

fn github_api_get(token: &str, url: &str) -> Result<serde_json::Value, String> {
    let resp = ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "AgentHub")
        .call()
        .map_err(|e| format!("GitHub API 失败: {e}"))?;
    resp.into_json().map_err(|e| e.to_string())
}

/// 自动建私有备份仓库（存在则跳过），返回仓库 url
pub fn create_backup_repo(app: &AppH, provider: &str) -> Result<String, String> {
    let mut s = load_store(app);
    let (token, api): (&str, &str) = match provider {
        "gitee" => (s.gitee_token.as_str(), "https://gitee.com/api/v5"),
        _ => (s.github_token.as_str(), "https://api.github.com"),
    };
    if token.is_empty() {
        return Err("未授权".into());
    }

    if provider == "gitee" {
        // Gitee: POST /user/repos { name, private }
        let resp = ureq::post(&format!("{api}/user/repos"))
            .set("Content-Type", "application/json")
            .send_string(
                &serde_json::json!({
                    "name": REPO_NAME,
                    "private": true,
                    "auto_init": false,
                })
                .to_string(),
            );
        match resp {
            Ok(r) => {
                let v: serde_json::Value = r.into_json().map_err(|e| e.to_string())?;
                let full = v["full_name"].as_str().unwrap_or("").to_string();
                if full.is_empty() {
                    return Err("Gitee 建仓失败".into());
                }
                let url = format!("https://gitee.com/{full}.git");
                s.repo_url = url.clone();
                save_store(app, &s)?;
                Ok(url)
            }
            Err(ureq::Error::Status(400 | 422, r)) => {
                // 已存在 → 直接用
                let body = r.into_string().unwrap_or_default();
                if body.contains("已存在") || body.contains("exists") {
                    let login = gitee_login(token)?;
                    let url = format!("https://gitee.com/{login}/{REPO_NAME}.git");
                    s.repo_url = url.clone();
                    save_store(app, &s)?;
                    Ok(url)
                } else {
                    Err(format!("Gitee 建仓失败: {}", &body[..body.len().min(200)]))
                }
            }
            Err(e) => Err(format!("Gitee 建仓失败: {e}")),
        }
    } else {
        // GitHub: GET user → POST /user/repos
        let login = github_api_get(token, "https://api.github.com/user")?["login"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if login.is_empty() {
            return Err("无法获取 GitHub 用户".into());
        }
        // 已存在检查
        let exists = ureq::get(&format!("https://api.github.com/repos/{login}/{REPO_NAME}"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("User-Agent", "AgentHub")
            .call();
        let url = format!("https://github.com/{login}/{REPO_NAME}.git");
        if exists.is_err() {
            let resp = ureq::post("https://api.github.com/user/repos")
                .set("Authorization", &format!("Bearer {token}"))
                .set("Accept", "application/vnd.github+json")
                .set("User-Agent", "AgentHub")
                .send_string(
                    &serde_json::json!({
                        "name": REPO_NAME,
                        "private": true,
                        "auto_init": false,
                        "description": "AgentHub data backup (prompts / MCP / skills)",
                    })
                    .to_string(),
                )
                .map_err(|e| format!("GitHub 建仓失败: {e}"))?;
            let _ = resp.into_json::<serde_json::Value>();
        }
        s.repo_url = url.clone();
        save_store(app, &s)?;
        Ok(url)
    }
}

fn gitee_login(token: &str) -> Result<String, String> {
    let resp = ureq::get("https://gitee.com/api/v5/user")
        .query("access_token", token)
        .call()
        .map_err(|e| format!("Gitee API 失败: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    Ok(v["login"].as_str().unwrap_or("").to_string())
}

/// PAT 方式保存（github/gitee 通用）
pub fn save_pat(app: &AppH, provider: &str, pat: &str) -> Result<AuthResult, String> {
    let pat = pat.trim();
    if pat.is_empty() {
        return Err("请输入 Token".into());
    }
    let login = if provider == "gitee" {
        gitee_login(pat)?
    } else {
        github_api_get(pat, "https://api.github.com/user")?["login"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };
    if login.is_empty() {
        return Err("Token 无效（无法获取用户信息）".into());
    }
    let mut s = load_store(app);
    if provider == "gitee" {
        s.gitee_token = pat.into();
    } else {
        s.github_token = pat.into();
    }
    s.login = login;
    save_store(app, &s)?;
    Ok(AuthResult { ok: true, login: s.login, provider: provider.into(), error: String::new() })
}

/// 用已存 token 生成带凭据的推送 URL（仅内存使用，不落盘到 git config）
pub fn authenticated_url(app: &AppH, provider: &str) -> Result<(String, String), String> {
    let s = load_store(app);
    let (token, base) = match provider {
        "gitee" => (s.gitee_token.clone(), "https://gitee.com"),
        _ => (s.github_token.clone(), "https://github.com"),
    };
    if token.is_empty() {
        return Err("未授权".into());
    }
    let repo = s.repo_url.trim_start_matches("https://").trim_start_matches("http://").to_string();
    let repo = repo.trim_start_matches(&format!("{base}/")).to_string();
    let repo = repo.trim_end_matches(".git").to_string();
    if repo.is_empty() {
        return Err("尚未创建备份仓库".into());
    }
    // x-access-token 形式（GitHub 官方推荐；Gitee 同样支持 oauth2 用户名+token 密码形式）
    let url = if provider == "gitee" {
        format!("https://{token}@{base}/{repo}.git") // gitee: token as username
    } else {
        format!("https://x-access-token:{token}@{base}/{repo}.git")
    };
    Ok((url, s.login))
}
