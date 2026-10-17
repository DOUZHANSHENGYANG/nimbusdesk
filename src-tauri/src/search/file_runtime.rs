//! Background metadata/extraction lifecycle. Only configuration is read under
//! the shared data-directory lock; scans, SQLite writes and parsers run outside.
use super::{
    SearchHit,
    file_index::{FileIndex, QueryScope, inside, normalize},
    sources::state,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::Emitter;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesStatus {
    pub running: bool,
    pub paused: bool,
    pub total: u64,
    pub processed: u64,
    pub indexed: u64,
    pub failed: u64,
    pub current: Option<String>,
    pub error: Option<String>,
    pub updated_at: Option<u64>,
    pub name_running: bool,
    pub name_total: u64,
    pub name_indexed: u64,
}
static STATUS: Mutex<Option<FilesStatus>> = Mutex::new(None);
static NAME_ERROR: Mutex<Option<(String, String)>> = Mutex::new(None);
static PAUSED: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static REVISION: AtomicU64 = AtomicU64::new(1);
static SCAN: AtomicU64 = AtomicU64::new(1);
static QUERY_REVISION: AtomicU64 = AtomicU64::new(1);
static QUERY_LOCK: Mutex<()> = Mutex::new(());
static SIGNAL: (Mutex<bool>, Condvar) = (Mutex::new(true), Condvar::new());

pub fn status() -> FilesStatus {
    let mut status = STATUS
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_default();
    status.paused = PAUSED.load(Ordering::Acquire);
    status
}
pub fn request_refresh() {
    REVISION.fetch_add(1, Ordering::AcqRel);
    CANCEL.store(true, Ordering::Release);
    if let Ok(mut requested) = SIGNAL.0.lock() {
        *requested = true;
        SIGNAL.1.notify_one();
    }
}
pub fn pause(paused: bool) {
    PAUSED.store(paused, Ordering::Release);
    request_refresh();
}
fn publish(app: &tauri::AppHandle, update: impl FnOnce(&mut FilesStatus)) {
    if let Ok(mut status) = STATUS.lock() {
        update(status.get_or_insert_with(FilesStatus::default));
    }
    let _ = app.emit("search://files-status", status());
    // Existing search/settings consumers already subscribe to this event.
    let _ = app.emit("search://status", super::runtime::status());
}

struct Snapshot {
    data: PathBuf,
    roots: Vec<PathBuf>,
    scope: QueryScope,
    instance: String,
    enabled: bool,
    derived: bool,
}
fn absolute_directory(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || value.chars().any(char::is_control)
    {
        return Err("索引目录必须是无跳转的绝对路径".into());
    }
    Ok(path.components().collect())
}
fn default_roots(data: &Path, knowledge: Option<&Value>) -> Vec<String> {
    let mut roots = vec![];
    if let Some(knowledge) = knowledge.map(state) {
        if let Some(vault) = knowledge
            .get("vaultRoot")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            let vault_path = Path::new(vault);
            if vault_path.is_absolute() {
                let key = normalize(vault);
                let folders = knowledge
                    .get("folderBindings")
                    .and_then(|v| v.get(&key))
                    .cloned()
                    .and_then(|v| {
                        serde_json::from_value::<crate::knowledge::KnowledgeFolders>(v).ok()
                    })
                    .unwrap_or_default();
                for relative in [
                    folders.experience,
                    folders.recipe,
                    folders.resource,
                    "08-收件箱".into(),
                    "assets/images/工作台".into(),
                ] {
                    let relative = Path::new(&relative);
                    if !relative.is_absolute()
                        && !relative
                            .components()
                            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
                    {
                        roots.push(vault_path.join(relative).to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    roots.push(
        data.join("modules/plans/tasks")
            .to_string_lossy()
            .into_owned(),
    );
    roots
}
fn read_snapshot() -> Result<Snapshot, String> {
    let (data, settings, knowledge) = crate::commands::data::with_data_dir(|root| {
        Ok((
            root.to_path_buf(),
            crate::database::read_at(root, "search-settings")?,
            crate::database::read_at(root, "knowledge-settings")?,
        ))
    })?;
    let settings = settings
        .as_ref()
        .map(state)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let derived = settings.get("documentRoots").is_none_or(Value::is_null);
    let roots = if derived {
        default_roots(&data, knowledge.as_ref())
    } else {
        settings
            .get("documentRoots")
            .and_then(Value::as_array)
            .ok_or("索引目录配置必须是数组")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or("索引目录配置无效".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    if roots.len() > 64 {
        return Err("最多选择 64 个索引目录".into());
    }
    let roots = dedup_roots(
        roots
            .iter()
            .map(|s| absolute_directory(s))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let excludes = settings
        .get("documentExcludes")
        .map(|value| value.as_array().ok_or("排除目录配置必须是数组"))
        .transpose()?
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| absolute_directory(s).map(|p| normalize(&p.to_string_lossy())))
        .collect::<Result<Vec<_>, _>>()?;
    if excludes.len() > 128 {
        return Err("最多设置 128 个排除目录".into());
    }
    let instance = settings
        .get("everythingInstance")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let native_source = if settings.get("fileBackend").and_then(Value::as_str) != Some("windows")
        && super::files::available(&instance)
    {
        Some(format!("everything:{instance}"))
    } else {
        None
    };
    Ok(Snapshot {
        data,
        scope: QueryScope {
            roots: roots
                .iter()
                .map(|p| normalize(&p.to_string_lossy()))
                .collect(),
            excludes,
            content: settings
                .get("documentIndexEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            pinyin: settings
                .get("pinyinEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            native_source,
        },
        roots,
        instance,
        enabled: settings
            .get("documentIndexEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        derived,
    })
}
pub fn defaults() -> Result<Vec<String>, String> {
    let (data, knowledge) = crate::commands::data::with_data_dir(|root| {
        Ok((
            root.to_path_buf(),
            crate::database::read_at(root, "knowledge-settings")?,
        ))
    })?;
    Ok(dedup_roots(
        default_roots(&data, knowledge.as_ref())
            .iter()
            .map(|s| PathBuf::from(s))
            .collect(),
    )
    .iter()
    .map(|p| p.to_string_lossy().into_owned())
    .collect())
}
pub fn query(query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    // Keep rapid typing from queuing many concurrent scans of cached bodies.
    // Waiting requests superseded by a newer keystroke do no SQLite work.
    let revision = QUERY_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let _guard = QUERY_LOCK.lock().map_err(|_| "文件查询状态不可用")?;
    if QUERY_REVISION.load(Ordering::Acquire) != revision {
        return Ok(vec![]);
    }
    let snapshot = read_snapshot()?;
    FileIndex::open(&snapshot.data)?.query(query, limit, &snapshot.scope)
}
fn dedup_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots.sort_by_key(|p| normalize(&p.to_string_lossy()));
    let mut out: Vec<PathBuf> = vec![];
    for root in roots {
        if !out.iter().any(|p| {
            inside(
                &normalize(&root.to_string_lossy()),
                &normalize(&p.to_string_lossy()),
            )
        }) {
            out.push(root);
        }
    }
    out
}

struct Entry {
    path: PathBuf,
    directory: bool,
    stamp: String,
    extract: bool,
}
struct Scan {
    entries: Vec<Entry>,
    complete: Vec<PathBuf>,
    warnings: Vec<String>,
}
fn link_or_hidden(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & (0x400 | 0x2 | 0x4) != 0 {
            return true;
        }
    }
    false
}
fn metadata_stamp(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{modified}:{}", metadata.len())
}
fn supported(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "doc"
            | "xls"
            | "ppt"
            | "txt"
            | "md"
            | "markdown"
            | "json"
            | "jsonc"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "csv"
            | "log"
            | "ini"
            | "conf"
            | "rs"
            | "py"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "java"
            | "kt"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "cs"
            | "go"
            | "rb"
            | "sql"
            | "html"
            | "css"
            | "scss"
            | "sh"
            | "ps1"
            | "vue"
            | "svelte"
    )
}
fn scan(snapshot: &Snapshot, cancel: &AtomicBool) -> Scan {
    let mut scan = Scan {
        entries: vec![],
        complete: vec![],
        warnings: vec![],
    };
    let mut seen = HashSet::new();
    for root in &snapshot.roots {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        if snapshot.derived && !root.exists() {
            continue;
        }
        let before = scan.warnings.len();
        if let Err(error) = crate::database::reject_link_components(root) {
            scan.warnings.push(format!("{}：{error}", root.display()));
            continue;
        }
        walk(root, 0, &snapshot.scope, cancel, &mut scan, &mut seen);
        if scan.warnings.len() == before && !cancel.load(Ordering::Acquire) {
            scan.complete.push(root.clone());
        }
    }
    scan
}
fn walk(
    path: &Path,
    depth: usize,
    scope: &QueryScope,
    cancel: &AtomicBool,
    scan: &mut Scan,
    seen: &mut HashSet<String>,
) {
    if cancel.load(Ordering::Acquire) {
        return;
    }
    let key = normalize(&path.to_string_lossy());
    if scope.excluded(&key) || !seen.insert(key) {
        return;
    }
    if depth > 40 || scan.entries.len() >= 100_000 {
        scan.warnings
            .push("目录索引达到 40 层或十万项上限；未删除原有快照".into());
        return;
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) => {
            scan.warnings.push(format!("{}：{error}", path.display()));
            return;
        }
    };
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if link_or_hidden(&meta)
        || name.starts_with('.')
        || (meta.is_dir()
            && [
                "node_modules",
                "target",
                "vendor",
                "__pycache__",
                "$recycle.bin",
                "system volume information",
            ]
            .contains(&name.to_ascii_lowercase().as_str()))
    {
        return;
    }
    scan.entries.push(Entry {
        path: path.to_path_buf(),
        directory: meta.is_dir(),
        stamp: metadata_stamp(&meta),
        extract: meta.is_file() && supported(path),
    });
    if meta.is_dir() {
        match fs::read_dir(path) {
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        Ok(entry) => walk(&entry.path(), depth + 1, scope, cancel, scan, seen),
                        Err(error) => scan.warnings.push(format!("{}：{error}", path.display())),
                    };
                    if cancel.load(Ordering::Acquire) {
                        break;
                    }
                }
            }
            Err(error) => scan.warnings.push(format!("{}：{error}", path.display())),
        }
    }
}
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_names: Option<(String, Instant)> = None;
        loop {
            let force = match SIGNAL.0.lock() {
                Ok(mut requested) => {
                    if !*requested {
                        requested = match SIGNAL.1.wait_timeout(requested, Duration::from_secs(30))
                        {
                            Ok((v, _)) => v,
                            Err(_) => return,
                        };
                    }
                    let force = *requested;
                    *requested = false;
                    force
                }
                Err(_) => return,
            };
            if PAUSED.load(Ordering::Acquire) {
                publish(&app, |s| {
                    s.running = false;
                    s.name_running = false;
                    s.current = None;
                });
                continue;
            }
            let revision = REVISION.load(Ordering::Acquire);
            CANCEL.store(false, Ordering::Release);
            if REVISION.load(Ordering::Acquire) != revision || PAUSED.load(Ordering::Acquire) {
                CANCEL.store(true, Ordering::Release);
                continue;
            }
            publish(&app, |s| {
                s.running = true;
                s.error = None;
                s.processed = 0;
                s.total = 0;
            });
            let result = update(&app, force, &mut last_names);
            publish(&app, |s| {
                s.running = false;
                s.name_running = false;
                s.current = None;
                if let Err(error) = result {
                    if !CANCEL.load(Ordering::Acquire) {
                        s.error = Some(error);
                    }
                } else {
                    s.updated_at = Some(super::runtime::now());
                }
            });
        }
    });
}
fn update(
    app: &tauri::AppHandle,
    force: bool,
    last_names: &mut Option<(String, Instant)>,
) -> Result<(), String> {
    let snapshot = read_snapshot()?;
    let source = snapshot.scope.native_source.as_deref().unwrap_or_default();
    if snapshot.scope.native_source.is_none()
        || last_names
            .as_ref()
            .is_some_and(|(previous, _)| previous != source)
    {
        publish(app, |s| {
            s.name_running = false;
            s.name_total = 0;
            s.name_indexed = 0;
        });
    }
    let mut index = FileIndex::open(&snapshot.data)?;
    let generation =
        super::runtime::now().saturating_mul(1000) + SCAN.fetch_add(1, Ordering::Relaxed) % 1000;
    let mut scan = scan(&snapshot, &CANCEL);
    if CANCEL.load(Ordering::Acquire) {
        return Ok(());
    }
    let total = if snapshot.enabled {
        scan.entries.iter().filter(|e| e.extract).count() as u64
    } else {
        0
    };
    publish(app, |s| {
        s.total = total;
    });
    for batch in scan.entries.chunks(256) {
        if CANCEL.load(Ordering::Acquire) {
            return Ok(());
        }
        index.names(
            &batch
                .iter()
                .map(|entry| (entry.path.to_string_lossy().into_owned(), entry.directory))
                .collect::<Vec<_>>(),
            false,
            generation,
        )?;
        // Invalidate all detected modifications before starting slow parsing.
        for entry in batch.iter().filter(|e| e.extract) {
            index.invalidate_changed(&entry.path.to_string_lossy(), &entry.stamp)?;
        }
    }
    // Safe pruning happens only for roots with a complete metadata traversal.
    for root in &scan.complete {
        index.finish_scope(&root.to_string_lossy(), generation)?;
    }
    let mut processed = 0;
    let mut last_emit = Instant::now();
    if snapshot.enabled {
        for entry in scan.entries.iter().filter(|e| e.extract) {
            if CANCEL.load(Ordering::Acquire) {
                return Ok(());
            }
            let display = entry.path.to_string_lossy();
            if index.needs_content(&display, &entry.stamp, force)? {
                publish(app, |s| {
                    s.current = entry
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned());
                });
                let body = super::extract_worker::extract(&entry.path, &CANCEL);
                if CANCEL.load(Ordering::Acquire) {
                    return Ok(());
                }
                // A document edited while its worker was reading must be
                // reparsed next cycle, never stamped as the newer version.
                let unchanged = fs::metadata(&entry.path)
                    .ok()
                    .is_some_and(|meta| metadata_stamp(&meta) == entry.stamp);
                if unchanged {
                    index.content(&display, &entry.stamp, body)?;
                }
            }
            processed += 1;
            if last_emit.elapsed() > Duration::from_millis(350) || processed == total {
                let (indexed, failed) = index.counts(&snapshot.scope)?;
                publish(app, |s| {
                    s.processed = processed;
                    s.indexed = indexed;
                    s.failed = failed;
                });
                last_emit = Instant::now();
            }
        }
    }
    if snapshot.scope.pinyin
        && snapshot.scope.native_source.is_some()
        && (force
            || last_names.as_ref().is_none_or(|(previous, t)| {
                previous != source || t.elapsed() > Duration::from_secs(600)
            }))
    {
        publish(app, |s| {
            s.name_running = true;
            s.name_indexed = 0;
            s.name_total = 0;
        });
        let mut processed = 0;
        let enumerated =
            super::name_enum::enumerate(&snapshot.instance, &CANCEL, |names, total| {
                if CANCEL.load(Ordering::Acquire) {
                    return Err("文件索引已取消".into());
                }
                let count = names.len() as u64;
                index.names_for_source(
                    &names
                        .into_iter()
                        .filter(|name| !snapshot.scope.excluded(&normalize(&name.path)))
                        .map(|name| (name.path, name.directory))
                        .collect::<Vec<_>>(),
                    true,
                    generation,
                    snapshot.scope.native_source.as_deref().unwrap_or_default(),
                )?;
                processed += count;
                publish(app, |s| {
                    s.name_total = total;
                    s.name_indexed = processed;
                });
                Ok(())
            });
        if CANCEL.load(Ordering::Acquire) {
            return Ok(());
        }
        match enumerated {
            Ok(_) => {
                index.finish_native(
                    generation,
                    snapshot.scope.native_source.as_deref().unwrap_or_default(),
                )?;
                *last_names = Some((source.to_string(), Instant::now()));
                if let Ok(mut error) = NAME_ERROR.lock() {
                    *error = None;
                }
            }
            Err(error) => {
                *last_names = if error.contains("上限") {
                    Some((source.to_string(), Instant::now()))
                } else {
                    None
                };
                if let Ok(mut current) = NAME_ERROR.lock() {
                    *current = Some((source.to_string(), error));
                }
            }
        }
    }
    if snapshot.scope.pinyin {
        if let Some((previous, error)) = NAME_ERROR.lock().ok().and_then(|error| error.clone()) {
            if previous == source && snapshot.scope.native_source.is_some() {
                scan.warnings.push(error);
            }
        }
    }
    scan.warnings
        .extend(index.failure_summary(&snapshot.scope)?);
    let (indexed, failed) = index.counts(&snapshot.scope)?;
    publish(app, |s| {
        s.indexed = indexed;
        s.failed = failed;
        s.processed = processed;
        s.error = if scan.warnings.is_empty() {
            None
        } else {
            Some(
                scan.warnings
                    .into_iter()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("；"),
            )
        };
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_stay_in_managed_folders_and_explicit_empty_is_preserved() {
        let knowledge = serde_json::json!({"state":{"vaultRoot":"C:/vault","folderBindings":{"c:/vault":{"experience":"work/experience","recipe":"work/recipe","resource":"saved"}}}});
        let roots = default_roots(Path::new("C:/app/data"), Some(&knowledge));
        assert!(!roots.iter().any(|p| normalize(p) == "c:/vault"));
        assert!(
            roots
                .iter()
                .any(|p| normalize(p) == "c:/vault/work/experience")
        );
        assert!(dedup_roots(vec![]).is_empty());
        let roots = dedup_roots(vec![
            PathBuf::from("C:/docs/sub"),
            PathBuf::from("C:/docs"),
            PathBuf::from("c:/DOCS"),
        ]);
        assert_eq!(roots.len(), 1);
    }
    #[test]
    fn scan_deduplicates_and_missing_root_never_counts_as_complete() {
        let root = std::env::temp_dir().join(format!(
            "nimbus-file-scan-{}-{}",
            std::process::id(),
            super::super::runtime::now()
        ));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("sub/note.txt"), "hello").unwrap();
        fs::write(root.join("node_modules/hidden.txt"), "skip").unwrap();
        let roots = vec![root.clone(), root.join("sub"), root.join("missing")];
        let snapshot = Snapshot {
            data: root.clone(),
            scope: QueryScope {
                roots: roots
                    .iter()
                    .map(|r| normalize(&r.to_string_lossy()))
                    .collect(),
                excludes: vec![],
                content: true,
                pinyin: true,
                native_source: None,
            },
            roots,
            instance: String::new(),
            enabled: true,
            derived: false,
        };
        let result = scan(&snapshot, &AtomicBool::new(false));
        assert_eq!(result.entries.iter().filter(|e| e.extract).count(), 1);
        assert!(!result.complete.contains(&root.join("missing")));
        assert!(!result.warnings.is_empty());
        // Only remove this unique, explicitly verified temporary test root.
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
