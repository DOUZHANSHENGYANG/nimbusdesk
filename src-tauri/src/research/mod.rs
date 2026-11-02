//! 信息调研的检索/抓取/归档。
//!
//! 不搬 ShiCang 的任务队列：规划、抽取断言、合成简报都是 LLM 调用，留在前端
//! （`chatWithProvider`），这里只提供「不依赖模型」的那半边 —— 检索、抓正文、存报告。
//! 也因此没有暂停/续跑：一次调研就是一次前端驱动的流水线，取消 = 前端不再往下走。

use crate::commands::data;
use crate::feeds::{collect, store as feed_store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NimbusDesk/0.1";
const REPORT_DIR: &str = "modules/research";
const JOBS_FILE: &str = "modules/research/jobs.json";
/// 队列快照最多留这么多条（按时间从旧到新裁），免得文件无限长。
const JOB_LIMIT: usize = 50;
/// 单篇正文上限：再长对摘要没有增量，只会把上下文撑爆。
const ARTICLE_LIMIT: usize = 20_000;
const OK_CHARS: usize = 300;
const BODY_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub channel: String,
    pub summary: String,
    pub author: String,
    pub published_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchedSource {
    pub url: String,
    pub ok: bool,
    pub chars: usize,
    pub text: String,
    pub error: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedResearch {
    pub file: String,
    pub query: String,
    pub depth: String,
    pub channels: Vec<String>,
    pub created_at: String,
    pub title: String,
    /// 报告里用到的来源数（同名 .json 的 detail.sources）
    pub sources: usize,
}

#[tauri::command]
pub async fn research_search(channel: String, queries: Vec<String>, limit: Option<usize>) -> Result<Vec<Hit>, String> {
    let limit = limit.unwrap_or(8).clamp(1, 30) as i64;
    let queries: Vec<String> = queries
        .into_iter()
        .map(|query| query.trim().to_string())
        .filter(|query| !query.is_empty())
        .take(12)
        .collect();
    if queries.is_empty() {
        return Err("没有搜索词".into());
    }
    let hits = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Hit>, String> {
        let raws = match channel.as_str() {
            "web" => collect::searxng_search(&queries, limit, "http://127.0.0.1:8888", "zh-CN")?,
            "cn-social" => collect::social_search(
                &["bilibili".to_string(), "zhihu".to_string(), "xiaohongshu".to_string(), "douyin".to_string()],
                &queries,
                limit,
            )?,
            "global" => collect::social_search(
                &["reddit".to_string(), "hackernews".to_string(), "twitter".to_string(), "youtube".to_string()],
                &queries,
                limit,
            )?,
            "repo" => github_repos(&queries, limit)?,
            other => return Err(format!("未知渠道：{other}")),
        };
        Ok(raws
            .into_iter()
            .map(|raw| Hit {
                title: raw.title,
                url: raw.url,
                channel: raw.channel,
                summary: raw.summary,
                author: raw.author,
                published_at: raw.published_at,
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(hits)
}

fn github_repos(queries: &[String], limit: i64) -> Result<Vec<crate::feeds::RawItem>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(UA)
        .build()
        .map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    let mut first_error: Option<String> = None;
    for query in queries {
        let url = format!(
            "https://api.github.com/search/repositories?q={}&per_page={limit}&sort=stars",
            collect::percent_encode(query)
        );
        let mut request = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json");
        if let Ok(token) = std::env::var("GITHUB_TOKEN") {
            if !token.trim().is_empty() {
                request = request.bearer_auth(token.trim());
            }
        }
        let value: Value = match request.send().and_then(|response| response.error_for_status()).and_then(|response| response.json()) {
            Ok(value) => value,
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(format!("{query}：{error}"));
                }
                continue;
            }
        };
        for row in value.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
            let title = row.get("full_name").and_then(Value::as_str).unwrap_or("").to_string();
            let url = row.get("html_url").and_then(Value::as_str).unwrap_or("").to_string();
            if title.is_empty() || url.is_empty() {
                continue;
            }
            let stars = row.get("stargazers_count").and_then(Value::as_i64).unwrap_or(0);
            out.push(crate::feeds::RawItem {
                title: format!("{title} ✰ {stars}"),
                url,
                author: row.get("language").and_then(Value::as_str).unwrap_or("").to_string(),
                published_at: row.get("pushed_at").and_then(Value::as_str).map(str::to_string),
                summary: row.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                content: String::new(),
                channel: "repo".into(),
                tags: Vec::new(),
                fingerprint: String::new(),
                diff: String::new(),
                hash_salt: String::new(),
            });
        }
    }
    if out.is_empty() {
        return Err(first_error.unwrap_or_else(|| "GitHub 没有结果".into()));
    }
    Ok(out)
}

/// 抓正文。逐条串行：本意是别把本机网络和对方站点一起打满，几十条也够快。
#[tauri::command]
pub async fn research_fetch(urls: Vec<String>, limit: Option<usize>) -> Result<Vec<FetchedSource>, String> {
    let limit = limit.unwrap_or(12).clamp(1, 40);
    let urls: Vec<String> = urls
        .into_iter()
        .map(|url| url.trim().to_string())
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .take(limit)
        .collect();
    if urls.is_empty() {
        return Err("没有可抓的地址".into());
    }
    let sources = tauri::async_runtime::spawn_blocking(move || {
        urls.into_iter()
            .map(|url| match collect::fetch_text(&url, 30) {
                Ok(body) => {
                    let text = feed_store::truncate(&crate::feeds::html::html_to_text(&body), ARTICLE_LIMIT);
                    let chars = text.chars().count();
                    FetchedSource {
                        url,
                        ok: chars >= OK_CHARS,
                        chars,
                        text,
                        error: if chars >= OK_CHARS { String::new() } else { format!("正文太短（{chars} 字）") },
                    }
                }
                Err(error) => FetchedSource { url, ok: false, chars: 0, text: String::new(), error },
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(sources)
}

/// 报告目录：设置里给了就用自己的（必须绝对路径），否则落在数据目录的 modules/research。
fn resolve_dir(dir: Option<String>) -> Result<std::path::PathBuf, String> {
    if let Some(custom) = dir.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        let path = std::path::PathBuf::from(custom);
        if !path.is_absolute() {
            return Err("报告目录需要是绝对路径".into());
        }
        return Ok(path);
    }
    data::with_data_dir(|root| Ok(root.join(REPORT_DIR)))
}

#[tauri::command]
pub fn research_default_dir() -> Result<String, String> {
    data::with_data_dir(|root| Ok(root.join(REPORT_DIR).to_string_lossy().into_owned()))
}

/// 队列快照：任务状态、事件与阶段结果都在这份文件里，重启后据此恢复。
#[tauri::command]
pub fn research_jobs() -> Result<Vec<Value>, String> {
    data::with_data_dir(|root| {
        let path = root.join(JOBS_FILE);
        let text = match crate::atomic::read_file_with_fallback(&path.to_string_lossy()) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        serde_json::from_str(&text).map_err(|error| format!("解析 {JOBS_FILE} 失败: {error}"))
    })
}

/// 整份覆盖写：数组顺序就是队列优先级，逐条 upsert 反而保不住顺序。
#[tauri::command]
pub fn research_jobs_save(jobs: Vec<Value>) -> Result<(), String> {
    if jobs.len() > 500 {
        return Err("任务数量异常".into());
    }
    let mut jobs = jobs;
    if jobs.len() > JOB_LIMIT {
        // 从旧到新裁：保留末尾的 JOB_LIMIT 条
        let drop = jobs.len() - JOB_LIMIT;
        jobs.drain(0..drop);
    }
    data::with_data_dir(|root| {
        let text = serde_json::to_string_pretty(&jobs).map_err(|error| error.to_string())?;
        crate::atomic::write_file_atomic(&root.join(JOBS_FILE).to_string_lossy(), text.as_bytes())
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub async fn research_save(query: String, markdown: String, meta: Option<Value>, dir: Option<String>) -> Result<SavedResearch, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("缺少调研主题".into());
    }
    if markdown.trim().is_empty() {
        return Err("报告是空的".into());
    }
    let target = resolve_dir(dir)?;
    tauri::async_runtime::spawn_blocking(move || save_report(query, markdown, meta.unwrap_or(Value::Null), target))
        .await
        .map_err(|error| error.to_string())?
}

fn save_report(query: String, markdown: String, meta: Value, dir: std::path::PathBuf) -> Result<SavedResearch, String> {
    let created_at = chrono::Local::now();
    let stamp = created_at.format("%Y-%m-%d").to_string();
    let slug = slug_of(&query);
    let file = format!("{stamp}-{slug}-{}.md", hash12(&format!("{query}{}", created_at.timestamp())));
    let title = markdown
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .unwrap_or(&query)
        .to_string();
    std::fs::create_dir_all(&dir).map_err(|error| format!("建不了报告目录：{error}"))?;
    crate::atomic::write_file_atomic(&dir.join(&file).to_string_lossy(), markdown.as_bytes())
        .map_err(|error| error.to_string())?;
    let saved = SavedResearch {
        file: file.clone(),
        query: query.clone(),
        depth: meta.get("depth").and_then(Value::as_str).unwrap_or("standard").to_string(),
        channels: meta
            .get("channels")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        created_at: created_at.to_rfc3339(),
        title,
        sources: meta
            .get("sources")
            .and_then(Value::as_array)
            .map(|list| list.len())
            .unwrap_or(0),
    };
    let meta_text = serde_json::to_string_pretty(&json!({ "report": saved, "detail": meta }))
        .map_err(|error| error.to_string())?;
    crate::atomic::write_file_atomic(
        &dir.join(file.replace(".md", ".json")).to_string_lossy(),
        meta_text.as_bytes(),
    )
    .map_err(|error| error.to_string())?;
    Ok(saved)
}

/// 文件名后缀：同一主题同一天存两次也不互相覆盖。
fn hash12(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect()
}

fn slug_of(query: &str) -> String {
    let mut slug: String = query
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "research" } else { slug };
    feed_store::truncate(slug, 40).trim_end_matches('-').to_string()
}

#[tauri::command]
pub fn research_list(dir: Option<String>) -> Result<Vec<SavedResearch>, String> {
    let dir = resolve_dir(dir)?;
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut out: Vec<SavedResearch> = entries
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .filter_map(|entry| {
            let text = std::fs::read_to_string(entry.path()).ok()?;
            let value: Value = serde_json::from_str(&text).ok()?;
            let mut report = serde_json::from_value::<SavedResearch>(value.get("report")?.clone()).ok()?;
            report.sources = value
                .get("detail")
                .and_then(|detail| detail.get("sources"))
                .and_then(Value::as_array)
                .map(|list| list.len())
                .unwrap_or(report.sources);
            Some(report)
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn research_read(file: String, dir: Option<String>) -> Result<String, String> {
    let path = safe_name(&file, "md")?;
    let dir = resolve_dir(dir)?;
    crate::atomic::read_file_with_fallback(&dir.join(path).to_string_lossy())
        .map_err(|error| format!("读不到报告：{error}"))
}

/// 历史报告的「过程」：规划、来源与断言都在同名 .json 里。
#[tauri::command]
pub fn research_meta(file: String, dir: Option<String>) -> Result<Value, String> {
    let name = safe_name(&file, "md")?.replace(".md", ".json");
    let dir = resolve_dir(dir)?;
    let text = std::fs::read_to_string(dir.join(name)).map_err(|error| format!("读不到过程记录：{error}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    Ok(value.get("detail").cloned().unwrap_or(value))
}

#[tauri::command]
pub fn research_delete(file: String, dir: Option<String>) -> Result<(), String> {
    let markdown = safe_name(&file, "md")?;
    let meta = markdown.replace(".md", ".json");
    let dir = resolve_dir(dir)?;
    let _ = std::fs::remove_file(dir.join(&markdown));
    let _ = std::fs::remove_file(dir.join(&meta));
    Ok(())
}

/// 只接受「一个文件名」：带路径分隔符或换扩展名的一律拒绝，避免读写跑到目录外。
fn safe_name(file: &str, extension: &str) -> Result<String, String> {
    let name = file.trim();
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || name.contains("..")
        || !name.ends_with(&format!(".{extension}"))
    {
        return Err("非法的报告名".into());
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_tricks() {
        assert!(safe_name("../secret.md", "md").is_err());
        assert!(safe_name("a/b.md", "md").is_err());
        assert!(safe_name("ok.md", "md").is_ok());
        assert!(safe_name("ok.json", "md").is_err());
    }

    #[test]
    fn slug_is_ascii_only() {
        let slug = slug_of("Tauri 桌面应用 2026");
        assert_eq!(slug, "tauri-2026");
    }
}
