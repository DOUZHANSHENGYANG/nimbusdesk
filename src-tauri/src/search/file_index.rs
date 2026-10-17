//! Independent derived file index. Losing/rebuilding business documents cannot
//! delete file rows, and no operation writes to a source document.
use super::{
    SearchHit,
    content::{grams, parse, snippet},
    pinyin,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::BTreeSet, path::Path, time::Duration};

type Result<T> = std::result::Result<T, String>;
pub struct FileIndex(Connection);

#[derive(Clone, Default)]
pub struct QueryScope {
    pub roots: Vec<String>,
    pub excludes: Vec<String>,
    pub content: bool,
    pub pinyin: bool,
    pub native_source: Option<String>,
}
pub fn normalize(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|p| format!(r"\\{p}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).into());
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}
pub fn inside(path: &str, root: &str) -> bool {
    path == root || (path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/'))
}
impl QueryScope {
    pub fn selected(&self, path: &str) -> bool {
        self.roots.iter().any(|root| inside(path, root)) && !self.excluded(path)
    }
    pub fn excluded(&self, path: &str) -> bool {
        self.excludes.iter().any(|root| inside(path, root))
    }
}
fn confirmed_missing(path: &Path) -> bool {
    let mut volume = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                volume.push(component.as_os_str())
            }
            _ => break,
        }
    }
    volume.is_dir()
        && std::fs::symlink_metadata(path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

impl FileIndex {
    pub fn open(root: &Path) -> Result<Self> {
        let directory = root.join("modules/search");
        crate::database::reject_link_components(&directory)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("files.sqlite3");
        crate::database::reject_link_components(&path)?;
        Self::init(Connection::open(path).map_err(|e| e.to_string())?)
    }
    #[cfg(test)]
    fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }
    fn init(connection: Connection) -> Result<Self> {
        connection
            .busy_timeout(Duration::from_millis(1500))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS files(path TEXT UNIQUE NOT NULL,display TEXT NOT NULL,title TEXT NOT NULL,directory INTEGER NOT NULL,native INTEGER NOT NULL DEFAULT 0,scoped INTEGER NOT NULL DEFAULT 0,native_seen INTEGER NOT NULL DEFAULT 0,scope_seen INTEGER NOT NULL DEFAULT 0,stamp TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',pinyin TEXT NOT NULL DEFAULT '',error TEXT,native_source TEXT NOT NULL DEFAULT '');
          CREATE VIRTUAL TABLE IF NOT EXISTS file_terms USING fts5(tokens);
          CREATE INDEX IF NOT EXISTS file_native_seen ON files(native_seen);
          CREATE INDEX IF NOT EXISTS file_scope_seen ON files(scope_seen);
          CREATE INDEX IF NOT EXISTS file_scoped ON files(scoped);")
            .map_err(|e| e.to_string())?;
        let source_column = connection
            .prepare("PRAGMA table_info(files)")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(std::result::Result::ok)
            .any(|name| name == "native_source");
        if !source_column {
            connection
                .execute_batch(
                    "ALTER TABLE files ADD COLUMN native_source TEXT NOT NULL DEFAULT ''",
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(Self(connection))
    }
    pub fn name(
        &mut self,
        path: &str,
        directory: bool,
        native: bool,
        generation: u64,
    ) -> Result<()> {
        self.names(&[(path.to_string(), directory)], native, generation)
    }
    pub fn names(&mut self, names: &[(String, bool)], native: bool, generation: u64) -> Result<()> {
        self.names_for_source(names, native, generation, "")
    }
    pub fn names_for_source(
        &mut self,
        names: &[(String, bool)],
        native: bool,
        generation: u64,
        source: &str,
    ) -> Result<()> {
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        {
            let mut insert = tx.prepare("INSERT INTO files(path,display,title,directory,native,scoped,native_seen,scope_seen,pinyin,native_source) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
              ON CONFLICT(path) DO UPDATE SET display=excluded.display,title=excluded.title,directory=excluded.directory,native=MAX(files.native,excluded.native),scoped=MAX(files.scoped,excluded.scoped),native_seen=CASE WHEN ?5=1 THEN ?7 ELSE files.native_seen END,scope_seen=CASE WHEN ?6=1 THEN ?8 ELSE files.scope_seen END,native_source=CASE WHEN ?5=1 THEN ?10 ELSE files.native_source END,pinyin=excluded.pinyin,body=CASE WHEN files.directory<>excluded.directory THEN '' ELSE files.body END,stamp=CASE WHEN files.directory<>excluded.directory THEN '' ELSE files.stamp END,error=CASE WHEN files.directory<>excluded.directory THEN NULL ELSE files.error END").map_err(|e|e.to_string())?;
            let mut terms = tx.prepare("INSERT OR REPLACE INTO file_terms(rowid,tokens) SELECT rowid,?2 FROM files WHERE path=?1").map_err(|e| e.to_string())?;
            for (display, directory) in names {
                let path = normalize(display);
                let title = display.rsplit(['/', '\\']).next().unwrap_or(display);
                let existing: Option<(String, bool)> = tx
                    .query_row(
                        "SELECT title,directory FROM files WHERE path=?1",
                        [&path],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if existing.is_some_and(|(previous, was_directory)| {
                    previous == title && was_directory == *directory
                }) {
                    // A metadata poll must not retokenize multi-megabyte Office
                    // bodies or regenerate pinyin for unchanged filenames.
                    tx.execute("UPDATE files SET display=?2,native=MAX(native,?3),scoped=MAX(scoped,?4),native_seen=CASE WHEN ?3=1 THEN ?5 ELSE native_seen END,scope_seen=CASE WHEN ?4=1 THEN ?5 ELSE scope_seen END,native_source=CASE WHEN ?3=1 THEN ?6 ELSE native_source END WHERE path=?1",params![path,display,native,!native,generation,source]).map_err(|e|e.to_string())?;
                    continue;
                }
                let py = pinyin::keys(title);
                insert
                    .execute(params![
                        path,
                        display,
                        title,
                        directory,
                        native,
                        !native,
                        if native { generation } else { 0 },
                        if native { 0 } else { generation },
                        py,
                        source
                    ])
                    .map_err(|e| e.to_string())?;
                let body: String = tx
                    .query_row("SELECT body FROM files WHERE path=?1", [&path], |r| {
                        r.get(0)
                    })
                    .map_err(|e| e.to_string())?;
                terms
                    .execute(params![
                        path,
                        grams(&format!("{path}\n{py}\n{}", body.to_lowercase())).join(" ")
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn needs_content(&self, path: &str, stamp: &str, retry_failed: bool) -> Result<bool> {
        let record: Option<(String, Option<String>)> = self
            .0
            .query_row(
                "SELECT stamp,error FROM files WHERE path=?1",
                [normalize(path)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(record.is_none_or(|(old, error)| old != stamp || (retry_failed && error.is_some())))
    }
    pub fn content(&mut self, path: &str, stamp: &str, body: Result<String>) -> Result<()> {
        let (body, error) = match body {
            Ok(body) => (body, None),
            Err(error) => (String::new(), Some(error)),
        };
        let normalized = normalize(path);
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE files SET stamp=?2,body=?3,error=?4 WHERE path=?1",
            params![normalized, stamp, body, error],
        )
        .map_err(|e| e.to_string())?;
        let (rowid, py): (i64, String) = tx
            .query_row(
                "SELECT rowid,pinyin FROM files WHERE path=?1",
                [&normalized],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO file_terms(rowid,tokens) VALUES(?1,?2)",
            params![
                rowid,
                grams(&format!("{normalized}\n{py}\n{}", body.to_lowercase())).join(" ")
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn invalidate_changed(&mut self, path: &str, stamp: &str) -> Result<()> {
        // Leave stamp empty so a cancelled worker is retried on resume. Stale
        // FTS candidates are harmless: query verifies the current empty body.
        self.0
            .execute(
                "UPDATE files SET stamp='',body='',error=NULL WHERE path=?1 AND stamp<>?2",
                params![normalize(path), stamp],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    /// Called only after complete traversal, never after cancellation or I/O
    /// failure. A missing/offline root retains its last successful snapshot.
    pub fn finish_scope(&mut self, root: &str, generation: u64) -> Result<()> {
        let root = normalize(root);
        self.0.execute("UPDATE files SET scoped=0,body='',stamp='',error=NULL WHERE scope_seen<>?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",params![generation,root]).map_err(|e|e.to_string())?;
        self.prune()
    }
    pub fn finish_native(&mut self, generation: u64, source: &str) -> Result<()> {
        // Pagination is not a filesystem snapshot. A rename can preserve total
        // count while shifting page offsets; clear absent rows only when the
        // actual path is confirmed missing on an accessible volume/share.
        let missing = {
            let mut statement=self.0.prepare("SELECT path,display FROM files WHERE native=1 AND native_source=?1 AND native_seen<>?2").map_err(|e|e.to_string())?;
            statement
                .query_map(params![source, generation], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (path, display) in missing {
            if confirmed_missing(Path::new(&display)) {
                self.0
                    .execute(
                        "UPDATE files SET native=0 WHERE path=?1 AND native_source=?2",
                        params![path, source],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        self.prune()
    }
    fn prune(&mut self) -> Result<()> {
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("DELETE FROM file_terms WHERE rowid IN (SELECT rowid FROM files WHERE native=0 AND scoped=0); DELETE FROM files WHERE native=0 AND scoped=0;").map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn counts(&self, scope: &QueryScope) -> Result<(u64, u64)> {
        if !scope.content {
            return Ok((0, 0));
        }
        self.0.query_row("SELECT COALESCE(sum(CASE WHEN body<>'' THEN 1 ELSE 0 END),0),COALESCE(sum(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END),0) FROM files f WHERE scoped=1
          AND EXISTS(SELECT 1 FROM json_each(?1) r WHERE f.path=r.value OR substr(f.path,1,length(r.value)+1)=r.value||'/')
          AND NOT EXISTS(SELECT 1 FROM json_each(?2) x WHERE f.path=x.value OR substr(f.path,1,length(x.value)+1)=x.value||'/')",params![serde_json::to_string(&scope.roots).map_err(|e|e.to_string())?,serde_json::to_string(&scope.excludes).map_err(|e|e.to_string())?],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())
    }
    pub fn failure_summary(&self, scope: &QueryScope) -> Result<Vec<String>> {
        if !scope.content {
            return Ok(vec![]);
        }
        let mut statement=self.0.prepare("SELECT title,error FROM files f WHERE scoped=1 AND error IS NOT NULL
          AND EXISTS(SELECT 1 FROM json_each(?1) r WHERE f.path=r.value OR substr(f.path,1,length(r.value)+1)=r.value||'/')
          AND NOT EXISTS(SELECT 1 FROM json_each(?2) x WHERE f.path=x.value OR substr(f.path,1,length(x.value)+1)=x.value||'/') LIMIT 3").map_err(|e|e.to_string())?;
        statement
            .query_map(
                params![
                    serde_json::to_string(&scope.roots).map_err(|e| e.to_string())?,
                    serde_json::to_string(&scope.excludes).map_err(|e| e.to_string())?
                ],
                |r| {
                    Ok(format!(
                        "{}：{}",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?.chars().take(240).collect::<String>()
                    ))
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn query(&self, query: &str, limit: usize, scope: &QueryScope) -> Result<Vec<SearchHit>> {
        let mut query = query.trim();
        let lower = query.to_lowercase();
        let kind = if lower.starts_with("file:") {
            query = &query[5..];
            Some(false)
        } else if lower.starts_with("folder:") {
            query = &query[7..];
            Some(true)
        } else {
            None
        };
        // Advanced Everything syntax is handled by the native engine, not
        // guessed by this literal/document index.
        if query.is_empty()
            || limit == 0
            || query
                .chars()
                .any(|c| matches!(c, ':' | '*' | '?' | '<' | '>' | '\0'))
        {
            return Ok(vec![]);
        }
        let branches = parse(query);
        if branches.is_empty() {
            return Ok(vec![]);
        }
        let expressions: Vec<_> = branches
            .iter()
            .map(|branch| {
                branch
                    .iter()
                    .filter(|(_, n)| !*n)
                    .flat_map(|(word, _)| grams(word))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(" AND ")
            })
            .collect();
        // Never enumerate the whole index for a negative-only query.
        if expressions.iter().any(String::is_empty) {
            return Ok(vec![]);
        }
        let expression = expressions
            .iter()
            .map(|s| format!("({s})"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement=self.0.prepare("SELECT f.path,f.display,f.title,f.directory,f.native,f.scoped,f.body,f.pinyin,f.native_source FROM files f JOIN file_terms t ON t.rowid=f.rowid WHERE file_terms MATCH ?1
          AND ((f.native=1 AND f.native_source=?4) OR (f.scoped=1 AND EXISTS(SELECT 1 FROM json_each(?2) r WHERE f.path=r.value OR substr(f.path,1,length(r.value)+1)=r.value||'/')))
          AND NOT EXISTS(SELECT 1 FROM json_each(?3) x WHERE f.path=x.value OR substr(f.path,1,length(x.value)+1)=x.value||'/')
          ORDER BY CASE WHEN EXISTS(SELECT 1 FROM json_each(?2) r WHERE f.path=r.value OR substr(f.path,1,length(r.value)+1)=r.value||'/') THEN 1 ELSE 0 END DESC LIMIT 20000").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(
                params![
                    expression,
                    serde_json::to_string(&scope.roots).map_err(|e| e.to_string())?,
                    serde_json::to_string(&scope.excludes).map_err(|e| e.to_string())?,
                    scope.native_source
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                        r.get::<_, bool>(4)?,
                        r.get::<_, bool>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, String>(8)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let mut hits = vec![];
        let mut inspected = 0usize;
        let mut body_bytes = 0usize;
        let started = std::time::Instant::now();
        for row in rows {
            let (path, display, title, directory, native, scoped, body, py, native_source) =
                row.map_err(|e| e.to_string())?;
            if inspected > 0
                && (body_bytes >= 64 * 1024 * 1024
                    || started.elapsed() > Duration::from_millis(300))
            {
                break;
            }
            inspected += 1;
            body_bytes += body.len();
            let selected = scope.selected(&path);
            let native = native && scope.native_source.as_deref() == Some(&native_source);
            if scope.excluded(&path)
                || (!native && !(scoped && selected))
                || kind.is_some_and(|v| v != directory)
            {
                continue;
            }
            let text = if selected && scope.content {
                body.to_lowercase()
            } else {
                String::new()
            };
            let matches = |word: &str| {
                path.contains(word)
                    || (scope.pinyin && pinyin::matches(&py, word))
                    || text.contains(word)
            };
            let Some(branch) = branches
                .iter()
                .filter(|branch| {
                    branch
                        .iter()
                        .all(|(word, negative)| matches(word) != *negative)
                })
                .max_by_key(|branch| branch.len())
            else {
                continue;
            };
            let title_lower = title.to_lowercase();
            let score = branch
                .iter()
                .filter(|(_, n)| !*n)
                .map(|(word, _)| {
                    if title_lower == *word {
                        1000.0
                    } else if title_lower.starts_with(word) {
                        800.0
                    } else if title_lower.contains(word) {
                        600.0
                    } else if path.contains(word) {
                        400.0
                    } else if scope.pinyin && pinyin::matches(&py, word) {
                        250.0
                    } else {
                        60.0
                    }
                })
                .sum();
            let content_word = branch.iter().filter(|(_, n)| !*n).find(|(word, _)| {
                !path.contains(word) && !pinyin::matches(&py, word) && text.contains(word)
            });
            hits.push(SearchHit {
                id: format!("file:{display}"),
                kind: if directory { "folder" } else { "file" }.into(),
                title,
                subtitle: display
                    .rsplit_once(['/', '\\'])
                    .map(|p| p.0)
                    .unwrap_or_default()
                    .into(),
                snippet: content_word
                    .map(|(word, _)| snippet(&body, word))
                    .unwrap_or_default(),
                path: Some(display),
                url: None,
                route: None,
                score,
            });
        }
        hits.sort_by(super::compare_hits);
        hits.truncate(limit.min(100));
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_priority_is_applied_before_the_result_limit() {
        for extension in ["EXE", "bat", "cmd", "ps1", "ps"] {
            let mut index = FileIndex::memory().unwrap();
            let executable = format!("C:/tools/runner-99.{extension}");
            index.names_for_source(&[("C:/tools/runner-00.exe".into(), true), ("C:/tools/runner-01.md".into(), false), (executable.clone(), false)], true, 1, "priority").unwrap();
            let mut selected = scope(&[]);
            selected.native_source = Some("priority".into());
            let hits = index.query("runner", 1, &selected).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].path.as_deref(), Some(executable.as_str()));
        }
    }

    fn scope(roots: &[&str]) -> QueryScope {
        QueryScope {
            roots: roots.iter().map(|s| normalize(s)).collect(),
            excludes: vec![],
            content: true,
            pinyin: true,
            native_source: Some(String::new()),
        }
    }
    #[test]
    fn names_pinyin_and_content_are_independent_and_scoped() {
        let mut index = FileIndex::memory().unwrap();
        index.name("C:/docs/文档.docx", false, false, 1).unwrap();
        index
            .content("C:/docs/文档.docx", "1", Ok("预算 alpha".into()))
            .unwrap();
        index.name("C:/elsewhere/中文.txt", false, true, 1).unwrap();
        assert_eq!(
            index.query("wd", 10, &scope(&["C:/docs"])).unwrap().len(),
            1
        );
        assert_eq!(
            index.query("预算", 10, &scope(&["C:/docs"])).unwrap().len(),
            1
        );
        assert!(index.query("预算", 10, &scope(&[])).unwrap().is_empty());
        assert!(index.query("文档", 10, &scope(&[])).unwrap().is_empty());
        assert_eq!(index.query("zw", 10, &scope(&[])).unwrap().len(), 1);
        let mut disabled = scope(&["C:/docs"]);
        disabled.pinyin = false;
        assert!(index.query("wd", 10, &disabled).unwrap().is_empty());
        disabled.content = false;
        assert!(index.query("预算", 10, &disabled).unwrap().is_empty());
    }
    #[test]
    fn changes_failures_and_complete_scans_do_not_leak_stale_content() {
        let mut index = FileIndex::memory().unwrap();
        let p = "C:/docs/文档.docx";
        index.name(p, false, false, 1).unwrap();
        index.content(p, "old", Ok("oldkeyword".into())).unwrap();
        assert!(!index.needs_content(p, "old", false).unwrap());
        assert!(index.needs_content(p, "changed", false).unwrap());
        index.content(p, "changed", Err("bad zip".into())).unwrap();
        assert!(
            index
                .query("oldkeyword", 10, &scope(&["C:/docs"]))
                .unwrap()
                .is_empty()
        );
        assert!(!index.needs_content(p, "changed", false).unwrap());
        assert!(index.needs_content(p, "changed", true).unwrap());
        // An incomplete scan does not prune. A complete one does.
        assert_eq!(
            index.query("文档", 10, &scope(&["C:/docs"])).unwrap().len(),
            1
        );
        index.finish_scope("C:/docs", 2).unwrap();
        assert!(
            index
                .query("文档", 10, &scope(&["C:/docs"]))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn root_boundaries_exclusions_and_case_identity() {
        let mut index = FileIndex::memory().unwrap();
        index.name("C:/docs/a.txt", false, false, 1).unwrap();
        index.name("c:\\DOCS\\a.txt", false, false, 1).unwrap();
        index.name("C:/docs-extra/a.txt", false, false, 1).unwrap();
        assert_eq!(
            index
                .query("a.txt", 10, &scope(&["C:/docs"]))
                .unwrap()
                .len(),
            1
        );
        let mut excluded = scope(&["C:/docs"]);
        excluded.excludes.push(normalize("C:/docs/a.txt"));
        assert!(index.query("a.txt", 10, &excluded).unwrap().is_empty());
    }
    #[test]
    fn rescans_preserve_unchanged_bodies_and_native_pruning_preserves_scoped_files() {
        let mut index = FileIndex::memory().unwrap();
        let path = "C:/docs/readme.txt";
        index.name(path, false, false, 1).unwrap();
        index
            .content(path, "stamp", Ok("bodykeyword".into()))
            .unwrap();
        index.name(path, false, true, 1).unwrap();
        index.name(path, false, false, 2).unwrap();
        index.finish_native(2, "").unwrap();
        assert_eq!(
            index
                .query("bodykeyword", 10, &scope(&["C:/docs"]))
                .unwrap()
                .len(),
            1
        );
        assert!(!index.needs_content(path, "stamp", false).unwrap());
        index.invalidate_changed(path, "newstamp").unwrap();
        assert!(
            index
                .query("bodykeyword", 10, &scope(&["C:/docs"]))
                .unwrap()
                .is_empty()
        );
        assert!(index.needs_content(path, "newstamp", false).unwrap());
        index
            .content(path, "newstamp", Ok("anotherword".into()))
            .unwrap();
        index.name(path, true, false, 3).unwrap();
        assert!(
            index
                .query("anotherword", 10, &scope(&["C:/docs"]))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn file_and_business_databases_remain_independent() {
        let root = std::env::temp_dir().join(format!(
            "nimbus-file-index-{}-{}",
            std::process::id(),
            crate::search::runtime::now()
        ));
        std::fs::create_dir_all(&root).unwrap();
        {
            let mut files = FileIndex::open(&root).unwrap();
            files.name("C:/docs/预算.pdf", false, false, 1).unwrap();
            files
                .content("C:/docs/预算.pdf", "1", Ok("fileonlyword".into()))
                .unwrap();
            let mut business = crate::search::ContentIndex::open(&root).unwrap();
            business.replace(&[]).unwrap();
            assert_eq!(
                files
                    .query("fileonlyword", 10, &scope(&["C:/docs"]))
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(business.count().unwrap(), 0);
        }
        assert!(root.join("modules/search/files.sqlite3").exists());
        assert!(root.join("modules/search/index.sqlite3").exists());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_snapshot_is_never_visible_for_a_different_backend_or_instance() {
        let mut index = FileIndex::memory().unwrap();
        index
            .names_for_source(
                &[("C:/elsewhere/报告.txt".into(), false)],
                true,
                1,
                "everything:work",
            )
            .unwrap();
        let mut selected = scope(&[]);
        selected.native_source = Some("everything:work".into());
        assert_eq!(index.query("bg", 10, &selected).unwrap().len(), 1);
        selected.native_source = Some("everything:other".into());
        assert!(index.query("bg", 10, &selected).unwrap().is_empty());
        selected.native_source = None;
        assert!(index.query("bg", 10, &selected).unwrap().is_empty());
        // Selected-directory filenames remain queryable with Everything off.
        index.name("C:/docs/报告.txt", false, false, 1).unwrap();
        selected.roots = vec![normalize("C:/docs")];
        assert_eq!(index.query("bg", 10, &selected).unwrap().len(), 1);
    }
    #[test]
    fn native_snapshot_prunes_confirmed_missing_paths_but_not_existing_unseen_paths() {
        let root = std::env::temp_dir().join(format!(
            "nimbus-native-prune-{}-{}",
            std::process::id(),
            crate::search::runtime::now()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let existing = root.join("existing.txt").to_string_lossy().into_owned();
        let missing = root.join("missing.txt").to_string_lossy().into_owned();
        std::fs::write(&existing, "test").unwrap();
        let mut index = FileIndex::memory().unwrap();
        index
            .names_for_source(&[(existing, false), (missing, false)], true, 1, "source")
            .unwrap();
        index.finish_native(2, "source").unwrap();
        let mut selected = scope(&[]);
        selected.native_source = Some("source".into());
        assert_eq!(index.query("existing", 10, &selected).unwrap().len(), 1);
        assert!(index.query("missing", 10, &selected).unwrap().is_empty());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
