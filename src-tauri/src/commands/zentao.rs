//! Only saved connection metadata crosses this boundary; secrets stay in the OS vault.
use crate::{
    commands::data::with_data_dir,
    database,
    zentao::{
        client::{self, Client, Connection, FetchResult, Task},
        credentials::{self, Secret},
        writeback::{self, Fields},
    },
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;

static TASK_WRITE: Mutex<()> = Mutex::new(());

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("ZENTAO_INVALID_CONFIG".into());
    }
    Ok(())
}
fn connection(id: &str) -> Result<Connection, String> {
    validate_id(id)?;
    with_data_dir(|root| {
        let state = database::read_at(root, "zentao")
            .map_err(|_| "ZENTAO_CONFIG_READ_FAILED")?
            .ok_or("ZENTAO_CONNECTION_NOT_FOUND")?;
        let value = state
            .pointer("/state/connections")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.iter().find(|value| value["id"].as_str() == Some(id)))
            .ok_or("ZENTAO_CONNECTION_NOT_FOUND")?;
        serde_json::from_value(value.clone()).map_err(|_| "ZENTAO_INVALID_CONFIG".into())
    })
    .map_err(|error| {
        if error.starts_with("ZENTAO_") {
            error
        } else {
            "ZENTAO_CONFIG_READ_FAILED".into()
        }
    })
}

fn same_snapshot_scope(left: &Connection, right: &Connection) -> bool {
    client::endpoint(&left.base_url).ok() == client::endpoint(&right.base_url).ok()
        && left.account.trim() == right.account.trim()
        && left.api_version == right.api_version
        && left
            .execution_ids
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            == right
                .execution_ids
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
}

fn same_write_scope(left: &Connection, right: &Connection) -> bool {
    same_snapshot_scope(left, right)
        && left
            .write_fields
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            == right
                .write_fields
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
}

fn task_snapshot(
    config: &Connection,
    remote_id: u64,
    write: Option<(&Fields, &Value)>,
) -> Result<Value, String> {
    with_data_dir(|root| {
        let projects = database::read_at(root, "projects")
            .map_err(|_| "ZENTAO_CONFIG_READ_FAILED")?
            .ok_or("ZENTAO_TASK_NOT_BOUND")?;
        match write {
            Some((expected, changes)) => {
                writeback::validate_intent(config, &projects, remote_id, expected, changes)
            }
            None => writeback::validate_binding(config, &projects, remote_id),
        }
    })
    .map_err(|error| {
        if error.starts_with("ZENTAO_") {
            error
        } else {
            "ZENTAO_CONFIG_READ_FAILED".into()
        }
    })
}

fn resolved_config(config: &Connection, secret: &Secret) -> Connection {
    let mut resolved = config.clone();
    if resolved.api_version == "auto" {
        if let Some(version) = secret
            .api_version
            .as_ref()
            .filter(|s| matches!(s.as_str(), "v1" | "v2"))
        {
            resolved.api_version = version.clone();
        }
    }
    resolved
}

#[tauri::command]
pub async fn zentao_read_task(connection_id: String, remote_id: u64) -> Result<Task, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = connection(&connection_id)?;
        let snapshot = task_snapshot(&config, remote_id, None)?;
        let secret = credentials::read(&config)?.ok_or("ZENTAO_AUTH_REQUIRED")?;
        let resolved = resolved_config(&config, &secret);
        let mut http = Client::new(&resolved)?;
        let (version, token) = http.authenticate(
            if secret.token.is_none() {
                secret.password.as_deref()
            } else {
                None
            },
            secret.token.as_deref(),
        )?;
        let task = http.read_task(&version, &token, remote_id)?;
        if !same_snapshot_scope(&config, &connection(&connection_id)?)
            || task_snapshot(&config, remote_id, None)? != snapshot
        {
            return Err("ZENTAO_CONNECTION_CHANGED".into());
        }
        Ok(task)
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[tauri::command]
pub async fn zentao_write_task(
    connection_id: String,
    remote_id: u64,
    expected: Fields,
    changes: Value,
) -> Result<Task, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize native mutations across all webviews. Never block the UI or
        // queue a second implicit send behind an ambiguous first request.
        let _write = TASK_WRITE.try_lock().map_err(|_| "ZENTAO_BUSY")?;
        let config = connection(&connection_id)?;
        let snapshot = task_snapshot(&config, remote_id, Some((&expected, &changes)))?;
        let secret = credentials::read(&config)?.ok_or("ZENTAO_AUTH_REQUIRED")?;
        let resolved = resolved_config(&config, &secret);
        let mut http = Client::new(&resolved)?;
        let (version, token) = http.authenticate(
            if secret.token.is_none() {
                secret.password.as_deref()
            } else {
                None
            },
            secret.token.as_deref(),
        )?;
        writeback::guarded_write(
            &mut http,
            &config,
            &version,
            &token,
            remote_id,
            &expected,
            &changes,
            || {
                if !same_write_scope(&config, &connection(&connection_id)?)
                    || task_snapshot(&config, remote_id, Some((&expected, &changes)))? != snapshot
                {
                    return Err("ZENTAO_CONNECTION_CHANGED".into());
                }
                Ok(())
            },
        )
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    has_password: bool,
    has_token: bool,
    api_version: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    api_version: String,
    account: String,
}

#[tauri::command]
pub async fn zentao_secret_status(connection_id: String) -> Result<SecretStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = connection(&connection_id)?;
        let secret = credentials::read(&config)?;
        Ok(SecretStatus {
            has_password: secret
                .as_ref()
                .is_some_and(|s| s.password.as_ref().is_some_and(|v| !v.is_empty())),
            has_token: secret
                .as_ref()
                .is_some_and(|s| s.token.as_ref().is_some_and(|v| !v.is_empty())),
            api_version: secret.and_then(|s| s.api_version),
        })
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[tauri::command]
pub async fn zentao_forget_secret(connection_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&connection_id)?;
        credentials::delete(&connection_id)
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[tauri::command]
pub async fn zentao_test_connection(
    connection_id: String,
    password: Option<String>,
    token: Option<String>,
) -> Result<TestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = connection(&connection_id)?;
        let mut http = Client::new(&config)?;
        let stored = credentials::read(&config)?.unwrap_or_default();
        let password = password.filter(|s| !s.is_empty());
        let token = token.filter(|s| !s.is_empty());
        let explicit = password.is_some() || token.is_some();
        let selected_password = if explicit {
            password.as_deref()
        } else if stored.token.is_none() {
            stored.password.as_deref()
        } else {
            None
        };
        let selected_token = if explicit {
            token.as_deref()
        } else {
            stored.token.as_deref()
        };
        let (version, validated_token) = http.authenticate(selected_password, selected_token)?;
        http.validate(&version, &validated_token)?;
        // Config may have been edited while the request was in flight.
        let current = connection(&connection_id)?;
        if client::endpoint(&current.base_url)? != client::endpoint(&config.base_url)?
            || current.account.trim() != config.account.trim()
            || current.api_version != config.api_version
        {
            return Err("ZENTAO_CONNECTION_CHANGED".into());
        }
        credentials::save(
            &connection_id,
            &Secret {
                base_url: client::endpoint(&config.base_url)?,
                account: config.account.trim().to_owned(),
                password: if explicit { password } else { stored.password },
                token: Some(validated_token),
                api_version: Some(version.clone()),
            },
        )?;
        Ok(TestResult {
            api_version: version,
            account: config.account.trim().to_owned(),
        })
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[tauri::command]
pub async fn zentao_fetch_tasks(
    connection_id: String,
    tracked_ids: Vec<u64>,
) -> Result<FetchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = connection(&connection_id)?;
        let secret = credentials::read(&config)?.ok_or("ZENTAO_AUTH_REQUIRED")?;
        let resolved = resolved_config(&config, &secret);
        let mut http = Client::new(&resolved)?;
        let (version, token) = http.authenticate(
            if secret.token.is_none() {
                secret.password.as_deref()
            } else {
                None
            },
            secret.token.as_deref(),
        )?;
        let result = http.fetch(&version, &token, &tracked_ids)?;
        if !same_snapshot_scope(&config, &connection(&connection_id)?) {
            return Err("ZENTAO_CONNECTION_CHANGED".into());
        }
        Ok(result)
    })
    .await
    .map_err(|_| "ZENTAO_INTERNAL_ERROR")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_or_scope_change_invalidates_an_inflight_snapshot() {
        let config: Connection=serde_json::from_value(serde_json::json!({"id":"one","baseUrl":"https://one.test/zentao/","account":"dev","apiVersion":"auto","executionIds":[2,3]})).unwrap();
        let mut edited = config.clone();
        edited.execution_ids.reverse();
        assert!(same_snapshot_scope(&config, &edited));
        edited.execution_ids.push(4);
        assert!(!same_snapshot_scope(&config, &edited));
        edited = config.clone();
        edited.account = "other".into();
        assert!(!same_snapshot_scope(&config, &edited));
        edited = config.clone();
        edited.base_url = "https://two.test/zentao/".into();
        assert!(!same_snapshot_scope(&config, &edited));
        edited = config.clone();
        edited.api_version = "v1".into();
        assert!(!same_snapshot_scope(&config, &edited));
    }
    #[test]
    fn changing_write_permission_invalidates_an_inflight_write() {
        let config: Connection=serde_json::from_value(serde_json::json!({"id":"one","baseUrl":"https://one.test/","account":"dev","apiVersion":"v1","writeFields":["title","note"]})).unwrap();
        let mut edited = config.clone();
        edited.write_fields.reverse();
        assert!(same_write_scope(&config, &edited));
        edited.write_fields.pop();
        assert!(!same_write_scope(&config, &edited));
    }
}
