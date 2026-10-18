//! Project documents: roots come from saved project state, never from a caller's root argument.
use crate::{commands::data, database};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 12 * 1024 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocument {
    pub kind: String,
    pub content: Option<String>,
    pub data_url: Option<String>,
}

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name != name.trim()
        || name.ends_with('.')
        || name.ends_with(' ')
        || name == "."
        || name == ".."
        || name.chars().any(|c| c < ' ' || "\\/:*?\"<>|".contains(c))
    {
        return Err("invalid-name".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
            })
        })
    {
        return Err("reserved-name".into());
    }
    Ok(())
}
fn confined(root: &Path, relative: &str, allow_root: bool) -> Result<PathBuf, String> {
    database::reject_link_components(root)?;
    if !root.is_dir() {
        return Err("root-missing".into());
    }
    if relative.is_empty() {
        return if allow_root {
            Ok(root.to_owned())
        } else {
            Err("root-protected".into())
        };
    }
    let mut target = root.to_owned();
    for part in relative.split(['/', '\\']) {
        valid_name(part)?;
        target.push(part);
    }
    database::reject_link_components(&target)?;
    // Each component is a plain name; existing ancestors must stay under the canonical root.
    if let Some(existing) = target.ancestors().find(|p| p.exists()) {
        let canonical = fs::canonicalize(existing).map_err(|e| e.to_string())?;
        let bound = fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !canonical.starts_with(bound) {
            return Err("outside-project".into());
        }
    }
    Ok(target)
}
fn saved_project<'a>(state: &'a Value, id: &str) -> Result<&'a Value, String> {
    state
        .get("state")
        .and_then(|s| s.get("projects"))
        .and_then(Value::as_array)
        .and_then(|projects| {
            projects
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
        })
        .ok_or_else(|| "project-not-found".into())
}
fn root_from_state(state: &Value, id: &str, data_root: &Path) -> Result<PathBuf, String> {
    let project = saved_project(state, id)?;
    let folder = project
        .get("folder")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or("project-folder-unbound")?;
    valid_name(id)?;
    let managed = format!("modules/projects/materials/{id}");
    let root = if Path::new(folder).is_absolute() {
        PathBuf::from(folder)
    } else if folder == managed {
        data_root.join(&managed)
    } else {
        return Err("invalid-project-root".into());
    };
    database::reject_link_components(&root)?;
    if !root.is_dir() {
        return Err("root-missing".into());
    }
    fs::canonicalize(root).map_err(|e| e.to_string())
}
async fn with_root<T: Send + 'static>(
    id: String,
    action: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        data::with_data_dir(|data_root| {
            let state = database::read_at(data_root, "projects")?.ok_or("project-not-found")?;
            action(&root_from_state(&state, &id, data_root)?)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
// Shell APIs such as SHFileOperationW reject the canonical extended-length prefix.
fn shell_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
}
fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn list_at(root: &Path, relative: &str) -> Result<Vec<ProjectFile>, String> {
    let target = confined(root, relative, true)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if database::reject_link_components(&entry.path()).is_err() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() && !metadata.is_dir() {
            continue;
        }
        if files.len() >= 10000 {
            return Err("too-many-files".into());
        }
        files.push(ProjectFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: relative_path(root, &entry.path()),
            directory: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    files.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}
fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}
fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("not-a-file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("preview-too-large".into());
    }
    Ok(bytes)
}
fn read_at(root: &Path, relative: &str) -> Result<ProjectDocument, String> {
    let path = confined(root, relative, false)?;
    let ext = extension(&path);
    if ["txt", "md", "markdown"].contains(&ext.as_str()) {
        return Ok(ProjectDocument {
            kind: if ext == "txt" { "text" } else { "markdown" }.into(),
            content: Some(
                String::from_utf8(read_limited(&path, TEXT_LIMIT)?).map_err(|_| "text-not-utf8")?,
            ),
            data_url: None,
        });
    }
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "",
    };
    if !mime.is_empty() {
        return Ok(ProjectDocument {
            kind: "image".into(),
            content: None,
            data_url: Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(read_limited(&path, IMAGE_LIMIT)?)
            )),
        });
    }
    if !path.is_file() {
        return Err("not-a-file".into());
    }
    Ok(ProjectDocument {
        kind: "external".into(),
        content: None,
        data_url: None,
    })
}
fn create_at(root: &Path, relative: &str, name: &str, kind: &str) -> Result<String, String> {
    valid_name(name)?;
    let parent = confined(root, relative, true)?;
    if !parent.is_dir() {
        return Err("parent-missing".into());
    }
    let filename = match kind {
        "folder" => name.to_owned(),
        "text" => {
            if name.to_lowercase().ends_with(".txt") {
                name.to_owned()
            } else {
                format!("{name}.txt")
            }
        }
        "markdown" => {
            if ["md", "markdown"].contains(&extension(Path::new(name)).as_str()) {
                name.to_owned()
            } else {
                format!("{name}.md")
            }
        }
        _ => return Err("invalid-kind".into()),
    };
    let target = parent.join(filename);
    database::reject_link_components(&target)?;
    if kind == "folder" {
        fs::create_dir(&target).map_err(|e| e.to_string())?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
    }
    Ok(relative_path(root, &target))
}
fn write_text_at(root: &Path, relative: &str, expected: &str, content: &str) -> Result<(), String> {
    let path = confined(root, relative, false)?;
    if !["md", "txt", "markdown"].contains(&extension(&path).as_str()) {
        return Err("not-editable".into());
    }
    if content.len() as u64 > TEXT_LIMIT {
        return Err("preview-too-large".into());
    }
    if read_limited(&path, TEXT_LIMIT)? != expected.as_bytes() {
        return Err("file-conflict".into());
    }
    let temp = path.parent().ok_or("parent-missing")?.join(format!(
        ".nimbus-project-save-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        database::reject_link_components(&path)?;
        if read_limited(&path, TEXT_LIMIT)? != expected.as_bytes() {
            return Err("file-conflict".into());
        }
        fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    if temp.exists() {
        let _ = fs::remove_file(temp);
    }
    result
}
// Preflight the entire source before creating anything; imports never follow junctions.
fn inspect_tree(path: &Path, depth: usize, count: &mut usize) -> Result<(), String> {
    database::reject_link_components(path)?;
    *count += 1;
    if depth > 64 || *count > 10000 {
        return Err("import-too-large".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            inspect_tree(&entry.map_err(|e| e.to_string())?.path(), depth + 1, count)?;
        }
    } else if !metadata.is_file() {
        return Err("unsupported-file-type".into());
    }
    Ok(())
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    database::reject_link_components(source)?;
    database::reject_link_components(destination)?;
    if source.is_dir() {
        fs::create_dir(destination).map_err(|e| e.to_string())?;
        let result = (|| {
            for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(destination);
        }
        result
    } else {
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| e.to_string())?;
        let result = std::io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string());
        drop(output);
        if result.is_err() {
            let _ = fs::remove_file(destination);
        }
        result
    }
}
fn transfer_at(root: &Path, relative: &str, destination: &str) -> Result<String, String> {
    let source = confined(root, relative, false)?;
    let target = confined(root, destination, false)?;
    if source == target {
        return Ok(relative.to_owned());
    }
    if target.starts_with(&source) {
        return Err("destination-inside-source".into());
    }
    if target.exists() {
        return Err("already-exists".into());
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err("parent-missing".into());
    }
    inspect_tree(&source, 0, &mut 0)?;
    fs::rename(source, target).map_err(|e| e.to_string())?;
    Ok(destination.replace('\\', "/"))
}
fn import_at(
    root: &Path,
    source: &Path,
    relative: &str,
    move_source: bool,
) -> Result<String, String> {
    database::reject_link_components(source)?;
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let parent = confined(root, relative, true)?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if parent.starts_with(&source) {
        return Err("destination-inside-source".into());
    }
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("invalid-name")?;
    valid_name(name)?;
    let destination = parent.join(name);
    if destination.exists() {
        return Err("already-exists".into());
    }
    inspect_tree(&source, 0, &mut 0)?;
    // Copy first even across volumes. Never remove a source until the complete copy is durable.
    copy_tree(&source, &destination)?;
    if move_source {
        database::reject_link_components(&source)?;
        let result = if source.is_dir() {
            fs::remove_dir_all(&source)
        } else {
            fs::remove_file(&source)
        };
        result.map_err(|e| format!("copy-succeeded-source-retained: {e}"))?;
    }
    Ok(relative_path(root, &destination))
}

#[tauri::command]
pub async fn project_create_root(project_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        data::with_data_dir(|root| {
            valid_name(&project_id)?;
            let state = database::read_at(root, "projects")?.ok_or("project-not-found")?;
            let project = saved_project(&state, &project_id)?;
            if project
                .get("folder")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.is_empty())
            {
                return Err("project-folder-already-bound".into());
            }
            let relative = format!("modules/projects/materials/{project_id}");
            let target = root.join(&relative);
            database::reject_link_components(&target)?;
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            Ok(relative)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn project_list_files(
    project_id: String,
    path: String,
) -> Result<Vec<ProjectFile>, String> {
    with_root(project_id, move |r| list_at(r, &path)).await
}
#[tauri::command]
pub async fn project_read_file(
    project_id: String,
    path: String,
) -> Result<ProjectDocument, String> {
    with_root(project_id, move |r| read_at(r, &path)).await
}
#[tauri::command]
pub async fn project_write_text(
    project_id: String,
    path: String,
    expected: String,
    content: String,
) -> Result<(), String> {
    with_root(project_id, move |r| {
        write_text_at(r, &path, &expected, &content)
    })
    .await
}
#[tauri::command]
pub async fn project_create_entry(
    project_id: String,
    path: String,
    name: String,
    kind: String,
) -> Result<String, String> {
    with_root(project_id, move |r| create_at(r, &path, &name, &kind)).await
}
#[tauri::command]
pub async fn project_transfer_file(
    project_id: String,
    path: String,
    destination: String,
) -> Result<String, String> {
    with_root(project_id, move |r| transfer_at(r, &path, &destination)).await
}
#[tauri::command]
pub async fn project_import_file(
    project_id: String,
    source: String,
    path: String,
    move_source: bool,
) -> Result<String, String> {
    with_root(project_id, move |r| {
        import_at(r, Path::new(&source), &path, move_source)
    })
    .await
}
#[tauri::command]
pub async fn project_trash_file(project_id: String, path: String) -> Result<(), String> {
    let target = with_root(project_id, move |r| {
        let target = confined(r, &path, false)?;
        inspect_tree(&target, 0, &mut 0)?;
        Ok(shell_path(&target))
    })
    .await?;
    super::fileops::delete_entry(target).await
}
#[tauri::command]
pub async fn project_open_file(project_id: String, path: String) -> Result<(), String> {
    with_root(project_id, move |r| {
        let target = confined(r, &path, true)?;
        if !target.exists() {
            return Err("not-found".into());
        }
        tauri_plugin_opener::open_path(shell_path(&target), None::<&str>).map_err(|e| e.to_string())
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nimbus-project-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn project_files_managed_roots_follow_data_directory_and_reject_other_relative_bindings() {
        let old = Fixture::new();
        let moved = Fixture::new();
        let relative = "modules/projects/materials/p";
        std::fs::create_dir_all(old.0.join(relative)).unwrap();
        std::fs::create_dir_all(moved.0.join(relative)).unwrap();
        std::fs::write(old.0.join(relative).join("a.txt"), "old").unwrap();
        std::fs::write(moved.0.join(relative).join("a.txt"), "moved").unwrap();
        let state = serde_json::json!({"state":{"projects":[{"id":"p","folder":relative}]}});
        let root = root_from_state(&state, "p", &moved.0).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "moved"
        );
        for binding in [
            "../outside",
            "modules/projects/materials/q",
            "modules/projects/materials/p/../../outside",
            "arbitrary/relative",
        ] {
            let state = serde_json::json!({"state":{"projects":[{"id":"p","folder":binding}]}});
            assert!(
                root_from_state(&state, "p", &moved.0).is_err(),
                "accepted {binding}"
            );
        }
    }
    #[test]
    fn project_files_shell_paths_support_windows_canonical_roots() {
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\notes\file.txt")),
            r"C:\notes\file.txt"
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\server\share\file.txt")),
            r"\\server\share\file.txt"
        );
    }
    #[test]
    fn project_files_reject_escape_reserved_and_root_mutations() {
        let fixture = Fixture::new();
        for path in [
            "../outside",
            "/absolute",
            "C:\\outside",
            "a/../b",
            "a\\..\\b",
            "CON.txt",
            "trailing.",
            "space ",
            "file:stream",
            "a//b",
        ] {
            assert!(
                confined(&fixture.0, path, false).is_err(),
                "accepted {path}"
            );
        }
        assert!(confined(&fixture.0, "", false).is_err());
        assert!(confined(&fixture.0, "", true).is_ok());
    }
    #[test]
    fn project_files_create_list_edit_and_protect_external_changes() {
        let fixture = Fixture::new();
        create_at(&fixture.0, "", "notes.md", "markdown").unwrap();
        write_text_at(&fixture.0, "notes.md", "", "draft").unwrap();
        assert_eq!(
            read_at(&fixture.0, "notes.md").unwrap().content.as_deref(),
            Some("draft")
        );
        std::fs::write(fixture.0.join("notes.md"), "external").unwrap();
        assert_eq!(
            write_text_at(&fixture.0, "notes.md", "draft", "overwrite").unwrap_err(),
            "file-conflict"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("notes.md")).unwrap(),
            "external"
        );
        assert!(create_at(&fixture.0, "", "notes.md", "markdown").is_err());
        assert_eq!(list_at(&fixture.0, "").unwrap().len(), 1);
    }
    #[test]
    fn project_files_import_copies_by_default_and_collision_preserves_source() {
        let root = Fixture::new();
        let source = Fixture::new();
        std::fs::write(source.0.join("source.txt"), "keep").unwrap();
        import_at(&root.0, &source.0.join("source.txt"), "", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(source.0.join("source.txt")).unwrap(),
            "keep"
        );
        assert!(import_at(&root.0, &source.0.join("source.txt"), "", true).is_err());
        assert!(source.0.join("source.txt").exists());
        create_at(&root.0, "", "nested", "folder").unwrap();
        assert!(import_at(&root.0, &root.0, "nested", false).is_err());
        transfer_at(&root.0, "source.txt", "nested/renamed.txt").unwrap();
        assert!(!root.0.join("source.txt").exists());
        assert!(root.0.join("nested/renamed.txt").is_file());
        assert!(transfer_at(&root.0, "nested", "nested/deeper").is_err());
    }
    #[test]
    fn project_files_resolves_only_saved_project_root() {
        let root = Fixture::new();
        let files = Fixture::new();
        let value = serde_json::json!({"state":{"projects":[{"id":"p","folder":files.0.to_string_lossy()}]}});
        assert_eq!(
            root_from_state(&value, "p", &root.0).unwrap(),
            std::fs::canonicalize(&files.0).unwrap()
        );
        assert!(root_from_state(&value, "unknown", &root.0).is_err());
        assert!(
            root_from_state(
                &serde_json::json!({"state":{"projects":[{"id":"p","folder":null}]}}),
                "p",
                &root.0
            )
            .is_err()
        );
        assert!(root.0.is_dir());
    }
    #[cfg(windows)]
    #[test]
    fn project_files_rejects_junctions_in_root_and_import_trees() {
        let root = Fixture::new();
        let outside = Fixture::new();
        let link = root.0.join("jump");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside.0)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(confined(&root.0, "jump/file.txt", false).is_err());
        assert!(list_at(&root.0, "").unwrap().is_empty());
        assert!(import_at(&outside.0, &root.0, "", false).is_err());
        std::fs::remove_dir(&link).unwrap();
    }
}
