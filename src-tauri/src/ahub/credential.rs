//! Windows 凭据管理器封装。
//!
//! API key 只存操作系统凭据管理器（`CredWriteW` / `CredReadW` / `CredDeleteW`），
//! 不写入 `settings.json` 或任何明文配置文件（spec `credential-vault`）。
//!
//! 不引第三方 crate：`CREDENTIALW` 与常量按 `wincred.h` 手工声明。
//! **字段顺序必须与头文件一致**（`Flags` / `Type` / `TargetName` / `Comment` /
//! `LastWritten` / `CredentialBlobSize` / `CredentialBlob` / `Persist` /
//! `AttributeCount` / `Attributes` / `TargetAlias` / `UserName`），
//! 否则调用方读到的会是错位的数据。
//!
//! 本项目只支持 Windows（brief「明确不建」）；非 Windows 平台保留同名函数
//! 返回错误，只为让 `cargo check` 在其它平台也能通过。

#[cfg(windows)]
mod win {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Bool = i32;
    type Dword = u32;
    type LpWstr = *mut u16;
    type LpcWstr = *const u16;

    /// `CRED_TYPE_GENERIC`：通用凭据，blob 内容由调用方自行解释
    const CRED_TYPE_GENERIC: Dword = 1;
    /// `CRED_PERSIST_LOCAL_MACHINE`：只在本机持久化
    const CRED_PERSIST_LOCAL_MACHINE: Dword = 2;
    /// `ERROR_NOT_FOUND`：目标条目不存在
    const ERROR_NOT_FOUND: i32 = 1168;
    /// `CRED_MAX_CREDENTIAL_BLOB_SIZE`
    const MAX_BLOB: usize = 5 * 512;

    /// `FILETIME`：两个 DWORD，按 8 字节对齐（与头文件一致）
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: Dword,
        high: Dword,
    }

    /// `CREDENTIALW`
    #[repr(C)]
    struct CredentialW {
        flags: Dword,
        kind: Dword,
        target_name: LpWstr,
        comment: LpWstr,
        last_written: FileTime,
        credential_blob_size: Dword,
        credential_blob: *mut u8,
        persist: Dword,
        attribute_count: Dword,
        attributes: *mut c_void,
        target_alias: LpWstr,
        user_name: LpWstr,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn CredWriteW(credential: *const CredentialW, flags: Dword) -> Bool;
        fn CredReadW(
            target: LpcWstr,
            kind: Dword,
            flags: Dword,
            credential: *mut *mut CredentialW,
        ) -> Bool;
        fn CredDeleteW(target: LpcWstr, kind: Dword, flags: Dword) -> Bool;
        fn CredFree(buffer: *mut c_void);
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    /// 写入（或覆盖）一条通用凭据。同一 `target` 重复写入只会更新那一条。
    pub fn write(target: &str, secret: &str) -> Result<(), String> {
        if target.trim().is_empty() {
            return Err("凭据引用名为空".into());
        }
        let mut blob = secret.as_bytes().to_vec();
        if blob.len() > MAX_BLOB {
            return Err(format!(
                "凭据内容过长（{} 字节，上限 {MAX_BLOB} 字节）",
                blob.len()
            ));
        }
        let mut target_w = wide(target);
        let mut user_w = wide("agenthub");
        let cred = CredentialW {
            flags: 0,
            kind: CRED_TYPE_GENERIC,
            target_name: target_w.as_mut_ptr(),
            comment: ptr::null_mut(),
            last_written: FileTime::default(),
            credential_blob_size: blob.len() as Dword,
            credential_blob: blob.as_mut_ptr(),
            persist: CRED_PERSIST_LOCAL_MACHINE,
            attribute_count: 0,
            attributes: ptr::null_mut(),
            target_alias: ptr::null_mut(),
            user_name: user_w.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            return Err(format!("写入凭据失败（Windows 错误码 {}）", last_error()));
        }
        Ok(())
    }

    /// 读一条凭据；条目不存在时返回 `Ok(None)`（不是错误）。
    pub fn read(target: &str) -> Result<Option<String>, String> {
        if target.trim().is_empty() {
            return Err("凭据引用名为空".into());
        }
        let target_w = wide(target);
        let mut out: *mut CredentialW = ptr::null_mut();
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut out) };
        if ok == 0 {
            let code = last_error();
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("读取凭据失败（Windows 错误码 {code}）"));
        }
        if out.is_null() {
            return Ok(None);
        }
        // 内存归 CredFree 释放：先拷出内容，再统一释放，避免任何提前返回漏掉释放
        let text = unsafe {
            let size = (*out).credential_blob_size as usize;
            let blob = (*out).credential_blob;
            if blob.is_null() || size == 0 {
                String::new()
            } else {
                let bytes = std::slice::from_raw_parts(blob, size);
                String::from_utf8_lossy(bytes).into_owned()
            }
        };
        unsafe { CredFree(out as *mut c_void) };
        Ok(Some(text))
    }

    /// 删除一条凭据。条目不存在时视为成功（幂等）。
    pub fn delete(target: &str) -> Result<(), String> {
        if target.trim().is_empty() {
            return Err("凭据引用名为空".into());
        }
        let target_w = wide(target);
        let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = last_error();
            if code == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(format!("删除凭据失败（Windows 错误码 {code}）"));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use win::{delete, read, write};

#[cfg(not(windows))]
pub fn write(_target: &str, _secret: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

#[cfg(not(windows))]
pub fn read(_target: &str) -> Result<Option<String>, String> {
    Err("仅支持 Windows".into())
}

#[cfg(not(windows))]
pub fn delete(_target: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

// ---------------- 测试：真实凭据管理器读写 ----------------
// 用 `agenthub-test-<uuid>` 前缀，每个用例结束时删除，不在系统里留垃圾条目。

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn test_target() -> String {
        format!("agenthub-test-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn write_read_delete_roundtrip() {
        let target = test_target();
        write(&target, "sk-test-abcdefghijklmn").unwrap();
        assert_eq!(
            read(&target).unwrap().as_deref(),
            Some("sk-test-abcdefghijklmn"),
            "刚写入的 key 必须能原样读回"
        );
        delete(&target).unwrap();
        assert_eq!(read(&target).unwrap(), None, "删除后必须读不到");
    }

    #[test]
    fn overwrite_updates_same_entry() {
        let target = test_target();
        write(&target, "first-key").unwrap();
        write(&target, "second-key").unwrap();
        assert_eq!(
            read(&target).unwrap().as_deref(),
            Some("second-key"),
            "覆盖写入同一引用名应更新而不是新增"
        );
        delete(&target).unwrap();
    }

    #[test]
    fn read_missing_is_none() {
        let target = test_target();
        assert_eq!(read(&target).unwrap(), None, "不存在的条目不是错误");
    }

    #[test]
    fn delete_missing_is_ok() {
        let target = test_target();
        delete(&target).expect("删除不存在的条目应当幂等成功");
    }

    #[test]
    fn unicode_secret_roundtrip() {
        let target = test_target();
        let secret = "密钥-测试-🔑";
        write(&target, secret).unwrap();
        assert_eq!(read(&target).unwrap().as_deref(), Some(secret));
        delete(&target).unwrap();
    }

    #[test]
    fn empty_secret_roundtrip() {
        let target = test_target();
        write(&target, "").unwrap();
        assert_eq!(
            read(&target).unwrap().as_deref(),
            Some(""),
            "空串也能存取（区别于条目不存在）"
        );
        delete(&target).unwrap();
    }
}
