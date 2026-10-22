//! AI 提供商：厂商预设、CRUD、凭据引用、端点与请求体构造、旧配置迁移。
//!
//! 存储分层（spec `provider-model` / `credential-vault`）：
//! - 元信息（不含 key）存 `settings.json` 的 `aiProviders` / `aiDefaultProviderId`
//! - API key 只存 Windows 凭据管理器，用 `credentialRef = agenthub-ai-<id>` 定位
//!
//! 协议只分两类（D1）：`openai`（`{base}/chat/completions`）与
//! `anthropic`（`{base}/v1/messages`，base 已含 `/v1` 时不重复）。
//! Base URL 留空时回退厂商默认（D3）。

use crate::ahub::credential;
use crate::ahub::models::{new_id, now_iso, Settings};
use crate::ahub::store::{self, AppH};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// 没有可用提供商时的统一提示：必须明确指向设置页（spec `unified-chat` 第 2 步）
pub const ERR_NOT_CONFIGURED: &str =
    "尚未配置 AI 提供商：请到「设置」→「AI 提供商」添加一个提供商并设为默认后重试";

/// 连通性测试超时（spec `connectivity-test`：15 秒）
pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 常规 AI 调用超时（长文本生成也够用，沿用改造前的取值）
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(60);

/// 凭据引用名前缀：`agenthub-ai-<provider-id>`
pub const CREDENTIAL_PREFIX: &str = "agenthub-ai-";

const DEFAULT_OPENAI_BASE: &str = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const DEFAULT_OPENAI_MODEL: &str = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-5";

fn default_true() -> bool {
    true
}

/// 一个 AI 提供商。`key_hint` 只在返回给前端时填充（masked key），
/// 落盘前一律清空 —— settings.json 里不会出现任何形式的 key。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    /// "openai" | "anthropic"，决定请求格式与端点路径
    pub kind: String,
    /// 空 = 用厂商默认
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
    /// 凭据管理器里的引用名（`agenthub-ai-<id>`）；旧数据缺失时按 id 补
    #[serde(default)]
    pub credential_ref: String,
    /// 运行期展示字段（masked key），不持久化
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_hint: String,
}

impl AiProvider {
    /// 凭据引用名：旧数据没有该字段时按 id 推出
    pub fn credential_ref(&self) -> String {
        if self.credential_ref.trim().is_empty() {
            credential_ref_for(&self.id)
        } else {
            self.credential_ref.trim().to_string()
        }
    }
}

pub fn credential_ref_for(id: &str) -> String {
    format!("{CREDENTIAL_PREFIX}{id}")
}

// ---------------- 厂商预设 ----------------

/// 一条内置厂商预设：选中后自动填充 kind / baseUrl / 起始 model
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
}

/// 预设表（brief「内置厂商预设」表格，顺序即下拉顺序）
pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        base_url: "https://api.openai.com/v1",
        default_model: "gpt-4o",
    },
    ProviderPreset {
        id: "anthropic",
        label: "Anthropic",
        kind: "anthropic",
        base_url: "https://api.anthropic.com",
        default_model: "claude-sonnet-4-5",
    },
    ProviderPreset {
        id: "deepseek",
        label: "DeepSeek",
        kind: "openai",
        base_url: "https://api.deepseek.com",
        default_model: "deepseek-chat",
    },
    ProviderPreset {
        id: "zhipu",
        label: "智谱 GLM",
        kind: "openai",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        default_model: "glm-4-plus",
    },
    ProviderPreset {
        id: "qwen",
        label: "通义千问",
        kind: "openai",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen-max",
    },
    ProviderPreset {
        id: "kimi",
        label: "Kimi (Moonshot)",
        kind: "openai",
        base_url: "https://api.moonshot.cn/v1",
        default_model: "moonshot-v1-8k",
    },
    ProviderPreset {
        id: "minimax",
        label: "MiniMax",
        kind: "openai",
        base_url: "https://api.minimax.chat/v1",
        default_model: "abab6.5s-chat",
    },
    ProviderPreset {
        id: "openrouter",
        label: "OpenRouter",
        kind: "openai",
        base_url: "https://openrouter.ai/api/v1",
        default_model: "",
    },
    ProviderPreset {
        id: "custom",
        label: "自定义",
        kind: "openai",
        base_url: "",
        default_model: "",
    },
];

/// 预设的序列化形态（前端下拉用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
}

pub fn presets() -> Vec<PresetInfo> {
    PRESETS
        .iter()
        .map(|p| PresetInfo {
            id: p.id,
            label: p.label,
            kind: p.kind,
            base_url: p.base_url,
            default_model: p.default_model,
        })
        .collect()
}

/// 按 id 找预设（前端提交预设 id 时可用；当前只被测试使用）
#[allow(dead_code)]
pub fn find_preset(id: &str) -> Option<&'static ProviderPreset> {
    PRESETS.iter().find(|p| p.id == id.trim())
}

/// 把表单草稿叠加到已保存配置上：非空字段覆盖，key 留空则沿用已保存凭据。
/// 测试连接走这条路径 —— 用户不必先保存即可验证表单当前值。
fn merge_draft(mut p: AiProvider, draft: Option<&ProviderDraft>) -> AiProvider {
    if let Some(d) = draft {
        if !d.kind.trim().is_empty() {
            p.kind = normalize_kind(&d.kind);
        }
        if !d.base_url.trim().is_empty() {
            p.base_url = d.base_url.trim().to_string();
        }
        if !d.model.trim().is_empty() {
            p.model = d.model.trim().to_string();
        }
    }
    p
}

// ---------------- 纯逻辑：协议、端点、模型 ----------------

/// 协议归一：只允许 openai / anthropic（D1），其它值一律落到 openai。
pub fn normalize_kind(kind: &str) -> String {
    let k = kind.trim().to_ascii_lowercase();
    if k == "anthropic" || k == "claude" || k.starts_with("claude-") {
        "anthropic".into()
    } else {
        "openai".into()
    }
}

/// 该协议的厂商默认 Base URL（`baseUrl` 留空时使用，D3）
pub fn default_base_url(kind: &str) -> &'static str {
    match normalize_kind(kind).as_str() {
        "anthropic" => DEFAULT_ANTHROPIC_BASE,
        _ => DEFAULT_OPENAI_BASE,
    }
}

/// 实际请求地址：`baseUrl` 非空用它，否则回退厂商默认；末尾 `/` 去掉
pub fn effective_base_url(p: &AiProvider) -> String {
    let base = p.base_url.trim();
    let base = if base.is_empty() { default_base_url(&p.kind) } else { base };
    base.trim_end_matches('/').to_string()
}

/// 实际使用的模型名：提供商为空时按协议回退
pub fn resolve_model(p: &AiProvider) -> String {
    let m = p.model.trim();
    if !m.is_empty() {
        return m.to_string();
    }
    match normalize_kind(&p.kind).as_str() {
        "anthropic" => DEFAULT_ANTHROPIC_MODEL.to_string(),
        _ => DEFAULT_OPENAI_MODEL.to_string(),
    }
}

/// openai 协议端点：`{base}/chat/completions`
pub fn openai_endpoint(base: &str) -> String {
    format!("{}/chat/completions", base.trim_end_matches('/'))
}

/// anthropic 协议端点：`{base}/v1/messages`（base 已含 `/v1` 时不重复）
pub fn anthropic_endpoint(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

/// openai 请求体。`system` 为空时不发 system 段（与改造前形态一致）。
pub fn openai_payload(model: &str, system: &str, user: &str, max_tokens: Option<u32>) -> serde_json::Value {
    let mut messages = Vec::new();
    if !system.trim().is_empty() {
        messages.push(serde_json::json!({"role": "system", "content": system}));
    }
    messages.push(serde_json::json!({"role": "user", "content": user}));
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": 0.3,
    });
    if let Some(n) = max_tokens {
        body["max_tokens"] = serde_json::json!(n);
    }
    body
}

/// anthropic 请求体。system 放顶层 `system` 字段，不进 messages。
pub fn anthropic_payload(model: &str, system: &str, user: &str, max_tokens: u32) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": user}],
    });
    if !system.trim().is_empty() {
        body["system"] = serde_json::json!(system);
    }
    body
}

/// anthropic 固定要求的 API 版本头
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 掩码显示 key：只留首尾各 4 位
pub fn mask(key: &str) -> String {
    let k = key.trim();
    if k.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = k.chars().collect();
    if chars.len() <= 8 {
        return "•".repeat(8);
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// HTTP 状态码的可读提示
pub fn status_hint(code: u16) -> &'static str {
    match code {
        400 => "请求被拒绝（参数或模型名不正确）",
        401 => "API key 无效",
        402 => "账户余额不足",
        403 => "没有访问权限",
        404 => "接口地址或模型不存在",
        413 => "请求内容过大",
        429 => "请求过于频繁或额度已用尽",
        500..=599 => "服务端错误",
        _ => "请求失败",
    }
}

/// 统一的失败文案：含厂商名与 HTTP 状态（spec `unified-chat` 第 5 步）
pub fn http_error(provider_name: &str, code: u16, body: &str) -> String {
    let detail: String = body.trim().chars().take(200).collect();
    let hint = status_hint(code);
    if detail.is_empty() {
        format!("{provider_name} 返回 HTTP {code}（{hint}）")
    } else {
        format!("{provider_name} 返回 HTTP {code}（{hint}）：{detail}")
    }
}

// ---------------- 纯逻辑：默认提供商与迁移 ----------------

/// 保证「默认唯一」并让 `isDefault` 与 `aiDefaultProviderId` 一致
pub fn normalize_defaults(s: &mut Settings) {
    let found = s
        .ai_providers
        .iter()
        .any(|p| p.id == s.ai_default_provider_id);
    if !found {
        s.ai_default_provider_id = s
            .ai_providers
            .iter()
            .find(|p| p.enabled)
            .or_else(|| s.ai_providers.first())
            .map(|p| p.id.clone())
            .unwrap_or_default();
    }
    let default_id = s.ai_default_provider_id.clone();
    for p in &mut s.ai_providers {
        p.is_default = !default_id.is_empty() && p.id == default_id;
    }
}

/// 删除一个提供商后新的默认：剩下的第一个已启用者（没有就空）
pub fn next_default_after_remove(remaining: &[AiProvider]) -> Option<String> {
    remaining
        .iter()
        .find(|p| p.enabled)
        .or_else(|| remaining.first())
        .map(|p| p.id.clone())
}

/// 旧三字段 → 「自定义」提供商。`base_url` 为空视为无有效旧配置（不迁移）。
pub fn legacy_to_provider(id: &str, base_url: &str, api_key: &str, model: &str) -> Option<AiProvider> {
    let base = base_url.trim();
    if base.is_empty() {
        return None;
    }
    let now = now_iso();
    Some(AiProvider {
        id: id.to_string(),
        name: "自定义".into(),
        kind: "openai".into(),
        base_url: base.to_string(),
        model: model.trim().to_string(),
        enabled: true,
        is_default: true,
        created_at: now.clone(),
        updated_at: now,
        credential_ref: credential_ref_for(id),
        key_hint: mask(api_key),
    })
}

// ---------------- 纯逻辑：对 Settings 的 CRUD 变换 ----------------
// 这些函数不碰凭据管理器也不落盘，便于在临时 Settings 上验证行为；
// 带 `app` 的公开函数只是「读设置 → 调这些 → 写设置」的包装。

/// 新建提供商（只改内存中的 Settings）。第一个提供商自动成为默认。
pub fn create_in(
    s: &mut Settings,
    id: &str,
    name: &str,
    kind: &str,
    base_url: &str,
    model: &str,
) -> AiProvider {
    let now = now_iso();
    let kind = normalize_kind(kind);
    let name = {
        let n = name.trim();
        if n.is_empty() {
            format!("{kind} 提供商")
        } else {
            n.to_string()
        }
    };
    let p = AiProvider {
        credential_ref: credential_ref_for(id),
        id: id.to_string(),
        name,
        kind,
        base_url: base_url.trim().to_string(),
        model: model.trim().to_string(),
        enabled: true,
        is_default: s.ai_providers.is_empty(),
        created_at: now.clone(),
        updated_at: now,
        key_hint: String::new(),
    };
    if p.is_default {
        s.ai_default_provider_id = p.id.clone();
    }
    s.ai_providers.push(p.clone());
    normalize_defaults(s);
    p
}

/// 更新提供商（只改内存中的 Settings）。空字符串/None 表示不改该字段。
pub fn update_in(
    s: &mut Settings,
    id: &str,
    name: Option<&str>,
    kind: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<AiProvider, String> {
    let idx = s
        .ai_providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("提供商不存在：{id}"))?;
    if let Some(v) = name {
        let v = v.trim();
        if !v.is_empty() {
            s.ai_providers[idx].name = v.to_string();
        }
    }
    if let Some(v) = kind {
        s.ai_providers[idx].kind = normalize_kind(v);
    }
    if let Some(v) = base_url {
        s.ai_providers[idx].base_url = v.trim().to_string();
    }
    if let Some(v) = model {
        s.ai_providers[idx].model = v.trim().to_string();
    }
    s.ai_providers[idx].updated_at = now_iso();
    let p = s.ai_providers[idx].clone();
    normalize_defaults(s);
    Ok(p)
}

/// 删除提供商（只改内存中的 Settings），返回被删的那一条。
/// 删掉默认时自动把默认交给下一个已启用的。
pub fn delete_in(s: &mut Settings, id: &str) -> Result<AiProvider, String> {
    let idx = s
        .ai_providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("提供商不存在：{id}"))?;
    let removed = s.ai_providers.remove(idx);
    if s.ai_default_provider_id == id {
        s.ai_default_provider_id = next_default_after_remove(&s.ai_providers).unwrap_or_default();
    }
    normalize_defaults(s);
    Ok(removed)
}

/// 设为默认（只改内存中的 Settings）：清掉其他提供商的默认标记。
pub fn set_default_in(s: &mut Settings, id: &str) -> Result<(), String> {
    if !s.ai_providers.iter().any(|p| p.id == id) {
        return Err(format!("提供商不存在：{id}"));
    }
    s.ai_default_provider_id = id.to_string();
    normalize_defaults(s);
    Ok(())
}

/// 启用/停用（只改内存中的 Settings）。停用保留凭据与元信息。
pub fn set_enabled_in(s: &mut Settings, id: &str, enabled: bool) -> Result<AiProvider, String> {
    let idx = s
        .ai_providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| format!("提供商不存在：{id}"))?;
    s.ai_providers[idx].enabled = enabled;
    s.ai_providers[idx].updated_at = now_iso();
    let p = s.ai_providers[idx].clone();
    normalize_defaults(s);
    Ok(p)
}

// ---------------- 持久化 ----------------

/// 落盘前清空运行期字段并修正默认唯一性
fn prepare_for_save(s: &mut Settings) {
    normalize_defaults(s);
    for p in &mut s.ai_providers {
        p.key_hint.clear();
        if p.credential_ref.trim().is_empty() {
            p.credential_ref = credential_ref_for(&p.id);
        }
    }
}

/// 写 settings 到指定路径（AppHandle 版本只是把路径换成 `settings_path(app)`）。
/// 单独拆出来是为了能在临时目录上验证真实的落盘 → 读回链路。
fn save_to(path: &std::path::Path, s: &mut Settings) -> Result<(), String> {
    prepare_for_save(s);
    store::write_json(path, s)
}

fn load_from(path: &std::path::Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppH, s: &mut Settings) -> Result<(), String> {
    save_to(&store::settings_path(app), s)
}

/// 读出凭据并生成 masked hint（读失败时留空，不影响列表显示）
fn fill_hint(p: &mut AiProvider) {
    p.key_hint = credential::read(&p.credential_ref())
        .ok()
        .flatten()
        .map(|k| mask(&k))
        .unwrap_or_default();
}

pub fn list(app: &AppH) -> Result<Vec<AiProvider>, String> {
    // 与 get_settings 一致：首次访问时把旧三字段迁移成「自定义」提供商（幂等）
    let _ = migrate_legacy(app);
    let s = store::load_settings(app);
    let mut out = s.ai_providers.clone();
    for p in &mut out {
        fill_hint(p);
    }
    Ok(out)
}

/// 新建提供商。第一个提供商自动成为默认（spec `provider-state`）。
pub fn create(
    app: &AppH,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    api_key: String,
) -> Result<AiProvider, String> {
    let mut s = store::load_settings(app);
    let id = new_id();
    let key = api_key.trim().to_string();
    // key 先进凭据管理器：写失败就整体失败，不留半成品配置
    if !key.is_empty() {
        credential::write(&credential_ref_for(&id), &key)?;
    }
    let mut p = create_in(&mut s, &id, &name, &kind, &base_url, &model);
    save(app, &mut s)?;
    fill_hint(&mut p);
    Ok(p)
}

/// 更新提供商。`api_key` 为空/None 表示不改凭据。
#[allow(clippy::too_many_arguments)]
pub fn update(
    app: &AppH,
    id: &str,
    name: Option<String>,
    kind: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<AiProvider, String> {
    let mut s = store::load_settings(app);
    if let Some(v) = api_key {
        let v = v.trim();
        if !v.is_empty() {
            let target = s
                .ai_providers
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.credential_ref())
                .ok_or_else(|| format!("提供商不存在：{id}"))?;
            credential::write(&target, v)?;
        }
    }
    let mut p = update_in(
        &mut s,
        id,
        name.as_deref(),
        kind.as_deref(),
        base_url.as_deref(),
        model.as_deref(),
    )?;
    save(app, &mut s)?;
    fill_hint(&mut p);
    Ok(p)
}

/// 删除提供商：连凭据一起删；删掉默认时自动选下一个已启用的。
pub fn delete(app: &AppH, id: &str) -> Result<(), String> {
    let mut s = store::load_settings(app);
    let removed = delete_in(&mut s, id)?;
    // 凭据删除失败不阻塞配置清理（条目可能本来就不存在）
    let _ = credential::delete(&removed.credential_ref());
    save(app, &mut s)
}

pub fn set_default(app: &AppH, id: &str) -> Result<(), String> {
    let mut s = store::load_settings(app);
    set_default_in(&mut s, id)?;
    save(app, &mut s)
}

/// 启用/停用。停用保留凭据（spec `provider-state`）。
pub fn set_enabled(app: &AppH, id: &str, enabled: bool) -> Result<AiProvider, String> {
    let mut s = store::load_settings(app);
    let mut p = set_enabled_in(&mut s, id, enabled)?;
    save(app, &mut s)?;
    fill_hint(&mut p);
    Ok(p)
}

// ---------------- 连通性测试 ----------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    /// 技术细节（含厂商名与 HTTP 状态）；界面上的类别文案由前端按 `reason` 本地化
    pub message: String,
    pub elapsed_ms: u64,
    pub model: String,
    /// HTTP 状态码，0 = 未拿到响应
    pub status: u16,
    /// `ok` | `http` | `timeout` | `network` | `parse`
    pub reason: String,
}

impl TestResult {
    fn fail(reason: &str, message: String, status: u16, model: &str, started: Instant) -> TestResult {
        TestResult {
            ok: false,
            message,
            elapsed_ms: started.elapsed().as_millis() as u64,
            model: model.to_string(),
            status,
            reason: reason.to_string(),
        }
    }
}

/// 测试时可用表单当前值覆盖已保存配置（spec：无需先保存即可测试）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

/// 发最小请求（max_tokens 1，内容 ping）验证 key 与 baseUrl，15 秒超时。
pub fn test_connection(app: &AppH, id: &str, draft: Option<ProviderDraft>) -> Result<TestResult, String> {
    let s = store::load_settings(app);
    let stored = s.ai_providers.iter().find(|p| p.id == id).cloned();

    // 已保存配置 + 表单草稿；没有已保存记录时用草稿拼一个临时提供商（新增未保存也能测）
    let p = match stored {
        Some(p) => merge_draft(p, draft.as_ref()),
        None => match draft.as_ref() {
            Some(d) => merge_draft(
                AiProvider {
                    id: if id.trim().is_empty() { new_id() } else { id.to_string() },
                    name: "自定义".into(),
                    kind: "openai".into(),
                    base_url: String::new(),
                    model: String::new(),
                    enabled: true,
                    is_default: false,
                    created_at: now_iso(),
                    updated_at: now_iso(),
                    credential_ref: String::new(),
                    key_hint: String::new(),
                },
                Some(d),
            ),
            None => return Err(format!("提供商不存在：{id}")),
        },
    };
    // key 草稿为空时回退凭据管理器里已保存的那一条
    let key = match draft.as_ref().map(|d| d.api_key.trim().to_string()) {
        Some(k) if !k.is_empty() => k,
        _ => credential::read(&p.credential_ref()).ok().flatten().unwrap_or_default(),
    };
    let model = resolve_model(&p);
    let started = Instant::now();

    let base = effective_base_url(&p);
    let (url, body) = match normalize_kind(&p.kind).as_str() {
        "anthropic" => (
            anthropic_endpoint(&base),
            anthropic_payload(&model, "", "ping", 1),
        ),
        _ => (
            openai_endpoint(&base),
            openai_payload(&model, "", "ping", Some(1)),
        ),
    };

    let agent = ureq::AgentBuilder::new()
        .timeout(TEST_TIMEOUT)
        .user_agent("AgentHub/0.1 (AI)")
        .build();
    let mut req = agent.post(&url);
    // 本地网关可不需要 key：空 key 就不发鉴权头（与改造前的行为一致）
    if !key.is_empty() {
        req = match normalize_kind(&p.kind).as_str() {
            "anthropic" => req
                .set("x-api-key", &key)
                .set("anthropic-version", ANTHROPIC_VERSION),
            _ => req.set("Authorization", &format!("Bearer {key}")),
        };
    } else if normalize_kind(&p.kind) == "anthropic" {
        req = req.set("anthropic-version", ANTHROPIC_VERSION);
    }

    match req.send_json(body) {
        Ok(resp) => {
            let value: serde_json::Value = match resp.into_json() {
                Ok(v) => v,
                Err(e) => {
                    return Ok(TestResult::fail(
                        "parse",
                        format!("{} 响应无法解析：{e}", p.name),
                        0,
                        &model,
                        started,
                    ))
                }
            };
            let text = match normalize_kind(&p.kind).as_str() {
                "anthropic" => value
                    .pointer("/content/0/text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                _ => value
                    .pointer("/choices/0/message/content")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            };
            match text {
                Some(t) => Ok(TestResult {
                    ok: true,
                    message: t.chars().take(80).collect(),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    model,
                    status: 200,
                    reason: "ok".into(),
                }),
                None => Ok(TestResult::fail(
                    "parse",
                    format!(
                        "{} 响应格式异常：{}",
                        p.name,
                        value.to_string().chars().take(200).collect::<String>()
                    ),
                    0,
                    &model,
                    started,
                )),
            }
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Ok(TestResult::fail(
                "http",
                http_error(&p.name, code, &text),
                code,
                &model,
                started,
            ))
        }
        Err(e) => {
            let msg = e.to_string();
            let timeout = msg.to_ascii_lowercase().contains("timed out")
                || msg.to_ascii_lowercase().contains("timeout");
            Ok(TestResult::fail(
                if timeout { "timeout" } else { "network" },
                if timeout {
                    format!("{} 请求超时（{} 秒）", p.name, TEST_TIMEOUT.as_secs())
                } else {
                    format!("{} 请求失败：{msg}", p.name)
                },
                0,
                &model,
                started,
            ))
        }
    }
}

// ---------------- 默认提供商解析 ----------------

/// 桥③（AI 提供商）：云台那套「AI 提供商」是唯一一份配置。
///
/// 源侧读自己的 settings.json（`aiProviders`）与凭据管理器里的 `agenthub-ai-*`，
/// 而用户配好的那条在云台那边：模块存储的 `ai-providers`（zustand 持久化，
/// `{"state":{"providers":[…],"defaultTextId":"…"}}`）与 `NimbusDesk/AI/<id>` 凭据。
/// 源侧那套设置页并没有随四个页面一起搬进来，所以这里必须自己转译一次 ——
/// 否则技能页的「生成摘要」永远报「尚未配置 AI 提供商」。
///
/// 只读、只取云台的默认**文本**提供商（与云台 `selectProvider()` 同一条选取规则）；
/// 源侧要的只有 kind / baseUrl / model，云台侧全是 OpenAI 兼容，kind 固定 `openai`。
fn from_nimbusdesk() -> Option<(AiProvider, String)> {
    let value = crate::commands::data::read_current("ai-providers").ok().flatten()?;
    let p = nimbusdesk_provider(&value)?;
    let key = crate::commands::ai::read_secret(&p.id).ok().flatten().unwrap_or_default();
    Some((p, key))
}

/// 从云台 `ai-providers` 的持久化信封里取出默认文本提供商（纯函数，便于验证）。
pub fn nimbusdesk_provider(value: &serde_json::Value) -> Option<AiProvider> {
    let state = value.get("state")?;
    let id = state.get("defaultTextId")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let raw = state
        .get("providers")?
        .as_array()?
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))?;
    let base_url = raw.get("baseUrl").and_then(|v| v.as_str())?.trim().to_string();
    if base_url.is_empty() {
        return None;
    }
    let now = now_iso();
    Some(AiProvider {
        id,
        name: raw
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("云台 AI 提供商")
            .to_string(),
        kind: "openai".into(),
        base_url,
        model: raw.get("model").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string(),
        enabled: true,
        is_default: true,
        created_at: now.clone(),
        updated_at: now,
        // 凭据不在源侧这边：key 由 from_nimbusdesk 直接从云台凭据读出
        credential_ref: String::new(),
        key_hint: String::new(),
    })
}

/// 返回默认提供商 + 从凭据管理器读出的 key。
/// 源侧自己没配过（或没默认）时，落到桥③：用云台那一条。
/// 无默认 / 默认已停用 → Err（不静默回退到其它提供商）。
/// 空 key 不算错误（本地网关可不需要 key），由厂商以 HTTP 401 报回。
pub fn resolve_default(app: &AppH) -> Result<(AiProvider, String), String> {
    // 迁移是幂等的：只在 aiProviders 为空时生效，失败不影响后续判断
    let _ = migrate_legacy(app);
    let s = store::load_settings(app);
    let stored = s
        .ai_providers
        .iter()
        .find(|p| !s.ai_default_provider_id.trim().is_empty() && p.id == s.ai_default_provider_id)
        .or_else(|| s.ai_providers.iter().find(|p| p.is_default))
        .cloned();
    let Some(p) = stored else {
        return from_nimbusdesk().ok_or_else(|| ERR_NOT_CONFIGURED.to_string());
    };
    if !p.enabled {
        return Err(format!(
            "AI 提供商「{}」已停用：请到「设置」→「AI 提供商」启用它，或换一个默认提供商",
            p.name
        ));
    }
    let key = credential::read(&p.credential_ref())
        .map_err(|e| format!("读取「{}」的 API key 失败：{e}", p.name))?
        .unwrap_or_default();
    // 空 key 不在这里拦：本地网关 / 自建 LiteLLM 常常不需要 key，
    // 真正的鉴权失败会由厂商以 HTTP 401 报回（文案里含厂商名与状态）。
    Ok((p, key))
}

/// 默认提供商的模型名（不读凭据、不校验可用性）：供「摘要里记下用的哪个模型」这类元信息使用。
pub fn default_model_name(app: &AppH) -> Option<String> {
    let s = store::load_settings(app);
    let p = s
        .ai_providers
        .iter()
        .find(|p| !s.ai_default_provider_id.trim().is_empty() && p.id == s.ai_default_provider_id)
        .or_else(|| s.ai_providers.iter().find(|p| p.is_default))
        .cloned()
        .or_else(|| {
            // 桥③：源侧没配过时，摘要里记的模型来自云台那一条
            let value = crate::commands::data::read_current("ai-providers").ok().flatten()?;
            nimbusdesk_provider(&value)
        })?;
    Some(resolve_model(&p))
}

// ---------------- 旧字段迁移 ----------------

/// 旧三字段迁移：仅在「未迁移过」且 `aiProviders` 为空且有有效 `ai_base_url` 时
/// 创建一个「自定义」提供商并设为默认（D4）。旧字段保留在 settings.json 里但不再被读取。
///
/// 「只执行一次」靠 `ai_legacy_migrated` 标记：旧字段不删，若只看 `aiProviders` 是否为空，
/// 用户删光提供商后旧配置会被再次迁回来。
pub fn migrate_legacy(app: &AppH) -> Result<Option<AiProvider>, String> {
    let path = store::settings_path(app);
    migrate_legacy_at(&path)
}

fn migrate_legacy_at(path: &std::path::Path) -> Result<Option<AiProvider>, String> {
    let mut s = load_from(path);
    if s.ai_legacy_migrated {
        return Ok(None);
    }
    // 已有提供商（例如手动配过）就不再迁移，同时记下标记避免以后重复判断
    if !s.ai_providers.is_empty() {
        s.ai_legacy_migrated = true;
        save_to(path, &mut s)?;
        return Ok(None);
    }
    let base = s.ai_base_url.clone();
    let key = s.ai_api_key.trim().to_string();
    let model = s.ai_model.clone();
    let Some(mut p) = legacy_to_provider(&new_id(), &base, &key, &model) else {
        // 没有有效旧配置：标记已处理，避免每次加载都重复检查
        s.ai_legacy_migrated = true;
        save_to(path, &mut s)?;
        return Ok(None);
    };
    if !key.is_empty() {
        credential::write(&p.credential_ref, &key)?;
    }
    s.ai_providers.push(p.clone());
    s.ai_default_provider_id = p.id.clone();
    s.ai_legacy_migrated = true;
    // 旧字段本身保留（不删，满足 spec `legacy-migration`），但明文 key 必须清空：
    // spec A4 要求 settings.json 不含明文 key，而 key 此时已进凭据管理器。
    // 留着明文等于把一个已迁移的凭据继续暴露在配置文件里。
    s.ai_api_key.clear();
    save_to(path, &mut s)?;
    fill_hint(&mut p);
    Ok(Some(p))
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(kind: &str, base_url: &str, model: &str) -> AiProvider {
        AiProvider {
            id: "p1".into(),
            name: "测试".into(),
            kind: kind.into(),
            base_url: base_url.into(),
            model: model.into(),
            enabled: true,
            is_default: false,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            credential_ref: String::new(),
            key_hint: String::new(),
        }
    }

    // ---- 预设表 ----

    #[test]
    fn presets_cover_all_vendors() {
        let ids: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
        for want in [
            "openai",
            "anthropic",
            "deepseek",
            "zhipu",
            "qwen",
            "kimi",
            "minimax",
            "openrouter",
            "custom",
        ] {
            assert!(ids.contains(&want), "缺少厂商预设 {want}");
        }
        assert_eq!(presets().len(), PRESETS.len());
    }

    #[test]
    fn presets_only_use_two_kinds() {
        for p in PRESETS {
            assert!(
                p.kind == "openai" || p.kind == "anthropic",
                "预设 {} 的 kind 非法：{}",
                p.id,
                p.kind
            );
            assert!(!p.label.trim().is_empty(), "预设 {} 缺 label", p.id);
        }
    }

    #[test]
    fn presets_base_urls_are_absolute() {
        for p in PRESETS {
            if p.id == "custom" {
                assert!(p.base_url.is_empty(), "自定义预设的 baseUrl 必须留空");
                assert!(p.default_model.is_empty(), "自定义预设的 model 必须留空");
                continue;
            }
            assert!(
                p.base_url.starts_with("https://"),
                "预设 {} 的 baseUrl 必须是 https 绝对地址",
                p.id
            );
            assert!(!p.base_url.ends_with('/'), "预设 {} 的 baseUrl 不该带尾斜杠", p.id);
        }
    }

    #[test]
    fn openrouter_and_custom_allow_empty_model() {
        assert!(find_preset("openrouter").unwrap().default_model.is_empty());
        assert!(find_preset("custom").unwrap().default_model.is_empty());
        assert!(find_preset("nope").is_none());
    }

    // ---- kind 归一 ----

    #[test]
    fn kind_normalizes_invalid_values() {
        assert_eq!(normalize_kind("anthropic"), "anthropic");
        assert_eq!(normalize_kind("  Anthropic "), "anthropic");
        assert_eq!(normalize_kind("claude"), "anthropic");
        assert_eq!(normalize_kind("claude-sonnet"), "anthropic");
        assert_eq!(normalize_kind("openai"), "openai");
        assert_eq!(normalize_kind("azure"), "openai");
        assert_eq!(normalize_kind(""), "openai");
        assert_eq!(normalize_kind("__proto__"), "openai");
    }

    // ---- base url 回退 ----

    #[test]
    fn empty_base_url_falls_back_to_vendor_default() {
        let p = provider("openai", "", "gpt-4o");
        assert_eq!(effective_base_url(&p), "https://api.openai.com/v1");
        let a = provider("anthropic", "   ", "claude-sonnet-4-5");
        assert_eq!(effective_base_url(&a), "https://api.anthropic.com");
    }

    #[test]
    fn explicit_base_url_overrides_default() {
        let p = provider("openai", "https://gw.example.com/v1/", "gpt-4o");
        assert_eq!(effective_base_url(&p), "https://gw.example.com/v1");
    }

    #[test]
    fn endpoints_have_no_duplicate_slashes_or_v1() {
        assert_eq!(
            openai_endpoint("https://api.deepseek.com/"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_endpoint("https://gw.example.com/v1/"),
            "https://gw.example.com/v1/messages"
        );
    }

    #[test]
    fn model_falls_back_per_kind() {
        assert_eq!(resolve_model(&provider("openai", "", "")), DEFAULT_OPENAI_MODEL);
        assert_eq!(
            resolve_model(&provider("anthropic", "", "")),
            DEFAULT_ANTHROPIC_MODEL
        );
        assert_eq!(resolve_model(&provider("openai", "", " qwen-max ")), "qwen-max");
    }

    // ---- 请求体 ----

    #[test]
    fn openai_payload_shape() {
        let body = openai_payload("deepseek-chat", "你是助手", "你好", None);
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "你好");
        assert!(body.get("max_tokens").is_none(), "常规调用不带 max_tokens");
    }

    #[test]
    fn openai_payload_omits_empty_system() {
        let body = openai_payload("gpt-4o", "  ", "只发用户消息", None);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn anthropic_payload_puts_system_on_top_level() {
        let body = anthropic_payload("claude-sonnet-4-5", "你是助手", "你好", 2048);
        assert_eq!(body["system"], "你是助手");
        assert_eq!(body["max_tokens"], 2048);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn anthropic_payload_omits_empty_system() {
        let body = anthropic_payload("claude-sonnet-4-5", "", "你好", 1);
        assert!(body.get("system").is_none());
    }

    // ---- 掩码与错误文案 ----

    #[test]
    fn mask_keeps_head_and_tail_only() {
        assert_eq!(mask("sk-1234567890abcdef"), "sk-1…cdef");
        assert_eq!(mask("short"), "••••••••");
        assert_eq!(mask(""), "");
    }

    #[test]
    fn http_error_contains_vendor_and_status() {
        let msg = http_error("DeepSeek", 401, "");
        assert!(msg.contains("DeepSeek"));
        assert!(msg.contains("401"));
        assert!(msg.contains("API key 无效"));
        let msg = http_error("Kimi", 404, "model not found");
        assert!(msg.contains("Kimi") && msg.contains("404"));
        assert!(msg.contains("model not found"));
    }

    #[test]
    fn status_hints_cover_common_codes() {
        assert!(status_hint(401).contains("key"));
        assert!(status_hint(429).contains("频繁"));
        assert!(!status_hint(503).is_empty());
        assert!(!status_hint(418).is_empty());
    }

    // ---- 默认唯一 ----

    #[test]
    fn normalize_defaults_keeps_exactly_one() {
        let mut s = Settings::default();
        let mut a = provider("openai", "", "");
        a.id = "a".into();
        a.is_default = true;
        let mut b = provider("openai", "", "");
        b.id = "b".into();
        b.is_default = true;
        s.ai_providers = vec![a, b];
        s.ai_default_provider_id = "b".into();
        normalize_defaults(&mut s);
        assert_eq!(s.ai_providers.iter().filter(|p| p.is_default).count(), 1);
        assert!(s.ai_providers[1].is_default, "以 aiDefaultProviderId 为准");
    }

    #[test]
    fn normalize_defaults_promotes_first_enabled_when_missing() {
        let mut s = Settings::default();
        let mut a = provider("openai", "", "");
        a.id = "a".into();
        a.enabled = false;
        let mut b = provider("openai", "", "");
        b.id = "b".into();
        s.ai_providers = vec![a, b];
        s.ai_default_provider_id = "gone".into();
        normalize_defaults(&mut s);
        assert_eq!(s.ai_default_provider_id, "b");
        assert!(s.ai_providers[1].is_default);
    }

    // ---- 删除默认后自动选下一个 ----

    #[test]
    fn removing_default_picks_next_enabled() {
        let mut a = provider("openai", "", "");
        a.id = "a".into();
        a.enabled = false;
        let mut b = provider("openai", "", "");
        b.id = "b".into();
        let mut c = provider("openai", "", "");
        c.id = "c".into();
        assert_eq!(
            next_default_after_remove(&[a.clone(), b.clone(), c.clone()]),
            Some("b".into()),
            "优先选已启用的第一个"
        );
        assert_eq!(
            next_default_after_remove(&[a.clone()]),
            Some("a".into()),
            "全停用时退回第一个，避免没有默认"
        );
        assert_eq!(next_default_after_remove(&[]), None);
    }

    #[test]
    fn delete_default_moves_default_to_remaining() {
        let mut s = Settings::default();
        let mut a = provider("openai", "", "");
        a.id = "a".into();
        let mut b = provider("openai", "", "");
        b.id = "b".into();
        s.ai_providers = vec![a, b];
        s.ai_default_provider_id = "a".into();
        normalize_defaults(&mut s);
        // 模拟 delete 的收尾逻辑
        let removed = s.ai_providers.remove(0);
        if s.ai_default_provider_id == removed.id {
            s.ai_default_provider_id = next_default_after_remove(&s.ai_providers).unwrap_or_default();
        }
        normalize_defaults(&mut s);
        assert_eq!(s.ai_default_provider_id, "b");
        assert!(s.ai_providers[0].is_default);
    }

    // ---- 迁移 ----

    #[test]
    fn legacy_fields_become_custom_provider() {
        let p = legacy_to_provider(
            "id-1",
            " https://gw.example.com/v1 ",
            "sk-old-key",
            "gpt-4o-mini",
        )
        .expect("旧配置有效时必须能迁移");
        assert_eq!(p.name, "自定义");
        assert_eq!(p.kind, "openai");
        assert_eq!(p.base_url, "https://gw.example.com/v1");
        assert_eq!(p.model, "gpt-4o-mini");
        assert!(p.enabled);
        assert!(p.is_default);
        assert_eq!(p.credential_ref, "agenthub-ai-id-1");
        assert_eq!(p.key_hint, "sk-o…-key");
    }

    #[test]
    fn legacy_without_base_url_is_not_migrated() {
        assert!(legacy_to_provider("id-1", "", "sk-old", "gpt-4o").is_none());
        assert!(legacy_to_provider("id-1", "   ", "", "").is_none());
    }

    #[test]
    fn legacy_keeps_empty_model_as_empty() {
        let p = legacy_to_provider("id-2", "https://gw.example.com/v1", "", "").unwrap();
        assert_eq!(p.model, "");
        assert_eq!(p.key_hint, "", "没有 key 时不给 masked hint");
    }

    #[test]
    fn credential_ref_falls_back_to_id() {
        let mut p = provider("openai", "", "");
        p.id = "abc".into();
        assert_eq!(p.credential_ref(), "agenthub-ai-abc");
        p.credential_ref = "custom-ref".into();
        assert_eq!(p.credential_ref(), "custom-ref");
    }

    // ---- 测试连接的草稿覆盖 ----

    #[test]
    fn draft_overrides_only_non_empty_fields() {
        let p = provider("openai", "https://saved.example.com/v1", "saved-model");
        let merged = merge_draft(
            p.clone(),
            Some(&ProviderDraft {
                kind: "Anthropic".into(),
                base_url: "https://form.example.com/v1".into(),
                model: "form-model".into(),
                api_key: String::new(),
            }),
        );
        assert_eq!(merged.kind, "anthropic", "草稿的 kind 要归一后生效");
        assert_eq!(merged.base_url, "https://form.example.com/v1");
        assert_eq!(merged.model, "form-model");
    }

    #[test]
    fn empty_draft_keeps_saved_values() {
        let p = provider("openai", "https://saved.example.com/v1", "saved-model");
        let merged = merge_draft(
            p.clone(),
            Some(&ProviderDraft {
                kind: String::new(),
                base_url: "  ".into(),
                model: String::new(),
                api_key: String::new(),
            }),
        );
        assert_eq!(merged.kind, "openai");
        assert_eq!(merged.base_url, "https://saved.example.com/v1");
        assert_eq!(merged.model, "saved-model");
    }

    #[test]
    fn no_draft_is_a_noop() {
        let p = provider("anthropic", "https://a.example.com", "claude-x");
        let merged = merge_draft(p.clone(), None);
        assert_eq!(merged.kind, p.kind);
        assert_eq!(merged.base_url, p.base_url);
        assert_eq!(merged.model, p.model);
    }

    #[test]
    fn test_probe_is_minimal_and_timed() {
        assert_eq!(TEST_TIMEOUT.as_secs(), 15, "连通性测试必须 15 秒超时");
        let openai = openai_payload("gpt-4o", "", "ping", Some(1));
        assert_eq!(openai["max_tokens"], 1);
        assert_eq!(openai["messages"][0]["content"], "ping");
        let anthropic = anthropic_payload("claude-sonnet-4-5", "", "ping", 1);
        assert_eq!(anthropic["max_tokens"], 1);
        assert_eq!(anthropic["messages"][0]["content"], "ping");
        assert!(anthropic.get("system").is_none());
    }

    #[test]
    fn not_configured_message_points_to_settings() {
        assert!(ERR_NOT_CONFIGURED.contains("设置"));
        assert!(ERR_NOT_CONFIGURED.contains("AI 提供商"));
    }

    // ---- 桥③：把云台的提供商转译成源侧的一条 ----

    /// 云台 `ai-providers` 模块的真实持久化形态（zustand 信封）
    fn nimbusdesk_store() -> serde_json::Value {
        serde_json::json!({
            "state": {
                "defaultTextId": "e3ad",
                "defaultVisionId": null,
                "providers": [
                    { "id": "other", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
                    { "id": "e3ad", "name": "本地网关", "baseUrl": "http://127.0.0.1:7865/v1", "model": "deepseek" }
                ]
            },
            "version": 1
        })
    }

    #[test]
    fn nimbusdesk_default_provider_becomes_an_openai_provider() {
        let p = nimbusdesk_provider(&nimbusdesk_store()).expect("云台的默认提供商必须能转译");
        assert_eq!(p.base_url, "http://127.0.0.1:7865/v1");
        assert_eq!(p.model, "deepseek");
        assert_eq!(p.kind, "openai", "云台侧只有 OpenAI 兼容一种协议");
        assert!(p.enabled && p.is_default);
        assert_eq!(
            openai_endpoint(&effective_base_url(&p)),
            "http://127.0.0.1:7865/v1/chat/completions",
            "转译后的端点就是云台在用的那个"
        );
    }

    #[test]
    fn nimbusdesk_without_a_usable_default_is_none() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({ "state": {} }),
            serde_json::json!({ "state": { "defaultTextId": "", "providers": [] } }),
            serde_json::json!({ "state": { "defaultTextId": null, "providers": [] } }),
            serde_json::json!({ "state": { "defaultTextId": "gone", "providers": [{ "id": "a", "baseUrl": "http://x/v1" }] } }),
            serde_json::json!({ "state": { "defaultTextId": "a", "providers": [{ "id": "a", "baseUrl": "   " }] } }),
        ] {
            assert!(
                nimbusdesk_provider(&value).is_none(),
                "取不到默认提供商时宁可报「尚未配置」，也不猜一个：{value}"
            );
        }
    }

    // ---- CRUD（在内存 Settings 上验证真实行为） ----

    #[test]
    fn first_created_provider_becomes_default() {
        let mut s = Settings::default();
        let a = create_in(&mut s, "a", "DeepSeek", "openai", "https://api.deepseek.com", "deepseek-chat");
        assert!(a.is_default, "第一个提供商自动成为默认");
        assert_eq!(s.ai_default_provider_id, "a");
        let b = create_in(&mut s, "b", "Kimi", "openai", "", "moonshot-v1-8k");
        assert!(!b.is_default, "后来者不该抢默认");
        assert_eq!(s.ai_default_provider_id, "a");
        assert_eq!(s.ai_providers.len(), 2);
    }

    #[test]
    fn create_normalizes_kind_and_trims_fields() {
        let mut s = Settings::default();
        let p = create_in(
            &mut s,
            "a",
            "  My Claude  ",
            "Claude",
            "  https://gw.example.com/v1  ",
            "  claude-sonnet-4-5  ",
        );
        assert_eq!(p.name, "My Claude");
        assert_eq!(p.kind, "anthropic", "非法/别名 kind 归一为 anthropic");
        assert_eq!(p.base_url, "https://gw.example.com/v1");
        assert_eq!(p.model, "claude-sonnet-4-5");
        assert_eq!(p.credential_ref, "agenthub-ai-a");
        assert!(p.enabled);
    }

    #[test]
    fn create_without_name_falls_back_to_kind_name() {
        let mut s = Settings::default();
        let p = create_in(&mut s, "a", "   ", "anthropic", "", "");
        assert_eq!(p.name, "anthropic 提供商");
    }

    #[test]
    fn update_only_touches_given_fields() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "旧名", "openai", "https://old.example.com/v1", "old-model");
        let p = update_in(&mut s, "a", Some("新名"), None, None, Some("new-model")).unwrap();
        assert_eq!(p.name, "新名");
        assert_eq!(p.model, "new-model");
        assert_eq!(p.base_url, "https://old.example.com/v1", "未传的字段保持不变");
        assert_eq!(p.kind, "openai");
    }

    #[test]
    fn update_ignores_empty_name_and_trims_base_url() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "保留名", "openai", "", "");
        let p = update_in(&mut s, "a", Some("   "), None, Some("  https://gw/v1  "), None).unwrap();
        assert_eq!(p.name, "保留名", "空名称不该把名字清掉");
        assert_eq!(p.base_url, "https://gw/v1");
    }

    #[test]
    fn update_missing_provider_is_an_error() {
        let mut s = Settings::default();
        let e = update_in(&mut s, "nope", Some("x"), None, None, None).unwrap_err();
        assert!(e.contains("不存在"));
        assert!(delete_in(&mut s, "nope").is_err());
        assert!(set_default_in(&mut s, "nope").is_err());
        assert!(set_enabled_in(&mut s, "nope", false).is_err());
    }

    #[test]
    fn set_default_clears_previous_default() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "", "");
        create_in(&mut s, "b", "B", "openai", "", "");
        set_default_in(&mut s, "b").unwrap();
        assert_eq!(s.ai_default_provider_id, "b");
        assert_eq!(s.ai_providers.iter().filter(|p| p.is_default).count(), 1);
        assert!(!s.ai_providers[0].is_default, "A 的默认标记必须被清除");
        assert!(s.ai_providers[1].is_default);
    }

    #[test]
    fn disabling_default_keeps_credential_and_metadata() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "https://gw/v1", "m");
        let p = set_enabled_in(&mut s, "a", false).unwrap();
        assert!(!p.enabled);
        assert_eq!(p.credential_ref, "agenthub-ai-a", "停用保留凭据引用");
        assert_eq!(p.base_url, "https://gw/v1", "停用保留元信息");
        assert_eq!(s.ai_default_provider_id, "a", "停用不改默认指向（由调用处报不可用）");
        let p = set_enabled_in(&mut s, "a", true).unwrap();
        assert!(p.enabled);
    }

    #[test]
    fn delete_removes_and_reassigns_default() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "", "");
        create_in(&mut s, "b", "B", "openai", "", "");
        set_default_in(&mut s, "a").unwrap();
        let removed = delete_in(&mut s, "a").unwrap();
        assert_eq!(removed.id, "a");
        assert_eq!(removed.credential_ref, "agenthub-ai-a", "调用方据此删凭据");
        assert_eq!(s.ai_providers.len(), 1);
        assert_eq!(s.ai_default_provider_id, "b", "删默认后自动选下一个");
        assert!(s.ai_providers[0].is_default);
    }

    #[test]
    fn delete_last_provider_leaves_no_default() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "", "");
        delete_in(&mut s, "a").unwrap();
        assert!(s.ai_providers.is_empty());
        assert_eq!(s.ai_default_provider_id, "", "没有提供商时默认 id 为空");
    }

    #[test]
    fn deleting_non_default_keeps_default() {
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "", "");
        create_in(&mut s, "b", "B", "openai", "", "");
        delete_in(&mut s, "b").unwrap();
        assert_eq!(s.ai_default_provider_id, "a");
    }

    #[test]
    fn legacy_settings_migrate_once_only() {
        let mut s = Settings {
            ai_base_url: "https://gw.example.com/v1".into(),
            ai_api_key: "sk-old".into(),
            ai_model: "gpt-4o-mini".into(),
            ..Default::default()
        };
        // 首次：aiProviders 为空 → 迁移
        assert!(s.ai_providers.is_empty());
        let p = legacy_to_provider("id-1", &s.ai_base_url, &s.ai_api_key, &s.ai_model).unwrap();
        s.ai_providers.push(p);
        s.ai_default_provider_id = "id-1".into();
        normalize_defaults(&mut s);
        assert_eq!(s.ai_providers.len(), 1);
        // 再次：已有提供商 → 不再迁移（迁移函数以 ai_providers 非空为门槛）
        assert!(!s.ai_providers.is_empty(), "第二次不该再建一个");
        assert_eq!(s.ai_default_provider_id, "id-1");
        // 旧字段仍在（不删），但调用层不再读取它们
        assert_eq!(s.ai_base_url, "https://gw.example.com/v1");
        assert_eq!(s.ai_api_key, "sk-old");
    }

    #[test]
    fn legacy_migration_runs_only_once_even_after_deleting_all() {
        // 旧字段按 spec 保留不删：只看 aiProviders 是否为空会导致删光后再次迁移，
        // 所以必须靠 aiLegacyMigrated 标记。这里验证标记与状态的组合语义。
        let mut s = Settings {
            ai_base_url: "https://gw.example.com/v1".into(),
            ai_api_key: "sk-old".into(),
            ai_model: "gpt-4o-mini".into(),
            ..Default::default()
        };
        assert!(!s.ai_legacy_migrated, "初始未迁移");
        let p = legacy_to_provider("id-1", &s.ai_base_url, &s.ai_api_key, &s.ai_model).unwrap();
        s.ai_providers.push(p);
        s.ai_default_provider_id = "id-1".into();
        s.ai_legacy_migrated = true;
        normalize_defaults(&mut s);

        // 用户删光所有提供商：旧字段仍在
        delete_in(&mut s, "id-1").unwrap();
        assert!(s.ai_providers.is_empty());
        assert_eq!(s.ai_base_url, "https://gw.example.com/v1", "旧字段保留");
        assert!(s.ai_legacy_migrated, "标记保留 → 不会再次迁移");
    }

    #[test]
    fn legacy_migration_flag_serializes() {        let mut s = Settings::default();
        assert!(!s.ai_legacy_migrated);
        s.ai_legacy_migrated = true;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"aiLegacyMigrated\":true"));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(back.ai_legacy_migrated);
    }

    #[test]
    fn saved_provider_carries_no_key_material() {
        // 落盘前 save() 会清掉 key_hint，并把 credentialRef 补齐
        let mut s = Settings::default();
        create_in(&mut s, "a", "A", "openai", "", "");
        s.ai_providers[0].key_hint = "sk-1…cdef".into();
        s.ai_providers[0].credential_ref.clear();
        for p in &mut s.ai_providers {
            p.key_hint.clear();
            if p.credential_ref.trim().is_empty() {
                p.credential_ref = credential_ref_for(&p.id);
            }
        }
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"aiProviders\""));
        assert!(json.contains("\"aiDefaultProviderId\""));
        assert!(json.contains("\"credentialRef\":\"agenthub-ai-a\""));
        assert!(!json.contains("sk-"), "提供商条目不该含任何 key 片段：{json}");
        assert!(!json.contains("keyHint"), "keyHint 是运行期字段，不落盘");
        assert!(!json.contains("\"apiKey\""), "不存在明文 apiKey 字段");
    }

    #[test]
    fn settings_without_new_fields_loads_as_no_provider() {
        // 旧 settings.json：既无 aiProviders 也无 aiDefaultProviderId
        let json = r#"{"dataDir":"","envRoot":"","language":"zh","theme":"dark",
            "skillSourceDirs":[],"harnessOrder":[],"aiBaseUrl":"","aiApiKey":"",
            "aiModel":"","autoSummaryOnImport":false}"#;
        let s: Settings = serde_json::from_str(json).expect("缺新字段必须能正常反序列化");
        assert!(s.ai_providers.is_empty());
        assert_eq!(s.ai_default_provider_id, "");
        assert!(!s.ai_legacy_migrated);
    }

    // ---- 真实落盘 + 真实凭据管理器（临时目录，测完清理） ----

    /// 临时凭据的清理守卫：断言失败（panic）时也会删掉，不在系统里留垃圾条目
    struct CredGuard(String);

    impl CredGuard {
        fn new(target: &str) -> Self {
            CredGuard(target.to_string())
        }
    }

    impl Drop for CredGuard {
        fn drop(&mut self) {
            let _ = credential::delete(&self.0);
        }
    }

    fn tmp_settings_path(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-aiprovider-{tag}-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join("settings.json")
    }

    #[test]
    fn disk_roundtrip_keeps_providers_and_no_plaintext_key() {
        let path = tmp_settings_path("roundtrip");
        let id = format!("test-{}", new_id());
        let target = credential_ref_for(&id);
        let _guard = CredGuard::new(&target);
        credential::write(&target, "sk-e2e-secret-key").unwrap();

        // 第一次写：一个提供商，默认
        let mut s = Settings::default();
        create_in(&mut s, &id, "E2E", "openai", "https://gw.example.com/v1", "m1");
        s.ai_providers[0].credential_ref = target.clone();
        save_to(&path, &mut s).unwrap();

        // 落盘文件里不含明文 key
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("sk-e2e-secret-key"), "settings.json 不得含明文 key");
        assert!(raw.contains(&target), "应只留 credentialRef");

        // 读回：提供商、默认标记、credentialRef 都在
        let back = load_from(&path);
        assert_eq!(back.ai_providers.len(), 1);
        assert_eq!(back.ai_providers[0].id, id);
        assert_eq!(back.ai_providers[0].credential_ref, target);
        assert_eq!(back.ai_default_provider_id, id);
        assert!(back.ai_providers[0].is_default);
        assert!(back.ai_providers[0].key_hint.is_empty(), "keyHint 不落盘");

        // 凭据仍能读回
        assert_eq!(
            credential::read(&target).unwrap().as_deref(),
            Some("sk-e2e-secret-key")
        );

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn disk_roundtrip_delete_removes_credential() {
        let path = tmp_settings_path("delete");
        let id = format!("test-{}", new_id());
        let target = credential_ref_for(&id);
        let _guard = CredGuard::new(&target);
        credential::write(&target, "sk-to-be-deleted").unwrap();

        let mut s = Settings::default();
        create_in(&mut s, &id, "E2E", "openai", "", "m1");
        s.ai_providers[0].credential_ref = target.clone();
        save_to(&path, &mut s).unwrap();

        // 模拟 delete：先删凭据，再落盘
        let mut s = load_from(&path);
        let removed = delete_in(&mut s, &id).unwrap();
        credential::delete(&removed.credential_ref()).unwrap();
        save_to(&path, &mut s).unwrap();

        assert_eq!(credential::read(&target).unwrap(), None, "凭据必须被删掉");
        let back = load_from(&path);
        assert!(back.ai_providers.is_empty());
        assert_eq!(back.ai_default_provider_id, "");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn disk_migration_from_legacy_settings_creates_custom_provider() {
        let path = tmp_settings_path("migrate");
        // 旧 settings.json：只有旧三字段
        let legacy = Settings {
            ai_base_url: "https://legacy.example.com/v1".into(),
            ai_api_key: "sk-legacy-key".into(),
            ai_model: "legacy-model".into(),
            ..Default::default()
        };
        store::write_json(&path, &legacy).unwrap();

        let created = migrate_legacy_at(&path).unwrap().expect("旧配置必须被迁移");
        let _guard = CredGuard::new(&created.credential_ref);
        assert_eq!(created.name, "自定义");
        assert_eq!(created.base_url, "https://legacy.example.com/v1");
        assert_eq!(created.model, "legacy-model");
        assert!(created.is_default);

        // key 进了凭据管理器，且能读回
        assert_eq!(
            credential::read(&created.credential_ref).unwrap().as_deref(),
            Some("sk-legacy-key")
        );
        // 落盘文件：有提供商、无明文 key、旧字段保留（值已清空）
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"aiProviders\""));
        assert!(!raw.contains("sk-legacy-key"), "迁移后 settings.json 不该有明文 key");
        assert!(raw.contains("legacy.example.com"), "旧字段按 spec 保留");
        assert!(raw.contains("\"aiApiKey\": \"\""), "旧 key 字段保留但清空");

        // 第二次迁移：不再创建
        assert!(migrate_legacy_at(&path).unwrap().is_none(), "迁移只能执行一次");

        // 删光提供商后，旧字段仍在但不会再被迁回来
        let mut s = load_from(&path);
        let removed = delete_in(&mut s, &created.id).unwrap();
        save_to(&path, &mut s).unwrap();
        assert_eq!(
            credential::read(&removed.credential_ref).unwrap().as_deref(),
            Some("sk-legacy-key"),
            "删配置不该自动删凭据（凭据由 delete 命令负责）"
        );
        credential::delete(&removed.credential_ref).unwrap();
        assert!(migrate_legacy_at(&path).unwrap().is_none(), "删光后不该再次迁移");
        assert!(load_from(&path).ai_providers.is_empty());

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn disk_migration_skipped_when_providers_exist() {
        let path = tmp_settings_path("skip");
        let mut s = Settings {
            ai_base_url: "https://legacy.example.com/v1".into(),
            ai_api_key: "sk-legacy".into(),
            ..Default::default()
        };
        create_in(&mut s, "existing", "已有", "openai", "", "m");
        store::write_json(&path, &s).unwrap();

        assert!(migrate_legacy_at(&path).unwrap().is_none(), "已有提供商时不迁移");
        let back = load_from(&path);
        assert_eq!(back.ai_providers.len(), 1);
        assert_eq!(back.ai_providers[0].id, "existing");
        assert!(back.ai_legacy_migrated, "应记下已处理标记");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn disk_migration_without_base_url_marks_done() {
        let path = tmp_settings_path("nobase");
        store::write_json(&path, &Settings::default()).unwrap();
        assert!(migrate_legacy_at(&path).unwrap().is_none());
        let back = load_from(&path);
        assert!(back.ai_legacy_migrated, "无有效旧配置也要记标记，避免每次重复检查");
        assert!(back.ai_providers.is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
