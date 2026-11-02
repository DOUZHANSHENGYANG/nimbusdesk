//! 订阅源与条目的持久化：一份 `modules/feeds/state.json`。
//!
//! 只有一个写者路径（`mutate`）：所有命令都在同一把数据目录锁里「重读 → 改 → 写回」，
//! 后台采集线程和界面操作不会用几分钟前读到的整表互相覆盖。

use super::{FeedItem, FeedSource, FeedState, RawItem};
use crate::commands::data;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::Path;

pub const STATE_FILE: &str = "modules/feeds/state.json";
/// 条目上限：starred 永不裁掉，其余按时间从旧到新裁。
const ITEM_LIMIT: usize = 2000;

fn read_at<T: DeserializeOwned + Default>(root: &Path, relative: &str) -> Result<T, String> {
    let path = root.join(relative);
    let text = match crate::atomic::read_file_with_fallback(&path.to_string_lossy()) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(error.to_string()),
    };
    if text.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&text).map_err(|error| format!("解析 {relative} 失败: {error}"))
}

fn write_at<T: Serialize>(root: &Path, relative: &str, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    crate::atomic::write_file_atomic(&root.join(relative).to_string_lossy(), text.as_bytes())
        .map_err(|error| error.to_string())
}

pub fn load() -> Result<FeedState, String> {
    data::with_data_dir(|root| read_at(root, STATE_FILE))
}

pub fn mutate<T>(operation: impl FnOnce(&mut FeedState) -> Result<T, String>) -> Result<T, String> {
    data::with_data_dir(|root| {
        let mut state: FeedState = read_at(root, STATE_FILE)?;
        sort_sources(&mut state);
        let out = operation(&mut state)?;
        write_at(root, STATE_FILE, &state)?;
        Ok(out)
    })
}

pub fn sort_sources(state: &mut FeedState) {
    state.sources.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
}

/// 按 url_hash 去重写入，返回新增条数。
pub fn upsert_items(state: &mut FeedState, source: &FeedSource, raws: Vec<RawItem>) -> usize {
    let now = chrono::Local::now().to_rfc3339();
    let mut added = 0;
    for raw in raws {
        let url = raw.url.trim().to_string();
        if url.is_empty() {
            continue;
        }
        let digest = url_hash(&url, &raw.hash_salt);
        if state.items.iter().any(|item| item.url_hash == digest) {
            continue;
        }
        state.items.push(FeedItem {
            id: new_id("fi"),
            source_id: source.id.clone(),
            source_name: source.name.clone(),
            kind: source.kind.clone(),
            channel: if raw.channel.is_empty() { source.kind.clone() } else { raw.channel },
            title: truncate(&raw.title, 400),
            url,
            url_hash: digest,
            author: truncate(&raw.author, 120),
            published_at: raw.published_at,
            summary: truncate(&raw.summary, 2000),
            content: truncate(&raw.content, 60_000),
            tags: raw.tags,
            fingerprint: raw.fingerprint,
            diff: raw.diff,
            read: false,
            starred: false,
            created_at: now.clone(),
        });
        added += 1;
    }
    if added > 0 {
        sort_items(&mut state.items);
        prune(state);
    }
    added
}

pub fn sort_items(items: &mut [FeedItem]) {
    items.sort_by(|a, b| {
        let a_key = a.published_at.clone().unwrap_or_else(|| a.created_at.clone());
        let b_key = b.published_at.clone().unwrap_or_else(|| b.created_at.clone());
        b_key.cmp(&a_key)
    });
}

fn prune(state: &mut FeedState) {
    prune_to(state, ITEM_LIMIT);
}

fn prune_to(state: &mut FeedState, limit: usize) {
    if state.items.len() <= limit {
        return;
    }
    let mut budget = state.items.len() - limit;
    let mut keep = Vec::with_capacity(state.items.len());
    // items 已按新到旧排序：从尾部（最旧）开始裁，starred 跳过。
    for item in state.items.drain(..) {
        if budget > 0 && !item.starred {
            budget -= 1;
            continue;
        }
        keep.push(item);
    }
    state.items = keep;
}

/// 去 utm_* 参数、锚点、尾斜杠后算指纹：同一篇文章换跟踪参数仍算同一条。
pub fn url_hash(url: &str, salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut cleaned = String::with_capacity(url.len());
    let url_no_fragment = url.split('#').next().unwrap_or(url);
    let (base, query) = match url_no_fragment.split_once('?') {
        Some((base, query)) => (base, query),
        None => (url_no_fragment, ""),
    };
    cleaned.push_str(base.trim_end_matches('/'));
    let kept: Vec<&str> = query
        .split('&')
        .filter(|part| !part.is_empty() && !part.starts_with("utm_"))
        .collect();
    if !kept.is_empty() {
        cleaned.push('?');
        cleaned.push_str(&kept.join("&"));
    }
    if !salt.is_empty() {
        cleaned.push('#');
        cleaned.push_str(salt);
    }
    let digest = Sha256::digest(cleaned.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

pub fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        Some((index, _)) => text[..index].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_ignores_tracking_and_anchor() {
        assert_eq!(
            url_hash("https://a.com/x/?utm_source=rss&id=1#top", ""),
            url_hash("https://a.com/x?id=1", "")
        );
    }

    #[test]
    fn hash_separates_salted_versions() {
        assert_ne!(url_hash("https://a.com/x", "1"), url_hash("https://a.com/x", "2"));
    }

    #[test]
    fn prune_keeps_starred() {
        let mut state = FeedState::default();
        for n in 0..4 {
            state.items.push(FeedItem {
                id: n.to_string(),
                starred: n == 0,
                ..Default::default()
            });
        }
        prune_to(&mut state, 2);
        let ids: Vec<&str> = state.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["0", "3"], "最旧的 starred 留下，次旧的被裁掉");
    }
}
