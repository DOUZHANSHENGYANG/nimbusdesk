//! HTML → 纯文本。资讯的 page 源与调研的正文抓取共用这一份，不引额外解析库。

/// 这些标签里的内容不是给人读的，整段跳过。
const SKIP: &[&str] = &["script", "style", "noscript", "svg", "template", "head"];
/// 遇到就把上下切开，避免所有文字挤成一行。
const BLOCK: &[&str] = &[
    "p", "div", "br", "hr", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "section",
    "article", "header", "footer", "blockquote", "pre", "ul", "ol", "table", "figure", "figcaption",
    "dd", "dt", "nav", "aside", "main",
];

pub fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut cursor = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(offset) = lower[i..].find('>') else { break };
        let end = i + offset;
        let inner = &lower[i + 1..end];
        let tag = tag_name(inner);
        let closing = inner.starts_with('/');
        out.push_str(&html[cursor..i]);
        if !closing && SKIP.contains(&tag.as_str()) {
            // 整段跳过：直接跳到同名闭合标签之后（找不到就跳到底）
            let close = format!("</{tag}");
            i = match lower[i..].find(&close) {
                Some(pos) => lower[i + pos..].find('>').map(|end2| i + pos + end2 + 1).unwrap_or(lower.len()),
                None => lower.len(),
            };
            cursor = i;
            continue;
        }
        if BLOCK.contains(&tag.as_str()) {
            out.push('\n');
        }
        i = end + 1;
        cursor = i;
    }
    if cursor < html.len() {
        out.push_str(&html[cursor..]);
    }
    normalize(&decode_entities(&out))
}

/// 页面的 `<title>`：page 源没配标题时用它当条目标题。
pub fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open = start + lower[start..].find('>')? + 1;
    let close = lower[open..].find("</title")? + open;
    let title = normalize_line(&decode_entities(&html[open..close]));
    (!title.is_empty()).then_some(title)
}

/// 只认最常见的实体；未知的原样保留，不做猜测。
pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let Some(semi) = tail.find(';').filter(|semi| *semi <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "ldquo" => Some('“'),
            "rdquo" => Some('”'),
            "lsquo" => Some('‘'),
            "rsquo" => Some('’'),
            "middot" => Some('·'),
            _ => entity.strip_prefix('#').and_then(|code| {
                let value = match code.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                    None => code.parse::<u32>().ok()?,
                };
                char::from_u32(value)
            }),
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn tag_name(inner: &str) -> String {
    let inner = inner.trim_start_matches('/');
    let name: String = inner
        .chars()
        .take_while(|ch| !ch.is_whitespace() && *ch != '/')
        .collect();
    name.to_ascii_lowercase()
}

/// 每个标签一段、段内空白压成一个空格。
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = normalize_line(line);
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out
}

fn normalize_line(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_scripts_and_keeps_paragraphs() {
        let text = html_to_text("<html><head><title>T</title><style>p{}</style></head><body><script>var a=1;</script><p>你好 <b>世界</b></p><p>第二段</p></body></html>");
        assert_eq!(text, "你好 世界\n第二段");
    }

    #[test]
    fn decodes_numeric_entities() {
        assert_eq!(decode_entities("a&#39;b &amp; c &#x4F60;"), "a'b & c 你");
        assert_eq!(decode_entities("100% &unknown;"), "100% &unknown;");
    }

    #[test]
    fn reads_title() {
        assert_eq!(html_title("<TITLE>标题</TITLE>").as_deref(), Some("标题"));
        assert_eq!(html_title("<p>x</p>"), None);
    }
}
