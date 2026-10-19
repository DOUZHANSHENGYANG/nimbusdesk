//! Read-only snapshots of a mapped directory's immediate children.

use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 5_000;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ELAPSED: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySnapshot {
    pub root: String,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
}

fn snapshot_with_limits(
    root: &Path,
    max_entries: usize,
    max_bytes: usize,
    max_elapsed: Duration,
) -> Result<DirectorySnapshot, String> {
    let started = Instant::now();
    let check_time = || {
        if started.elapsed() >= max_elapsed {
            Err("directory-map:time-limit".to_owned())
        } else {
            Ok(())
        }
    };
    check_time()?;
    if !root.is_absolute() {
        return Err("directory-map:absolute-directory-required".into());
    }
    let canonical = fs::canonicalize(root).map_err(|error| scan_error("root", error))?;
    if !fs::metadata(&canonical)
        .map_err(|error| scan_error("root", error))?
        .is_dir()
    {
        return Err("directory-map:not-directory".into());
    }
    check_time()?;
    let root = shell_path(&canonical)?;
    let directory = fs::read_dir(&canonical).map_err(|error| scan_error("read", error))?;
    let mut entries = Vec::new();
    let mut bytes = root.len();
    if bytes > max_bytes {
        return Err("directory-map:size-limit".into());
    }
    for entry in directory {
        check_time()?;
        if entries.len() >= max_entries {
            return Err("directory-map:entry-limit".into());
        }
        let entry = entry.map_err(|error| scan_error("read-entry", error))?;
        let file_type = entry
            .file_type()
            .map_err(|error| scan_error("entry-type", error))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "directory-map:invalid-name".to_owned())?;
        let path = shell_path(&canonical.join(&name))?;
        bytes = bytes.saturating_add(path.len()).saturating_add(name.len());
        if bytes > max_bytes {
            return Err("directory-map:size-limit".into());
        }
        // DirEntry::file_type does not follow symlinks. Windows preserves whether
        // a directory symlink/junction is a folder even when its target is offline.
        #[cfg(windows)]
        let is_folder = {
            use std::os::windows::fs::FileTypeExt;
            file_type.is_dir() || file_type.is_symlink_dir()
        };
        #[cfg(not(windows))]
        let is_folder = file_type.is_dir();
        entries.push(DirectoryEntry {
            path,
            name,
            kind: if is_folder { "folder" } else { "file" },
        });
    }
    check_time()?;
    // Repeatability avoids incidental filesystem enumeration order reshuffling UI.
    entries.sort_by(|a, b| (a.kind != "folder", &a.name).cmp(&(b.kind != "folder", &b.name)));
    check_time()?;
    Ok(DirectorySnapshot { root, entries })
}

fn scan_error(operation: &str, error: std::io::Error) -> String {
    // ErrorKind conveys actionable failures without including private local paths.
    format!("directory-map:{operation}:{:?}", error.kind())
}

fn shell_path(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or_else(|| "directory-map:invalid-path".to_owned())?;
    Ok(if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    })
}

/// An incomplete, inaccessible or oversized directory never produces a partial
/// successful snapshot. Scan budgets are checked between OS calls; an unresponsive
/// network filesystem may still block an individual OS call in this worker.
#[tauri::command]
pub async fn file_directory_snapshot(root: String) -> Result<DirectorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_with_limits(Path::new(&root), MAX_ENTRIES, MAX_BYTES, MAX_ELAPSED)
    })
    .await
    .map_err(|_| "directory-map:worker-failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "nimbus-directory-map-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn scan(&self) -> Result<DirectorySnapshot, String> {
            snapshot_with_limits(&self.0, 5_000, 4 * 1024 * 1024, Duration::from_secs(3))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn complete_snapshot_tracks_create_rename_and_delete_without_recursing() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("资料.md"), "hello").unwrap();
        fs::create_dir(fixture.0.join("项目")).unwrap();
        fs::write(fixture.0.join("项目").join("private.txt"), "nested").unwrap();
        let snapshot = fixture.scan().unwrap();
        assert_eq!(snapshot.entries.len(), 2);
        let file = snapshot
            .entries
            .iter()
            .find(|entry| entry.name == "资料.md")
            .unwrap();
        assert_eq!(file.kind, "file");
        assert_eq!(
            Path::new(&file.path).parent(),
            Some(Path::new(&snapshot.root))
        );
        assert!(
            snapshot
                .entries
                .iter()
                .any(|entry| entry.name == "项目" && entry.kind == "folder")
        );
        fs::rename(fixture.0.join("资料.md"), fixture.0.join("重命名.md")).unwrap();
        assert!(
            fixture
                .scan()
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "重命名.md")
        );
        fs::remove_file(fixture.0.join("重命名.md")).unwrap();
        assert_eq!(fixture.scan().unwrap().entries.len(), 1);
    }

    #[test]
    fn invalid_or_missing_root_fails_instead_of_returning_an_empty_snapshot() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("file.txt"), "file").unwrap();
        for root in [
            PathBuf::from("relative"),
            fixture.0.join("missing"),
            fixture.0.join("file.txt"),
        ] {
            assert!(snapshot_with_limits(&root, 10, 1024, Duration::from_secs(3)).is_err());
        }
        assert_eq!(fixture.scan().unwrap().entries.len(), 1);
    }

    #[test]
    fn exceeded_entry_byte_or_time_budget_fails_as_a_whole() {
        let fixture = Fixture::new();
        assert!(snapshot_with_limits(&fixture.0, 3, 1, Duration::from_secs(3)).is_err());
        for name in ["one.txt", "two.txt", "three.txt"] {
            fs::write(fixture.0.join(name), "").unwrap();
        }
        assert!(snapshot_with_limits(&fixture.0, 2, 4096, Duration::from_secs(3)).is_err());
        assert!(snapshot_with_limits(&fixture.0, 3, 1, Duration::from_secs(3)).is_err());
        assert!(snapshot_with_limits(&fixture.0, 3, 4096, Duration::ZERO).is_err());
        assert_eq!(
            snapshot_with_limits(&fixture.0, 3, 4096, Duration::from_secs(3))
                .unwrap()
                .entries
                .len(),
            3
        );
    }

    #[test]
    fn root_dot_segments_are_canonicalized_and_sibling_contents_are_excluded() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("root")).unwrap();
        fs::create_dir(fixture.0.join("sibling")).unwrap();
        fs::write(fixture.0.join("sibling").join("not-mapped.txt"), "").unwrap();
        let snapshot = snapshot_with_limits(
            &fixture.0.join("root").join(".."),
            10,
            4096,
            Duration::from_secs(3),
        )
        .unwrap();
        assert_eq!(snapshot.entries.len(), 2);
        assert!(!snapshot.root.contains(".."));
        let empty = snapshot_with_limits(&fixture.0.join("root"), 10, 4096, Duration::from_secs(3))
            .unwrap();
        assert!(empty.entries.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn broken_file_links_are_kept_without_following_their_targets() {
        let fixture = Fixture::new();
        // Windows permits this when Developer Mode or symlink privilege is available.
        if std::os::windows::fs::symlink_file(
            fixture.0.join("missing"),
            fixture.0.join("broken.lnk"),
        )
        .is_err()
        {
            return;
        }
        let snapshot = fixture.scan().unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].name, "broken.lnk");
    }

    #[cfg(windows)]
    #[test]
    fn directory_links_keep_their_local_path_and_do_not_recurse_into_loops() {
        let fixture = Fixture::new();
        if std::os::windows::fs::symlink_dir(&fixture.0, fixture.0.join("loop")).is_err() {
            return;
        }
        let snapshot = fixture.scan().unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].kind, "folder");
        assert_eq!(snapshot.entries[0].name, "loop");
        assert_eq!(
            Path::new(&snapshot.entries[0].path),
            Path::new(&snapshot.root).join("loop")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loops_and_broken_links_are_entries_and_never_traversed() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(&fixture.0, fixture.0.join("loop")).unwrap();
        std::os::unix::fs::symlink(fixture.0.join("missing"), fixture.0.join("broken")).unwrap();
        assert_eq!(fixture.scan().unwrap().entries.len(), 2);
    }
}
