//! MCP 连通性测试 + AI 标签建议（mcp-enhance）。
//!
//! - 连通性：stdio 跑 `command args --help`（复用 cliscan 的超时执行器，Windows 无黑框）；
//!   http/sse GET url，状态码 < 500 视为可达（4xx 说明服务在线，只是鉴权/路径问题）。
//! - AI 标签：调 OpenAI 兼容 chat/completions，**只发送 name + description**，
//!   不发送 command/args/env 等本机敏感信息。

use crate::ahub::models::McpServer;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
    /// 超时单独标记：前端显示「⏳ 超时」而不是「❌ 失败」
    pub timed_out: bool,
}

fn result(ok: bool, message: impl Into<String>, start: Instant, timed_out: bool) -> McpTestResult {
    McpTestResult {
        ok,
        message: message.into(),
        elapsed_ms: start.elapsed().as_millis() as u64,
        timed_out,
    }
}

/// 连通性测试入口。stdio → 本地进程探测；http/sse → GET url。
pub fn test_connectivity(mcp: &McpServer) -> McpTestResult {
    let start = Instant::now();
    if mcp.transport == "stdio" {
        test_stdio(mcp, start)
    } else {
        test_http(&mcp.url, start)
    }
}

fn test_stdio(mcp: &McpServer, start: Instant) -> McpTestResult {
    let name = mcp.command.trim();
    if name.is_empty() {
        return result(false, "命令为空", start, false);
    }
    // Windows 上 npm/npx 等是 .cmd 批处理，裸命令名先按 PATHEXT 解析成真实可执行文件；
    // 用户填了完整路径时 resolve_program 会拒绝（含路径分隔符），此时按原样执行。
    let program: PathBuf = crate::ahub::cliscan::resolve_program(name).unwrap_or_else(|| PathBuf::from(name));
    let mut args: Vec<&str> = mcp.args.iter().map(String::as_str).collect();
    args.push("--help");

    match crate::ahub::cliscan::run_command(&program, &args, PROBE_TIMEOUT) {
        Ok(out) if out.timed_out => {
            result(false, format!("{} 秒内无响应", PROBE_TIMEOUT.as_secs()), start, true)
        }
        Ok(out) if out.ok => result(true, "进程可正常运行（--help 退出码 0）", start, false),
        Ok(out) => {
            let line = out
                .stderr
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or(out.stdout.lines().find(|l| !l.trim().is_empty()).unwrap_or(""));
            let msg = line.trim();
            let msg = if msg.is_empty() {
                "进程退出码非 0".to_string()
            } else {
                msg.chars().take(160).collect()
            };
            result(false, msg, start, false)
        }
        Err(e) => result(false, format!("无法启动：{e}"), start, false),
    }
}

fn test_http(url: &str, start: Instant) -> McpTestResult {
    let url = url.trim();
    if url.is_empty() {
        return result(false, "URL 为空", start, false);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(PROBE_TIMEOUT)
        .user_agent("AgentHub/0.1 (MCP connectivity test)")
        .build();
    match agent.get(url).call() {
        Ok(resp) => result(true, format!("HTTP {}", resp.status()), start, false),
        Err(ureq::Error::Status(code, _)) => {
            if code < 500 {
                result(true, format!("HTTP {code}"), start, false)
            } else {
                result(false, format!("HTTP {code}"), start, false)
            }
        }
        Err(e) => {
            let s = e.to_string();
            // ureq 2 的超时没有独立错误变体，靠消息识别；识别不出也只是显示为失败
            let timed_out = s.to_lowercase().contains("timed out") || s.to_lowercase().contains("timeout");
            result(false, s, start, timed_out)
        }
    }
}

// ---------------- AI 标签建议（A4/A5） ----------------

/// 用默认 AI 提供商的接口根据名称与描述建议 3-5 个标签。
/// 配置统一来自默认提供商（settings.json 的 aiProviders + 系统凭据管理器）；
/// 旧字段 aiBaseUrl / aiApiKey / aiModel 只在首次迁移时读取。
pub fn suggest_tags(app: &crate::ahub::store::AppH, name: &str, description: &str) -> Result<Vec<String>, String> {
    let prompt = format!(
        "你是标签助手。根据下面这个 MCP 服务/技能的名称与描述，生成 1-4 个标签。\n\
要求：\n\
1. 每个标签 2-8 个字；\n\
2. 每个标签描述**不同的方面**（领域 / 对象 / 动作 / 平台 各取一个），不要重复同一个维度；\n\
3. **禁止近义或包含关系的重复**：有了「邮件」就不要再给「邮箱」「电子邮件」「邮件操作」「邮件管理」；\n\
4. 不要照抄名称；标签要能帮人快速定位，宁少勿滥。\n\
只输出一个 JSON 字符串数组，不要输出任何其他文字。\n名称：{name}\n描述：{description}"
    );

    let content = crate::ahub::aihelper::chat(app, "", &prompt)?;
    let tags = parse_tags(&content);
    if tags.is_empty() {
        return Err(format!("AI 未返回可解析的标签：{}", content.chars().take(200).collect::<String>()));
    }
    Ok(tags)
}

/// 从模型输出里抠出 JSON 字符串数组（容忍 ```json 围栏与前后杂文字）。
fn parse_tags(content: &str) -> Vec<String> {
    let mut s = content.trim();
    if let Some(rest) = s.strip_prefix("```json") {
        s = rest.trim();
    } else if let Some(rest) = s.strip_prefix("```") {
        s = rest.trim();
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.trim();
    }
    let arr = match (s.find('['), s.rfind(']')) {
        (Some(a), Some(b)) if b > a => &s[a..=b],
        _ => s,
    };
    let mut kept: Vec<String> = Vec::new();
    for tag in serde_json::from_str::<Vec<String>>(arr).unwrap_or_default() {
        let tag = tag.trim().to_string();
        if tag.is_empty() || kept.iter().any(|kept_tag| too_similar(kept_tag, &tag)) {
            continue;
        }
        kept.push(tag);
        if kept.len() >= 4 {
            break;
        }
    }
    kept
}

/// 两个标签是不是在说同一件事。
///
/// 中文标签没有词形变化，"邮件 / 邮箱 / 邮件操作 / 邮件管理" 会一起冒出来，
/// 光去重相同字符串没用。这里用「共享字数 / 较短标签长度」做粗判：
/// 邮件 vs 邮箱 = 1/2，邮件 vs 邮件操作 = 1，都会被判成同一维度。
fn too_similar(a: &str, b: &str) -> bool {
    let na: Vec<char> = a.chars().filter(|c| !c.is_whitespace()).collect();
    let nb: Vec<char> = b.chars().filter(|c| !c.is_whitespace()).collect();
    if na.is_empty() || nb.is_empty() {
        return true;
    }
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    let shared = na.iter().filter(|c| nb.contains(c)).count();
    let shorter = na.len().min(nb.len());
    shared * 2 >= shorter
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_dedupe_keeps_distinct_dimensions() {
        let raw = r#"["电子邮件","邮件","邮件操作","邮件管理","邮箱","附件","OAuth 授权"]"#;
        let tags = parse_tags(raw);
        assert!(tags.len() <= 4, "最多 4 个：{tags:?}");
        assert_eq!(tags.iter().filter(|t| t.contains('邮')).count(), 1, "邮件维度只留一个：{tags:?}");
        assert!(tags.iter().any(|t| t.contains("OAuth")), "不同维度要留下：{tags:?}");
    }

    #[test]
    fn parse_tags_handles_fenced_and_embedded_json() {
        assert_eq!(parse_tags("[\"搜索\",\"浏览器\"]"), vec!["搜索", "浏览器"]);
        assert_eq!(
            parse_tags("```json\n[\"a\", \"b\"]\n```"),
            vec!["a", "b"]
        );
        assert_eq!(
            parse_tags("好的：[\"x\",\"y\",\"x\"] 如上"),
            vec!["x", "y"],
            "应取首段 [...] 并去重"
        );
        assert!(parse_tags("抱歉我不能").is_empty(), "无数组时返回空");
    }

    #[test]
    fn parse_tags_caps_at_four() {
        let tags = parse_tags("[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\"]");
        assert_eq!(tags.len(), 4);
    }
}
