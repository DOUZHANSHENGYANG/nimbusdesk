//! 五种采集器：rss / opencli / cn-social / searxng / page。
//!
//! 外部依赖只有三样，都按「有就用、没有就报一条带原因的错」处理：
//! 源地址本身、`opencli`（PATH 里）、本机 SearXNG（默认 127.0.0.1:8888）。

use super::{FeedItem, FeedSource, RawItem, html, store};
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NimbusDesk/0.1";
const BODY_LIMIT: u64 = 8 * 1024 * 1024;

pub fn collect(
    source: &FeedSource,
    previous: Option<&FeedItem>,
    sequence: usize,
) -> Result<Vec<RawItem>, String> {
    match source.kind.as_str() {
        "rss" => collect_rss(source),
        "opencli" => collect_opencli(source),
        "cn-social" => collect_cn_social(source),
        "searxng" => collect_searxng(source),
        "page" => collect_page(source, previous, sequence),
        other => Err(format!("未知源类型：{other}")),
    }
}

// ── rss ─────────────────────────────────────────────────────────────

fn collect_rss(source: &FeedSource) -> Result<Vec<RawItem>, String> {
    let url = text_field(&source.config, "url");
    if url.is_empty() {
        return Err("RSS 源缺少 url".into());
    }
    let body = fetch_text(&url, 30)?;
    let items = parse_feed(&body);
    if items.is_empty() {
        return Err("没有解析到条目（不是 RSS/Atom？）".into());
    }
    Ok(items)
}

struct Draft {
    title: String,
    url: String,
    author: String,
    published: String,
    summary: String,
    content: String,
    tags: Vec<String>,
}

enum Field {
    Title,
    Url,
    Author,
    Published,
    Summary,
    Content,
    Tag,
}

pub fn parse_feed(xml: &str) -> Vec<RawItem> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut out = Vec::new();
    let mut draft: Option<Draft> = None;
    let mut field: Option<Field> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let tag = tag_of(element.name().as_ref());
                if tag == "item" || tag == "entry" {
                    draft = Some(Draft::default_empty());
                    field = None;
                    continue;
                }
                if draft.is_none() {
                    continue;
                }
                if tag == "link" {
                    if let Some(href) = attribute(&element, "href") {
                        if let Some(current) = draft.as_mut() {
                            if current.url.is_empty() && !href.is_empty() {
                                current.url = href;
                            }
                        }
                    }
                }
                field = field_of(&tag);
            }
            Ok(Event::Empty(element)) => {
                if draft.is_none() {
                    continue;
                }
                let tag = tag_of(element.name().as_ref());
                if tag == "link" {
                    if let Some(href) = attribute(&element, "href") {
                        if let Some(current) = draft.as_mut() {
                            if current.url.is_empty() && !href.is_empty() {
                                current.url = href;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(text)) => {
                let (Some(current), Some(slot)) = (draft.as_mut(), field.as_ref()) else {
                    continue;
                };
                let Ok(value) = text.decode() else { continue };
                push_field(current, slot, &value);
            }
            Ok(Event::CData(text)) => {
                let (Some(current), Some(slot)) = (draft.as_mut(), field.as_ref()) else {
                    continue;
                };
                let Ok(value) = text.decode() else { continue };
                push_field(current, slot, &value);
            }
            Ok(Event::GeneralRef(reference)) => {
                let (Some(current), Some(slot)) = (draft.as_mut(), field.as_ref()) else {
                    continue;
                };
                let name = String::from_utf8_lossy(reference.as_ref()).into_owned();
                let decoded = html::decode_entities(&format!("&{name};"));
                push_field(current, slot, &decoded);
            }
            Ok(Event::End(element)) => {
                let tag = tag_of(element.name().as_ref());
                if tag == "item" || tag == "entry" {
                    if let Some(current) = draft.take() {
                        if let Some(item) = finish(current) {
                            out.push(item);
                        }
                    }
                    field = None;
                } else if field_of(&tag).is_some() {
                    field = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn finish(draft: Draft) -> Option<RawItem> {
    let url = draft.url.trim().to_string();
    if url.is_empty() {
        return None;
    }
    let summary = draft.summary.trim().to_string();
    let summary = if summary.contains('<') {
        html::html_to_text(&summary)
    } else {
        summary
    };
    Some(RawItem {
        title: if draft.title.trim().is_empty() { url.clone() } else { draft.title.trim().to_string() },
        url,
        author: draft.author.trim().to_string(),
        published_at: (!draft.published.trim().is_empty()).then(|| draft.published.trim().to_string()),
        summary,
        content: draft.content.trim().to_string(),
        channel: "rss".into(),
        tags: draft.tags,
        fingerprint: String::new(),
        diff: String::new(),
        hash_salt: String::new(),
    })
}

impl Draft {
    fn default_empty() -> Self {
        Self { title: String::new(), url: String::new(), author: String::new(), published: String::new(), summary: String::new(), content: String::new(), tags: Vec::new() }
    }
}

fn push_field(draft: &mut Draft, field: &Field, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    match field {
        Field::Title => draft.title.push_str(value),
        Field::Url => draft.url.push_str(value),
        Field::Author => {
            if draft.author.is_empty() {
                draft.author.push_str(value);
            }
        }
        Field::Published => {
            if draft.published.is_empty() {
                draft.published.push_str(value);
            }
        }
        Field::Summary => draft.summary.push_str(value),
        Field::Content => draft.content.push_str(value),
        Field::Tag => {
            if draft.tags.len() < 12 && !draft.tags.iter().any(|tag| tag == value) {
                draft.tags.push(value.to_string());
            }
        }
    }
}

fn field_of(tag: &str) -> Option<Field> {
    match tag {
        "title" => Some(Field::Title),
        "link" | "guid" | "id" => Some(Field::Url),
        // Atom 的 <author><name>；RSS 的 <author> 直接是邮箱/名字
        "author" | "creator" | "name" => Some(Field::Author),
        "pubdate" | "published" | "updated" | "date" => Some(Field::Published),
        "description" | "summary" | "subtitle" => Some(Field::Summary),
        "content" | "encoded" => Some(Field::Content),
        "category" => Some(Field::Tag),
        _ => None,
    }
}

fn tag_of(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    name.rsplit(':').next().unwrap_or(&name).trim().to_ascii_lowercase()
}

fn attribute(element: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    for attribute in element.attributes().flatten() {
        let name = String::from_utf8_lossy(attribute.key.as_ref()).to_ascii_lowercase();
        if name == key {
            return Some(
                attribute
                    .unescape_value()
                    .map(|value| value.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(&attribute.value).into_owned()),
            );
        }
    }
    None
}

// ── opencli ─────────────────────────────────────────────────────────

fn collect_opencli(source: &FeedSource) -> Result<Vec<RawItem>, String> {
    let config = &source.config;
    let site = text_field(config, "site");
    if site.is_empty() {
        return Err("opencli 源缺少 site".into());
    }
    let command = {
        let command = text_field(config, "command");
        if command.is_empty() { "search".to_string() } else { command }
    };
    let limit = number_field(config, "limit").unwrap_or(20).clamp(1, 100);
    let mut args = vec![site.clone(), command];
    let configured: Vec<String> = config
        .get("args")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    args.extend(configured);
    let query = text_field(config, "query");
    if args.len() == 2 && !query.is_empty() {
        args.push(query);
    }
    let rows = run_opencli(&args, limit)?;
    Ok(rows_to_items(&rows, &text_field(config, "channel"), Some(&site)))
}

fn collect_cn_social(source: &FeedSource) -> Result<Vec<RawItem>, String> {
    let config = &source.config;
    let queries = text_list(config, "queries");
    if queries.is_empty() {
        return Err("社区源缺少搜索词".into());
    }
    let sites = {
        let raw = text_field(config, "sites");
        if raw.is_empty() {
            vec!["zhihu".to_string(), "xiaohongshu".to_string(), "douyin".to_string()]
        } else {
            raw.split(',').map(|site| site.trim().to_string()).filter(|site| !site.is_empty()).collect()
        }
    };
    let limit = number_field(config, "limit").unwrap_or(4).clamp(1, 20);
    social_search(&sites, &queries, limit)
}

/// 逐站点 × 逐词调 `opencli <site> search`；单个失败不拖垮整批，全失败才报第一条原因。
pub fn social_search(sites: &[String], queries: &[String], limit: i64) -> Result<Vec<RawItem>, String> {
    let mut out = Vec::new();
    let mut first_error: Option<String> = None;
    for site in sites {
        for query in queries {
            match run_opencli(&[site.clone(), "search".into(), query.clone()], limit) {
                Ok(rows) => out.extend(rows_to_items(&rows, site, None)),
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(format!("{site}：{error}"));
                    }
                }
            }
        }
    }
    if out.is_empty() {
        return Err(first_error.unwrap_or_else(|| "没有拿到社区内容".into()));
    }
    Ok(out)
}

fn run_opencli(args: &[String], limit: i64) -> Result<Vec<Value>, String> {
    // shortcut: 子进程没有超时，opencli 卡住会一直占着这个采集线程。等它真的出现卡死再加 kill。
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command.arg("/C").arg("opencli");
        command
    } else {
        std::process::Command::new("opencli")
    };
    command.args(args);
    command.arg("--limit").arg(limit.to_string());
    command.arg("--format").arg("json");
    let output = command.output().map_err(|error| format!("未能运行 opencli：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("无输出");
        return Err(format!("opencli 退出异常：{detail}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = parse_json_loose(&stdout).ok_or("opencli 没有输出 JSON")?;
    let rows = rows_of(&value);
    if rows.is_empty() {
        return Err("opencli 返回空结果".into());
    }
    Ok(rows)
}

/// opencli 有时先打日志再打 JSON：从第一个 `{` / `[` 开始试解析。
fn parse_json_loose(text: &str) -> Option<Value> {
    let start = text.find(['{', '['])?;
    serde_json::from_str(&text[start..]).ok()
}

fn rows_of(value: &Value) -> Vec<Value> {
    if let Some(rows) = value.as_array() {
        return rows.clone();
    }
    for key in ["data", "items", "results", "list", "videos", "notes"] {
        if let Some(rows) = value.get(key).and_then(Value::as_array) {
            return rows.clone();
        }
        if let Some(rows) = value.get("payload").and_then(|inner| inner.get(key)).and_then(Value::as_array) {
            return rows.clone();
        }
    }
    value.get("payload").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn rows_to_items(rows: &[Value], channel: &str, fallback_channel: Option<&str>) -> Vec<RawItem> {
    rows.iter()
        .filter_map(|row| {
            let title = first_text(row, &["title", "name", "text", "content", "desc", "description"]);
            let mut url = first_text(row, &["url", "link", "href", "share_url", "web_url"]);
            if url.is_empty() {
                if let Some(bvid) = row.get("bvid").and_then(Value::as_str) {
                    url = format!("https://www.bilibili.com/video/{bvid}");
                } else if let Some(id) = row.get("id").and_then(|id| id.as_str().map(str::to_string).or_else(|| row.get("id").and_then(Value::as_i64).map(|id| id.to_string()))) {
                    if channel == "bilibili" {
                        url = format!("https://www.bilibili.com/opus/{id}");
                    }
                }
            }
            if url.is_empty() || title.is_empty() {
                return None;
            }
            let summary = first_text(row, &["summary", "desc", "description", "excerpt", "content", "text"]);
            Some(RawItem {
                title,
                url,
                author: first_text(row, &["author", "user", "owner", "nickname", "up_name", "user_name"]),
                published_at: first_text(row, &["published_at", "pub_date", "date", "created_at", "time", "ctime", "publish_time"])
                    .into_optional(),
                summary: html::html_to_text(&summary),
                content: first_text(row, &["content", "text", "desc"]),
                channel: if channel.is_empty() { fallback_channel.unwrap_or_default().to_string() } else { channel.to_string() },
                tags: Vec::new(),
                fingerprint: String::new(),
                diff: String::new(),
                hash_salt: String::new(),
            })
        })
        .collect()
}

fn first_text(row: &Value, keys: &[&str]) -> String {
    for key in keys {
        match row.get(*key) {
            Some(Value::String(text)) => {
                let text = text.trim();
                if !text.is_empty() {
                    return text.to_string();
                }
            }
            Some(Value::Number(number)) => return number.to_string(),
            _ => {}
        }
    }
    String::new()
}

trait IntoOptional {
    fn into_optional(self) -> Option<String>;
}

impl IntoOptional for String {
    fn into_optional(self) -> Option<String> {
        (!self.is_empty()).then_some(self)
    }
}

// ── searxng ─────────────────────────────────────────────────────────

fn collect_searxng(source: &FeedSource) -> Result<Vec<RawItem>, String> {
    let config = &source.config;
    let queries = text_list(config, "queries");
    if queries.is_empty() {
        return Err("搜索订阅缺少搜索词".into());
    }
    let base = {
        let base = text_field(config, "baseUrl");
        if base.is_empty() { "http://127.0.0.1:8888".to_string() } else { base.trim_end_matches('/').to_string() }
    };
    let language = {
        let language = text_field(config, "language");
        if language.is_empty() { "zh-CN".to_string() } else { language }
    };
    let per_query = number_field(config, "perQuery").or_else(|| number_field(config, "per_query")).unwrap_or(8).clamp(1, 30);
    searxng_search(&queries, per_query, &base, &language)
}

/// 本机 SearXNG；资讯的搜索源与调研的 web 渠道共用。
pub fn searxng_search(queries: &[String], per_query: i64, base: &str, language: &str) -> Result<Vec<RawItem>, String> {
    let mut out = Vec::new();
    let mut first_error: Option<String> = None;
    for query in queries {
        let url = format!("{base}/search?q={}&format=json&language={language}", percent_encode(query));
        match fetch_text(&url, 45).map_err(|error| format!("{query}：{error}")) {
            Ok(body) => match serde_json::from_str::<Value>(&body) {
                Ok(value) => {
                    let rows: Vec<Value> = value.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
                    for row in rows.into_iter().take(per_query as usize) {
                        let title = first_text(&row, &["title"]);
                        let url = first_text(&row, &["url"]);
                        if title.is_empty() || url.is_empty() {
                            continue;
                        }
                        out.push(RawItem {
                            title,
                            url,
                            author: first_text(&row, &["engine"]),
                            published_at: first_text(&row, &["publishedDate"]).into_optional(),
                            summary: first_text(&row, &["content"]),
                            content: String::new(),
                            channel: "web".into(),
                            tags: row.get("engines").and_then(Value::as_array).map(|list| list.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                            fingerprint: String::new(),
                            diff: String::new(),
                            hash_salt: String::new(),
                        });
                    }
                }
                Err(_) => {
                    if first_error.is_none() {
                        first_error = Some("SearXNG 返回的不是 JSON".into());
                    }
                }
            },
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if out.is_empty() {
        return Err(first_error.unwrap_or_else(|| "搜索没有结果".into()));
    }
    Ok(out)
}

/// 只保留 RFC 3986 的 unreserved 与常规分隔符，避免中文/空格把 URL 弄坏。
pub fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b' ' => {
                if *byte == b' ' {
                    out.push('+');
                } else {
                    out.push(*byte as char);
                }
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ── page ────────────────────────────────────────────────────────────

fn collect_page(source: &FeedSource, previous: Option<&FeedItem>, sequence: usize) -> Result<Vec<RawItem>, String> {
    let config = &source.config;
    let url = text_field(config, "url");
    if url.is_empty() {
        return Err("页面源缺少 url".into());
    }
    let body = fetch_text(&url, 30)?;
    let text = html::html_to_text(&body);
    if text.is_empty() {
        return Err("页面没有正文".into());
    }
    let fingerprint = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(text.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    };
    if previous.map(|item| item.fingerprint.as_str()) == Some(fingerprint.as_str()) {
        return Ok(Vec::new());
    }
    let diff = previous.map(|item| diff_lines(&item.content, &text)).unwrap_or_default();
    let title = {
        let configured = text_field(config, "title");
        if !configured.is_empty() {
            configured
        } else if let Some(title) = html::html_title(&body) {
            title
        } else {
            text.lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| store::truncate(line, 60))
                .unwrap_or_else(|| url.split("://").nth(1).unwrap_or(&url).split('/').next().unwrap_or(&url).to_string())
        }
    };
    Ok(vec![RawItem {
        title,
        url: url.clone(),
        author: String::new(),
        published_at: Some(chrono::Local::now().to_rfc3339()),
        summary: store::truncate(&text, 300),
        content: text,
        channel: {
            let channel = text_field(config, "channel");
            if channel.is_empty() { "page".into() } else { channel }
        },
        tags: Vec::new(),
        fingerprint: fingerprint.clone(),
        diff,
        hash_salt: format!("{}:full:{}:{sequence}", source.id, &fingerprint[..12]),
    }])
}

fn diff_lines(old: &str, new: &str) -> String {
    let old_lines: Vec<&str> = old.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let added: Vec<&str> = new
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !old_lines.contains(line))
        .take(40)
        .collect();
    added.join("\n")
}

// ── 公共 ────────────────────────────────────────────────────────────

pub fn fetch_text(url: &str, seconds: u64) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只支持 http(s) 地址".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(seconds))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(UA)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().map_err(|error| format!("请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(BODY_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取失败：{error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn text_field(config: &Value, key: &str) -> String {
    config.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn number_field(config: &Value, key: &str) -> Option<i64> {
    match config.get(key) {
        Some(Value::Number(number)) => number.as_i64(),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

fn text_list(config: &Value, key: &str) -> Vec<String> {
    match config.get(key) {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|item| item.as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_string))
            .collect(),
        Some(Value::String(text)) => text
            .split(['\n', ',', '，'])
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rss_and_atom() {
        let rss = r#"<rss><channel><item><title>A</title><link>https://a.com/1</link><author>张三</author><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description><![CDATA[<p>摘要</p>]]></description></item></channel></rss>"#;
        let items = parse_feed(rss);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].url, "https://a.com/1");
        assert_eq!(items[0].summary, "摘要");
        let atom = r#"<feed><entry><title>B</title><link href="https://b.com/2"/><updated>2024-01-01T00:00:00Z</updated><content type="html">&lt;p&gt;正文&lt;/p&gt;</content></entry></feed>"#;
        let items = parse_feed(atom);
        assert_eq!(items[0].url, "https://b.com/2");
        assert_eq!(items[0].content, "<p>正文</p>");
    }

    #[test]
    fn reads_opencli_rows() {
        let rows = vec![json!({ "title": "视频", "bvid": "BV1xx", "owner": "阿婆" })];
        let items = rows_to_items(&rows, "bilibili", None);
        assert_eq!(items[0].url, "https://www.bilibili.com/video/BV1xx");
        assert_eq!(items[0].author, "阿婆");
    }

    #[test]
    fn encodes_query() {
        assert_eq!(percent_encode("tauri 桌面"), "tauri+%E6%A1%8C%E9%9D%A2");
    }

    #[test]
    fn diff_keeps_new_lines_only() {
        assert_eq!(diff_lines("旧\n留", "留\n新"), "新");
    }
}
