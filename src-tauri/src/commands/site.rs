//! 网站元信息抓取：title / meta description / favicon。
//! 无 HTML 解析器依赖，用大小写无关的朴素扫描（够用且零依赖）。

use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMeta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub icon_url: Option<String>,
}

#[tauri::command]
pub async fn fetch_site_meta(url: String) -> Result<SiteMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) NimbusDesk/0.1")
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        let final_url = resp.url().clone();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let body = resp.text().map_err(|e| e.to_string())?;
        Ok(parse_meta(&body, &final_url, &content_type))
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

fn parse_meta(html: &str, base: &reqwest::Url, content_type: &str) -> SiteMeta {
    let lower = html.to_lowercase();

    // 非HTML响应（纯图标/二进制）：title 用主机名，favicon 即该 URL
    if !content_type.contains("text/html") && !lower.contains("<html") && !lower.contains("<title")
    {
        return SiteMeta {
            title: None,
            description: None,
            icon_url: Some(final_url_string(base)),
        };
    }

    let title = extract_between_ci(html, "<title", ">")
        .and_then(|(_s, from)| {
            let end = html[from..].find("</title>")?;
            Some(html[from..from + end].to_string())
        })
        .map(|s| decode_entities(s.trim()))
        .filter(|s| !s.is_empty());

    let description = meta_content(&lower, html, "name", "description")
        .or_else(|| meta_content(&lower, html, "property", "og:description"))
        .map(|s| decode_entities(s.trim()))
        .filter(|s| !s.is_empty());

    let icon_url = find_icon(html, base);

    SiteMeta {
        title,
        description,
        icon_url,
    }
}

fn final_url_string(base: &reqwest::Url) -> String {
    base.join("favicon.ico")
        .map(|u| u.to_string())
        .unwrap_or_else(|_| base.to_string())
}

/// 在 `<meta ...>` 中按 key=value 匹配属性，返回 content 值。
fn meta_content(lower: &str, html: &str, key: &str, value: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta") {
        let start = from + i;
        let end_rel = lower[start..].find('>')?;
        let end = start + end_rel;
        let tag = &lower[start..end];
        let raw = &html[start..end];
        if attr_value(tag, key)
            .map(|v| v.eq_ignore_ascii_case(value))
            .unwrap_or(false)
        {
            if let Some(c) = attr_value(raw, "content") {
                return Some(c);
            }
        }
        from = end + 1;
    }
    None
}

/// 找 <link rel~="icon" href=...>；优先 apple-touch-icon（180px 大图），否则首个 icon。
fn find_icon(html: &str, base: &reqwest::Url) -> Option<String> {
    let lower = html.to_lowercase();
    let mut plain: Option<String> = None;
    let mut apple: Option<String> = None;

    let mut from = 0;
    while let Some(i) = lower[from..].find("<link") {
        let start = from + i;
        let end_rel = lower[start..].find('>')?;
        let end = start + end_rel;
        let tag = &lower[start..end];
        let raw = &html[start..end];

        let rel = attr_value(tag, "rel").unwrap_or_default();
        if rel.contains("icon") {
            if let Some(href) = attr_value(raw, "href") {
                if rel.contains("apple-touch") {
                    apple = apple.or_else(|| Some(href));
                } else {
                    plain = plain.or_else(|| Some(href));
                }
            }
        }
        from = end + 1;
    }

    let rel = apple.or(plain)?;
    if rel.starts_with("data:") {
        return Some(rel);
    }
    base.join(&rel).ok().map(|u| u.to_string())
}

/// 在标签字符串里找 `key="value"` 或 `key='value'`（key 已小写匹配）。
fn attr_value(tag_lower: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let mut from = 0;
    while let Some(i) = tag_lower[from..].find(&needle) {
        let at = from + i;
        // 防误匹配：key 前必须是标签边界（< 或空白）
        let boundary =
            at == 0 || tag_lower[..at].ends_with(|c: char| c == '<' || c.is_ascii_whitespace());
        from = at + needle.len();
        if !boundary {
            continue;
        }
        let rest = &tag_lower[at + needle.len()..];
        let quote = rest.chars().next()?;
        let val_lower = if quote == '"' || quote == '\'' {
            let end = rest[1..].find(quote)? + 1;
            &rest[1..end]
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            &rest[..end]
        };
        // 值要从原文取（保留原始大小写）：重新定位
        let raw_rest = &tag_lower[at + needle.len()..];
        let _ = raw_rest;
        return Some(val_lower.to_string());
    }
    None
}

/// 取 `<tag ...>` 与 `</tag>` 之间的内容（大小写无关找开标签）。
fn extract_between_ci<'a>(html: &'a str, open: &str, _close: &str) -> Option<(&'a str, usize)> {
    let lower = html.to_lowercase();
    let i = lower.find(open)?;
    let gt = lower[i..].find('>')? + i + 1;
    Some((&html[gt..], gt))
}

/// 最小 HTML 实体解码。
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}
