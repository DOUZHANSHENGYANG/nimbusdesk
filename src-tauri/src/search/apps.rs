//! Windows Start Menu catalog. Only native catalog identities may be activated.
use super::SearchHit;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::Emitter;

const MAX_APPS: usize = 8192;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const CACHE_KEY: &str = "search-apps";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartApp {
    #[serde(alias = "Name")]
    name: String,
    #[serde(alias = "AppId", alias = "AppID")]
    app_id: String,
    #[serde(default, alias = "Path")]
    path: Option<String>,
}
enum AppTarget {
    AppsFolder { app_id: String },
}
struct Entry {
    row: StartApp,
    keys: String,
    id: String,
    target: AppTarget,
}
#[derive(Default)]
struct Catalog {
    entries: Vec<Entry>,
    verified: bool,
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn aliases(row: &StartApp) -> &'static [&'static str] {
    let id = row.app_id.to_lowercase();
    // Preserve meaningful punctuation: Notepad++ is a different app from Notepad.
    let name = row.name.trim().to_lowercase();
    if id.contains("windowsnotepad_")
        || id == "microsoft.windows.notepad"
        || ["notepad", "记事本"].contains(&name.as_str())
    {
        &["notepad", "记事本", "jishiben", "jsb"]
    } else if id.contains("windowscalculator_")
        || ["calculator", "calc", "计算器"].contains(&name.as_str())
    {
        &["calculator", "calc", "计算器", "jisuanqi", "jsq"]
    } else if id.contains("microsoftstickynotes_")
        || ["sticky notes", "stickynotes", "便笺", "便签"].contains(&name.as_str())
    {
        &[
            "sticky notes",
            "stickynotes",
            "便笺",
            "便签",
            "bianqian",
            "bq",
        ]
    } else {
        &[]
    }
}

impl Catalog {
    fn from_rows(rows: Vec<StartApp>) -> Result<Self, String> {
        if rows.len() > MAX_APPS {
            return Err("应用目录超过 8192 项上限".into());
        }
        let mut entries = BTreeMap::new();
        for mut row in rows {
            row.name = row.name.trim().to_string();
            if row.name.is_empty()
                || row.name.len() > 2048
                || row.app_id.is_empty()
                || row.app_id.len() > 4096
                || row.name.chars().any(char::is_control)
                || row.app_id.chars().any(char::is_control)
            {
                return Err("应用目录包含无效名称或标识".into());
            }
            row.path = row.path.filter(|path| {
                let path = std::path::Path::new(path);
                path.is_absolute()
                    && path.extension().is_some_and(|ext| {
                        matches!(
                            ext.to_string_lossy().to_ascii_lowercase().as_str(),
                            "exe" | "lnk"
                        )
                    })
            });
            let id = format!("app:{}", row.app_id.to_lowercase());
            let keys = std::iter::once(compact(&row.name))
                .chain(super::pinyin::keys(&row.name).lines().map(str::to_owned))
                .chain(aliases(&row).iter().map(|alias| compact(alias)))
                .collect::<Vec<_>>()
                .join("\n");
            let target = AppTarget::AppsFolder {
                app_id: row.app_id.clone(),
            };
            entries.entry(id.clone()).or_insert(Entry {
                row,
                keys,
                id,
                target,
            });
        }
        Ok(Self {
            entries: entries.into_values().collect(),
            verified: true,
        })
    }
    fn query(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        if query.len() > 4096 || query.chars().any(char::is_control) {
            return Err("应用搜索词无效".into());
        }
        let query = compact(query);
        if query.is_empty() || limit == 0 {
            return Ok(vec![]);
        }
        let mut hits = self
            .entries
            .iter()
            .filter_map(|entry| {
                if !super::pinyin::matches(&entry.keys, &query) {
                    return None;
                }
                let name = compact(&entry.row.name);
                let score = if name == query {
                    120.0
                } else if entry.keys.lines().any(|key| key == query) {
                    115.0
                } else if name.starts_with(&query) {
                    110.0
                } else if name.contains(&query) {
                    100.0
                } else {
                    90.0
                };
                Some(SearchHit {
                    id: entry.id.clone(),
                    kind: "app".into(),
                    title: entry.row.name.clone(),
                    subtitle: "Windows 应用".into(),
                    snippet: String::new(),
                    path: entry.row.path.clone(),
                    url: None,
                    route: None,
                    score,
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(super::compare_hits);
        hits.truncate(limit.min(100));
        Ok(hits)
    }
    fn resolve(&self, id: &str) -> Result<&StartApp, String> {
        Ok(&self.entry(id)?.row)
    }
    fn entry(&self, id: &str) -> Result<&Entry, String> {
        if !self.verified {
            return Err("应用目录尚未通过本机验证，请刷新后重试".into());
        }
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "应用已移除或目录已更新，请重新搜索".into())
    }
}

#[derive(Default)]
struct AppState {
    catalog: Catalog,
    last_indexed_at: Option<u64>,
    indexing: bool,
    error: Option<String>,
}
impl AppState {
    fn finish(&mut self, result: Result<Catalog, String>, now: u64) {
        self.indexing = false;
        match result {
            Ok(catalog) => {
                self.catalog = catalog;
                self.last_indexed_at = Some(now);
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub count: usize,
    pub indexing: bool,
    pub last_indexed_at: Option<u64>,
    pub error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCatalog {
    rows: Vec<StartApp>,
    last_indexed_at: Option<u64>,
}
static STATE: OnceLock<Mutex<AppState>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);
static SIGNAL: (Mutex<bool>, Condvar) = (Mutex::new(true), Condvar::new());
fn state() -> &'static Mutex<AppState> {
    STATE.get_or_init(|| Mutex::new(AppState::default()))
}
pub fn status() -> AppStatus {
    match state().lock() {
        Ok(state) => AppStatus {
            count: state.catalog.entries.len(),
            indexing: state.indexing,
            last_indexed_at: state.last_indexed_at,
            error: state.error.clone(),
        },
        Err(_) => AppStatus {
            count: 0,
            indexing: false,
            last_indexed_at: None,
            error: Some("应用目录状态不可用".into()),
        },
    }
}
pub fn query(query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    state()
        .lock()
        .map_err(|_| "应用目录状态不可用")?
        .catalog
        .query(query, limit)
}
pub fn refresh() {
    if let Ok(mut refresh) = SIGNAL.0.lock() {
        *refresh = true;
        SIGNAL.1.notify_one();
    }
}
pub fn start(app: tauri::AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let cached =
            crate::commands::data::with_data_dir(|root| crate::database::read_at(root, CACHE_KEY))
                .and_then(|value| {
                    value
                        .map(serde_json::from_value::<CachedCatalog>)
                        .transpose()
                        .map_err(|_| "应用目录缓存无效".into())
                });
        if let Ok(mut state) = state().lock() {
            match cached {
                Ok(Some(cached)) => match Catalog::from_rows(cached.rows) {
                    Ok(mut catalog) => {
                        // The generic module-state API is writable by the UI. A disk cache
                        // remains searchable, but activation requires fresh OS provenance.
                        catalog.verified = false;
                        state.catalog = catalog;
                        state.last_indexed_at = cached.last_indexed_at;
                    }
                    Err(error) => state.error = Some(error),
                },
                Err(error) => state.error = Some(error),
                Ok(None) => {}
            }
        }
        loop {
            let Ok(mut requested) = SIGNAL.0.lock() else {
                return;
            };
            while !*requested {
                requested = match SIGNAL.1.wait(requested) {
                    Ok(requested) => requested,
                    Err(_) => return,
                };
            }
            *requested = false;
            drop(requested);
            if let Ok(mut state) = state().lock() {
                state.indexing = true;
            }
            let _ = app.emit("search://apps-status", status());
            let result = discover();
            let now = super::runtime::now();
            let cache_error = result.as_ref().ok().and_then(|catalog| {
                let cached = CachedCatalog {
                    rows: catalog
                        .entries
                        .iter()
                        .map(|entry| entry.row.clone())
                        .collect(),
                    last_indexed_at: Some(now),
                };
                let value = serde_json::to_value(cached).map_err(|e| e.to_string());
                value
                    .and_then(|value| {
                        crate::commands::data::with_data_dir(|root| {
                            crate::database::write_at(root, CACHE_KEY, &value)
                        })
                    })
                    .err()
            });
            if let Ok(mut state) = state().lock() {
                state.finish(result, now);
                if let Some(error) = cache_error {
                    state.error = Some(format!("应用目录可用，但缓存保存失败：{error}"));
                }
            }
            let _ = app.emit("search://apps-status", status());
        }
    });
}

fn parse_discovery(bytes: &[u8]) -> Result<Catalog, String> {
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err("应用目录输出超过上限".into());
    }
    let rows: Vec<StartApp> =
        serde_json::from_slice(bytes).map_err(|_| "无法读取 Windows 应用目录".to_string())?;
    if rows.is_empty() {
        return Err("Windows 返回空应用目录，已保留已有缓存".into());
    }
    Catalog::from_rows(rows)
}

#[cfg(windows)]
fn discover() -> Result<Catalog, String> {
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    let system = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:/Windows".into());
    let mut command = Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        DISCOVERY_SCRIPT,
    ]);
    let bytes = super::extract_worker::run_child(
        command,
        b"",
        &AtomicBool::new(false),
        Duration::from_secs(12),
        MAX_OUTPUT_BYTES,
    )
    .map_err(|error| format!("读取 Windows 应用目录失败：{error}"))?;
    parse_discovery(&bytes)
}
#[cfg(not(windows))]
fn discover() -> Result<Catalog, String> {
    Err("应用目录仅支持 Windows".into())
}

#[cfg(windows)]
const DISCOVERY_SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$apps=@(Get-StartApps)
if($apps.Count -gt 8192){throw 'Application catalog exceeds limit'}
$folder=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
$rows=@(foreach($app in $apps){
    $path=$null
    try {
        $item=$folder.ParseName($app.AppID)
        $candidate=[string]$item.ExtendedProperty('System.Link.TargetParsingPath')
        if($candidate -and [IO.Path]::IsPathRooted($candidate) -and [IO.Path]::GetExtension($candidate) -in '.exe','.lnk' -and [IO.File]::Exists($candidate)){$path=$candidate}
    } catch {}
    [pscustomobject]@{name=[string]$app.Name;appId=[string]$app.AppID;path=$path}
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
"#;

/// AppsFolder activation preserves Windows' registered desktop shortcut arguments.
/// Neither a frontend path nor a frontend launch command enters this function.
pub fn launch(id: &str) -> Result<(), String> {
    let target = {
        let state = state().lock().map_err(|_| "应用目录状态不可用")?;
        let entry = state.catalog.entry(id)?;
        match &entry.target {
            AppTarget::AppsFolder { app_id } => format!("shell:AppsFolder\\{app_id}"),
        }
    };
    shell_open(&target)
}

pub fn reveal(id: &str) -> Result<(), String> {
    let path = {
        let state = state().lock().map_err(|_| "应用目录状态不可用")?;
        state
            .catalog
            .resolve(id)?
            .path
            .clone()
            .ok_or("该商店应用没有可定位的本地程序文件")?
    };
    if !std::path::Path::new(&path).is_absolute() || !std::path::Path::new(&path).exists() {
        return Err("应用文件已移动或删除，请刷新应用目录".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:/Windows".into());
        std::process::Command::new(system.join("explorer.exe"))
            .arg(format!("/select,{path}"))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法定位应用：{e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("应用定位仅支持 Windows".into())
    }
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::{
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        core::{PCWSTR, w},
    };
    let target = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0 as usize <= 32 {
        Err("Windows 无法打开该应用，请刷新目录后重试".into())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn shell_open(_: &str) -> Result<(), String> {
    Err("应用启动仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        Catalog::from_rows(vec![
            StartApp {
                name: "记事本".into(),
                app_id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App".into(),
                path: None,
            },
            StartApp {
                name: "计算器".into(),
                app_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".into(),
                path: None,
            },
            StartApp {
                name: "便笺".into(),
                app_id: "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App".into(),
                path: None,
            },
            StartApp {
                name: "重庆文档".into(),
                app_id: "Example.Documents".into(),
                path: Some("C:/Apps/Documents.exe".into()),
            },
        ])
        .unwrap()
    }

    #[test]
    fn aliases_and_pinyin_resolve_to_one_stable_app_entity() {
        let catalog = catalog();
        for query in ["记事本", "notepad", "jishiben", "jsb"] {
            let hits = catalog.query(query, 10).unwrap();
            assert_eq!(hits.len(), 1, "{query}");
            assert_eq!(hits[0].id, "app:microsoft.windowsnotepad_8wekyb3d8bbwe!app");
            assert_eq!(hits[0].kind, "app");
            assert!(hits[0].route.is_none());
        }
        for query in ["calc", "Calculator", "jsq", "计算器"] {
            assert_eq!(catalog.query(query, 10).unwrap()[0].title, "计算器");
        }
        for query in ["Sticky Notes", "stickynotes", "便签", "bianqian", "bq"] {
            assert_eq!(catalog.query(query, 10).unwrap()[0].title, "便笺");
        }
        assert_eq!(catalog.query("cqwd", 10).unwrap()[0].title, "重庆文档");
    }

    #[test]
    fn exact_alias_or_phonetic_name_ranks_before_partial_initials() {
        let mut rows = catalog()
            .entries
            .into_iter()
            .map(|entry| entry.row)
            .collect::<Vec<_>>();
        rows.push(StartApp {
            name: "性能监视器".into(),
            app_id: "Example.PerformanceMonitor".into(),
            path: None,
        });
        rows.push(StartApp {
            name: "资源监视器".into(),
            app_id: "Example.ResourceMonitor".into(),
            path: None,
        });
        let catalog = Catalog::from_rows(rows).unwrap();
        let hits = catalog.query("jsq", 10).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "计算器");
    }

    #[test]
    fn built_in_aliases_do_not_claim_other_editors_with_similar_names() {
        let catalog = Catalog::from_rows(vec![StartApp {
            name: "Notepad++".into(),
            app_id: "Example.OtherEditor".into(),
            path: None,
        }])
        .unwrap();
        assert!(catalog.query("记事本", 10).unwrap().is_empty());
        assert!(catalog.query("jsb", 10).unwrap().is_empty());
        assert_eq!(catalog.query("Notepad++", 10).unwrap().len(), 1);
    }

    #[test]
    fn activation_uses_catalog_id_and_rejects_paths_or_urls() {
        let catalog = catalog();
        let id = catalog.query("notepad", 1).unwrap().remove(0).id;
        assert_eq!(
            catalog.resolve(&id).unwrap().app_id,
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"
        );
        for untrusted in [
            "C:/evil.exe",
            "https://evil.test",
            "app:missing",
            "app:Microsoft.WindowsNotepad_8wekyb3d8bbwe!App\n",
        ] {
            assert!(catalog.resolve(untrusted).is_err(), "{untrusted}");
        }
    }

    #[test]
    fn catalog_and_queries_enforce_bounds_and_deduplicate() {
        let row = StartApp {
            name: "记事本".into(),
            app_id: "Notepad".into(),
            path: Some("https://evil.test/icon.exe".into()),
        };
        let catalog = Catalog::from_rows(vec![row.clone(), row.clone()]).unwrap();
        assert_eq!(catalog.entries.len(), 1);
        assert!(catalog.query("notepad", 10).unwrap()[0].path.is_none());
        assert!(catalog.query("", 10).unwrap().is_empty());
        assert!(catalog.query("notepad", 0).unwrap().is_empty());
        assert!(catalog.query(&"x".repeat(4097), 10).is_err());
        assert!(Catalog::from_rows(vec![row; MAX_APPS + 1]).is_err());
        assert!(parse_discovery(&vec![b'x'; MAX_OUTPUT_BYTES + 1]).is_err());
        assert!(parse_discovery(b"not json").is_err());
    }

    #[test]
    fn failed_discovery_keeps_the_previous_snapshot_and_error_status() {
        let mut state = AppState {
            catalog: catalog(),
            last_indexed_at: Some(42),
            indexing: true,
            error: None,
        };
        state.finish(Err("test discovery failure".into()), 99);
        assert_eq!(state.catalog.query("notepad", 10).unwrap().len(), 1);
        assert_eq!(state.last_indexed_at, Some(42));
        assert!(!state.indexing);
        assert_eq!(state.error.as_deref(), Some("test discovery failure"));
    }

    #[test]
    fn disk_cache_is_searchable_but_requires_native_provenance_for_activation() {
        let mut catalog = catalog();
        let id = catalog.query("notepad", 1).unwrap()[0].id.clone();
        catalog.verified = false;
        assert_eq!(catalog.query("notepad", 1).unwrap().len(), 1);
        assert!(catalog.resolve(&id).is_err());
        catalog.verified = true;
        assert!(catalog.resolve(&id).is_ok());
        for invalid in [
            StartApp {
                name: "Bad".into(),
                app_id: "bad\ncmd".into(),
                path: None,
            },
            StartApp {
                name: "".into(),
                app_id: "empty".into(),
                path: None,
            },
        ] {
            assert!(Catalog::from_rows(vec![invalid]).is_err());
        }
    }

    #[test]
    fn sqlite_cache_round_trip_has_no_plaintext_catalog_sidecar() {
        let root = std::env::temp_dir().join(format!(
            "nimbus-app-catalog-{}-{}",
            std::process::id(),
            super::super::runtime::now()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let original = catalog();
        let cache = CachedCatalog {
            rows: original
                .entries
                .iter()
                .map(|entry| entry.row.clone())
                .collect(),
            last_indexed_at: Some(7),
        };
        crate::database::write_at(&root, CACHE_KEY, &serde_json::to_value(cache).unwrap()).unwrap();
        let cached: CachedCatalog =
            serde_json::from_value(crate::database::read_at(&root, CACHE_KEY).unwrap().unwrap())
                .unwrap();
        assert_eq!(cached.last_indexed_at, Some(7));
        assert_eq!(
            Catalog::from_rows(cached.rows)
                .unwrap()
                .query("jsb", 1)
                .unwrap()[0]
                .title,
            "记事本"
        );
        assert!(root.join(crate::database::DATABASE_FILE).exists());
        assert!(!root.join("search-apps.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apps_rank_before_executables_and_ordinary_hits_even_with_generic_uwp_icons() {
        let app = catalog().query("notepad", 1).unwrap().remove(0);
        let mut executable = app.clone();
        executable.kind = "file".into();
        executable.path = Some("C:/Apps/notepad.exe".into());
        executable.score = 9999.0;
        assert!(super::super::compare_hits(&app, &executable).is_lt());
        assert!(app.path.is_none());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "reads the real local Windows Start Menu; run explicitly as native smoke verification"]
    fn native_discovery_has_localized_desktop_and_store_apps() {
        let catalog = discover().unwrap();
        assert!(!catalog.entries.is_empty());
        assert!(
            catalog
                .entries
                .iter()
                .any(|entry| entry.row.app_id.contains('!'))
        );
        assert!(catalog.entries.iter().any(|entry| entry.row.path.is_some()));
        for query in ["notepad", "calc", "Sticky Notes"] {
            assert!(!catalog.query(query, 10).unwrap().is_empty(), "{query}");
        }
    }
}
