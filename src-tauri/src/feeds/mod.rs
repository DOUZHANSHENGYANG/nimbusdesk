//! 资讯订阅：源与条目的存储、五种采集器、后台定时采集、命令面。
//!
//! 与 ShiCang 的差别只有两处，都是因为桌面端没有那套 Python 运行时：
//! - `cn-social` 不再跑它自带的 node 聚合脚本，直接逐个站点调 `opencli <site> search`；
//! - `page` 源没有浏览器选器可用，只按整页正文的变化判定（配置里的 `selector` 忽略）。
//! 邮件日报需要 SMTP 凭据，没有移植。

pub mod collect;
pub mod engine;
pub mod html;
pub mod store;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeedSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub config: Value,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_minutes: i64,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_count: i64,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub source_name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub url_hash: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub diff: String,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeedState {
    #[serde(default)]
    pub sources: Vec<FeedSource>,
    #[serde(default)]
    pub items: Vec<FeedItem>,
}

/// 采集器的统一输出；`url_hash` / id / 时间戳由 store 补齐。
#[derive(Clone, Debug, Default)]
pub struct RawItem {
    pub title: String,
    pub url: String,
    pub author: String,
    pub published_at: Option<String>,
    pub summary: String,
    pub content: String,
    pub channel: String,
    pub tags: Vec<String>,
    pub fingerprint: String,
    pub diff: String,
    pub hash_salt: String,
}

fn yes() -> bool {
    true
}

fn default_interval() -> i64 {
    60
}

fn now_text() -> String {
    chrono::Local::now().to_rfc3339()
}

// ── 采集 + 落盘（命令与后台引擎共用）────────────────────────────────

/// 跑一个源：采集 → 按 url_hash 去重写入 → 记录本次状态。返回该源最新条目。
pub fn run_source(id: &str) -> Result<Vec<FeedItem>, String> {
    let state = store::load()?;
    let source = state
        .sources
        .iter()
        .find(|source| source.id == id)
        .cloned()
        .ok_or("订阅源不存在")?;
    let previous = state
        .items
        .iter()
        .find(|item| item.source_id == id)
        .cloned();
    let sequence = state.items.iter().filter(|item| item.source_id == id).count();
    match collect::collect(&source, previous.as_ref(), sequence) {
        Ok(raws) => {
            store::mutate(|state| {
                let added = store::upsert_items(state, &source, raws);
                mark_run(state, &source.id, "ok", None, Some(added as i64));
                Ok(())
            })?;
            let state = store::load()?;
            Ok(state
                .items
                .into_iter()
                .filter(|item| item.source_id == source.id)
                .take(100)
                .collect())
        }
        Err(error) => {
            store::mutate(|state| {
                mark_run(state, &source.id, "error", Some(error.clone()), Some(0));
                Ok(())
            })?;
            Err(error)
        }
    }
}

fn mark_run(state: &mut FeedState, id: &str, status: &str, error: Option<String>, count: Option<i64>) {
    if let Some(slot) = state.sources.iter_mut().find(|item| item.id == id) {
        slot.last_run_at = Some(now_text());
        slot.last_status = Some(status.to_string());
        slot.last_error = error;
        if let Some(count) = count {
            slot.last_count = count;
        }
    }
}

// ── 命令面 ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn feeds_sources() -> Result<Vec<FeedSource>, String> {
    let state = store::load()?;
    let mut sources = state.sources;
    sources.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.created_at.cmp(&b.created_at)));
    Ok(sources)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemsQuery {
    pub source_id: Option<String>,
    pub unread_only: bool,
    pub starred_only: bool,
    pub query: String,
    pub limit: usize,
    pub offset: usize,
}

#[tauri::command]
pub fn feeds_items(query: ItemsQuery) -> Result<Vec<FeedItem>, String> {
    let state = store::load()?;
    let needle = query.query.trim().to_lowercase();
    let hits = state.items.into_iter().filter(|item| {
        query
            .source_id
            .as_deref()
            .is_none_or(|id| item.source_id == id || id.is_empty())
            && (!query.unread_only || !item.read)
            && (!query.starred_only || item.starred)
            && (needle.is_empty()
                || item.title.to_lowercase().contains(&needle)
                || item.summary.to_lowercase().contains(&needle)
                || item.author.to_lowercase().contains(&needle))
    });
    let limit = query.limit.clamp(1, 500);
    Ok(hits.skip(query.offset).take(limit).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    #[serde(default)]
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub config: Value,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_minutes: i64,
}

const KINDS: [&str; 5] = ["rss", "opencli", "cn-social", "searxng", "page"];

#[tauri::command]
pub fn feeds_save_source(input: SourceInput) -> Result<FeedSource, String> {
    let kind = input.kind.trim().to_string();
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("未知源类型：{kind}"));
    }
    let (config, name) = normalize_source(&kind, input.name, input.config)?;
    let interval = input.interval_minutes.clamp(5, 1440);
    store::mutate(|state| {
        let mut source = match state.sources.iter().find(|item| !input.id.is_empty() && item.id == input.id) {
            Some(existing) => existing.clone(),
            None => FeedSource {
                id: store::new_id("fs"),
                kind: kind.clone(),
                name: String::new(),
                config: Value::Null,
                enabled: true,
                interval_minutes: interval,
                sort_order: state
                    .sources
                    .iter()
                    .map(|item| item.sort_order)
                    .max()
                    .unwrap_or(0)
                    + 1,
                last_run_at: None,
                last_status: None,
                last_error: None,
                last_count: 0,
                created_at: now_text(),
            },
        };
        source.kind = kind;
        source.name = name;
        source.config = config;
        source.enabled = input.enabled;
        source.interval_minutes = interval;
        if !state.sources.iter().any(|item| item.id == source.id) {
            state.sources.push(source.clone());
        } else if let Some(slot) = state.sources.iter_mut().find(|item| item.id == source.id) {
            *slot = source.clone();
        }
        store::sort_sources(state);
        Ok(source)
    })
}

/// 名称留空就从地址推一个；rss/page 必须给可用的 http(s) 地址。
fn normalize_source(kind: &str, name: String, config: Value) -> Result<(Value, String), String> {
    let mut config = config;
    let mut name = name.trim().to_string();
    let needs_url = matches!(kind, "rss" | "page");
    let url = config
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if needs_url {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("需要 http(s) 地址".into());
        }
        if let Some(object) = config.as_object_mut() {
            object.insert("url".into(), Value::String(url.clone()));
        }
        if name.is_empty() {
            name = url
                .split("://")
                .nth(1)
                .unwrap_or(&url)
                .split('/')
                .next()
                .unwrap_or("订阅源")
                .to_string();
        }
    }
    if matches!(kind, "searxng" | "cn-social") && config.get("queries").is_none() {
        return Err("需要至少一个搜索词".into());
    }
    if matches!(kind, "opencli") && config.get("site").and_then(Value::as_str).unwrap_or("").is_empty() {
        return Err("opencli 源需要填站点".into());
    }
    if name.is_empty() {
        name = match kind {
            "searxng" => "搜索订阅".into(),
            "cn-social" => "中文社区".into(),
            "opencli" => config
                .get("site")
                .and_then(Value::as_str)
                .unwrap_or("opencli")
                .to_string(),
            _ => "订阅源".into(),
        };
    }
    Ok((config, name))
}

#[tauri::command]
pub fn feeds_delete_source(id: String) -> Result<(), String> {
    store::mutate(|state| {
        state.sources.retain(|source| source.id != id);
        state.items.retain(|item| item.source_id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn feeds_reorder(ids: Vec<String>) -> Result<Vec<FeedSource>, String> {
    store::mutate(|state| {
        for (index, id) in ids.iter().enumerate() {
            if let Some(slot) = state.sources.iter_mut().find(|source| &source.id == id) {
                slot.sort_order = index as i64;
            }
        }
        store::sort_sources(state);
        Ok(state.sources.clone())
    })
}

/// 与相邻同组源换位（界面的 Alt+方向键用）。
#[tauri::command]
pub fn feeds_move(id: String, delta: i64) -> Result<Vec<FeedSource>, String> {
    store::mutate(|state| {
        store::sort_sources(state);
        let from = state.sources.iter().position(|source| source.id == id);
        let Some(from) = from else { return Ok(state.sources.clone()) };
        let to = (from as i64 + delta).clamp(0, state.sources.len() as i64 - 1) as usize;
        if to != from {
            let source = state.sources.remove(from);
            state.sources.insert(to, source);
            for (index, slot) in state.sources.iter_mut().enumerate() {
                slot.sort_order = index as i64;
            }
        }
        Ok(state.sources.clone())
    })
}

#[tauri::command]
pub async fn feeds_run_source(app: tauri::AppHandle, id: String) -> Result<Vec<FeedItem>, String> {
    let source = id.clone();
    let items = tauri::async_runtime::spawn_blocking(move || run_source(&source))
        .await
        .map_err(|error| error.to_string())??;
    let _ = app.emit("feeds://updated", json!({ "sourceId": id }));
    Ok(items)
}

#[tauri::command]
pub async fn feeds_collect_all(app: tauri::AppHandle) -> Result<usize, String> {
    let ran = tauri::async_runtime::spawn_blocking(|| {
        let state = store::load()?;
        let mut ran = 0usize;
        for source in state.sources.iter().filter(|source| source.enabled) {
            if run_source(&source.id).is_ok() {
                ran += 1;
            }
        }
        Ok::<usize, String>(ran)
    })
    .await
    .map_err(|error| error.to_string())??;
    let _ = app.emit("feeds://updated", json!({ "all": true }));
    Ok(ran)
}

#[tauri::command]
pub fn feeds_patch_item(id: String, read: Option<bool>, starred: Option<bool>) -> Result<FeedItem, String> {
    store::mutate(|state| {
        let item = state
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("条目不存在")?;
        if let Some(read) = read {
            item.read = read;
        }
        if let Some(starred) = starred {
            item.starred = starred;
        }
        Ok(item.clone())
    })
}

#[tauri::command]
pub fn feeds_mark_all_read(source_id: Option<String>) -> Result<usize, String> {
    store::mutate(|state| {
        let mut changed = 0;
        for item in state.items.iter_mut() {
            let matches = source_id.as_deref().is_none_or(|id| id.is_empty() || item.source_id == id);
            if matches && !item.read {
                item.read = true;
                changed += 1;
            }
        }
        Ok(changed)
    })
}

#[tauri::command]
pub fn feeds_import_opml(path: String) -> Result<Vec<FeedSource>, String> {
    let text = std::fs::read_to_string(path.trim()).map_err(|error| format!("读不到 OPML：{error}"))?;
    if text.len() > 5 * 1024 * 1024 {
        return Err("OPML 文件过大".into());
    }
    let feeds = parse_opml(&text);
    if feeds.is_empty() {
        return Err("OPML 里没有找到订阅".into());
    }
    let interval = 60i64;
    store::mutate(|state| {
        let mut order = state.sources.iter().map(|source| source.sort_order).max().unwrap_or(0);
        for (name, url) in feeds {
            if state.sources.iter().any(|source| source.config.get("url").and_then(Value::as_str) == Some(url.as_str())) {
                continue;
            }
            order += 1;
            state.sources.push(FeedSource {
                id: store::new_id("fs"),
                kind: "rss".into(),
                name,
                config: json!({ "url": url }),
                enabled: true,
                interval_minutes: interval,
                sort_order: order,
                last_run_at: None,
                last_status: None,
                last_error: None,
                last_count: 0,
                created_at: now_text(),
            });
        }
        store::sort_sources(state);
        Ok(state.sources.clone())
    })
}

fn parse_opml(opml: &str) -> Vec<(String, String)> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(opml);
    let mut feeds = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let mut url = String::new();
                let mut title = String::new();
                for attribute in element.attributes().flatten() {
                    let key = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
                    let value = html::decode_entities(&String::from_utf8_lossy(&attribute.value));
                    match key.as_str() {
                        "xmlurl" => url = value,
                        "title" | "text" => title = value,
                        _ => {}
                    }
                }
                if url.starts_with("http://") || url.starts_with("https://") {
                    if title.trim().is_empty() {
                        title = url.split("://").nth(1).unwrap_or(&url).split('/').next().unwrap_or("订阅源").to_string();
                    }
                    feeds.push((title.trim().to_string(), url));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    feeds
}

#[tauri::command]
pub fn feeds_stats() -> Result<Value, String> {
    let state = store::load()?;
    let total = state.items.len();
    let unread = state.items.iter().filter(|item| !item.read).count();
    let starred = state.items.iter().filter(|item| item.starred).count();
    let mut channels: Vec<(String, usize)> = Vec::new();
    for item in &state.items {
        match channels.iter_mut().find(|(name, _)| name == &item.channel) {
            Some(slot) => slot.1 += 1,
            None => channels.push((item.channel.clone(), 1)),
        }
    }
    channels.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(json!({
        "total": total,
        "unread": unread,
        "starred": starred,
        "sources": state.sources.len(),
        "channels": channels.into_iter().take(20).map(|(name, count)| json!({ "channel": name, "count": count })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opml_reads_outlines() {
        let opml = r#"<opml><body><outline text="组"><outline text="少数派" xmlUrl="https://sspai.com/feed" /><outline text="阮一峰" xmlUrl="https://ruanyf.com/feed" /></outline></body></opml>"#;
        let feeds = parse_opml(opml);
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0], ("少数派".into(), "https://sspai.com/feed".into()));
    }

    #[test]
    fn rejects_non_http_source() {
        assert!(normalize_source("rss", "x".into(), json!({ "url": "file:///etc/passwd" })).is_err());
        assert!(normalize_source("searxng", String::new(), json!({ "url": "x" })).is_err());
    }
}
