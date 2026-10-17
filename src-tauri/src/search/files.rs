//! Indexed native file search. Never recursively walks the user's drives.

use super::SearchHit;
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_RESULTS: usize = 100;
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Call on a blocking worker. A newer call cancels older IPC waits and kills
/// older Windows Search child processes; the UI also discards stale responses.
pub fn query(
    query: &str,
    limit: usize,
    backend: &str,
    instance: &str,
) -> Result<Vec<SearchHit>, String> {
    query_filtered(query,limit,backend,instance,false)
}
pub fn query_filtered(query:&str,limit:usize,backend:&str,instance:&str,hide_noise:bool)->Result<Vec<SearchHit>,String>{
    query_impl(query,limit,backend,instance,hide_noise).map(|mut hits| {if hide_noise {hits.retain(|h|h.path.as_deref().is_none_or(|p|!super::filters::noisy(p)));}hits.truncate(limit);hits})
}
fn query_impl(query:&str,limit:usize,backend:&str,instance:&str,hide_noise:bool)->Result<Vec<SearchHit>,String>{
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    if query.len() > 4096 || query.chars().any(char::is_control) {
        return Err("搜索词包含控制字符或超过长度限制".into());
    }
    if instance.len() > 256 || instance.chars().any(char::is_control) {
        return Err("Everything 实例名称无效".into());
    }
    if !matches!(backend, "auto" | "everything" | "windows") {
        return Err("未知文件搜索后端".into());
    }
    #[cfg(windows)]
    {
        let limit = limit.min(MAX_RESULTS);
        if backend == "windows" {
            return native::windows_query(query, limit, generation);
        }
        let (_, ipc, ready, error) = super::everything_app::probe(instance);
        if !ipc || ready != Some(true) {
            if backend == "everything" {
                return Err(error.unwrap_or_else(|| {
                    if ipc {
                        "Everything 正在建立索引，请稍后重试"
                    } else {
                        "Everything IPC 尚不可用"
                    }
                    .into()
                }));
            }
            return native::windows_query(query, limit, generation);
        }
        match native::everything_query(&super::filters::everything(query,None,hide_noise)?, limit, instance.trim(), generation) {
            Ok(hits) => Ok(hits),
            Err(error) => {
                if backend == "everything" {
                    return Err(error);
                }
                if cancelled(generation) {
                    return Err("文件搜索已取消".into());
                }
                native::windows_query(query, limit, generation)
                    .map_err(|fallback| format!("{error}；{fallback}"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = generation;
        Err("系统文件索引搜索仅支持 Windows".into())
    }
}

pub fn available(instance: &str) -> bool {
    #[cfg(windows)]
    {
        native::ipc_window(instance).is_some()
    }
    #[cfg(not(windows))]
    {
        let _ = instance;
        false
    }
}

fn cancelled(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) != generation
}

// Windows Search LIKE supports bracket-escaped wildcard literals. SQL and LIKE
// escaping are separate: apostrophes must still be doubled inside SQL strings.
fn windows_sql(query: &str, limit: usize) -> Result<String, String> {
    if query.chars().any(char::is_control) || query.len() > 4096 {
        return Err("搜索词包含控制字符或超过长度限制".into());
    }
    let mut query = query.trim();
    let mut predicates = vec!["System.ItemUrl IS NOT NULL".to_string()];
    let lower = query.to_ascii_lowercase();
    for (prefix, predicate) in [
        ("folder:", "System.ItemType = 'Directory'"),
        ("file:", "System.ItemType <> 'Directory'"),
    ] {
        if lower.starts_with(prefix) {
            query = query[prefix.len()..].trim();
            predicates.push(predicate.into());
            break;
        }
    }
    if query
        .chars()
        .any(|c| matches!(c, ':' | '|' | '!' | '<' | '>' | '*' | '?' | '\\' | '/'))
    {
        return Err(
            "Windows Search 后备仅支持文件名、引号短语及 file:/folder: 筛选；此语法需要 Everything"
                .into(),
        );
    }
    let mut terms = Vec::new();
    let mut term = String::new();
    let mut quoted = false;
    for character in query.chars() {
        if character == '"' {
            quoted = !quoted;
        } else if character.is_whitespace() && !quoted {
            if !term.is_empty() {
                terms.push(std::mem::take(&mut term));
            }
        } else {
            term.push(character);
        }
    }
    if quoted {
        return Err("搜索短语缺少右引号".into());
    }
    if !term.is_empty() {
        terms.push(term);
    }
    if terms.is_empty() {
        return Err("请输入文件名".into());
    }
    for term in terms {
        let mut escaped = String::new();
        for character in term.chars() {
            escaped.push_str(match character {
                '\'' => "''",
                '%' => "[%]",
                '_' => "[_]",
                '[' => "[[]",
                ']' => "[]]",
                _ => {
                    escaped.push(character);
                    continue;
                }
            });
        }
        predicates.push(format!("System.FileName LIKE '%{escaped}%'"));
    }
    Ok(format!(
        "SELECT TOP {} System.ItemUrl, System.FileName, System.FileAttributes FROM SYSTEMINDEX WHERE {}",
        limit.clamp(1, MAX_RESULTS),
        predicates.join(" AND ")
    ))
}

#[derive(Deserialize)]
struct IndexedRow {
    path: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    attributes: u32,
}

pub(super) fn indexed_path(mut path: String, attributes: u32) -> Option<String> {
    // Everything reports volume records as "C:". Only directory records with
    // exactly a drive letter and colon mean roots; "C:relative" stays invalid.
    if attributes & 0x10 != 0 && path.len() == 2 {
        let bytes = path.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            path.push('\\');
        }
    }
    (std::path::Path::new(&path).is_absolute() && !path.contains('\0')).then_some(path)
}

fn indexed_hit(path: String, title: String, attributes: u32, source: &str) -> Option<SearchHit> {
    // Only local/UNC absolute paths are actionable. Search may also index virtual
    // items (mail, protocol handlers); those are not files the user can open.
    let path = indexed_path(path, attributes)?;
    let title = if title.is_empty() {
        std::path::Path::new(&path)
            .file_name()?
            .to_string_lossy()
            .into_owned()
    } else {
        title
    };
    Some(SearchHit {
        id: format!("file:{path}"),
        kind: if attributes & 0x10 != 0 {
            "folder"
        } else {
            "file"
        }
        .into(),
        title,
        subtitle: path.clone(),
        snippet: source.into(),
        path: Some(path),
        url: None,
        route: None,
        score: 50.0,
    })
}

fn parse_windows_rows(json: &[u8], limit: usize) -> Result<Vec<SearchHit>, String> {
    let json = json.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(json);
    let rows: Vec<IndexedRow> = serde_json::from_slice(json)
        .map_err(|_| "Windows Search 返回了无效的索引结果".to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|row| indexed_hit(row.path, row.title, row.attributes, "Windows Search 索引"))
        .take(limit.min(MAX_RESULTS))
        .collect())
}

#[cfg(windows)]
mod native {
    use super::{SearchHit, cancelled, indexed_hit, parse_windows_rows, windows_sql};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use everything_ipc::{
        IpcWindow,
        wm::{EverythingClient, RequestFlags},
    };
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Child, Command, Stdio},
        sync::{Mutex, mpsc::RecvTimeoutError},
        time::{Duration, Instant},
    };

    // One reply-window client for the selected instance. Its asynchronous query
    // replaces the previous sender, cancelling old requests without queuing a
    // blocking query_wait mutex. Reuse also avoids per-keystroke reply threads.
    struct IpcClient {
        handle: usize,
        client: EverythingClient,
        timed_out: bool,
    }

    static EVERYTHING: Mutex<Option<IpcClient>> = Mutex::new(None);
    static WINDOWS_PROCESS: Mutex<()> = Mutex::new(());

    pub(super) fn ipc_window(instance: &str) -> Option<IpcWindow> {
        let instance = instance.trim();
        if instance.len() > 256 || instance.chars().any(char::is_control) {
            return None;
        }
        if instance.is_empty() {
            IpcWindow::new()
        } else {
            IpcWindow::with_instance(Some(instance))
        }
    }

    pub(super) fn everything_query(
        query: &str,
        limit: usize,
        instance: &str,
        generation: u64,
    ) -> Result<Vec<SearchHit>, String> {
        // Fetch launchable matches before the result cap, rather than sorting
        // an arbitrary first page that may contain only folders/documents.
        let preferred = format!("<{query}> file: ext:exe;bat;cmd;ps1;ps;com");
        let mut hits = everything_query_once(&preferred, limit, instance, generation)?;
        if hits.len() < limit {
            hits.extend(everything_query_once(query, limit, instance, generation)?);
        }
        hits.sort_by(crate::search::compare_hits);
        let mut seen = std::collections::HashSet::new();
        hits.retain(|hit| seen.insert(crate::search::path_identity(hit.path.as_deref().unwrap_or_default())));
        hits.truncate(limit);
        Ok(hits)
    }

    fn everything_query_once(
        query: &str,
        limit: usize,
        instance: &str,
        generation: u64,
    ) -> Result<Vec<SearchHit>, String> {
        let window = ipc_window(instance).ok_or("Everything 未运行或指定实例不可用")?;
        let receiver = {
            let mut cache = EVERYTHING
                .lock()
                .map_err(|_| "Everything 客户端状态不可用")?;
            if cancelled(generation) {
                return Err("文件搜索已取消".into());
            }
            let handle = window.hwnd().0 as usize;
            if cache.as_ref().is_none_or(|cached| cached.handle != handle) {
                *cache = Some(IpcClient {
                    handle,
                    client: window.wm_client().map_err(|_| "无法连接 Everything IPC")?,
                    timed_out: false,
                });
            }
            let cached = cache.as_ref().ok_or("Everything 客户端不可用")?;
            if cached.timed_out {
                return Err("Everything IPC 先前已超时，请重启 Everything 后重试".into());
            }
            cached
                .client
                .query(query)
                .request_flags(
                    RequestFlags::FileName
                        | RequestFlags::FullPathAndFileName
                        | RequestFlags::Attributes,
                )
                .max_results(limit as u32)
                .call()
                .map_err(|_| "Everything IPC 发送查询失败")?
        };
        let started = Instant::now();
        loop {
            if cancelled(generation) {
                return Err("文件搜索已取消".into());
            }
            if started.elapsed() >= Duration::from_millis(1200) {
                // Upstream uses SendMessageW on its reply thread. Stop posting
                // allocated requests to a potentially hung thread. A restarted
                // Everything HWND gets a fresh client next time.
                if let Ok(mut cache) = EVERYTHING.lock() {
                    if let Some(cached) = cache.as_mut() {
                        if cached.handle == window.hwnd().0 as usize {
                            cached.timed_out = true;
                        }
                    }
                }
                return Err("Everything 查询超时".into());
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(list) => {
                    return Ok(list
                        .iter()
                        .filter_map(|item| {
                            indexed_hit(
                                item.get_string(RequestFlags::FullPathAndFileName)?,
                                item.get_string(RequestFlags::FileName).unwrap_or_default(),
                                item.get_u32(RequestFlags::Attributes).unwrap_or_default(),
                                "Everything 索引",
                            )
                        })
                        .take(limit)
                        .collect());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("Everything 查询已被替换或连接中断".into());
                }
            }
        }
    }

    const WINDOWS_SEARCH_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$connection = $null
$recordset = $null
try {
    $connection = New-Object -ComObject ADODB.Connection
    $connection.ConnectionTimeout = 1
    $connection.CommandTimeout = 2
    $connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
    $recordset = $connection.Execute($env:NIMBUS_SEARCH_SQL)
    $rows = New-Object System.Collections.Generic.List[object]
    while (-not $recordset.EOF -and $rows.Count -lt 100) {
        $itemUrl = $recordset.Fields.Item('System.ItemUrl').Value
        $uri = [uri]$itemUrl
        $title = $recordset.Fields.Item('System.FileName').Value
        $attributes = $recordset.Fields.Item('System.FileAttributes').Value
        if ($uri.IsAbsoluteUri -and $uri.IsFile) {
            $rows.Add(@{path=$uri.LocalPath;title=[string]$title;attributes=[uint32]$attributes})
        }
        $recordset.MoveNext()
    }
    [Console]::Write((ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 3))
} catch {
    exit 1
} finally {
    if ($null -ne $recordset) { try { $recordset.Close() } catch {} }
    if ($null -ne $connection) { try { $connection.Close() } catch {} }
}
"#;

    pub(super) fn windows_query(
        query: &str,
        limit: usize,
        generation: u64,
    ) -> Result<Vec<SearchHit>, String> {
        let sql = windows_sql(query, limit)?;
        let started = Instant::now();
        // Windows PowerShell's first process in a session may spend ~1s loading
        // system modules before the provider's own two-second timeout starts.
        let timeout = Duration::from_millis(4000);
        // At most one indexed PowerShell query exists. Superseded callers stop
        // waiting; the current process observes cancellation and is reaped.
        let _guard = loop {
            if cancelled(generation) {
                return Err("文件搜索已取消".into());
            }
            match WINDOWS_PROCESS.try_lock() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Windows Search 查询状态不可用".into());
                }
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            if started.elapsed() >= timeout {
                return Err("Windows Search 查询等待超时".into());
            }
            std::thread::sleep(Duration::from_millis(15));
        };
        let output = run_powershell(
            WINDOWS_SEARCH_SCRIPT,
            &sql,
            timeout.saturating_sub(started.elapsed()),
            || cancelled(generation),
        )?;
        parse_windows_rows(&output, limit)
    }

    struct ReapedChild(Child);

    impl Drop for ReapedChild {
        fn drop(&mut self) {
            // Kill is harmless after a normal exit. wait closes the process
            // handle on every success, error, timeout and superseded request.
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    pub(super) fn run_powershell(
        script: &str,
        sql: &str,
        timeout: Duration,
        cancelled: impl Fn() -> bool,
    ) -> Result<Vec<u8>, String> {
        if cancelled() {
            return Err("文件搜索已取消".into());
        }
        let encoded: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        // Resolve the bundled OS executable explicitly; never look up an
        // executable relative to the workspace or install additional software.
        let powershell = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let mut child = ReapedChild(
            Command::new(powershell)
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                ])
                .arg(STANDARD.encode(encoded))
                .env("NIMBUS_SEARCH_SQL", sql)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn()
                .map_err(|_| "无法启动 Windows Search 查询进程".to_string())?,
        );
        let stdout = child.0.stdout.take().ok_or("查询进程缺少输出管道")?;
        let stderr = child.0.stderr.take().ok_or("查询进程缺少错误管道")?;
        // Drain both pipes while the process runs, avoiding a full-pipe deadlock.
        // Result count and output size are both bounded.
        let output_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let error_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr
                .take(32 * 1024)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let started = Instant::now();
        let outcome = loop {
            if cancelled() {
                break Err("文件搜索已取消".to_string());
            }
            if started.elapsed() >= timeout {
                break Err("Windows Search 查询超时".to_string());
            }
            match child.0.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                Err(_) => break Err("无法读取 Windows Search 进程状态".to_string()),
            }
        };
        // Closing the process before joining guarantees the pipe readers finish
        // even when the index provider is stopped, hung or the request is old.
        drop(child);
        let output = output_reader
            .join()
            .map_err(|_| "读取搜索结果失败")?
            .map_err(|_| "读取搜索结果失败")?;
        let _ = error_reader.join();
        let status = outcome?;
        if !status.success() {
            return Err("Windows Search 索引不可用或查询失败；请检查索引服务及已索引的位置".into());
        }
        if output.len() > 8 * 1024 * 1024 {
            return Err("Windows Search 返回结果超过大小限制".into());
        }
        Ok(output)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn powershell_transports_unicode_as_data_without_evaluation() {
            // This checks encoding and argument isolation. Full native builds
            // can delay cold PowerShell/module startup beyond three seconds;
            // deadline enforcement is covered separately below at 100ms.
            let output = run_powershell(
                "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Write($env:NIMBUS_SEARCH_SQL)",
                "中文'; $(throw 'must not run')",
                Duration::from_secs(10),
                || false,
            ).unwrap();
            assert_eq!(
                String::from_utf8(output).unwrap(),
                "中文'; $(throw 'must not run')"
            );
        }

        #[test]
        fn powershell_timeout_kills_and_reaps_child() {
            let start = std::time::Instant::now();
            let result = run_powershell(
                "Start-Sleep -Seconds 20",
                "",
                Duration::from_millis(100),
                || false,
            );
            assert!(result.unwrap_err().contains("超时"));
            assert!(start.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn cancelled_search_does_not_wait_for_child_completion() {
            let started = Instant::now();
            let result = run_powershell(
                "Start-Sleep -Seconds 20",
                "",
                Duration::from_secs(20),
                || started.elapsed() >= Duration::from_millis(100),
            );
            assert!(result.unwrap_err().contains("取消"));
            assert!(started.elapsed() < Duration::from_secs(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn everything_drive_roots_are_absolute_without_accepting_relative_paths() {
        for drive in ["C:", "F:"] {
            let hit = indexed_hit(drive.into(), drive.into(), 0x16, "Everything").expect("volume root");
            assert_eq!(hit.path, Some(format!("{drive}\\")));
            assert_eq!(hit.kind, "folder");
        }
        for (path, attributes) in [("C:", 0), ("C:notes.txt", 0x10), ("notes", 0x10), ("C:\\bad\0name", 0x10)] {
            assert!(indexed_hit(path.into(), path.into(), attributes, "Everything").is_none());
        }
    }

    #[test]
    fn empty_queries_never_launch_an_index_process() {
        assert!(query("  ", 30, "auto", "").unwrap().is_empty());
        assert!(query("report", 0, "auto", "").unwrap().is_empty());
    }

    #[test]
    fn invalid_requests_fail_before_reaching_native_providers() {
        assert!(query("report", 10, "unknown", "").is_err());
        assert!(query("report\0", 10, "auto", "").is_err());
        assert!(query("report", 10, "auto", "bad\0instance").is_err());
    }

    #[test]
    fn windows_query_escapes_sql_and_like_metacharacters() {
        let sql = windows_sql("O'Brien 100%_计划[1]", 12).unwrap();
        assert!(sql.starts_with("SELECT TOP 12 "));
        assert!(sql.contains("LIKE '%O''Brien%'"));
        assert!(sql.contains("LIKE '%100[%][_]计划[[]1[]]%'"));
        assert!(!sql.contains("LIKE '%100%_"));
    }

    #[test]
    fn windows_query_handles_file_folder_and_quoted_phrase() {
        let sql = windows_sql("folder:\"设计 方案\"", 999).unwrap();
        assert!(sql.starts_with("SELECT TOP 100 "));
        assert!(sql.contains("System.ItemType = 'Directory'"));
        assert!(sql.contains("LIKE '%设计 方案%'"));
        let files = windows_sql("file: report", 2).unwrap();
        assert!(files.contains("System.ItemType <> 'Directory'"));
    }

    #[test]
    fn unsupported_everything_syntax_is_not_silently_reinterpreted() {
        for query in [
            "ext:pdf",
            "a | b",
            "regex:.*",
            "!report",
            "file:folder:a",
            "\"unclosed",
        ] {
            assert!(windows_sql(query, 10).is_err(), "{query}");
        }
    }

    #[test]
    fn windows_query_rejects_empty_and_control_characters() {
        for query in ["", " ", "folder:", "a\0b", "a\nb"] {
            assert!(windows_sql(query, 10).is_err(), "{query:?}");
        }
    }

    #[test]
    fn windows_rows_preserve_unicode_and_classify_directories() {
        let rows = br#"[{"path":"E:\\notes\\\u8bbe\u8ba1.md","title":"\u8bbe\u8ba1.md","attributes":32},{"path":"E:\\notes\\\u8d44\u6599","title":"\u8d44\u6599","attributes":16}]"#;
        let hits = parse_windows_rows(rows, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "设计.md");
        assert_eq!(hits[0].path.as_deref(), Some("E:\\notes\\设计.md"));
        assert_eq!(hits[0].id, "file:E:\\notes\\设计.md");
        assert_eq!(hits[1].kind, "folder");
        assert_eq!(hits[0].kind, "file");
    }

    #[test]
    fn windows_rows_reject_non_file_paths_and_respect_limit() {
        let rows = br#"[{"path":"https://example.com/a","title":"remote","attributes":0},{"path":"relative.txt","title":"relative","attributes":0},{"path":"C:\\a.txt","title":"a.txt","attributes":0},{"path":"\\\\server\\share\\b.txt","title":"b.txt","attributes":0}]"#;
        let hits = parse_windows_rows(rows, 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path.as_deref(), Some("C:\\a.txt"));
        assert!(parse_windows_rows(b"[]", 10).unwrap().is_empty());
        assert!(parse_windows_rows(b"not json", 10).is_err());
    }
}
