//! 共享的 AI 调用：按默认提供商的协议分派 openai / anthropic 请求。
//!
//! 原先 MCP 标签建议（`mcpconnect`）、导入 AI 修复（`skillimport`）与技能摘要
//! （`skillsummary`）各有一份几乎相同的实现 —— 三处只保留这一份，且都只经由
//! 本模块的 `chat`（spec `unified-chat`）：三处调用点不各自读配置。
//!
//! 配置来源：`aiprovider::resolve_default` —— 默认提供商的协议 / Base URL /
//! 模型 / 凭据。旧字段 `ai_base_url` 等只用于一次性迁移，这里不再读取。

use crate::ahub::aiprovider::{self, AiProvider, ANTHROPIC_VERSION, CHAT_TIMEOUT};
use crate::ahub::store::AppH;

/// 未配置接口时的统一提示：必须明确指向设置页。
/// 实际取值定义在 `aiprovider`（唯一来源），这里保留旧名字以免调用方到处改。
#[allow(dead_code)]
pub const ERR_NOT_CONFIGURED: &str = aiprovider::ERR_NOT_CONFIGURED;

/// anthropic 协议单次回复的 token 上限
const ANTHROPIC_MAX_TOKENS: u32 = 2048;

/// 调用默认提供商的 AI 接口，返回助手回复的文本。
///
/// 无默认提供商、默认已停用或缺 key 时返回明确错误（含"请先在设置页配置"），
/// 不发起任何网络请求。
pub fn chat(app: &AppH, system_prompt: &str, user_content: &str) -> Result<String, String> {
    let (provider, key) = aiprovider::resolve_default(app)?;
    match aiprovider::normalize_kind(&provider.kind).as_str() {
        "anthropic" => chat_anthropic(&provider, &key, system_prompt, user_content),
        _ => chat_openai(&provider, &key, system_prompt, user_content),
    }
}

/// 实际使用的模型名（技能摘要等需要把模型名记进元信息）。
/// 只看配置，不校验 key 可用性 —— 摘要生成本身会经由 `chat` 报出真实错误。
pub fn resolve_model(app: &AppH) -> String {
    aiprovider::default_model_name(app).unwrap_or_default()
}

/// 保留旧接口：给定配置串解析模型名（空则退回 openai 默认）。
/// 新代码用 `resolve_model`（读默认提供商的真实模型）。
#[allow(dead_code)]
pub fn model_name(configured: &str) -> String {
    let m = configured.trim();
    if m.is_empty() {
        "gpt-4o-mini".to_string()
    } else {
        m.to_string()
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(CHAT_TIMEOUT)
        .user_agent("AgentHub/0.1 (AI)")
        .build()
}

/// 读取响应 JSON；失败文案含厂商名
fn read_json(provider: &AiProvider, resp: ureq::Response) -> Result<serde_json::Value, String> {
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("读取「{}」的 AI 响应失败：{e}", provider.name))
}

fn send(
    provider: &AiProvider,
    req: ureq::Request,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match req.send_json(body) {
        Ok(resp) => read_json(provider, resp),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(aiprovider::http_error(&provider.name, code, &text))
        }
        Err(e) => {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("timed out") || lower.contains("timeout") {
                Err(format!("「{}」请求超时（{} 秒）", provider.name, CHAT_TIMEOUT.as_secs()))
            } else {
                Err(format!("「{}」请求失败：{msg}", provider.name))
            }
        }
    }
}

fn extract_text(provider: &AiProvider, value: &serde_json::Value, pointer: &str) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "「{}」响应格式异常：{}",
                provider.name,
                value.to_string().chars().take(200).collect::<String>()
            )
        })
}

/// openai 兼容：POST `{base}/chat/completions`，取 `choices[0].message.content`
fn chat_openai(p: &AiProvider, key: &str, sys: &str, user: &str) -> Result<String, String> {
    let base = aiprovider::effective_base_url(p);
    let url = aiprovider::openai_endpoint(&base);
    let model = aiprovider::resolve_model(p);
    let body = aiprovider::openai_payload(&model, sys, user, None);
    let mut req = agent().post(&url);
    // 本地网关可不需要 key：空 key 就不发鉴权头
    if !key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    let value = send(p, req, body)?;
    extract_text(p, &value, "/choices/0/message/content")
}

/// anthropic：POST `{base}/v1/messages`（base 已含 /v1 不重复），取 `content[0].text`
fn chat_anthropic(p: &AiProvider, key: &str, sys: &str, user: &str) -> Result<String, String> {
    let base = aiprovider::effective_base_url(p);
    let url = aiprovider::anthropic_endpoint(&base);
    let model = aiprovider::resolve_model(p);
    let body = aiprovider::anthropic_payload(&model, sys, user, ANTHROPIC_MAX_TOKENS);
    let mut req = agent().post(&url).set("anthropic-version", ANTHROPIC_VERSION);
    if !key.is_empty() {
        req = req.set("x-api-key", key);
    }
    let value = send(p, req, body)?;
    extract_text(p, &value, "/content/0/text")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{channel, Receiver};

    /// 一次收到的 HTTP 请求（请求行 + 头 + body）
    struct Captured {
        request_line: String,
        headers: String,
        body: serde_json::Value,
    }

    impl Captured {
        fn path(&self) -> &str {
            self.request_line.split_whitespace().nth(1).unwrap_or("")
        }
        fn header(&self, name: &str) -> String {
            self.headers
                .lines()
                .skip(1)
                .find_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    if k.trim().eq_ignore_ascii_case(name) {
                        Some(v.trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default()
        }
    }

    /// 起一个只响应一次的本地 mock 服务器，返回 base URL 与「收到的请求」通道。
    fn mock_server(status: u16, body: &'static str) -> (String, Receiver<Captured>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // 读到 header 结束
            let header_end = loop {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break buf.len();
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let len = head
                .to_ascii_lowercase()
                .lines()
                .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            while buf.len() < header_end + len {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body_text = String::from_utf8_lossy(&buf[header_end..]).to_string();
            let request_line = head.lines().next().unwrap_or("").to_string();
            let headers = head;
            let _ = tx.send(Captured {
                request_line,
                headers,
                body: serde_json::from_str(&body_text).unwrap_or(serde_json::Value::Null),
            });
            let resp = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn provider(kind: &str, base_url: &str, model: &str) -> AiProvider {
        AiProvider {
            id: "p1".into(),
            name: "DeepSeek".into(),
            kind: kind.into(),
            base_url: base_url.into(),
            model: model.into(),
            enabled: true,
            is_default: true,
            created_at: String::new(),
            updated_at: String::new(),
            credential_ref: "agenthub-ai-p1".into(),
            key_hint: String::new(),
        }
    }

    #[test]
    fn openai_request_path_headers_and_body() {
        let (base, rx) = mock_server(200, r#"{"choices":[{"message":{"content":"你好"}}]}"#);
        let p = provider("openai", &format!("{base}/v1"), "deepseek-chat");
        let text = chat_openai(&p, "sk-key", "你是助手", "打个招呼").unwrap();
        assert_eq!(text, "你好");

        let req = rx.recv().unwrap();
        assert_eq!(req.path(), "/v1/chat/completions", "openai 端点应为 {{base}}/chat/completions");
        assert_eq!(req.header("authorization").to_ascii_lowercase(), "bearer sk-key");
        assert_eq!(req.body["model"], "deepseek-chat");
        assert_eq!(req.body["messages"][0]["role"], "system");
        assert_eq!(req.body["messages"][0]["content"], "你是助手");
        assert_eq!(req.body["messages"][1]["role"], "user");
    }

    #[test]
    fn anthropic_request_path_headers_and_body() {
        let (base, rx) = mock_server(200, r#"{"content":[{"type":"text","text":"hi there"}]}"#);
        let p = provider("anthropic", &base, "claude-sonnet-4-5");
        let text = chat_anthropic(&p, "sk-ant", "你是助手", "打个招呼").unwrap();
        assert_eq!(text, "hi there");

        let req = rx.recv().unwrap();
        assert_eq!(req.path(), "/v1/messages", "anthropic 端点应为 {{base}}/v1/messages");
        assert_eq!(req.header("x-api-key"), "sk-ant");
        assert_eq!(req.header("anthropic-version"), "2023-06-01");
        assert_eq!(req.body["system"], "你是助手", "system 必须放顶层");
        assert_eq!(req.body["max_tokens"], 2048);
        assert_eq!(req.body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(req.body["messages"][0]["role"], "user");
    }

    #[test]
    fn anthropic_base_with_v1_does_not_double_it() {
        let (base, rx) = mock_server(200, r#"{"content":[{"type":"text","text":"ok"}]}"#);
        let p = provider("anthropic", &format!("{base}/v1"), "claude-sonnet-4-5");
        chat_anthropic(&p, "k", "", "ping").unwrap();
        assert_eq!(rx.recv().unwrap().path(), "/v1/messages", "不该出现 /v1/v1");
    }

    #[test]
    fn openai_http_error_contains_vendor_and_status() {
        let (base, _rx) = mock_server(401, r#"{"error":"invalid api key"}"#);
        let p = provider("openai", &base, "gpt-4o");
        let e = chat_openai(&p, "bad", "", "ping").unwrap_err();
        assert!(e.contains("DeepSeek"), "错误必须含厂商名：{e}");
        assert!(e.contains("401"), "错误必须含 HTTP 状态：{e}");
        assert!(e.contains("API key 无效"), "{e}");
    }

    #[test]
    fn openai_malformed_response_is_reported() {
        let (base, _rx) = mock_server(200, r#"{"unexpected":true}"#);
        let p = provider("openai", &base, "gpt-4o");
        let e = chat_openai(&p, "k", "", "ping").unwrap_err();
        assert!(e.contains("DeepSeek") && e.contains("响应格式异常"), "{e}");
    }

    #[test]
    fn empty_base_url_uses_vendor_default_endpoint() {
        // 不发请求：只验证端点的拼装（真实厂商地址不该在测试里被访问）
        let p = provider("openai", "", "gpt-4o");
        assert_eq!(
            aiprovider::openai_endpoint(&aiprovider::effective_base_url(&p)),
            "https://api.openai.com/v1/chat/completions"
        );
        let a = provider("anthropic", "", "claude-sonnet-4-5");
        assert_eq!(
            aiprovider::anthropic_endpoint(&aiprovider::effective_base_url(&a)),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn no_key_sends_no_auth_header() {
        // 本地网关场景：没有 key 也要能调通，只是不带鉴权头
        let (base, rx) = mock_server(200, r#"{"choices":[{"message":{"content":"ok"}}]}"#);
        let p = provider("openai", &base, "local-model");
        assert_eq!(chat_openai(&p, "", "", "ping").unwrap(), "ok");
        let req = rx.recv().unwrap();
        assert_eq!(req.header("authorization"), "", "空 key 不该发 Authorization 头");
        assert_eq!(req.body["model"], "local-model");
    }

    #[test]
    fn model_name_falls_back_to_default() {
        assert_eq!(model_name(""), "gpt-4o-mini");
        assert_eq!(model_name("   "), "gpt-4o-mini");
        assert_eq!(model_name(" qwen-plus "), "qwen-plus");
    }

    #[test]
    fn not_configured_message_points_to_settings() {
        assert!(ERR_NOT_CONFIGURED.contains("设置"));
        assert!(ERR_NOT_CONFIGURED.contains("AI 提供商"));
    }
}
