use super::{ContentIndex, sources};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    hash::{Hash, Hasher},
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
static INDEXING: AtomicBool = AtomicBool::new(false);
static COUNT: AtomicU64 = AtomicU64::new(0);
static UPDATED: AtomicU64 = AtomicU64::new(0);
static ERROR: Mutex<Option<String>> = Mutex::new(None);
static SHORTCUT_ERROR: Mutex<Option<String>> = Mutex::new(None);
static HISTORY_ERROR: Mutex<Option<String>> = Mutex::new(None);
pub fn set_history_error(error: Option<String>) { if let Ok(mut current)=HISTORY_ERROR.lock(){*current=error;} }
pub fn set_shortcut_error(error: Option<String>) {
    if let Ok(mut current) = SHORTCUT_ERROR.lock() {
        *current = error;
    }
}
static SIGNAL: (Mutex<bool>, Condvar) = (Mutex::new(true), Condvar::new());
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn is_indexing() -> bool { INDEXING.load(Ordering::Relaxed) }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub count: u64,
    pub indexing: bool,
    pub last_indexed_at: Option<u64>,
    pub error: Option<String>,
    pub everything_available: bool,
    pub backend: String,
    pub files: super::file_runtime::FilesStatus,
    pub everything_path: Option<String>,
}
pub fn preferences() -> Value {
    crate::commands::data::read_current("search-settings")
        .ok()
        .flatten()
        .map(|v| sources::state(&v).clone())
        .unwrap_or_else(|| serde_json::json!({}))
}
pub fn status() -> SearchStatus {
    let settings = preferences();
    let instance = settings
        .get("everythingInstance")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (_, ipc, ready, _) = super::everything_app::probe(instance);
    let available = ipc && ready == Some(true);
    if available { super::everything_app::clear_start_error(); }
    let preferred = settings
        .get("fileBackend")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    SearchStatus {
        count: COUNT.load(Ordering::Relaxed),
        indexing: INDEXING.load(Ordering::Relaxed),
        last_indexed_at: match UPDATED.load(Ordering::Relaxed) {
            0 => None,
            v => Some(v),
        },
        error: {
            let errors = [
                ERROR.lock().ok().and_then(|v| v.clone()),
                SHORTCUT_ERROR.lock().ok().and_then(|v| v.clone()),
                HISTORY_ERROR.lock().ok().and_then(|v|v.clone()),
                super::everything_app::last_start_error(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            (!errors.is_empty()).then(|| errors.join("；"))
        },
        everything_available: available,
        backend: if preferred == "windows" || (preferred != "everything" && !available) {
            "windows".into()
        } else {
            "everything".into()
        },
        files: super::file_runtime::status(),
        everything_path: super::everything_app::locate(
            settings.get("everythingPath").and_then(Value::as_str),
            None,
            instance,
        )
        .map(|p| p.to_string_lossy().into_owned()),
    }
}
pub fn request_refresh() {
    if let Ok(mut requested) = SIGNAL.0.lock() {
        *requested = true;
        SIGNAL.1.notify_one();
    }
}
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            if let Ok(mut requested) = SIGNAL.0.lock() {
                if !*requested {
                    requested = match SIGNAL.1.wait_timeout(requested, Duration::from_secs(10)) {
                        Ok((value, _)) => value,
                        Err(_) => return,
                    };
                }
                *requested = false;
            }
            INDEXING.store(true, Ordering::Relaxed);
            let _ = app.emit("search://status", status());
            match rebuild() {
                Ok((count, changed, warnings)) => {
                    COUNT.store(count, Ordering::Relaxed);
                    if changed || UPDATED.load(Ordering::Relaxed) == 0 {
                        UPDATED.store(now(), Ordering::Relaxed);
                    }
                    if let Ok(mut error) = ERROR.lock() {
                        *error = if warnings.is_empty() {
                            None
                        } else {
                            Some(warnings.join("；"))
                        };
                    }
                }
                Err(error) => {
                    if let Ok(mut current) = ERROR.lock() {
                        *current = Some(error);
                    }
                }
            }
            INDEXING.store(false, Ordering::Relaxed);
            let _ = app.emit("search://status", status());
        }
    });
}
fn rebuild() -> Result<(u64, bool, Vec<String>), String> {
    let (root, states, files_items) = crate::commands::data::with_data_dir(|root| {
        let mut values = BTreeMap::new();
        for key in sources::KEYS {
            if let Some(value) = crate::database::read_at(root, key)? {
                values.insert((*key).into(), value);
            }
        }
        // 文件条目已搬进行级表：索引直接读表，不再为建索引反序列化整份文档
        let files_items = crate::database::open_at(root)
            .and_then(|conn| {
                crate::files_table::ensure_schema(&conn)?;
                crate::files_table::search_entries(&conn)
            })
            .unwrap_or_default();
        Ok((root.to_path_buf(), values, files_items))
    })?;
    let knowledge = states.get("knowledge-settings").map(sources::state);
    let vault = knowledge
        .and_then(|s| s.get("vaultRoot"))
        .and_then(Value::as_str);
    let mut warnings = vec![];
    let notes = if let Some(vault) = vault {
        let key = vault
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase();
        let folders = knowledge
            .and_then(|s| s.get("folderBindings"))
            .and_then(|s| s.get(&key))
            .cloned()
            .map(serde_json::from_value::<crate::knowledge::KnowledgeFolders>)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        match sources::note_files(vault, folders) {
            Ok(notes) => notes,
            Err(error) => {
                warnings.push(format!("知识索引：{error}"));
                vec![]
            }
        }
    } else {
        vec![]
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&states)
        .map_err(|e| e.to_string())?
        .hash(&mut hasher);
    for note in &notes {
        note.relative.hash(&mut hasher);
        note.modified.hash(&mut hasher);
        note.size.hash(&mut hasher);
    }
    let stamp = format!("v2-pinyin:{:x}", hasher.finish());
    let mut index = ContentIndex::open(&root)?;
    if index.stamp().as_deref() == Some(&stamp) {
        return Ok((index.count()?, false, warnings));
    }
    let mut documents = sources::from_states(&states, &files_items);
    let mut retry_read = false;
    for file in notes {
        if file.size > 1024 * 1024 {
            warnings.push(format!("{} 仅索引前 1 MiB", file.relative));
        }
        match sources::note_document(vault.unwrap_or_default(), &file) {
            Ok(doc) => documents.push(doc),
            Err(error) => {
                retry_read = true;
                warnings.push(format!("{}：{error}", file.relative));
            }
        }
    }
    let mut bytes = 0;
    let before = documents.len();
    documents.retain_mut(|doc| {
        if bytes >= 64 * 1024 * 1024 {
            return false;
        }
        if doc.body.len() > 1024 * 1024 {
            let mut end = 1024 * 1024;
            while !doc.body.is_char_boundary(end) {
                end -= 1;
            }
            doc.body.truncate(end);
        }
        bytes += doc.body.len();
        true
    });
    if before != documents.len() {
        warnings.push("内容索引达到 64 MiB 上限，部分条目尚未收录".into());
    }
    if documents.len() > 20000 {
        documents.truncate(20000);
        warnings.push("内容索引达到两万条上限".into());
    }
    index.replace(&documents)?;
    if !retry_read {
        index.set_stamp(&stamp)?;
    }
    Ok((index.count()?, true, warnings))
}
