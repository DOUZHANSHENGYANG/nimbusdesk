//! SQLite state storage; source documents and attachments remain ordinary files.
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const DATABASE_FILE: &str = "workbench.sqlite3";
const APPLICATION_ID: i64 = 0x4e494d42;
// Serialize first-time WAL/schema initialization inside this process. SQLite's
// immediate transactions and busy timeout cover independent app processes.
static INITIALIZE: Mutex<()> = Mutex::new(());

pub fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid data key".into());
    }
    Ok(())
}

fn state_key(key: &str) -> Result<(), String> {
    validate_key(key)?;
    if key == "ai-settings" {
        return Err("legacy AI credentials must remain in the protected migration file".into());
    }
    Ok(())
}

fn namespace(key: &str) -> (&str, &str) {
    match key {
        "settings" => ("core", "settings"),
        "plans" => ("plans", "tasks"),
        "plans-archive" => ("plans", "archive"),
        "projects" => ("projects", "state"),
        "todo-papers" => ("plans", "papers"),
        "reminders" => ("plans", "reminders"),
        "files" => ("files", "catalog"),
        "fences" => ("files", "fences"),
        "favorites" => ("favorites", "items"),
        "custom-feeds" => ("news", "feeds"),
        "feed-network" => ("news", "network"),
        "feed-cache" => ("news", "cache"),
        "ai-providers" => ("ai", "providers"),
        "knowledge-settings" => ("knowledge", "settings"),
        _ => key.split_once('-').unwrap_or(("app", key)),
    }
}

fn sqlite_error(error: rusqlite::Error) -> String {
    format!("SQLite state: {error}")
}

fn linklike(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Reject symlinks and Windows junctions before inspecting/copying app-owned data.
pub fn reject_link_components(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if linklike(&metadata) => {
                return Err("data paths cannot traverse links or junctions".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect data path: {error}")),
        }
    }
    Ok(())
}

fn legacy_keys(root: &Path) -> Result<BTreeSet<String>, String> {
    let mut keys = BTreeSet::new();
    for entry in fs::read_dir(root).map_err(|e| format!("read legacy directory: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(key) = legacy_key(&name) {
            if key != "ai-settings" {
                keys.insert(key.to_owned());
            }
        }
    }
    Ok(keys)
}

fn legacy_key(name: &str) -> Option<&str> {
    name.strip_suffix(".json")
        .or_else(|| name.strip_suffix(".json.bak"))
        .filter(|key| validate_key(key).is_ok())
}

fn read_legacy(root: &Path, key: &str) -> Result<Value, String> {
    let primary = root.join(format!("{key}.json"));
    let path = match fs::symlink_metadata(&primary) {
        Ok(_) => primary,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            root.join(format!("{key}.json.bak"))
        }
        Err(error) => return Err(format!("inspect legacy state {key}: {error}")),
    };
    reject_link_components(&path)?;
    if !fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err(format!("legacy state {key} is not a regular file"));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read legacy state {key}: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| {
        format!(
            "invalid legacy JSON for {key} at line {}, column {}",
            e.line(),
            e.column()
        )
    })
}

fn upsert(conn: &Connection, key: &str, value: &Value) -> Result<(), String> {
    let (module, feature) = namespace(key);
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO module_state(module,feature,key,value_json,revision,updated_at)
        VALUES(?1,?2,?3,?4,1,unixepoch()*1000)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
            revision=module_state.revision+1, updated_at=excluded.updated_at",
        params![module, feature, key, json],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn open(root: &Path) -> Result<Connection, String> {
    let _initializing = INITIALIZE
        .lock()
        .map_err(|_| "SQLite initialization lock poisoned")?;
    reject_link_components(root)?;
    fs::create_dir_all(root).map_err(|e| format!("create data directory: {e}"))?;
    let path = root.join(DATABASE_FILE);
    for name in [
        DATABASE_FILE.to_owned(),
        format!("{DATABASE_FILE}-wal"),
        format!("{DATABASE_FILE}-shm"),
    ] {
        reject_link_components(&root.join(name))?;
    }
    if !path.exists()
        && ["-wal", "-shm"]
            .iter()
            .any(|suffix| root.join(format!("{DATABASE_FILE}{suffix}")).exists())
    {
        return Err("SQLite main database is missing but recovery files exist; restore the database before continuing".into());
    }
    let mut conn = Connection::open(&path).map_err(sqlite_error)?;
    conn.busy_timeout(Duration::from_secs(10))
        .map_err(sqlite_error)?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(sqlite_error)?;
    if check != "ok" {
        return Err("SQLite database integrity check failed; original database retained".into());
    }
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sqlite_error)?;
    let app_id: i64 = conn
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(sqlite_error)?;
    if version > 2 || (app_id != 0 && app_id != APPLICATION_ID) {
        return Err("unsupported SQLite database schema; original database retained".into());
    }
    if version == 0 {
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )
            .map_err(sqlite_error)?;
        if tables != 0 {
            return Err("unrecognized SQLite database; original database retained".into());
        }
    } else if app_id != APPLICATION_ID {
        return Err("unrecognized SQLite database identity; original database retained".into());
    }
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite_error)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(sqlite_error)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(sqlite_error)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    // Another app process may finish migration while this connection waits for
    // the writer lock. Decide whether to create the schema under that lock.
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sqlite_error)?;
    if version > 2 {
        return Err("unsupported SQLite database schema; original database retained".into());
    }
    if version == 0 {
        tx.execute_batch(
            "CREATE TABLE module_state(
            module TEXT NOT NULL, feature TEXT NOT NULL, key TEXT PRIMARY KEY NOT NULL,
            value_json TEXT NOT NULL CHECK(json_valid(value_json)),
            revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX module_state_module_feature ON module_state(module,feature);
            CREATE TABLE storage_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);",
        )
        .map_err(sqlite_error)?;
        for key in legacy_keys(root)? {
            upsert(&tx, &key, &read_legacy(root, &key)?)?;
        }
        tx.execute(
            "INSERT INTO storage_meta(key,value) VALUES('legacy_json_imported','1')",
            [],
        )
        .map_err(sqlite_error)?;
        tx.pragma_update(None, "user_version", 1)
            .map_err(sqlite_error)?;
        tx.pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sqlite_error)?;
    } else {
        let migrated: Option<String> = tx
            .query_row(
                "SELECT value FROM storage_meta WHERE key='legacy_json_imported'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite_error)?;
        if migrated.as_deref() != Some("1") {
            return Err("SQLite migration marker missing; original database retained".into());
        }
    }
    if version < 2 {
        crate::project_database::create_schema(&tx)?;
        crate::project_database::rebuild(&tx)?;
        tx.execute(
            "UPDATE module_state SET module='projects',feature='state' WHERE key='projects'",
            [],
        )
        .map_err(sqlite_error)?;
        tx.pragma_update(None, "user_version", 2)
            .map_err(sqlite_error)?;
    }
    tx.commit().map_err(sqlite_error)?;
    Ok(conn)
}

fn read_value(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM module_state WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;
    json.map(|text| {
        serde_json::from_str(&text).map_err(|_| format!("invalid stored SQLite JSON for {key}"))
    })
    .transpose()
}

pub fn read_at(root: &Path, key: &str) -> Result<Option<Value>, String> {
    state_key(key)?;
    read_value(&open(root)?, key)
}

pub fn write_at(root: &Path, key: &str, value: &Value) -> Result<(), String> {
    state_key(key)?;
    let mut conn = open(root)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    upsert(&tx, key, value)?;
    crate::project_database::project_write(&tx, key, value)?;
    tx.commit().map_err(sqlite_error)
}

pub fn write_with_base_at(
    root: &Path,
    key: &str,
    value: &Value,
    base: &Value,
) -> Result<Value, String> {
    state_key(key)?;
    let mut conn = open(root)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let remote = read_value(&tx, key)?.unwrap_or(Value::Null);
    let merged = if &remote == base {
        value.clone()
    } else {
        crate::state_merge::merge(base, value, &remote)?
    };
    upsert(&tx, key, &merged)?;
    crate::project_database::project_write(&tx, key, &merged)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(merged)
}

pub fn write_plan_pair_with_base_at(
    root: &Path,
    plans: &Value,
    archive: &Value,
    base_plans: &Value,
    base_archive: &Value,
) -> Result<(Value, Value), String> {
    let mut conn = open(root)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let merge = |key: &str, value: &Value, base: &Value| -> Result<Value, String> {
        let remote = read_value(&tx, key)?.unwrap_or(Value::Null);
        if &remote == base {
            Ok(value.clone())
        } else {
            crate::state_merge::merge(base, value, &remote)
        }
    };
    let plans = merge("plans", plans, base_plans)?;
    let archive = merge("plans-archive", archive, base_archive)?;
    upsert(&tx, "plans", &plans)?;
    upsert(&tx, "plans-archive", &archive)?;
    crate::project_database::project_write(&tx, "plans", &plans)?;
    crate::project_database::project_write(&tx, "plans-archive", &archive)?;
    tx.commit().map_err(sqlite_error)?;
    Ok((plans, archive))
}

fn collect_owned_entries(
    root: &Path,
    directory: &Path,
    result: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| format!("read module files: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if linklike(&metadata) {
            return Err("module files cannot contain links or junctions".into());
        }
        if metadata.is_dir() {
            result.push(
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
            collect_owned_entries(root, &path, result)?;
        } else if metadata.is_file() {
            result.push(
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_owned(),
            );
        } else {
            return Err("module files must be regular files".into());
        }
    }
    Ok(())
}

/// Verified SQLite online backup + app-owned module files. The target must be
/// empty, and originals are retained. Callers switch data.dir only after success.
pub fn snapshot_to(source: &Path, target: &Path) -> Result<Vec<String>, String> {
    reject_link_components(source)?;
    reject_link_components(target)?;
    fs::create_dir_all(target).map_err(|e| format!("create relocation target: {e}"))?;
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    if source == target {
        return Ok(vec![]);
    }
    if source.starts_with(&target) || target.starts_with(&source) {
        return Err("data directories cannot contain one another".into());
    }
    if fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("relocation target must be empty; existing files were retained".into());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(&source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if legacy_key(&name).is_some() {
            reject_link_components(&entry.path())?;
            if !entry.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("legacy state is not a regular file".into());
            }
            files.push(PathBuf::from(entry.file_name()));
        }
    }
    let modules = source.join("modules");
    if modules.exists() {
        reject_link_components(&modules)?;
        files.push(PathBuf::from("modules"));
        collect_owned_entries(&source, &modules, &mut files)?;
    }
    let conn = open(&source)?;
    let database_target = target.join(DATABASE_FILE);
    // Reserve the destination exclusively so a racing target cannot be replaced.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&database_target)
        .map_err(|e| format!("reserve SQLite snapshot: {e}"))?;
    conn.backup(rusqlite::MAIN_DB, &database_target, None)
        .map_err(sqlite_error)?;
    let snapshot = Connection::open_with_flags(&database_target, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sqlite_error)?;
    let integrity: String = snapshot
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(sqlite_error)?;
    if integrity != "ok" {
        return Err("relocated SQLite snapshot failed integrity check".into());
    }
    drop(snapshot);
    fs::OpenOptions::new()
        .write(true)
        .open(&database_target)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("flush SQLite snapshot: {e}"))?;
    let mut copied = vec![DATABASE_FILE.to_owned()];
    for relative in files {
        let from = source.join(&relative);
        let to = target.join(&relative);
        reject_link_components(&from)?;
        reject_link_components(&to)?;
        if fs::symlink_metadata(&from)
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            fs::create_dir_all(&to).map_err(|e| format!("copy module directory: {e}"))?;
            copied.push(relative.to_string_lossy().into_owned());
            continue;
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut input = fs::File::open(&from).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&to)
            .map_err(|e| format!("copy module file without overwrite: {e}"))?;
        let expected = input.metadata().map_err(|e| e.to_string())?.len();
        let count = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|e| e.to_string())?;
        if count != expected || input.metadata().map_err(|e| e.to_string())?.len() != expected {
            return Err("source module file changed during relocation; pointer unchanged".into());
        }
        copied.push(relative.to_string_lossy().into_owned());
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nimbusdesk-sqlite-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_schema_migrates_fresh_and_v1_databases_without_rewriting_json() {
        for existing_v1 in [false, true] {
            let root = Fixture::new();
            let original = json!({"state":{"days":{"2026-10-18":[{"id":"old"}]}},"version":3});
            if existing_v1 {
                let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
                conn.execute_batch("CREATE TABLE module_state(module TEXT NOT NULL,feature TEXT NOT NULL,key TEXT PRIMARY KEY,value_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO storage_meta VALUES('legacy_json_imported','1');").unwrap();
                conn.pragma_update(None, "application_id", APPLICATION_ID)
                    .unwrap();
                conn.pragma_update(None, "user_version", 1).unwrap();
                upsert(&conn, "plans", &original).unwrap();
            } else {
                fs::write(root.0.join("plans.json"), original.to_string()).unwrap();
            }
            assert_eq!(read_at(&root.0, "plans").unwrap(), Some(original));
            let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
            assert_eq!(
                conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM project_work_items", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    fn project_envelope() -> Value {
        json!({"version":1,"state":{
            "areas":[{"id":"area","name":"Area","createdAt":1,"updatedAt":1}],
            "projects":[{"id":"project","areaId":"area","name":"Project","note":"","status":"active","folder":null,"createdAt":1,"updatedAt":1}],
            "iterations":[{"id":"iteration","name":"Cycle","start":"2026-10-18","end":"2026-10-31","createdAt":1,"updatedAt":1}],
            "items":[{"id":"item","projectId":"project","areaId":null,"title":"Work","note":"","status":"todo","deadline":"2026-10-31","activeIterationId":"iteration","createdAt":1,"updatedAt":1}],
            "memberships":[{"id":"membership","itemId":"item","iterationId":"iteration","joinedAt":1,"leftAt":null,"carriedFrom":null,"snapshot":null,"updatedAt":1}],
            "reminderRule":{"enabled":true,"times":["09:00","16:50"],"advanceDays":0,"weekdays":[1,2,3,4,5],"nonWorkingDay":"same","timezone":"Asia/Shanghai"},
            "deliveries":[]
        }})
    }

    #[test]
    fn project_writes_validate_and_project_atomically() {
        let root = Fixture::new();
        let valid = project_envelope();
        write_at(&root.0, "projects", &valid).unwrap();
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT title FROM project_work_items WHERE id='item'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Work"
        );
        assert_eq!(
            conn.query_row(
                "SELECT module FROM module_state WHERE key='projects'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "projects"
        );
        for (field, value) in [
            ("deadline", json!("2026-02-30")),
            ("projectId", json!("missing")),
            ("activeIterationId", json!("missing")),
            ("status", json!("unknown")),
        ] {
            let mut invalid = valid.clone();
            invalid["state"]["items"][0][field] = value;
            assert!(
                write_at(&root.0, "projects", &invalid).is_err(),
                "accepted {field}"
            );
            assert_eq!(read_at(&root.0, "projects").unwrap(), Some(valid.clone()));
        }
        let mut invalid = valid.clone();
        invalid["state"]["iterations"][0]["end"] = json!("2026-10-01");
        assert!(write_at(&root.0, "projects", &invalid).is_err());
        let mut invalid = valid.clone();
        invalid["state"]["memberships"] = json!([]);
        assert!(write_at(&root.0, "projects", &invalid).is_err());
        let mut invalid = valid.clone();
        let mut duplicate = invalid["state"]["memberships"][0].clone();
        duplicate["id"] = json!("duplicate");
        invalid["state"]["memberships"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(write_at(&root.0, "projects", &invalid).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT revision FROM module_state WHERE key='projects'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn project_plan_links_survive_archive_overlap_and_undo_and_reject_dangling_ids() {
        let root = Fixture::new();
        write_at(&root.0, "projects", &project_envelope()).unwrap();
        let linked = json!({"state":{"days":{"2026-10-18":[{"id":"parent","workItemId":"item"},{"id":"child","parentId":"parent"},{"id":"unbound","parentId":"parent","workItemId":null}]}},"version":3});
        write_at(&root.0, "plans", &linked).unwrap();
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM project_plan_links", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let archived = json!({"state":{"days":{"2026-10-18":{"archivedAt":2,"tasks":linked["state"]["days"]["2026-10-18"].clone()}}},"version":3});
        write_at(&root.0, "plans-archive", &archived).unwrap();
        write_at(&root.0, "plans", &json!({"state":{"days":{}},"version":3})).unwrap();
        write_at(&root.0, "plans", &linked).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM project_plan_links", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
        let mut bad = linked.clone();
        bad["state"]["days"]["2026-10-18"][0]["workItemId"] = json!("missing");
        assert!(write_at(&root.0, "plans", &bad).is_err());
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(linked));
        let mut without_item = project_envelope();
        without_item["state"]["items"] = json!([]);
        without_item["state"]["memberships"] = json!([]);
        assert!(write_at(&root.0, "projects", &without_item).is_err());
    }

    #[test]
    fn project_reminder_rules_reject_empty_slots_and_invalid_limits_without_overwriting() {
        let root = Fixture::new();
        let valid = project_envelope();
        write_at(&root.0, "projects", &valid).unwrap();
        for (field, value) in [
            ("times", json!([])),
            ("weekdays", json!([])),
            ("advanceDays", json!(366)),
            ("times", json!(["24:00"])),
        ] {
            let mut bad = valid.clone();
            bad["state"]["reminderRule"][field] = value;
            assert!(
                write_at(&root.0, "projects", &bad).is_err(),
                "accepted reminder {field}"
            );
        }
        assert_eq!(read_at(&root.0, "projects").unwrap(), Some(valid));
    }

    #[test]
    fn project_malformed_v1_migration_retains_json_version_and_can_retry() {
        let root = Fixture::new();
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        conn.execute_batch("CREATE TABLE module_state(module TEXT NOT NULL,feature TEXT NOT NULL,key TEXT PRIMARY KEY,value_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO storage_meta VALUES('legacy_json_imported','1');").unwrap();
        conn.pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        let mut bad = project_envelope();
        bad["state"]["items"][0]["deadline"] = json!("2026-02-30");
        upsert(&conn, "projects", &bad).unwrap();
        assert!(read_at(&root.0, "projects").is_err());
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(read_value(&conn, "projects").unwrap(), Some(bad));
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='project_work_items'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        upsert(&conn, "projects", &project_envelope()).unwrap();
        assert_eq!(
            read_at(&root.0, "projects").unwrap(),
            Some(project_envelope())
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM project_work_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn project_closed_memberships_are_unique_and_active_membership_cannot_disagree() {
        let root = Fixture::new();
        let valid = project_envelope();
        write_at(&root.0, "projects", &valid).unwrap();
        let mut bad = valid.clone();
        bad["state"]["memberships"][0]["leftAt"] = json!(2);
        assert!(write_at(&root.0, "projects", &bad).is_err());
        bad["state"]["items"][0]["activeIterationId"] = Value::Null;
        let mut duplicate = bad["state"]["memberships"][0].clone();
        duplicate["id"] = json!("duplicate");
        bad["state"]["memberships"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(write_at(&root.0, "projects", &bad).is_err());
        let mut bad = valid.clone();
        bad["state"]["items"][0]["activeIterationId"] = Value::Null;
        assert!(write_at(&root.0, "projects", &bad).is_err());
        let mut bad = valid.clone();
        bad["state"]["memberships"][0]["carriedFrom"] = json!("missing");
        assert!(write_at(&root.0, "projects", &bad).is_err());
        assert_eq!(read_at(&root.0, "projects").unwrap(), Some(valid));
    }

    #[test]
    fn project_merge_write_projects_merged_payload_and_rolls_back_invalid_links() {
        let root = Fixture::new();
        let base = project_envelope();
        write_at(&root.0, "projects", &base).unwrap();
        let mut remote = base.clone();
        remote["state"]["projects"][0]["note"] = json!("remote note");
        write_with_base_at(&root.0, "projects", &remote, &base).unwrap();
        let mut local = base.clone();
        local["state"]["items"][0]["title"] = json!("Merged work");
        let merged = write_with_base_at(&root.0, "projects", &local, &base).unwrap();
        assert_eq!(merged["state"]["projects"][0]["note"], "remote note");
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT title FROM project_work_items WHERE id='item'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "Merged work"
        );
        let plans = json!({"state":{"days":{"2026-10-18":[{"id":"plan","workItemId":"item"}]}},"version":3});
        write_at(&root.0, "plans", &plans).unwrap();
        let mut bad = plans.clone();
        bad["state"]["days"]["2026-10-18"][0]["workItemId"] = json!("missing");
        assert!(write_with_base_at(&root.0, "plans", &bad, &plans).is_err());
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(plans));
    }

    #[test]
    fn project_snapshot_retains_projection_and_unrelated_writes_do_not_rebuild_it() {
        let source = Fixture::new();
        let target = Fixture::new();
        let state = project_envelope();
        write_at(&source.0, "projects", &state).unwrap();
        write_at(&source.0,"plans",&json!({"state":{"days":{"2026-10-18":[{"id":"plan","workItemId":"item"}]}},"version":3})).unwrap();
        snapshot_to(&source.0, &target.0).unwrap();
        assert_eq!(read_at(&target.0, "projects").unwrap(), Some(state));
        let conn = Connection::open(target.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT work_item_id FROM project_plan_links WHERE plan_id='plan'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "item"
        );
        // A trigger makes an accidental rebuild observable on unrelated saves.
        conn.execute_batch("CREATE TRIGGER prevent_project_scan BEFORE DELETE ON project_work_items BEGIN SELECT RAISE(ABORT,'unexpected project rebuild'); END;").unwrap();
        write_at(&target.0, "settings", &json!({"state":{"theme":"dark"}})).unwrap();
    }

    #[test]
    fn project_snapshot_preserves_empty_managed_root_and_nested_directories() {
        let source = Fixture::new();
        let target = Fixture::new();
        let nested = "modules/projects/materials/id/root/nested";
        let second = "modules/projects/materials/empty/root";
        fs::create_dir_all(source.0.join(nested)).unwrap();
        fs::create_dir_all(source.0.join(second)).unwrap();
        write_at(&source.0, "settings", &json!({"state":{}})).unwrap();
        snapshot_to(&source.0, &target.0).unwrap();
        assert!(
            target.0.join(nested).is_dir(),
            "empty nested material directory must survive relocation"
        );
        assert!(
            target.0.join(second).is_dir(),
            "empty managed project root must survive relocation"
        );
        assert!(source.0.join(nested).is_dir());
    }

    #[test]
    fn project_plan_pair_moves_links_between_active_and_archive_atomically() {
        let root = Fixture::new();
        write_at(&root.0, "projects", &project_envelope()).unwrap();
        let active = json!({"version":4,"state":{"days":{"2026-10-18":[{"id":"p","workItemId":"item"},{"id":"c","parentId":"p","workItemId":null}]}}});
        let empty_active = json!({"version":4,"state":{"days":{}}});
        let empty_archive = json!({"version":3,"state":{"days":{}}});
        let archive = json!({"version":3,"state":{"days":{"2026-10-18":{"archivedAt":5,"tasks":active["state"]["days"]["2026-10-18"].clone()}}}});
        write_at(&root.0, "plans", &active).unwrap();
        write_at(&root.0, "plans-archive", &empty_archive).unwrap();
        let actual =
            write_plan_pair_with_base_at(&root.0, &empty_active, &archive, &active, &empty_archive)
                .unwrap();
        assert_eq!(actual, (empty_active.clone(), archive.clone()));
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM project_plan_links WHERE source_key='plans'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM project_plan_links WHERE source_key='plans-archive'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        write_plan_pair_with_base_at(&root.0, &active, &empty_archive, &empty_active, &archive)
            .unwrap();
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(active));
        assert_eq!(
            read_at(&root.0, "plans-archive").unwrap(),
            Some(empty_archive)
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM project_plan_links WHERE source_key='plans'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM project_plan_links WHERE source_key='plans-archive'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn project_plan_pair_second_key_sql_failure_rolls_back_first_json_and_revision() {
        let root = Fixture::new();
        let original = json!({"state":{"days":{}},"version":4});
        write_at(&root.0, "plans", &original).unwrap();
        write_at(&root.0, "plans-archive", &original).unwrap();
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_archive BEFORE UPDATE ON module_state WHEN NEW.key='plans-archive' BEGIN SELECT RAISE(ABORT,'archive write rejected'); END;").unwrap();
        let changed = json!({"state":{"days":{"2026-10-18":[]}},"version":4});
        assert!(
            write_plan_pair_with_base_at(&root.0, &changed, &changed, &original, &original)
                .is_err()
        );
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(original.clone()));
        assert_eq!(read_at(&root.0, "plans-archive").unwrap(), Some(original));
        assert_eq!(
            conn.query_row(
                "SELECT sum(revision) FROM module_state WHERE key IN ('plans','plans-archive')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn project_plan_pair_invalid_archive_link_rolls_back_json_and_link_changes() {
        let root = Fixture::new();
        write_at(&root.0, "projects", &project_envelope()).unwrap();
        let active =
            json!({"version":4,"state":{"days":{"2026-10-18":[{"id":"p","workItemId":"item"}]}}});
        let empty = json!({"state":{"days":{}},"version":3});
        write_at(&root.0, "plans", &active).unwrap();
        write_at(&root.0, "plans-archive", &empty).unwrap();
        let bad = json!({"state":{"days":{"2026-10-18":{"tasks":[{"id":"p","workItemId":"missing"}],"archivedAt":5}}},"version":3});
        assert!(write_plan_pair_with_base_at(&root.0, &empty, &bad, &active, &empty).is_err());
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(active));
        assert_eq!(read_at(&root.0, "plans-archive").unwrap(), Some(empty));
        let conn = Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT source_key FROM project_plan_links WHERE plan_id='p'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "plans"
        );
        assert_eq!(
            conn.query_row(
                "SELECT sum(revision) FROM module_state WHERE key IN ('plans','plans-archive')",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn project_plan_pair_merges_each_stale_base_and_rejects_second_conflict() {
        let root = Fixture::new();
        let base = json!({"state":{"days":{},"one":false,"two":false},"version":4});
        let mut remote = base.clone();
        remote["state"]["one"] = json!(true);
        write_at(&root.0, "plans", &remote).unwrap();
        write_at(&root.0, "plans-archive", &remote).unwrap();
        let mut local = base.clone();
        local["state"]["two"] = json!(true);
        let (active, archive) =
            write_plan_pair_with_base_at(&root.0, &local, &local, &base, &base).unwrap();
        assert_eq!(active["state"]["one"], true);
        assert_eq!(active["state"]["two"], true);
        assert_eq!(active, archive);
        let mut remote_archive = archive.clone();
        remote_archive["state"]["one"] = json!("other");
        write_at(&root.0, "plans-archive", &remote_archive).unwrap();
        let mut new_active = active.clone();
        new_active["state"]["two"] = json!(false);
        let mut conflicting_archive = archive.clone();
        conflicting_archive["state"]["one"] = json!("mine");
        assert!(
            write_plan_pair_with_base_at(
                &root.0,
                &new_active,
                &conflicting_archive,
                &active,
                &archive
            )
            .is_err()
        );
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(active));
        assert_eq!(
            read_at(&root.0, "plans-archive").unwrap(),
            Some(remote_archive)
        );
    }

    #[test]
    fn imports_legacy_envelope_once_and_retains_original() {
        let root = Fixture::new();
        let original = json!({"state":{"tasks":[{"id":"one"}]},"version":7});
        fs::write(root.0.join("plans.json"), original.to_string()).unwrap();
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(original.clone()));
        assert_eq!(
            &fs::read(root.0.join(DATABASE_FILE)).unwrap()[..16],
            b"SQLite format 3\0"
        );
        let newer = json!({"state":{"tasks":[]},"version":8});
        write_at(&root.0, "plans", &newer).unwrap();
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(newer));
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(root.0.join("plans.json")).unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn null_tombstone_never_resurrects_legacy_data() {
        let root = Fixture::new();
        fs::write(
            root.0.join("plans.json"),
            r#"{"version":3,"state":{"tasks":[1]}}"#,
        )
        .unwrap();
        write_at(&root.0, "plans", &Value::Null).unwrap();
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(Value::Null));
    }

    #[test]
    fn invalid_legacy_aborts_the_entire_import_then_can_retry() {
        let root = Fixture::new();
        fs::write(root.0.join("settings.json"), "{").unwrap();
        fs::write(root.0.join("plans.json"), r#"{"version":4}"#).unwrap();
        assert!(read_at(&root.0, "plans").is_err());
        fs::write(root.0.join("settings.json"), r#"{"version":2}"#).unwrap();
        assert_eq!(
            read_at(&root.0, "plans").unwrap(),
            Some(json!({"version":4}))
        );
        assert_eq!(
            read_at(&root.0, "settings").unwrap(),
            Some(json!({"version":2}))
        );
    }

    #[test]
    fn corrupt_database_is_not_overwritten_or_replaced_by_old_json() {
        let root = Fixture::new();
        fs::write(root.0.join(DATABASE_FILE), b"corrupt database").unwrap();
        fs::write(root.0.join("plans.json"), r#"{"stale":true}"#).unwrap();
        assert!(read_at(&root.0, "plans").is_err());
        assert!(write_at(&root.0, "plans", &json!({"new":true})).is_err());
        assert_eq!(
            fs::read(root.0.join(DATABASE_FILE)).unwrap(),
            b"corrupt database"
        );
    }

    #[test]
    fn imports_missing_primary_from_backup_and_excludes_legacy_credentials() {
        let root = Fixture::new();
        fs::write(
            root.0.join("settings.json.bak"),
            r#"{"state":{"lang":"en"},"version":5}"#,
        )
        .unwrap();
        fs::write(root.0.join("ai-settings.json"), "not JSON / private legacy").unwrap();
        assert_eq!(read_at(&root.0, "settings").unwrap().unwrap()["version"], 5);
        let conn = rusqlite::Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM module_state WHERE key='ai-settings'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn separates_module_features_and_preserves_envelope_versions() {
        let root = Fixture::new();
        for key in [
            "plans",
            "plans-archive",
            "todo-papers",
            "ai-providers",
            "custom-plugin",
        ] {
            write_at(&root.0, key, &json!({"state":{},"version":19})).unwrap();
        }
        let conn = rusqlite::Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(DISTINCT feature) FROM module_state WHERE module='plans'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert_eq!(
            read_at(&root.0, "ai-providers").unwrap().unwrap()["version"],
            19
        );
        assert!(read_at(&root.0, "../outside").is_err());
        assert!(write_at(&root.0, "ai-settings", &Value::Null).is_err());
    }

    #[test]
    fn concurrent_connections_preserve_all_independent_writes() {
        let root = Fixture::new();
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let path = root.0.clone();
                std::thread::spawn(move || {
                    write_at(&path, &format!("worker-{index}"), &json!({"worker":index})).unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        for index in 0..12 {
            assert_eq!(
                read_at(&root.0, &format!("worker-{index}")).unwrap(),
                Some(json!({"worker":index}))
            );
        }
    }

    #[test]
    fn stale_base_merges_independent_fields_transactionally() {
        let root = Fixture::new();
        let base = json!({"state":{"one":false,"two":false},"version":1});
        write_at(&root.0, "settings", &base).unwrap();
        let left = json!({"state":{"one":true,"two":false},"version":1});
        let right = json!({"state":{"one":false,"two":true},"version":1});
        write_with_base_at(&root.0, "settings", &left, &base).unwrap();
        let merged = write_with_base_at(&root.0, "settings", &right, &base).unwrap();
        assert_eq!(merged, json!({"state":{"one":true,"two":true},"version":1}));
        assert_eq!(read_at(&root.0, "settings").unwrap(), Some(merged));
    }

    #[test]
    fn relocation_snapshots_sqlite_and_owned_files_without_target_overwrite() {
        let source = Fixture::new();
        let target = Fixture::new();
        write_at(&source.0, "plans", &json!({"version":9})).unwrap();
        let relative = "modules/plans/tasks/task/attachments/id/photo.bin";
        fs::create_dir_all(source.0.join(relative).parent().unwrap()).unwrap();
        fs::write(source.0.join(relative), [0, 255, 4, 8]).unwrap();
        fs::write(source.0.join("ai-settings.json"), "{\"version\":1}").unwrap();
        snapshot_to(&source.0, &target.0).unwrap();
        assert_eq!(
            read_at(&target.0, "plans").unwrap(),
            Some(json!({"version":9}))
        );
        assert_eq!(fs::read(target.0.join(relative)).unwrap(), [0, 255, 4, 8]);
        assert!(target.0.join("ai-settings.json").is_file());
        assert!(snapshot_to(&source.0, &target.0).is_err());
        assert_eq!(
            read_at(&source.0, "plans").unwrap(),
            Some(json!({"version":9}))
        );
    }

    #[test]
    fn relocation_rejects_nested_targets_and_file_conflicts() {
        let source = Fixture::new();
        let target = Fixture::new();
        fs::write(target.0.join("unrelated.txt"), "keep").unwrap();
        assert!(snapshot_to(&source.0, &target.0).is_err());
        assert!(snapshot_to(&source.0, &source.0.join("nested")).is_err());
        assert_eq!(
            fs::read_to_string(target.0.join("unrelated.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn successful_import_never_reads_later_legacy_changes() {
        let root = Fixture::new();
        fs::write(root.0.join("plans.json"), r#"{"version":2}"#).unwrap();
        assert_eq!(
            read_at(&root.0, "plans").unwrap(),
            Some(json!({"version":2}))
        );
        fs::write(root.0.join("plans.json"), "broken stale JSON").unwrap();
        write_at(&root.0, "plans", &Value::Null).unwrap();
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(Value::Null));
    }

    #[test]
    fn corrupt_primary_does_not_silently_import_a_stale_backup() {
        let root = Fixture::new();
        fs::write(root.0.join("settings.json"), "{").unwrap();
        fs::write(root.0.join("settings.json.bak"), r#"{"version":1}"#).unwrap();
        assert!(
            read_at(&root.0, "settings")
                .unwrap_err()
                .contains("invalid legacy JSON")
        );
        assert_eq!(
            fs::read_to_string(root.0.join("settings.json")).unwrap(),
            "{"
        );
    }

    #[test]
    fn future_schema_is_rejected_without_mutating_database() {
        let root = Fixture::new();
        let path = root.0.join(DATABASE_FILE);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        let original = fs::read(&path).unwrap();
        assert!(read_at(&root.0, "plans").is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn concurrent_stale_bases_merge_without_losing_other_writers() {
        let root = Fixture::new();
        let base = json!({"a":false,"b":false,"c":false,"d":false,"e":false,"f":false});
        write_at(&root.0, "settings", &base).unwrap();
        let workers: Vec<_> = ["a", "b", "c", "d", "e", "f"]
            .into_iter()
            .map(|field| {
                let path = root.0.clone();
                let base = base.clone();
                std::thread::spawn(move || {
                    let mut local = base.clone();
                    local[field] = json!(true);
                    write_with_base_at(&path, "settings", &local, &base).unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            read_at(&root.0, "settings").unwrap(),
            Some(json!({"a":true,"b":true,"c":true,"d":true,"e":true,"f":true}))
        );
    }

    #[test]
    fn conflicting_stale_write_does_not_change_the_saved_value_or_revision() {
        let root = Fixture::new();
        let base = json!({"title":"original"});
        let remote = json!({"title":"other window"});
        write_at(&root.0, "plans", &base).unwrap();
        write_with_base_at(&root.0, "plans", &remote, &base).unwrap();
        assert!(write_with_base_at(&root.0, "plans", &json!({"title":"mine"}), &base).is_err());
        assert_eq!(read_at(&root.0, "plans").unwrap(), Some(remote));
        let conn = rusqlite::Connection::open(root.0.join(DATABASE_FILE)).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT revision FROM module_state WHERE key='plans'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }

    #[cfg(windows)]
    #[test]
    fn relocation_and_database_access_reject_junctions() {
        let source = Fixture::new();
        let target = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("private.bin"), [1, 2, 3]).unwrap();
        let link = source.0.join("modules");
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside.0)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(snapshot_to(&source.0, &target.0).is_err());
        assert!(read_at(&link, "plans").is_err());
        assert_eq!(fs::read(outside.0.join("private.bin")).unwrap(), [1, 2, 3]);
        assert!(fs::read_dir(&target.0).unwrap().next().is_none());
        fs::remove_dir(&link).unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target.0)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(snapshot_to(&source.0, &link).is_err());
        fs::remove_dir(link).unwrap();
    }
}
