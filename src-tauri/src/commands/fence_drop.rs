//! Move dropped items without replacing existing files. Only the OS performs the move.
use serde::Serialize;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedEntry {
    source: String,
    path: String,
    name: String,
    kind: String,
    source_retained: bool,
}

#[derive(Serialize)]
pub struct MoveFailure {
    source: String,
    error: String,
}

#[derive(Default, Serialize)]
pub struct MoveResult {
    moved: Vec<MovedEntry>,
    failed: Vec<MoveFailure>,
}

#[tauri::command]
pub async fn move_fence_entries(
    paths: Vec<String>,
    destination: String,
) -> Result<MoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || move_entries(&paths, Path::new(&destination)))
        .await
        .map_err(|error| error.to_string())?
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).into()
    }
}

#[cfg(windows)]
fn move_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{MOVEFILE_COPY_ALLOWED, MOVEFILE_WRITE_THROUGH, MoveFileExW},
        core::PCWSTR,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Deliberately omit MOVEFILE_REPLACE_EXISTING. No copy/delete fallback of our own.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xffff))
}

#[cfg(not(windows))]
fn move_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Folder moving is supported on Windows",
        ));
    }
    std::fs::hard_link(source, target)?;
    std::fs::remove_file(source)
}

fn move_one(source: &str, destination: &Path) -> Result<MovedEntry, String> {
    let input = Path::new(source);
    if !input.is_absolute() {
        return Err("请拖入绝对路径的文件".into());
    }
    crate::database::reject_link_components(input)?;
    let canonical = std::fs::canonicalize(input).map_err(|error| error.to_string())?;
    let folder = canonical.is_dir();
    if folder && destination.starts_with(&canonical) {
        return Err("不能把文件夹移动到自身或它的子目录".into());
    }
    let name = canonical
        .file_name()
        .ok_or("不能移动磁盘根目录")?
        .to_string_lossy()
        .into_owned();
    let kind = if folder { "folder" } else { "file" }.to_string();
    if canonical.parent() == Some(destination) {
        return Ok(MovedEntry {
            source: source.into(),
            path: display_path(&canonical),
            name,
            kind,
            source_retained: false,
        });
    }
    for index in 1..=10000 {
        let candidate = if index == 1 {
            name.clone()
        } else if folder {
            format!("{name} ({index})")
        } else {
            let stem = canonical.file_stem().unwrap_or_default().to_string_lossy();
            match canonical.extension() {
                Some(ext) => format!("{stem} ({index}).{}", ext.to_string_lossy()),
                None => format!("{stem} ({index})"),
            }
        };
        let target = destination.join(&candidate);
        // Every target stays directly under the resolved, explicitly chosen category directory.
        if target.parent() != Some(destination) {
            return Err("无效的目标文件名".into());
        }
        if target.exists() {
            continue;
        }
        match move_no_replace(&canonical, &target) {
            Ok(()) => {
                return Ok(MovedEntry {
                    source: source.into(),
                    path: display_path(&target),
                    name: candidate,
                    kind,
                    source_retained: canonical.exists(),
                });
            }
            Err(error) if matches!(error.raw_os_error(), Some(80 | 183)) => continue,
            Err(error) => return Err(format!("{error}（跨磁盘文件夹可先在资源管理器移动）")),
        }
    }
    Err("同名文件过多，请调整名称后重试".into())
}

fn move_entries(paths: &[String], destination: &Path) -> Result<MoveResult, String> {
    if !destination.is_absolute() || !destination.is_dir() {
        return Err("栅格目录不可用".into());
    }
    crate::database::reject_link_components(destination)?;
    let destination = std::fs::canonicalize(destination).map_err(|error| error.to_string())?;
    if paths.len() > 200 {
        return Err("每次最多拖入 200 个文件或文件夹".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = MoveResult::default();
    for source in paths {
        if !seen.insert(source.replace('/', "\\").to_lowercase()) {
            continue;
        }
        match move_one(source, &destination) {
            Ok(entry) => result.moved.push(entry),
            Err(error) => result.failed.push(MoveFailure {
                source: source.clone(),
                error,
            }),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "nimbus-fence-move-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(path.join("source")).unwrap();
            fs::create_dir_all(path.join("target")).unwrap();
            Self(path)
        }
        fn source(&self, name: &str) -> PathBuf {
            self.0.join("source").join(name)
        }
        fn target(&self) -> PathBuf {
            self.0.join("target")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn moves_files_without_replacing_collisions() {
        let f = Fixture::new();
        fs::write(f.source("note.md"), "new").unwrap();
        fs::write(f.target().join("note.md"), "existing").unwrap();
        let result =
            move_entries(&[f.source("note.md").to_string_lossy().into()], &f.target()).unwrap();
        assert_eq!(result.moved.len(), 1);
        assert!(result.failed.is_empty());
        assert!(!f.source("note.md").exists());
        assert_eq!(
            fs::read_to_string(f.target().join("note.md")).unwrap(),
            "existing"
        );
        assert_eq!(fs::read_to_string(&result.moved[0].path).unwrap(), "new");
        assert_eq!(result.moved[0].name, "note (2).md");
    }
    #[test]
    fn moves_a_folder_with_contents_and_treats_existing_target_as_noop() {
        let f = Fixture::new();
        fs::create_dir(f.source("folder")).unwrap();
        fs::write(f.source("folder").join("a.txt"), "kept").unwrap();
        let result =
            move_entries(&[f.source("folder").to_string_lossy().into()], &f.target()).unwrap();
        assert_eq!(result.moved.len(), 1);
        assert!(!f.source("folder").exists());
        assert_eq!(
            fs::read_to_string(f.target().join("folder/a.txt")).unwrap(),
            "kept"
        );
        let again = move_entries(&[result.moved[0].path.clone()], &f.target()).unwrap();
        assert_eq!(again.moved[0].path, result.moved[0].path);
    }
    #[test]
    fn refuses_moving_a_folder_inside_itself_and_keeps_the_source() {
        let f = Fixture::new();
        fs::create_dir_all(f.source("folder/child")).unwrap();
        fs::write(f.source("folder/a.txt"), "safe").unwrap();
        let result = move_entries(
            &[f.source("folder").to_string_lossy().into()],
            &f.source("folder/child"),
        )
        .unwrap();
        assert!(result.moved.is_empty());
        assert_eq!(result.failed.len(), 1);
        assert!(f.source("folder/a.txt").exists());
    }
    #[test]
    fn missing_items_do_not_abort_successful_items_and_duplicate_drops_are_ignored() {
        let f = Fixture::new();
        fs::write(f.source("ok.txt"), "safe").unwrap();
        let source = f.source("ok.txt").to_string_lossy().into_owned();
        let result = move_entries(
            &[
                f.source("missing").to_string_lossy().into(),
                source.clone(),
                source,
            ],
            &f.target(),
        )
        .unwrap();
        assert_eq!(result.moved.len(), 1);
        assert_eq!(result.failed.len(), 1);
    }
    #[test]
    fn invalid_destination_does_not_touch_any_source() {
        let f = Fixture::new();
        fs::write(f.source("ok.txt"), "safe").unwrap();
        assert!(
            move_entries(
                &[f.source("ok.txt").to_string_lossy().into()],
                &f.target().join("missing")
            )
            .is_err()
        );
        assert!(f.source("ok.txt").exists());
    }
    #[cfg(windows)]
    #[test]
    fn moves_a_file_across_volumes_using_only_system_move() {
        let Ok(root) = std::env::var("NIMBUS_TEST_SECOND_VOLUME") else {
            return;
        };
        let root = std::fs::canonicalize(root).unwrap();
        let f = Fixture::new();
        let target = root.join(f.0.file_name().unwrap());
        assert_eq!(target.parent(), Some(root.as_path()));
        fs::create_dir(&target).unwrap();
        let source = f.source("cross-volume.bin");
        let bytes = [0, 1, 127, 255, 42];
        fs::write(&source, bytes).unwrap();
        let result = move_entries(&[source.to_string_lossy().into()], &target).unwrap();
        assert_eq!(result.moved.len(), 1);
        assert!(!source.exists());
        assert_eq!(fs::read(&result.moved[0].path).unwrap(), bytes);
        fs::remove_file(target.join("cross-volume.bin")).unwrap();
        fs::remove_dir(&target).unwrap();
    }
}
