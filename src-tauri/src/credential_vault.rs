//! 系统凭据管理器里的机密存取：按「服务 + ID」定位一条记录。
//! 禅道凭据和 GitHub token 共用这一份实现，错误码由调用方映射成各自的边界错误。

/// CRED_MAX_CREDENTIAL_BLOB_SIZE
const KEY_MAX: usize = 2560;

/// 记录无效（空、过长、含控制字符）；调用方应映射成「输入不合法」。
pub const INVALID: &str = "VAULT_INVALID_SECRET";

pub fn read(service: &str, id: &str) -> Result<Option<String>, &'static str> {
    imp::read(service, id)
}

pub fn save(service: &str, id: &str, key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.len() > KEY_MAX || key.contains(['\r', '\n', '\0']) {
        return Err(INVALID);
    }
    imp::save(service, id, key)
}

pub fn delete(service: &str, id: &str) -> Result<(), &'static str> {
    imp::delete(service, id)
}

#[cfg(windows)]
mod imp {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    /// 服务名进 target 前缀，改名就等于换了一条记录。
    fn target(service: &str, id: &str) -> Vec<u16> {
        format!("NimbusDesk/{service}/{id}\0").encode_utf16().collect()
    }

    pub fn read(service: &str, id: &str) -> Result<Option<String>, &'static str> {
        let target = target(service, id);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            if let Err(error) = CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut credential) {
                return if error.code().0 as u32 == 0x80070490 {
                    Ok(None)
                } else {
                    Err("VAULT_READ_FAILED")
                };
            }
            let data = &*credential;
            let result = if data.CredentialBlobSize == 0 {
                Ok(None)
            } else {
                String::from_utf8(
                    std::slice::from_raw_parts(data.CredentialBlob, data.CredentialBlobSize as usize).to_vec(),
                )
                .map(Some)
                .map_err(|_| "VAULT_READ_FAILED")
            };
            CredFree(credential.cast());
            result
        }
    }

    pub fn save(service: &str, id: &str, key: &str) -> Result<(), &'static str> {
        let mut target = target(service, id);
        let mut bytes = key.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        let result = unsafe { CredWriteW(&credential, 0) }.map_err(|_| "VAULT_WRITE_FAILED");
        bytes.fill(0);
        result.map(|_| ())
    }

    pub fn delete(service: &str, id: &str) -> Result<(), &'static str> {
        let target = target(service, id);
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code().0 as u32 == 0x80070490 => Ok(()),
            Err(_) => Err("VAULT_DELETE_FAILED"),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    //! 其他平台没有系统凭据管理器；调用方会把这个码显示成「无法保存凭据」。
    pub fn read(_service: &str, _id: &str) -> Result<Option<String>, &'static str> {
        Ok(None)
    }
    pub fn save(_service: &str, _id: &str, _key: &str) -> Result<(), &'static str> {
        Err("VAULT_UNSUPPORTED")
    }
    pub fn delete(_service: &str, _id: &str) -> Result<(), &'static str> {
        Err("VAULT_UNSUPPORTED")
    }
}
