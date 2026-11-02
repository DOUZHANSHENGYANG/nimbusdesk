//! 跨 harness 会话迁移：OpenCode / DSH / WorkBuddy。
pub mod adapter;
pub mod index;
pub mod canvas_graph;
pub mod commands;
pub mod ir;
pub mod transfer;

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Atomically replace `path` with `tmp`. On Windows, `std::fs::rename` refuses
/// to overwrite, so use MoveFileEx with REPLACE_EXISTING instead of a
/// remove-then-rename window.
pub(crate) fn replace_state_file(tmp: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        result.map_err(|_| std::io::Error::last_os_error())?;
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(tmp, path)?;
    }
    Ok(())
}

#[cfg(test)]
mod state_file_tests {
    use super::*;

    #[test]
    fn replace_state_file_overwrites_existing_target() {
        let dir = std::env::temp_dir().join(format!("nimbus-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("state.json");
        let tmp = dir.join("state.json.tmp");
        std::fs::write(&target, b"old").unwrap();
        std::fs::write(&tmp, b"new").unwrap();
        replace_state_file(&tmp, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        std::fs::remove_dir_all(&dir).ok();
    }
}
