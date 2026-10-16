//! 原子文件写入。
//!
//! 单独成模块的意义：**不依赖 tauri**，所以能脱离整棵依赖树直接单测：
//! ```bash
//! cd src-tauri && cargo test --lib atomic
//! ```
//! 「断电不损坏文件」是最重要的一致性保证，随时可验证。

use std::io::Write;
use std::path::Path;

/// 给 IO 错误补上「哪一步 + 哪个路径」，便于定位（如 `os error 5` 拒绝访问）。
pub fn ctx(step: &str, path: &str, e: std::io::Error) -> std::io::Error {
    std::io::Error::new(e.kind(), format!("{step}失败 «{path}»: {e}"))
}

/// 原子写文件。
///
/// 流程：写 `<path>.tmp` → `sync_all`（fsync，内容+元数据落盘）→ 把旧文件
/// **复制**为 `<path>.bak` → `rename(tmp, path)`。
///
/// 任意时刻断电/崩溃，`path` 要么是完整的旧版本、要么是完整的新版本，不会出现
/// 「写了一半」的截断文件（直接 `fs::write` 会）。缺 `sync_all` 时 NTFS 可能只
/// 落盘了元数据，得到「长度正确但内容为空」的文件。
///
/// `.bak` 用 **copy 而非 rename**：即便紧接着崩溃，原文件仍在原位，不会出现
/// 「两个都没了」。备份失败不阻断主流程。
pub fn write_file_atomic(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = Path::new(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ctx("创建目录", &parent.to_string_lossy(), e))?;
    }

    // 1) 同目录临时文件 —— 同目录才能保证 rename 是原子替换（不会跨设备）
    let tmp = format!("{path}.tmp");
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| ctx("创建临时文件", &tmp, e))?;
        file.write_all(bytes).map_err(|e| ctx("写入临时文件", &tmp, e))?;
        file.flush().map_err(|e| ctx("刷新临时文件", &tmp, e))?;
        file.sync_all().map_err(|e| ctx("落盘临时文件", &tmp, e))?;
    }

    // 2) 旧文件留一份上一版
    if target.exists() {
        let _ = std::fs::copy(target, format!("{path}.bak"));
    }

    // 3) 原子替换；被占用时短暂重试（杀软/同步盘常瞬间持有句柄）
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..4 {
        match std::fs::rename(&tmp, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(ctx("替换目标文件", path, last.unwrap()))
}

/// 读取文件；主文件缺失时回退到 `<path>.bak`（极端断电场景的自愈）。
pub fn read_file_with_fallback(path: &str) -> std::io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(primary) => {
            let bak = format!("{path}.bak");
            if Path::new(&bak).exists() {
                std::fs::read_to_string(&bak)
            } else {
                Err(primary)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nimbusdesk-atomic-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn p(dir: &Path, name: &str) -> String {
        dir.join(name).to_string_lossy().to_string()
    }

    #[test]
    fn writes_new_file_and_cleans_tmp() {
        let dir = tmpdir("new");
        let path = p(&dir, "a.json");
        write_file_atomic(&path, b"v1").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "v1");
        assert!(!Path::new(&format!("{path}.tmp")).exists(), "临时文件应已被 rename");
        assert!(!Path::new(&format!("{path}.bak")).exists(), "首次写入无旧文件可备份");
    }

    #[test]
    fn keeps_previous_version_as_bak() {
        let dir = tmpdir("bak");
        let path = p(&dir, "b.json");
        write_file_atomic(&path, b"old").unwrap();
        write_file_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(format!("{path}.bak")).unwrap(),
            "old",
            "上一版应留在 .bak"
        );
    }

    #[test]
    fn read_falls_back_to_bak() {
        let dir = tmpdir("fallback");
        let path = p(&dir, "c.json");
        write_file_atomic(&path, b"only").unwrap();
        // 模拟「新文件丢失、但备份还在」
        std::fs::rename(&path, format!("{path}.bak")).unwrap();
        assert_eq!(read_file_with_fallback(&path).unwrap(), "only");
    }

    #[test]
    fn overwrite_is_not_partial() {
        let dir = tmpdir("partial");
        let path = p(&dir, "d.json");
        let big = vec![b'x'; 512 * 1024];
        write_file_atomic(&path, &big).unwrap();
        write_file_atomic(&path, b"small").unwrap();
        // 覆盖后长度必须是新内容的长度，不能是旧内容的残影
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 5);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "small");
    }

    #[test]
    fn creates_missing_parent_dirs() {
        let dir = tmpdir("mkdir");
        let path = p(&dir.join("deep").join("nested"), "e.json");
        write_file_atomic(&path, b"ok").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ok");
    }

    #[test]
    fn error_message_names_step_and_path() {
        let dir = tmpdir("err");
        // 目标路径的父级是一个文件 → create_dir_all 必然失败
        let blocker = p(&dir, "blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let bad = format!("{blocker}/sub/f.json");
        let err = write_file_atomic(&bad, b"x").unwrap_err().to_string();
        assert!(err.contains("创建目录"), "错误应说明是哪一步: {err}");
        assert!(err.contains("blocker"), "错误应带上路径: {err}");
    }
}
