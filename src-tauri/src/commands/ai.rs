//! Native OpenAI-compatible requests and Windows credential storage.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

static LEGACY_MIGRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    id: String,
    base_url: String,
    model: String,
    vision: bool,
    #[serde(default)]
    parameters: Option<ModelParameters>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelParameters {
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<u32>,
    token_limit_field: Option<String>,
    reasoning_effort: Option<String>,
}

impl ModelParameters {
    fn validate(&self) -> Result<(), String> {
        if self
            .temperature
            .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
            || self
                .top_p
                .is_some_and(|value| !value.is_finite() || value <= 0.0 || value > 1.0)
            || self
                .max_tokens
                .is_some_and(|value| !(1..=2_000_000).contains(&value))
            || self
                .token_limit_field
                .as_deref()
                .is_some_and(|value| !matches!(value, "max_tokens" | "max_completion_tokens"))
            || self.reasoning_effort.as_deref().is_some_and(|value| {
                !matches!(
                    value,
                    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
            })
        {
            return Err("AI_INVALID_PARAMETERS".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatInput {
    provider: Provider,
    messages: Vec<Value>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default = "default_true")]
    use_stored_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsInput {
    id: String,
    base_url: String,
    key: Option<String>,
    #[serde(default = "default_true")]
    use_stored_key: bool,
}

fn default_true() -> bool {
    true
}

fn validate_key(key: Option<&str>) -> Result<(), String> {
    if key.is_some_and(|key| key.len() > 2560 || key.contains(['\r', '\n', '\0'])) {
        return Err("AI_INVALID_KEY".into());
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("AI_INVALID_PROVIDER".into());
    }
    Ok(())
}

fn endpoint_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| "AI_INVALID_URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("AI_INVALID_URL".into());
    }
    let path = format!("{}/{}", url.path().trim_end_matches('/'), endpoint);
    url.set_path(&path);
    Ok(url)
}

fn validate_input(input: &ChatInput) -> Result<reqwest::Url, String> {
    validate_id(&input.provider.id)?;
    if let Some(parameters) = &input.provider.parameters {
        parameters.validate()?;
    }
    validate_key(input.key.as_deref())?;
    let url = endpoint_url(&input.provider.base_url, "chat/completions")?;
    if input.provider.model.trim().is_empty()
        || input.messages.is_empty()
        || input.messages.len() > 200
    {
        return Err("AI_INVALID_MESSAGES".into());
    }
    for message in &input.messages {
        if !matches!(
            message["role"].as_str(),
            Some("system" | "user" | "assistant")
        ) {
            return Err("AI_INVALID_MESSAGES".into());
        }
        match &message["content"] {
            Value::String(_) => {}
            Value::Array(parts) if !parts.is_empty() => {
                for part in parts {
                    match part["type"].as_str() {
                        Some("text") if part["text"].is_string() => {}
                        Some("image_url") => {
                            if !input.provider.vision {
                                return Err("AI_PROVIDER_NO_VISION".into());
                            }
                            let image = part["image_url"]["url"]
                                .as_str()
                                .ok_or("AI_INVALID_IMAGE")?;
                            let (header, data) = image.split_once(',').ok_or("AI_INVALID_IMAGE")?;
                            if !matches!(
                                header,
                                "data:image/png;base64"
                                    | "data:image/jpeg;base64"
                                    | "data:image/gif;base64"
                                    | "data:image/webp;base64"
                            ) || data.is_empty()
                                || data.len() > 20 * 1024 * 1024
                                || base64::engine::general_purpose::STANDARD
                                    .decode(data)
                                    .is_err()
                            {
                                return Err("AI_INVALID_IMAGE".into());
                            }
                        }
                        _ => return Err("AI_INVALID_MESSAGES".into()),
                    }
                }
            }
            _ => return Err("AI_INVALID_MESSAGES".into()),
        }
    }
    Ok(url)
}

fn request_models(base_url: &str, secret: Option<String>) -> Result<Vec<String>, String> {
    let url = endpoint_url(base_url, "models")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "AI_NETWORK_ERROR")?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(key) = secret.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().map_err(|_| "AI_NETWORK_ERROR")?;
    if !response.status().is_success() {
        return Err(format!("AI_HTTP_{}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "AI_RESPONSE_ERROR")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("AI_RESPONSE_TOO_LARGE".into());
    }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| "AI_RESPONSE_ERROR")?;
    let data = response["data"].as_array().ok_or("AI_RESPONSE_ERROR")?;
    let models: std::collections::BTreeSet<String> = data
        .iter()
        .filter_map(|model| model["id"].as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
        .map(str::to_string)
        .collect();
    if models.is_empty() {
        return Err("AI_MODELS_EMPTY".into());
    }
    Ok(models.into_iter().collect())
}

fn request_chat(input: ChatInput, secret: Option<String>) -> Result<String, String> {
    let url = validate_input(&input)?;
    let mut body = serde_json::json!({ "model": input.provider.model, "messages": input.messages, "stream": false });
    if let Some(parameters) = input.provider.parameters {
        if let Some(value) = parameters.temperature {
            body["temperature"] = value.into();
        }
        if let Some(value) = parameters.top_p {
            body["top_p"] = value.into();
        }
        if let Some(value) = parameters.max_tokens {
            body[parameters
                .token_limit_field
                .as_deref()
                .unwrap_or("max_tokens")] = value.into();
        }
        if let Some(value) = parameters.reasoning_effort {
            body["reasoning_effort"] = value.into();
        }
    }
    let body = serde_json::to_vec(&body).map_err(|_| "AI_INVALID_MESSAGES")?;
    if body.len() > 32 * 1024 * 1024 {
        return Err("AI_REQUEST_TOO_LARGE".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        // Credentials must never follow a service redirect to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "AI_NETWORK_ERROR")?;
    let mut request = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(key) = secret.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request.send().map_err(|_| "AI_NETWORK_ERROR")?;
    if !response.status().is_success() {
        return Err(format!("AI_HTTP_{}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "AI_RESPONSE_ERROR")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("AI_RESPONSE_TOO_LARGE".into());
    }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| "AI_RESPONSE_ERROR")?;
    let content = &response["choices"][0]["message"]["content"];
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else if let Some(parts) = content.as_array() {
        parts
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<String>()
    } else {
        return Err("AI_RESPONSE_ERROR".into());
    };
    if text.trim().is_empty() {
        return Err("AI_EMPTY_RESPONSE".into());
    }
    Ok(text)
}

#[cfg(windows)]
mod credentials {
    use windows::Win32::Security::Credentials::{
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
        CredDeleteW, CredFree, CredReadW, CredWriteW,
    };
    use windows::core::{PCWSTR, PWSTR};

    fn target(id: &str) -> Vec<u16> {
        format!("NimbusDesk/AI/{id}\0").encode_utf16().collect()
    }

    pub fn read(id: &str) -> Result<Option<String>, String> {
        let target = target(id);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            if let Err(error) = CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            ) {
                return if error.code().0 as u32 == 0x80070490 {
                    Ok(None)
                } else {
                    Err("AI_CREDENTIAL_READ_FAILED".into())
                };
            }
            let data = &*credential;
            let result = if data.CredentialBlobSize == 0 {
                Ok(None)
            } else {
                String::from_utf8(
                    std::slice::from_raw_parts(
                        data.CredentialBlob,
                        data.CredentialBlobSize as usize,
                    )
                    .to_vec(),
                )
                .map(Some)
                .map_err(|_| "AI_CREDENTIAL_READ_FAILED".into())
            };
            CredFree(credential.cast());
            result
        }
    }

    pub fn save(id: &str, key: &str) -> Result<(), String> {
        if key.is_empty()
            || key.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize
            || key.contains(['\r', '\n', '\0'])
        {
            return Err("AI_INVALID_KEY".into());
        }
        let mut target = target(id);
        let mut bytes = key.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        let result =
            unsafe { CredWriteW(&credential, 0) }.map_err(|_| "AI_CREDENTIAL_WRITE_FAILED".into());
        bytes.fill(0);
        result
    }

    pub fn delete(id: &str) -> Result<(), String> {
        let target = target(id);
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code().0 as u32 == 0x80070490 => Ok(()),
            Err(_) => Err("AI_CREDENTIAL_DELETE_FAILED".into()),
        }
    }
}

#[cfg(not(windows))]
mod credentials {
    pub fn read(_id: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn save(_id: &str, _key: &str) -> Result<(), String> {
        Err("AI_CREDENTIAL_UNSUPPORTED".into())
    }
    pub fn delete(_id: &str) -> Result<(), String> {
        Err("AI_CREDENTIAL_UNSUPPORTED".into())
    }
}

#[tauri::command]
pub async fn ai_save_secret(id: String, key: String) -> Result<(), String> {
    validate_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || credentials::save(&id, &key))
        .await
        .map_err(|_| "AI_TASK_FAILED")?
}

#[tauri::command]
pub async fn ai_has_secret(id: String) -> Result<bool, String> {
    validate_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || credentials::read(&id).map(|key| key.is_some()))
        .await
        .map_err(|_| "AI_TASK_FAILED")?
}

#[tauri::command]
pub async fn ai_delete_secret(id: String) -> Result<(), String> {
    validate_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || credentials::delete(&id))
        .await
        .map_err(|_| "AI_TASK_FAILED")?
}

#[tauri::command]
pub async fn ai_chat(input: ChatInput) -> Result<String, String> {
    validate_input(&input)?;
    tauri::async_runtime::spawn_blocking(move || {
        let secret = match input.key.as_ref().filter(|key| !key.is_empty()) {
            Some(key) => Some(key.clone()),
            None if input.use_stored_key => credentials::read(&input.provider.id)?,
            None => None,
        };
        request_chat(input, secret)
    })
    .await
    .map_err(|_| "AI_TASK_FAILED")?
}

#[tauri::command]
pub async fn ai_models(input: ModelsInput) -> Result<Vec<String>, String> {
    validate_id(&input.id)?;
    endpoint_url(&input.base_url, "models")?;
    validate_key(input.key.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let secret = match input.key.filter(|key| !key.is_empty()) {
            Some(key) => Some(key),
            None if input.use_stored_key => credentials::read(&input.id)?,
            None => None,
        };
        request_models(&input.base_url, secret)
    })
    .await
    .map_err(|_| "AI_TASK_FAILED")?
}

fn scrub_legacy_key(value: &mut Value) -> Result<(), String> {
    if let Some(fields) = value.as_object_mut() {
        if fields.contains_key("llmApiKey") {
            fields.insert("llmApiKey".into(), Value::String(String::new()));
        }
    }
    let state = if value.get("state").is_some() {
        &mut value["state"]
    } else {
        value
    };
    let fields = state.as_object_mut().ok_or("AI_MIGRATION_INVALID_CONFIG")?;
    fields.insert("llmApiKey".into(), Value::String(String::new()));
    Ok(())
}

/// Stage clean replacements without the ordinary writer's plaintext .bak rotation.
/// Backups commit first and the primary commits last, retaining a recoverable original on failure.
fn finalize_legacy_files(dir: &std::path::Path, secret: Option<&str>) -> Result<(), String> {
    use std::fs;
    use std::io::Write;

    let _guard = LEGACY_MIGRATION_LOCK
        .lock()
        .map_err(|_| "AI_MIGRATION_CONFLICT")?;

    let primary = dir.join("ai-settings.json");
    let original = fs::read(&primary)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                fs::read(dir.join("ai-settings.json.bak"))
            } else {
                Err(error)
            }
        })
        .map_err(|_| "AI_MIGRATION_READ_FAILED")?;
    let mut value: Value =
        serde_json::from_slice(&original).map_err(|_| "AI_MIGRATION_INVALID_CONFIG")?;
    let fields = value.get("state").unwrap_or(&value);
    let old_key = fields
        .get("llmApiKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !old_key.is_empty() && Some(old_key) != secret {
        return Err("AI_MIGRATION_CREDENTIAL_MISMATCH".into());
    }
    scrub_legacy_key(&mut value)?;
    let clean_primary =
        serde_json::to_vec_pretty(&value).map_err(|_| "AI_MIGRATION_INVALID_CONFIG")?;

    let mut replacements = Vec::new();
    for name in [
        "ai-settings.json.bak",
        "ai-settings.json.tmp",
        "ai-settings.json.bak.bak",
        "ai-settings.json",
    ] {
        let target = dir.join(name);
        let bytes = match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if !meta.file_type().is_file() {
                    return Err("AI_MIGRATION_WRITE_FAILED".into());
                }
                let current = fs::read(&target).map_err(|_| "AI_MIGRATION_READ_FAILED")?;
                let mut backup: Value =
                    serde_json::from_slice(&current).unwrap_or_else(|_| value.clone());
                if scrub_legacy_key(&mut backup).is_err() {
                    backup = value.clone();
                }
                serde_json::to_vec_pretty(&backup).map_err(|_| "AI_MIGRATION_INVALID_CONFIG")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if target != primary {
                    continue;
                }
                clean_primary.clone()
            }
            Err(_) => return Err("AI_MIGRATION_READ_FAILED".into()),
        };
        replacements.push((target, bytes));
    }

    // Stage all writes before replacing any existing file. Temporary files contain only sanitized data.
    let mut staged = Vec::new();
    let result = (|| -> Result<(), String> {
        for (target, bytes) in &replacements {
            let temp = target.with_file_name(format!(
                "{}.secure-migration.tmp",
                target.file_name().unwrap().to_string_lossy()
            ));
            if let Ok(meta) = fs::symlink_metadata(&temp) {
                if !meta.file_type().is_file() {
                    return Err("AI_MIGRATION_WRITE_FAILED".into());
                }
                // A previous interrupted migration can leave only sanitized staging bytes here.
                fs::remove_file(&temp).map_err(|_| "AI_MIGRATION_WRITE_FAILED")?;
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|_| "AI_MIGRATION_WRITE_FAILED")?;
            staged.push((temp.clone(), target.clone()));
            file.write_all(bytes)
                .map_err(|_| "AI_MIGRATION_WRITE_FAILED")?;
            file.sync_all().map_err(|_| "AI_MIGRATION_WRITE_FAILED")?;
        }
        for (temp, target) in &staged {
            if *target == primary {
                // Detect another window/editor changing the primary while replacements were prepared.
                if let Ok(current) = fs::read(&primary) {
                    if current != original {
                        return Err("AI_MIGRATION_CONFLICT".into());
                    }
                }
            }
            fs::rename(temp, target).map_err(|_| "AI_MIGRATION_WRITE_FAILED")?;
        }
        Ok(())
    })();
    for (temp, _) in &staged {
        let _ = fs::remove_file(temp);
    }
    result
}

#[tauri::command]
pub async fn ai_finalize_legacy_migration(id: String) -> Result<(), String> {
    validate_id(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let secret = credentials::read(&id)?;
        let dir = super::data::resolve_data_dir().map_err(|_| "AI_MIGRATION_READ_FAILED")?;
        finalize_legacy_files(&dir, secret.as_deref())
    })
    .await
    .map_err(|_| "AI_TASK_FAILED")?
}

/* ── 带密钥的流式转发（AI 面板的 fetch 接缝）────────────────────────

   渲染进程拿不到凭据（凭据只在 Rust 侧），而 WebView 直连过不了 CORS
   （origin 是 tauri.localhost，服务商不返回 CORS 头）。于是由这一个命令
   把「注入密钥 + 绕 CORS + 流式回传」一次做完；上层（AI SDK 的 provider
   与工具循环）只看到一个普通的 fetch，不感知 Rust。                      */

/// 单个流的总字节上限。
const FETCH_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 行数上限：防止「极短行 + 永不停」把内存吃光。
const FETCH_MAX_LINES: usize = 400_000;
const FETCH_MAX_HEADERS: usize = 32;
const FETCH_MAX_HEADER_VALUE: usize = 8 * 1024;
const FETCH_MAX_BODY: usize = 32 * 1024 * 1024;

/// 这些请求头由本命令决定，前端传来的同名头一律丢弃（尤其是 Authorization——
/// 否则前端就能用它把用户凭据带去打别的接口）。
const DROPPED_REQUEST_HEADERS: [&str; 8] = [
    "host",
    "authorization",
    "content-length",
    "connection",
    "transfer-encoding",
    "content-encoding",
    "accept-encoding",
    "cookie",
];
/// 这些响应头不能回传：按行重切后 content-length 已不成立，压缩已由 reqwest 处理。
const DROPPED_RESPONSE_HEADERS: [&str; 5] = [
    "content-length",
    "transfer-encoding",
    "connection",
    "content-encoding",
    "keep-alive",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FetchInput {
    provider_id: String,
    base_url: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Option<String>,
}

impl FetchInput {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.method.as_str(), "GET" | "POST") {
            return Err("AI_INVALID_METHOD".into());
        }
        if self.headers.len() > FETCH_MAX_HEADERS
            || self.headers.iter().any(|(name, value)| {
                name.is_empty()
                    || name.len() > 128
                    || name.contains(['\r', '\n', ':'])
                    || value.len() > FETCH_MAX_HEADER_VALUE
                    || value.contains(['\r', '\n'])
            })
        {
            return Err("AI_INVALID_HEADERS".into());
        }
        if self
            .body
            .as_ref()
            .is_some_and(|body| body.len() > FETCH_MAX_BODY)
        {
            return Err("AI_REQUEST_TOO_LARGE".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FetchEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        text: String,
    },
    End,
    Err {
        message: String,
    },
}

/// 取一个 URL 的「来源」（scheme + host + 有效端口），顺带拒掉非 http(s)。
fn origin_of(url: &reqwest::Url) -> Result<(String, String, u16), String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("AI_INVALID_URL".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let port = url.port_or_known_default().ok_or("AI_INVALID_URL")?;
    Ok((url.scheme().to_string(), host, port))
}

/// `ai_fetch` 会按 providerId 注入真实密钥，所以目标地址必须与服务商 baseUrl
/// 同源 —— 否则这个命令就是一把「拿着用户 Key 打任意地址」的跳板。
fn validate_same_origin(base_url: &str, target: &str) -> Result<reqwest::Url, String> {
    let base = reqwest::Url::parse(base_url.trim()).map_err(|_| "AI_INVALID_URL")?;
    let url = reqwest::Url::parse(target.trim()).map_err(|_| "AI_INVALID_URL")?;
    if origin_of(&url)? != origin_of(&base)? {
        return Err("AI_ORIGIN_MISMATCH".into());
    }
    Ok(url)
}

/// 按完整 `\n` 行切分字节流：跨 chunk 的多字节字符留在残余缓冲里，不会被劈成两半。
#[derive(Default)]
struct LineChunker {
    residue: Vec<u8>,
    lines: usize,
    bytes: usize,
}

impl LineChunker {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.bytes += chunk.len();
        if self.bytes > FETCH_MAX_BYTES {
            return Err("AI_RESPONSE_TOO_LARGE".into());
        }
        self.residue.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(end) = self.residue.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.residue.drain(..=end).collect();
            self.lines += 1;
            if self.lines > FETCH_MAX_LINES {
                return Err("AI_RESPONSE_TOO_LARGE".into());
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        Ok(lines)
    }

    /// 收尾：没有以 `\n` 结尾的尾巴也要发出去，否则最后一行会丢。
    fn flush(&mut self) -> Option<String> {
        (!self.residue.is_empty())
            .then(|| String::from_utf8_lossy(&std::mem::take(&mut self.residue)).into_owned())
    }
}

fn stream_fetch(
    input: &FetchInput,
    url: reqwest::Url,
    secret: Option<String>,
    cancelled: Arc<AtomicBool>,
    emit: &mut dyn FnMut(FetchEvent) -> bool,
) {
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        /*
         * 刻意不设整请求 timeout：request_chat 那个 90s 会连读 body 一起管，
         * 长流会被拦腰砍断。读空闲超时交给前端看门狗。
         */
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            emit(FetchEvent::Err {
                message: "AI_NETWORK_ERROR".into(),
            });
            return;
        }
    };
    let mut request = if input.method == "GET" {
        client.get(url)
    } else {
        client.post(url)
    };
    for (name, value) in &input.headers {
        if DROPPED_REQUEST_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        request = request.header(name, value);
    }
    // 带 body 却不声明类型时补上（与 request_chat 一致），否则服务商多半直接 415。
    if input.body.is_some()
        && !input
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
    }
    // 流式不要内容编码：reqwest 带着 gzip 特性，服务端一压缩 SSE 就会攒成一坨。
    request = request.header(reqwest::header::ACCEPT_ENCODING, "identity");
    if let Some(key) = secret.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    if let Some(body) = &input.body {
        request = request.body(body.clone());
    }
    let mut response = match request.send() {
        Ok(response) => response,
        Err(_) => {
            emit(FetchEvent::Err {
                message: "AI_NETWORK_ERROR".into(),
            });
            return;
        }
    };
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter(|(name, _)| !DROPPED_RESPONSE_HEADERS.contains(&name.as_str()))
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    // 4xx/5xx 也照常回传：AI SDK 要靠状态码与响应体拼出可读的错误。
    if !emit(FetchEvent::Head { status, headers }) {
        return;
    }
    let mut chunker = LineChunker::default();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let size = match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => {
                if !cancelled.load(Ordering::Relaxed) {
                    emit(FetchEvent::Err {
                        message: "AI_NETWORK_ERROR".into(),
                    });
                }
                return;
            }
        };
        match chunker.push(&buffer[..size]) {
            Ok(lines) => {
                for line in lines {
                    if !emit(FetchEvent::Chunk { text: line }) {
                        return;
                    }
                }
            }
            Err(message) => {
                emit(FetchEvent::Err { message });
                return;
            }
        }
    }
    if let Some(tail) = chunker.flush() {
        if !emit(FetchEvent::Chunk { text: tail }) {
            return;
        }
    }
    emit(FetchEvent::End);
}

/// 同一个服务商只留一条活流；取消按 providerId 打标记。
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn ai_fetch(
    input: FetchInput,
    on_event: tauri::ipc::Channel<FetchEvent>,
) -> Result<(), String> {
    validate_id(&input.provider_id)?;
    input.validate()?;
    let url = validate_same_origin(&input.base_url, &input.url)?;
    let secret = credentials::read(&input.provider_id)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(previous) = cancel_flags()
        .lock()
        .map_err(|_| "AI_TASK_FAILED")?
        .insert(input.provider_id.clone(), cancelled.clone())
    {
        previous.store(true, Ordering::Relaxed);
    }
    let provider_id = input.provider_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut emit = |event: FetchEvent| on_event.send(event).is_ok();
        stream_fetch(&input, url, secret, cancelled, &mut emit);
    })
    .await
    .map_err(|_| "AI_TASK_FAILED".to_string());
    if let Ok(mut flags) = cancel_flags().lock() {
        flags.remove(&provider_id);
    }
    result
}

#[tauri::command]
pub async fn ai_fetch_cancel(provider_id: String) -> Result<(), String> {
    validate_id(&provider_id)?;
    if let Some(flag) = cancel_flags()
        .lock()
        .map_err(|_| "AI_TASK_FAILED")?
        .get(&provider_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn mock(status: u16, body: &str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let body = body.to_string();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let size = socket.read(&mut chunk).unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..size]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).unwrap();
            let _ = sender.send(String::from_utf8(request).unwrap());
        });
        (base, receiver)
    }

    fn input(base: &str, content: Value) -> ChatInput {
        serde_json::from_value(serde_json::json!({"provider": {"id": "test", "baseUrl": base, "model": "test-model", "vision": true}, "messages": [{"role":"user", "content": content}]})).unwrap()
    }

    fn parameter_input(base: &str, parameters: Value) -> ChatInput {
        serde_json::from_value(serde_json::json!({
            "provider": {"id": "test", "baseUrl": base, "model": "test-model", "vision": true, "parameters": parameters},
            "messages": [{"role":"user", "content": "hi"}]
        })).unwrap()
    }

    fn received_body(received: mpsc::Receiver<String>) -> Value {
        let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    #[test]
    fn sends_only_explicit_model_parameters_with_selected_token_field() {
        for token_field in ["max_tokens", "max_completion_tokens"] {
            let (base, received) = mock(200, r#"{"choices":[{"message":{"content":"hello"}}]}"#);
            let parameters = serde_json::json!({
                "temperature": 0.7, "topP": 0.9, "maxTokens": 1200,
                "tokenLimitField": token_field, "reasoningEffort": "high"
            });
            assert_eq!(
                request_chat(parameter_input(&base, parameters), None).unwrap(),
                "hello"
            );
            let mut expected = serde_json::json!({
                "model": "test-model", "messages": [{"role":"user", "content":"hi"}], "stream": false,
                "temperature": 0.7, "top_p": 0.9, "reasoning_effort": "high"
            });
            expected[token_field] = serde_json::json!(1200);
            assert_eq!(received_body(received), expected);
        }
    }

    #[test]
    fn omits_unspecified_parameters_and_defaults_only_the_explicit_token_limit_field() {
        for parameters in [
            Value::Null,
            serde_json::json!({}),
            serde_json::json!({"tokenLimitField":"max_completion_tokens"}),
        ] {
            let (base, received) = mock(200, r#"{"choices":[{"message":{"content":"hello"}}]}"#);
            request_chat(parameter_input(&base, parameters), None).unwrap();
            assert_eq!(
                received_body(received),
                serde_json::json!({
                    "model": "test-model", "messages": [{"role":"user", "content":"hi"}], "stream": false
                })
            );
        }
        let (base, received) = mock(200, r#"{"choices":[{"message":{"content":"hello"}}]}"#);
        request_chat(
            parameter_input(&base, serde_json::json!({"maxTokens":1})),
            None,
        )
        .unwrap();
        assert_eq!(
            received_body(received),
            serde_json::json!({
                "model": "test-model", "messages": [{"role":"user", "content":"hi"}], "stream": false,
                "max_tokens": 1
            })
        );
    }

    #[test]
    fn rejects_invalid_model_parameters_before_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        for parameters in [
            serde_json::json!({"temperature": -0.1}),
            serde_json::json!({"temperature": 2.1}),
            serde_json::json!({"topP": 0}),
            serde_json::json!({"topP": 1.1}),
            serde_json::json!({"maxTokens": 0}),
            serde_json::json!({"maxTokens": 2000001}),
            serde_json::json!({"tokenLimitField": "both"}),
            serde_json::json!({"reasoningEffort": "auto"}),
        ] {
            assert_eq!(
                request_chat(parameter_input(&base, parameters), None).unwrap_err(),
                "AI_INVALID_PARAMETERS"
            );
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn chat_uses_draft_key_without_including_connection_controls_in_payload() {
        let (base, received) = mock(200, r#"{"choices":[{"message":{"content":"hello"}}]}"#);
        let input: ChatInput = serde_json::from_value(serde_json::json!({
            "provider": {"id":"test", "baseUrl":base, "model":"test-model", "vision":false},
            "messages": [{"role":"user", "content":"hi"}],
            "key":"draft-test-key", "useStoredKey":false
        }))
        .unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(ai_chat(input)).unwrap(),
            "hello"
        );
        let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.contains("Bearer draft-test-key"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "model":"test-model", "messages":[{"role":"user", "content":"hi"}], "stream":false
            })
        );
    }

    #[test]
    fn models_can_disable_stored_credentials_for_changed_connections() {
        for key in [Value::Null, serde_json::json!("draft-model-key")] {
            let (base, received) = mock(200, r#"{"data":[{"id":"model"}]}"#);
            let input: ModelsInput = serde_json::from_value(serde_json::json!({
                "id":"test", "baseUrl":base, "key":key, "useStoredKey":false
            }))
            .unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(ai_models(input)).unwrap(),
                vec!["model"]
            );
            let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(request.contains("Bearer draft-model-key"), key.is_string());
            if key.is_null() {
                assert!(!request.to_lowercase().contains("authorization:"));
            }
        }
    }

    #[test]
    fn rejects_invalid_draft_keys_before_any_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        for key in [
            "bad\rkey".to_string(),
            "bad\nkey".to_string(),
            "bad\0key".to_string(),
            "x".repeat(2561),
        ] {
            let input: ChatInput = serde_json::from_value(serde_json::json!({
                "provider": {"id":"test", "baseUrl":base, "model":"test-model", "vision":false},
                "messages": [{"role":"user", "content":"hi"}], "key":key, "useStoredKey":false
            }))
            .unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(ai_chat(input)).unwrap_err(),
                "AI_INVALID_KEY"
            );
            let input: ModelsInput = serde_json::from_value(serde_json::json!({
                "id":"test", "baseUrl":base, "key":key, "useStoredKey":false
            }))
            .unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(ai_models(input)).unwrap_err(),
                "AI_INVALID_KEY"
            );
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn lists_models_before_a_model_is_selected_and_deduplicates_ids() {
        let (base, received) = mock(
            200,
            r#"{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"},{"id":" "},{}]}"#,
        );
        assert_eq!(
            request_models(&base, None).unwrap(),
            vec!["a-model", "z-model"]
        );
        let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with("GET /v1/models "));
        assert!(!request.to_lowercase().contains("authorization:"));
    }

    #[test]
    fn model_discovery_authenticates_without_echoing_upstream_errors() {
        let (base, received) = mock(401, "test-model-key must never appear in an error");
        assert_eq!(
            request_models(&base, Some("test-model-key".into())).unwrap_err(),
            "AI_HTTP_401"
        );
        assert!(
            received
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .contains("Bearer test-model-key")
        );
        let (base, _) = mock(404, "unsupported");
        assert_eq!(request_models(&base, None).unwrap_err(), "AI_HTTP_404");
    }

    #[test]
    fn model_discovery_handles_empty_malformed_and_unsafe_endpoints() {
        for body in ["not json", r#"{"models":[]}"#] {
            let (base, _) = mock(200, body);
            assert_eq!(
                request_models(&base, None).unwrap_err(),
                "AI_RESPONSE_ERROR"
            );
        }
        let (base, _) = mock(200, r#"{"data":[]}"#);
        assert_eq!(request_models(&base, None).unwrap_err(), "AI_MODELS_EMPTY");
        assert_eq!(
            request_models("https://user:secret@example.com/v1", None).unwrap_err(),
            "AI_INVALID_URL"
        );
    }

    #[test]
    fn sends_text_without_key_and_extracts_response() {
        let (base, received) = mock(200, r#"{"choices":[{"message":{"content":"hello"}}]}"#);
        assert_eq!(
            request_chat(input(&base, Value::String("hi".into())), None).unwrap(),
            "hello"
        );
        let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.starts_with("POST /v1/chat/completions "));
        assert!(!request.to_lowercase().contains("authorization:"));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "model": "test-model", "messages": [{"role":"user", "content":"hi"}], "stream": false
            })
        );
    }

    #[test]
    fn sends_images_and_credential_without_exposing_key_in_errors() {
        let (base, received) = mock(401, "fake-test-key must never be echoed");
        let content = serde_json::json!([{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]);
        let error = request_chat(input(&base, content), Some("fake-test-key".into())).unwrap_err();
        assert_eq!(error, "AI_HTTP_401");
        let request = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.contains("Bearer fake-test-key"));
        assert!(request.contains("data:image/png;base64,aGVsbG8="));
    }

    #[test]
    fn rejects_unsafe_url_and_remote_image_before_request() {
        assert!(request_chat(input("file:///tmp", Value::String("hi".into())), None).is_err());
        let content = serde_json::json!([{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]);
        assert_eq!(
            request_chat(input("http://127.0.0.1:1/v1", content), None).unwrap_err(),
            "AI_INVALID_IMAGE"
        );
    }

    #[test]
    fn extracts_text_content_blocks() {
        let (base, _) = mock(
            200,
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}}]}"#,
        );
        assert_eq!(
            request_chat(input(&base, Value::String("hi".into())), None).unwrap(),
            "onetwo"
        );
    }

    fn migration_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nimbusdesk-ai-migration-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migration_clears_primary_backup_and_old_temporary_without_chained_backups() {
        let dir = migration_dir("cleanup");
        let old = r#"{"state":{"llmApiKey":"fake-old-key","tavilyApiKey":"unrelated-setting","llmModel":"model"},"version":1}"#;
        for name in [
            "ai-settings.json",
            "ai-settings.json.bak",
            "ai-settings.json.tmp",
        ] {
            std::fs::write(dir.join(name), old).unwrap();
        }
        finalize_legacy_files(&dir, Some("fake-old-key")).unwrap();
        for name in [
            "ai-settings.json",
            "ai-settings.json.bak",
            "ai-settings.json.tmp",
        ] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            assert!(!text.contains("fake-old-key"));
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["state"]["tavilyApiKey"], "unrelated-setting");
        }
        assert!(!dir.join("ai-settings.json.bak.bak").exists());
    }

    #[test]
    fn migration_preserves_original_when_credential_does_not_match() {
        let dir = migration_dir("mismatch");
        let old = r#"{"state":{"llmApiKey":"fake-original"},"version":1}"#;
        std::fs::write(dir.join("ai-settings.json"), old).unwrap();
        assert!(finalize_legacy_files(&dir, Some("fake-other")).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("ai-settings.json")).unwrap(),
            old
        );
    }

    #[test]
    fn migration_preserves_primary_if_backup_cannot_be_replaced() {
        let dir = migration_dir("blocked");
        let old = r#"{"state":{"llmApiKey":"fake-original"},"version":1}"#;
        std::fs::write(dir.join("ai-settings.json"), old).unwrap();
        std::fs::create_dir_all(dir.join("ai-settings.json.bak")).unwrap();
        assert!(finalize_legacy_files(&dir, Some("fake-original")).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("ai-settings.json")).unwrap(),
            old
        );
    }

    #[test]
    fn fetch_refuses_targets_outside_the_provider_origin() {
        // 每一条都必须是「拿着用户 Key 打别处」的入口，全部拒掉。
        for (base, target) in [
            ("https://api.openai.com/v1", "https://evil.com/v1/chat/completions"),
            ("https://api.openai.com/v1", "http://api.openai.com/v1/chat/completions"),
            ("https://api.openai.com/v1", "https://api.openai.com:8443/v1/chat/completions"),
            ("https://api.openai.com/v1", "https://127.0.0.1/v1/chat/completions"),
            ("https://api.openai.com/v1", "https://api.openai.com.evil.com/v1/chat/completions"),
            ("http://127.0.0.1:11434/v1", "http://127.0.0.1:9/v1/chat/completions"),
        ] {
            assert_eq!(
                validate_same_origin(base, target).unwrap_err(),
                "AI_ORIGIN_MISMATCH",
                "{base} -> {target}"
            );
        }
        // 目标地址自带用户名/口令：同源比对之前就被判非法。
        assert_eq!(
            validate_same_origin(
                "https://api.openai.com/v1",
                "https://user:secret@api.openai.com/v1/chat/completions"
            )
            .unwrap_err(),
            "AI_INVALID_URL"
        );
        // 非 http(s) 的 scheme 连 baseUrl 这一关都过不去。
        for url in ["file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)"] {
            assert_eq!(validate_same_origin(url, url).unwrap_err(), "AI_INVALID_URL");
            assert_eq!(
                validate_same_origin("https://api.openai.com/v1", url).unwrap_err(),
                "AI_INVALID_URL"
            );
        }
    }

    #[test]
    fn fetch_allows_same_origin_paths_and_equivalent_ports() {
        for (base, target) in [
            ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
            ("https://api.openai.com/v1/", "https://api.openai.com/v1/chat/completions?x=1"),
            ("https://API.OpenAI.com/v1", "https://api.openai.com/v1/chat/completions"),
            // 缺省端口与显式默认端口是同一个来源
            ("https://api.openai.com/v1", "https://api.openai.com:443/v1/chat/completions"),
            ("http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/chat/completions"),
        ] {
            assert!(validate_same_origin(base, target).is_ok(), "{base} -> {target}");
        }
    }

    #[test]
    fn fetch_rejects_unsafe_request_shapes_before_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let shape = |method: &str, headers: Vec<(String, String)>, body: Option<String>| FetchInput {
            provider_id: "test".into(),
            base_url: base.clone(),
            url: format!("{base}/chat/completions"),
            method: method.into(),
            headers,
            body,
        };
        for input in [
            shape("DELETE", vec![], None),
            shape("POST", vec![("Host".into(), "evil.com".into()); 33], None),
            shape("POST", vec![("x-bad\r\nx".into(), "v".into())], None),
            shape("POST", vec![("x".into(), "v\nv".into())], None),
            shape("POST", vec![], Some("x".repeat(FETCH_MAX_BODY + 1))),
        ] {
            assert!(input.validate().is_err());
        }
        assert!(shape("POST", vec![("x".into(), "y".into())], Some("{}".into())).validate().is_ok());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn line_chunker_keeps_split_multibyte_characters_intact() {
        let mut chunker = LineChunker::default();
        let bytes = "你好，完成。\n".as_bytes();
        // 在「好」的第二个字节上劈开：这一块里没有任何完整行。
        let cut = "你".len() + 1;
        assert!(chunker.push(&bytes[..cut]).unwrap().is_empty());
        assert_eq!(
            chunker.push(&bytes[cut..]).unwrap(),
            vec!["你好，完成。\n".to_string()]
        );

        // 没有换行收尾的尾巴靠 flush 补上，不丢字。
        let mut chunker = LineChunker::default();
        assert_eq!(
            chunker.push("data: 完成".as_bytes()).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(chunker.flush(), Some("data: 完成".to_string()));
        assert_eq!(chunker.flush(), None);
    }

    #[test]
    fn line_chunker_enforces_byte_and_line_limits() {
        let mut chunker = LineChunker::default();
        assert_eq!(
            chunker.push(&vec![b'a'; FETCH_MAX_BYTES + 1]).unwrap_err(),
            "AI_RESPONSE_TOO_LARGE"
        );
        let mut chunker = LineChunker::default();
        let mut error = None;
        for _ in 0..=FETCH_MAX_LINES {
            if let Err(message) = chunker.push(b"\n") {
                error = Some(message);
                break;
            }
        }
        assert_eq!(error.as_deref(), Some("AI_RESPONSE_TOO_LARGE"));
    }

    #[test]
    fn fetch_streams_body_lines_in_order_with_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let body = "data: {\"choices\":[]}\n\ndata: [DONE]\n\n";
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let size = socket.read(&mut chunk).unwrap();
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..size]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.trim()
                                .eq("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            // 故意切成两块发，模拟 TCP 分片。
            let (first, second) = body.split_at(9);
            socket.write_all(first.as_bytes()).unwrap();
            socket.flush().unwrap();
            std::thread::sleep(Duration::from_millis(20));
            socket.write_all(second.as_bytes()).unwrap();
            socket.flush().unwrap();
            let _ = sender.send(String::from_utf8(request).unwrap());
        });

        let input = FetchInput {
            provider_id: "test".into(),
            base_url: base.clone(),
            url: format!("{base}/chat/completions"),
            method: "POST".into(),
            headers: vec![
                ("accept".into(), "text/event-stream".into()),
                // 前端想自带凭据：必须被丢弃，改用凭据管理器里那份。
                ("authorization".into(), "Bearer stolen".into()),
            ],
            body: Some("{\"stream\":true}".into()),
        };
        let url = validate_same_origin(&input.base_url, &input.url).unwrap();
        let mut events = Vec::new();
        let mut emit = |event: FetchEvent| {
            events.push(event);
            true
        };
        stream_fetch(
            &input,
            url,
            Some("test-key".into()),
            Arc::new(AtomicBool::new(false)),
            &mut emit,
        );

        match events.first() {
            Some(FetchEvent::Head { status, headers }) => {
                assert_eq!(*status, 200);
                assert!(headers.iter().any(|(name, value)| name == "content-type"
                    && value.starts_with("text/event-stream")));
                // 按行重切后 content-length 已经不成立，不能回传。
                assert!(!headers.iter().any(|(name, _)| name == "content-length"));
            }
            other => panic!("首事件应为 Head，实际 {other:?}"),
        }
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                FetchEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, body);
        assert_eq!(events.last(), Some(&FetchEvent::End));

        let request = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.contains("Bearer test-key"));
        assert!(!request.contains("stolen"));
        let request_lower = request.to_lowercase();
        assert!(request_lower.contains("accept-encoding: identity"));
        // 调用方没声明 content-type 时按 JSON 补上，否则服务商多半直接 415。
        assert!(request_lower.contains("content-type: application/json"));
        assert!(request.split("\r\n\r\n").nth(1) == Some("{\"stream\":true}"));
    }

    /// 真实服务商冒烟：读凭据 → 同源校验 → 流式转发，只花 max_tokens=1 的额度。
    /// 默认不跑（`--ignored` 才跑），因为它打的是用户自己的服务商。
    /// 用法：cargo test --lib real_provider_stream_smoke -- --ignored --nocapture
    #[test]
    #[ignore = "打真实服务商，会花额度"]
    fn real_provider_stream_smoke() {
        /*
         * 测试二进制的 exe 在 target/debug/deps 下，`resolve_data_dir()` 会因此
         * 解析到 deps/data 这个空目录。所以要显式指向应用的数据目录（或用
         * AI_SMOKE_DATA_DIR 覆盖）。
         */
        let root = std::env::var("AI_SMOKE_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/debug/data")
            });
        println!("数据目录={}", root.display());
        let stored = crate::database::read_at(&root, "ai-providers").expect("read ai-providers");
        let Some(stored) = stored else {
            // 没配服务商：把库里现存的键打出来，免得把「键名写错」当成「没配」。
            let conn =
                rusqlite::Connection::open(root.join("workbench.sqlite3")).expect("open database");
            let mut statement = conn
                .prepare("SELECT key FROM module_state ORDER BY key")
                .expect("prepare");
            let keys: Vec<String> = statement
                .query_map([], |row| row.get(0))
                .expect("query")
                .filter_map(Result::ok)
                .collect();
            println!("没有 ai-providers 这一条，现存的键：{keys:?}");
            return;
        };
        let state = stored.get("state").unwrap_or(&stored);
        let providers = state["providers"].as_array().cloned().unwrap_or_default();
        let wanted = state["defaultTextId"].as_str();
        let provider = providers
            .iter()
            .find(|item| Some(item["id"].as_str().unwrap_or_default()) == wanted)
            .or_else(|| providers.first())
            .expect("no provider configured");
        let id = provider["id"].as_str().unwrap();
        let base_url = provider["baseUrl"].as_str().unwrap();
        let model = provider["model"].as_str().unwrap();
        let secret = credentials::read(id).expect("credential read");
        println!(
            "provider={id} base={base_url} model={model} has_key={}",
            if secret.is_some() { "yes" } else { "no" }
        );

        let input = FetchInput {
            provider_id: id.to_string(),
            base_url: base_url.to_string(),
            url: format!("{}/chat/completions", base_url.trim_end_matches('/')),
            method: "POST".into(),
            headers: vec![("accept".into(), "text/event-stream".into())],
            body: Some(
                serde_json::json!({
                    "model": model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": true,
                    "max_tokens": 1,
                })
                .to_string(),
            ),
        };
        let url = validate_same_origin(&input.base_url, &input.url).expect("same origin");
        let mut events = Vec::new();
        let mut first_chunk_at = None;
        let started = std::time::Instant::now();
        let mut emit = |event: FetchEvent| {
            if first_chunk_at.is_none() && matches!(event, FetchEvent::Chunk { .. }) {
                first_chunk_at = Some(started.elapsed());
            }
            events.push(event);
            true
        };
        stream_fetch(
            &input,
            url,
            secret,
            Arc::new(AtomicBool::new(false)),
            &mut emit,
        );
        let elapsed = started.elapsed();
        let status = match events.first() {
            Some(FetchEvent::Head { status, .. }) => *status,
            other => panic!("首事件应为 Head，实际 {other:?}"),
        };
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                FetchEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        println!(
            "status={status} 总耗时={elapsed:?} 首字节={first_chunk_at:?} 事件数={} 正文={}",
            events.len(),
            &text[..text.len().min(240)]
        );
        assert!((200..300).contains(&status), "HTTP {status}");
        assert_eq!(events.last(), Some(&FetchEvent::End));
        assert!(!text.is_empty(), "没有收到任何正文");
    }
}
