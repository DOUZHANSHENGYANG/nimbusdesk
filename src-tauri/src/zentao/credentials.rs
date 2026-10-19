use super::client::{Connection, endpoint};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub base_url: String,
    pub account: String,
    pub password: Option<String>,
    pub token: Option<String>,
    pub api_version: Option<String>,
}

impl Secret {
    fn matches(&self, config: &Connection) -> bool {
        endpoint(&config.base_url).is_ok_and(|url| url == self.base_url)
            && config.account.trim() == self.account
    }
}
pub fn read(config: &Connection) -> Result<Option<Secret>, String> {
    let Some(value) = vault::read(&config.id)? else {
        return Ok(None);
    };
    let parsed =
        serde_json::from_str::<Secret>(&value).map_err(|_| "ZENTAO_CREDENTIAL_READ_FAILED");
    value.into_bytes().fill(0);
    let secret = parsed?;
    Ok(secret.matches(config).then_some(secret))
}
pub fn save(id: &str, secret: &Secret) -> Result<(), String> {
    let mut value = serde_json::to_vec(secret).map_err(|_| "ZENTAO_CREDENTIAL_WRITE_FAILED")?;
    let result = match std::str::from_utf8(&value) {
        Ok(serialized) => vault::save(id, serialized),
        Err(_) => Err("ZENTAO_CREDENTIAL_WRITE_FAILED".into()),
    };
    // Clear the temporary serialization before returning to the command boundary.
    value.fill(0);
    result
}
pub fn delete(id: &str) -> Result<(), String> {
    vault::delete(id)
}

#[cfg(windows)]
mod vault {
    use windows::Win32::Security::Credentials::{
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
        CredDeleteW, CredFree, CredReadW, CredWriteW,
    };
    use windows::core::{PCWSTR, PWSTR};

    fn target(id: &str) -> Vec<u16> {
        format!("NimbusDesk/ZenTao/{id}\0").encode_utf16().collect()
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
                    Err("ZENTAO_CREDENTIAL_READ_FAILED".into())
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
                .map_err(|_| "ZENTAO_CREDENTIAL_READ_FAILED".into())
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
            return Err("ZENTAO_INVALID_SECRET".into());
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
        let result = unsafe { CredWriteW(&credential, 0) }
            .map_err(|_| "ZENTAO_CREDENTIAL_WRITE_FAILED".into());
        bytes.fill(0);
        result
    }

    pub fn delete(id: &str) -> Result<(), String> {
        let target = target(id);
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code().0 as u32 == 0x80070490 => Ok(()),
            Err(_) => Err("ZENTAO_CREDENTIAL_DELETE_FAILED".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_endpoint_or_account_cannot_reuse_vault_secret() {
        let mut config:Connection=serde_json::from_value(serde_json::json!({"id":"one","baseUrl":"https://one.test/zentao/","account":"dev","apiVersion":"v1"})).unwrap();
        let secret = Secret {
            base_url: config.base_url.clone(),
            account: config.account.clone(),
            ..Default::default()
        };
        assert!(secret.matches(&config));
        config.base_url = "https://two.test/zentao/".into();
        assert!(!secret.matches(&config));
        config.base_url = secret.base_url.clone();
        config.account = "other".into();
        assert!(!secret.matches(&config));
    }

    #[cfg(windows)]
    #[test]
    fn isolated_windows_vault_lifecycle_binds_identity_and_cleans_up() {
        let id = format!(
            "fixture-{}-{}",
            std::process::id(),
            crate::zentao::client::now()
        );
        assert!(vault::read(&id).unwrap().is_none());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete(&self.0);
            }
        }
        let _cleanup = Cleanup(id.clone());
        let config:Connection=serde_json::from_value(serde_json::json!({"id":id,"baseUrl":"https://vault-fixture.invalid/zentao/","account":"fixture-account","apiVersion":"v1"})).unwrap();
        let secret = Secret {
            base_url: config.base_url.clone(),
            account: config.account.clone(),
            password: Some("fixture-password".into()),
            token: Some("fixture-token".into()),
            api_version: Some("v1".into()),
        };
        save(&config.id, &secret).unwrap();
        let loaded = read(&config).unwrap().unwrap();
        assert!(
            loaded
                .password
                .as_ref()
                .is_some_and(|s| s == "fixture-password")
        );
        assert!(loaded.token.as_ref().is_some_and(|s| s == "fixture-token"));
        let mut changed = config.clone();
        changed.account = "different-fixture-account".into();
        assert!(read(&changed).unwrap().is_none());
        changed = config.clone();
        changed.base_url = "https://different-vault-fixture.invalid/".into();
        assert!(read(&changed).unwrap().is_none());
        delete(&config.id).unwrap();
        assert!(read(&config).unwrap().is_none());
    }
}

#[cfg(not(windows))]
mod vault {
    pub fn read(_id: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn save(_id: &str, _key: &str) -> Result<(), String> {
        Err("ZENTAO_CREDENTIAL_UNSUPPORTED".into())
    }
    pub fn delete(_id: &str) -> Result<(), String> {
        Err("ZENTAO_CREDENTIAL_UNSUPPORTED".into())
    }
}
