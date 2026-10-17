//! Owned task attachment bytes. Metadata stays in the plans state.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ADD_FILES: usize = 20;
const MAX_BACKUP_FILES: usize = 4096;
const MAX_BACKUP_BYTES: u64 = 128 * 1024 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub created_at: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFile {
    pub path: String,
    pub data_base64: String,
}

fn io_error(context: &str, error: std::io::Error) -> String {
    format!("{context}: {error}")
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// Examine every component, including the data root and source ancestors.
fn checked_metadata(path: &Path) -> Result<fs::Metadata, String> {
    if !path.is_absolute() {
        return Err("Attachment paths must be absolute".into());
    }
    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err("Attachment paths cannot contain traversal".into());
        }
    }
    let mut final_meta = None;
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let meta =
            fs::symlink_metadata(ancestor).map_err(|e| io_error("Inspect attachment path", e))?;
        if is_link(&meta) {
            return Err("Attachment links and reparse points are not allowed".into());
        }
        final_meta = Some(meta);
    }
    final_meta.ok_or_else(|| "Invalid attachment path".into())
}

fn device_name(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}
fn valid_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || device_name(value)
    {
        return Err("Invalid attachment task or file ID".into());
    }
    Ok(())
}
fn safe_name(value: &str) -> Result<String, String> {
    let clean: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_end_matches([' ', '.']).to_string();
    if clean.is_empty() || clean == "." || clean == ".." || clean.len() > 240 || device_name(&clean)
    {
        return Err("Invalid attachment file name".into());
    }
    Ok(clean)
}
fn owned_parts(path: &str) -> Result<Vec<&str>, String> {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 7 || parts[..3] != ["modules", "plans", "tasks"] || parts[4] != "attachments"
    {
        return Err("Path is not an owned task attachment".into());
    }
    valid_id(parts[3])?;
    valid_id(parts[5])?;
    if safe_name(parts[6])? != parts[6] {
        return Err("Invalid owned attachment file name".into());
    }
    Ok(parts)
}
fn ensure_directories(root: &Path, parts: &[&str]) -> Result<PathBuf, String> {
    if !checked_metadata(root)?.is_dir() {
        return Err("Attachment data root must be a directory".into());
    }
    let mut current = root.to_path_buf();
    for part in parts {
        current.push(part);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io_error("Create attachment directory", e)),
        }
        if !checked_metadata(&current)?.is_dir() {
            return Err("Attachment ancestor is not a directory".into());
        }
    }
    Ok(current)
}
fn open_regular(path: &Path) -> Result<fs::File, String> {
    let meta = checked_metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err("Attachment must be a regular file of at most 64 MiB".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the link itself if an attacker swaps the final component after validation.
        options.custom_flags(0x00200000);
    }
    let file = options
        .open(path)
        .map_err(|e| io_error("Open attachment", e))?;
    let opened = file
        .metadata()
        .map_err(|e| io_error("Inspect open attachment", e))?;
    if is_link(&opened) || !opened.is_file() || opened.len() != meta.len() {
        return Err("Attachment changed while opening".into());
    }
    Ok(file)
}
fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = open_regular(path)?;
    let before = file
        .metadata()
        .map_err(|e| io_error("Inspect attachment", e))?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error("Read attachment", e))?;
    let after = file
        .metadata()
        .map_err(|e| io_error("Recheck attachment", e))?;
    let current = checked_metadata(path)?;
    if bytes.len() as u64 > MAX_FILE_BYTES
        || before.len() != bytes.len() as u64
        || after.len() != before.len()
        || current.len() != before.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Attachment changed while reading".into());
    }
    Ok(bytes)
}
fn new_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    checked_metadata(path.parent().ok_or("Invalid attachment parent")?)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| io_error("Create owned attachment", e))?;
    let written = (|| {
        file.write_all(bytes)
            .map_err(|e| io_error("Write attachment", e))?;
        file.sync_all()
            .map_err(|e| io_error("Flush attachment", e))?;
        if checked_metadata(path)?.len() != bytes.len() as u64 {
            return Err("Copied attachment size mismatch".into());
        }
        Ok(())
    })();
    drop(file);
    if written.is_err() {
        let _ = fs::remove_file(path);
    }
    written
}

pub(crate) fn add_files(
    root: &Path,
    task_id: &str,
    paths: &[String],
) -> Result<Vec<TaskAttachment>, String> {
    valid_id(task_id)?;
    if paths.len() > MAX_ADD_FILES {
        return Err("At most 20 attachments may be added at once".into());
    }
    let mut sources = Vec::new();
    let mut total = 0u64;
    // Validate the complete batch before creating any owned files.
    for source in paths {
        let path = PathBuf::from(source);
        let name = safe_name(
            path.file_name()
                .and_then(|n| n.to_str())
                .ok_or("Attachment name must be valid Unicode")?,
        )?;
        let file = open_regular(&path)?;
        let size = file
            .metadata()
            .map_err(|e| io_error("Inspect attachment", e))?
            .len();
        total = total
            .checked_add(size)
            .ok_or("Attachment batch is too large")?;
        if total > MAX_BATCH_BYTES {
            return Err("Attachment batch exceeds 256 MiB".into());
        }
        sources.push((path, name, size));
    }
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let parent = ensure_directories(root, &["modules", "plans", "tasks", task_id, "attachments"])?;
    let mut created_paths = Vec::new();
    let result = (|| {
        let mut attachments = Vec::new();
        for (source, name, expected_size) in sources {
            let bytes = read_regular(&source)?;
            if bytes.len() as u64 != expected_size {
                return Err("Attachment changed after selection".into());
            }
            let (id, directory) = loop {
                let id = new_id();
                let directory = parent.join(&id);
                checked_metadata(&parent)?;
                match fs::create_dir(&directory) {
                    Ok(()) => break (id, directory),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(io_error("Reserve attachment ID", e)),
                }
            };
            let destination = directory.join(&name);
            if let Err(e) = write_new(&destination, &bytes) {
                let _ = fs::remove_dir(&directory);
                return Err(e);
            }
            created_paths.push(destination);
            attachments.push(TaskAttachment {
                path: format!("modules/plans/tasks/{task_id}/attachments/{id}/{name}"),
                id,
                name,
                size: expected_size,
                created_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
        Ok(attachments)
    })();
    if result.is_err() {
        for path in created_paths {
            let _ = fs::remove_file(&path);
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    result
}

pub(crate) fn location(root: &Path, path: &str) -> Result<PathBuf, String> {
    let parts = owned_parts(path)?;
    checked_metadata(root)?;
    let full = parts.iter().fold(root.to_path_buf(), |p, c| p.join(c));
    let _ = open_regular(&full)?;
    Ok(full)
}

pub(crate) fn export_files(root: &Path, paths: &[String]) -> Result<Vec<AttachmentFile>, String> {
    if paths.len() > MAX_BACKUP_FILES {
        return Err("Too many attachments in backup".into());
    }
    let mut result = Vec::new();
    let mut total = 0u64;
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if !seen.insert(path) {
            continue;
        }
        let bytes = read_regular(&location(root, path)?)?;
        total += bytes.len() as u64;
        if total > MAX_BACKUP_BYTES {
            return Err("Attachment backup exceeds 128 MiB".into());
        }
        result.push(AttachmentFile {
            path: path.clone(),
            data_base64: STANDARD.encode(bytes),
        });
    }
    Ok(result)
}

pub(crate) fn import_files(root: &Path, files: &[AttachmentFile]) -> Result<(), String> {
    if files.len() > MAX_BACKUP_FILES {
        return Err("Too many attachments in backup".into());
    }
    let mut decoded = std::collections::BTreeMap::new();
    let mut total = 0u64;
    for file in files {
        owned_parts(&file.path)?;
        if file.data_base64.len() as u64 > (MAX_FILE_BYTES + 2) / 3 * 4 {
            return Err("Backup attachment exceeds 64 MiB".into());
        }
        let bytes = STANDARD
            .decode(&file.data_base64)
            .map_err(|_| "Invalid attachment base64".to_string())?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("Backup attachment exceeds 64 MiB".into());
        }
        total += bytes.len() as u64;
        if total > MAX_BACKUP_BYTES {
            return Err("Attachment backup exceeds 128 MiB".into());
        }
        if let Some(previous) = decoded.get(file.path.as_str()) {
            if previous != &bytes {
                return Err("Conflicting attachment records in backup".into());
            }
        } else {
            decoded.insert(file.path.as_str(), bytes);
        }
    }
    // Validate all existing files before creating anything: restore never overwrites bytes.
    for (path, bytes) in &decoded {
        let parts = owned_parts(path)?;
        let full = parts.iter().fold(root.to_path_buf(), |p, c| p.join(c));
        match fs::symlink_metadata(&full) {
            Ok(_) => {
                if read_regular(&full)? != *bytes {
                    return Err("Existing attachment conflicts with backup".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("Inspect restore destination", e)),
        }
    }
    let mut created = Vec::new();
    let result = (|| {
        for (path, bytes) in &decoded {
            let parts = owned_parts(path)?;
            let parent = ensure_directories(root, &parts[..6])?;
            let full = parent.join(parts[6]);
            match fs::symlink_metadata(&full) {
                Ok(_) => {
                    if read_regular(&full)? != *bytes {
                        return Err("Existing attachment conflicts with backup".into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    write_new(&full, bytes)?;
                    created.push(full);
                }
                Err(e) => return Err(io_error("Inspect restore destination", e)),
            }
        }
        Ok(())
    })();
    if result.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "nimbus-attachments-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn root(&self) -> PathBuf {
            let p = self.0.join("data");
            fs::create_dir_all(&p).unwrap();
            p
        }
        fn source(&self, name: &str, bytes: &[u8]) -> String {
            let p = self.0.join(name);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, bytes).unwrap();
            p.to_str().unwrap().into()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn copies_binary_bytes_into_unique_owned_paths_and_retains_originals() {
        let f = Fixture::new();
        let root = f.root();
        let bytes = [0, 255, 3, 128];
        let a = f.source("a/report.pdf", &bytes);
        let b = f.source("b/report.pdf", b"different");
        let result = add_files(&root, "task_01", &[a.clone(), b]).unwrap();
        assert_eq!(result.len(), 2);
        assert_ne!(result[0].path, result[1].path);
        assert!(
            result[0]
                .path
                .starts_with("modules/plans/tasks/task_01/attachments/")
        );
        assert_eq!(result[0].name, "report.pdf");
        assert_eq!(result[0].size, 4);
        assert!(result[0].created_at > 0);
        assert_eq!(
            fs::read(location(&root, &result[0].path).unwrap()).unwrap(),
            bytes
        );
        assert_eq!(fs::read(a).unwrap(), bytes);
    }
    #[test]
    fn backup_roundtrip_is_exact_and_idempotent_and_rejects_conflicts() {
        let f = Fixture::new();
        let root = f.root();
        let target = f.0.join("restore");
        fs::create_dir(&target).unwrap();
        let records = add_files(&root, "task", &[f.source("data.bin", &[0, 255, 254, 1])]).unwrap();
        let backup = export_files(&root, &[records[0].path.clone()]).unwrap();
        import_files(&target, &backup).unwrap();
        import_files(&target, &backup).unwrap();
        assert_eq!(
            fs::read(location(&target, &records[0].path).unwrap()).unwrap(),
            [0, 255, 254, 1]
        );
        let differing = vec![AttachmentFile {
            path: backup[0].path.clone(),
            data_base64: STANDARD.encode(b"different"),
        }];
        assert!(import_files(&target, &differing).is_err());
        assert_eq!(
            fs::read(location(&target, &records[0].path).unwrap()).unwrap(),
            [0, 255, 254, 1]
        );
        assert!(
            export_files(
                &root,
                &["modules/plans/tasks/task/attachments/id/missing.bin".into()]
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_unowned_paths_and_invalid_ids_and_device_names() {
        let f = Fixture::new();
        let root = f.root();
        let source = f.source("ok.txt", b"ok");
        for id in ["", "..", "x/y", "x\\y", "CON", "NUL.txt", "x:", "a "] {
            assert!(add_files(&root, id, &[source.clone()]).is_err(), "{id}");
        }
        for path in [
            "../outside",
            "C:/outside",
            "/etc/passwd",
            "modules/plans/tasks/t/attachments/i/../x",
            "modules/plans/tasks/t/attachments/i/CON.txt",
            "modules/plans/tasks/t/attachments/i/a.txt:secret",
            "modules\\plans\\tasks\\t\\attachments\\i\\a.txt",
            "modules/plans/tasks/t/attachments/i/a.",
        ] {
            assert!(location(&root, path).is_err(), "{path}");
            assert!(
                import_files(
                    &root,
                    &[AttachmentFile {
                        path: path.into(),
                        data_base64: STANDARD.encode(b"x")
                    }]
                )
                .is_err(),
                "{path}"
            );
        }
        assert!(
            import_files(
                &root,
                &[AttachmentFile {
                    path: "modules/plans/tasks/t/attachments/i/a.bin".into(),
                    data_base64: "???".into()
                }]
            )
            .is_err()
        );
    }
    #[test]
    fn enforces_file_and_batch_limits_before_copying() {
        let f = Fixture::new();
        let root = f.root();
        let source = f.source("large.bin", b"");
        fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(add_files(&root, "task", &[source.clone()]).is_err());
        fs::OpenOptions::new()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        assert!(add_files(&root, "task", &vec![source.clone(); 5]).is_err());
        assert!(add_files(&root, "task", &vec![source; MAX_ADD_FILES + 1]).is_err());
        assert!(add_files(&root, "task", &[f.0.to_str().unwrap().into()]).is_err());
        assert!(!root.join("modules").exists());
    }
    #[test]
    fn restore_preflights_conflicts_before_creating_other_files() {
        let f = Fixture::new();
        let root = f.root();
        let existing = "modules/plans/tasks/t/attachments/z/existing.bin";
        import_files(
            &root,
            &[AttachmentFile {
                path: existing.into(),
                data_base64: STANDARD.encode(b"original"),
            }],
        )
        .unwrap();
        let new_path = "modules/plans/tasks/t/attachments/a/new.bin";
        let result = import_files(
            &root,
            &[
                AttachmentFile {
                    path: new_path.into(),
                    data_base64: STANDARD.encode(b"new"),
                },
                AttachmentFile {
                    path: existing.into(),
                    data_base64: STANDARD.encode(b"conflict"),
                },
            ],
        );
        assert!(result.is_err());
        assert!(!root.join(new_path).exists());
        assert_eq!(fs::read(root.join(existing)).unwrap(), b"original");
    }
    #[test]
    fn sanitization_preserves_extensions_and_rejects_windows_devices() {
        assert_eq!(
            safe_name("report: final?.pdf").unwrap(),
            "report_ final_.pdf"
        );
        assert_eq!(safe_name("会议材料.docx").unwrap(), "会议材料.docx");
        for name in [
            "CON.txt",
            "nul",
            "COM1.pdf",
            "LPT9",
            "com¹.doc",
            "AUX .txt",
            "CONIN$",
            "..",
        ] {
            assert!(safe_name(name).is_err(), "{name}");
        }
    }
    #[cfg(windows)]
    #[test]
    fn location_export_and_import_reject_owned_junctions() {
        let f = Fixture::new();
        let root = f.root();
        let source = f.source("outside/file.bin", b"private");
        let parent = ["modules", "plans", "tasks", "t", "attachments"]
            .iter()
            .fold(root.clone(), |p, name| p.join(name));
        fs::create_dir_all(&parent).unwrap();
        let junction = parent.join("id");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(f.0.join("outside"))
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let path = "modules/plans/tasks/t/attachments/id/file.bin";
        assert!(location(&root, path).is_err());
        assert!(export_files(&root, &[path.into()]).is_err());
        assert!(
            import_files(
                &root,
                &[AttachmentFile {
                    path: path.into(),
                    data_base64: STANDARD.encode(b"private")
                }]
            )
            .is_err()
        );
        assert_eq!(fs::read(source).unwrap(), b"private");
        fs::remove_dir(junction).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn rejects_junctions_in_source_and_owned_destination_ancestors() {
        let f = Fixture::new();
        let root = f.root();
        let source = f.source("original/file.bin", b"private");
        let link = f.0.join("linked");
        // Junctions work without Developer Mode or symlink privileges.
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(f.0.join("original"))
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(
            add_files(
                &root,
                "task",
                &[link.join("file.bin").to_str().unwrap().into()]
            )
            .is_err()
        );
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("modules"))
            .arg(f.0.join("original"))
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(add_files(&root, "task", &[source]).is_err());
        fs::remove_dir(root.join("modules")).unwrap();
        fs::remove_dir(link).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let root = f.root();
        let source = f.source("file.bin", b"private");
        let link = f.0.join("linked.bin");
        symlink(&source, &link).unwrap();
        assert!(add_files(&root, "task", &[link.to_str().unwrap().into()]).is_err());
        symlink(f.0.join("outside"), root.join("modules")).unwrap();
        assert!(add_files(&root, "task", &[source]).is_err());
    }
}
