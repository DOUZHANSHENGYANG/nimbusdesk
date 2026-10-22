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
        "你是标签助手。根据下面这个 MCP 服务的名称与描述，生成 3-5 个简短标签：\
每个标签 2-8 个字，概括它的功能领域（如：搜索、浏览器、文件系统、代码、数据库）。\
不要照抄名称。只输出一个 JSON 字符串数组，不要输出任何其他文字。\n名称：{name}\n描述：{description}"
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
    let mut seen = std::collections::BTreeSet::new();
    serde_json::from_str::<Vec<String>>(arr)
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && seen.insert(t.clone()))
        .take(5)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_tags_caps_at_five() {
        let tags = parse_tags("[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\"]");
        assert_eq!(tags.len(), 5);
    }
}
