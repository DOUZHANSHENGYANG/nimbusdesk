//! Native OpenAI-compatible requests and Windows credential storage.

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
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
}
