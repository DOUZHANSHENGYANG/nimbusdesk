//! Transactional, rebuildable indexes of the authoritative module_state JSON.
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn error(message: impl std::fmt::Display) -> String {
    format!("project storage: {message}")
}

pub fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE project_areas(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)));
        CREATE TABLE project_projects(id TEXT PRIMARY KEY NOT NULL,area_id TEXT REFERENCES project_areas(id),name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','archived')),folder TEXT,updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)));
        CREATE INDEX project_projects_area ON project_projects(area_id);
        CREATE TABLE project_iterations(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL CHECK(end_date>=start_date),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)));
        CREATE TABLE project_work_items(id TEXT PRIMARY KEY NOT NULL,project_id TEXT REFERENCES project_projects(id),area_id TEXT REFERENCES project_areas(id),title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','doing','done','cancelled')),deadline TEXT,active_iteration_id TEXT REFERENCES project_iterations(id),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)));
        CREATE INDEX project_work_items_project ON project_work_items(project_id);
        CREATE INDEX project_work_items_iteration ON project_work_items(active_iteration_id);
        CREATE TABLE project_memberships(id TEXT PRIMARY KEY NOT NULL,item_id TEXT NOT NULL REFERENCES project_work_items(id),iteration_id TEXT NOT NULL REFERENCES project_iterations(id),joined_at INTEGER NOT NULL,left_at INTEGER,carried_from TEXT REFERENCES project_iterations(id),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),UNIQUE(item_id,iteration_id),CHECK(left_at IS NULL OR left_at>=joined_at));
        CREATE UNIQUE INDEX project_memberships_active ON project_memberships(item_id) WHERE left_at IS NULL;
        CREATE TABLE project_plan_links(source_key TEXT NOT NULL CHECK(source_key IN ('plans','plans-archive')),day TEXT NOT NULL,plan_id TEXT NOT NULL,work_item_id TEXT REFERENCES project_work_items(id),PRIMARY KEY(source_key,day,plan_id));
        CREATE INDEX project_plan_links_item ON project_plan_links(work_item_id);",
    ).map_err(error)
}

pub fn create_remote_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE project_remote_tasks(id TEXT PRIMARY KEY NOT NULL,connection_id TEXT NOT NULL,remote_id INTEGER NOT NULL CHECK(remote_id>0),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),UNIQUE(connection_id,remote_id));
        CREATE TABLE project_remote_executions(id TEXT PRIMARY KEY NOT NULL,connection_id TEXT NOT NULL,remote_id INTEGER NOT NULL CHECK(remote_id>0),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),UNIQUE(connection_id,remote_id));
        CREATE TABLE project_remote_links(id TEXT PRIMARY KEY NOT NULL,connection_id TEXT NOT NULL,remote_id INTEGER NOT NULL CHECK(remote_id>0),item_id TEXT NOT NULL UNIQUE REFERENCES project_work_items(id),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),UNIQUE(connection_id,remote_id),FOREIGN KEY(connection_id,remote_id) REFERENCES project_remote_tasks(connection_id,remote_id));",
    ).map_err(error)
}

pub fn create_writeback_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE UNIQUE INDEX project_remote_link_identity ON project_remote_links(id,connection_id,remote_id,item_id);
        CREATE TABLE project_remote_changes(id TEXT PRIMARY KEY NOT NULL,connection_id TEXT NOT NULL,remote_id INTEGER NOT NULL CHECK(remote_id>0),item_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('pending','conflict','sending','uncertain','failed')),updated_at INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),UNIQUE(connection_id,remote_id),FOREIGN KEY(id,connection_id,remote_id,item_id) REFERENCES project_remote_links(id,connection_id,remote_id,item_id));",
    ).map_err(error)
}

fn saved(conn: &Connection, key: &str) -> Result<Option<Value>, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value_json FROM module_state WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    json.map(|json| serde_json::from_str(&json).map_err(error))
        .transpose()
}

pub fn rebuild(conn: &Connection) -> Result<(), String> {
    if let Some(config) = saved(conn, "zentao")? {
        validate_zentao(&config)?;
    }
    project_state(conn, saved(conn, "projects")?.as_ref())?;
    for key in ["plans", "plans-archive"] {
        plan_links(conn, key, saved(conn, key)?.as_ref())?;
    }
    Ok(())
}

pub fn project_write(conn: &Connection, key: &str, value: &Value) -> Result<(), String> {
    match key {
        "projects" => rebuild(conn),
        "plans" | "plans-archive" => plan_links(conn, key, Some(value)),
        "zentao" => validate_zentao(value),
        _ => Ok(()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entity {
    id: String,
    #[serde(default)]
    name: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn nonempty(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error(format!("invalid {key}")))
}
fn optional_id(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if !id.trim().is_empty() => Ok(Some(id.clone())),
        _ => Err(error(format!("invalid {key}"))),
    }
}
fn epoch(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|n| *n >= 0)
        .ok_or_else(|| error(format!("invalid {key}")))
}
fn status(value: &Value, key: &str, allowed: &[&str]) -> Result<String, String> {
    let status = nonempty(value, key)?;
    if !allowed.contains(&status.as_str()) {
        return Err(error(format!("invalid {key}")));
    }
    Ok(status)
}
fn date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    year > 0 && day > 0 && day <= max
}
fn optional_date(value: &Value, key: &str) -> Result<Option<String>, String> {
    let d = optional_id(value, key)?;
    if d.as_deref().is_some_and(|d| !date(d)) {
        return Err(error(format!("invalid {key} date")));
    }
    Ok(d)
}
fn clock(time: &str) -> bool {
    let b = time.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b.iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && time[..2].parse::<u32>().is_ok_and(|h| h < 24)
        && time[3..].parse::<u32>().is_ok_and(|m| m < 60)
}
fn reminder(rule: &Value) -> Result<(), String> {
    if rule.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(error("invalid reminder enabled"));
    }
    let times = rule
        .get("times")
        .and_then(Value::as_array)
        .ok_or_else(|| error("invalid reminder times"))?;
    if times.is_empty() || times.len() > 12 {
        return Err(error("invalid reminder times"));
    }
    let mut seen = HashSet::new();
    for time in times {
        let time = time
            .as_str()
            .filter(|t| clock(t))
            .ok_or_else(|| error("invalid reminder time"))?;
        if !seen.insert(time) {
            return Err(error("duplicate reminder time"));
        }
    }
    let days = rule
        .get("weekdays")
        .and_then(Value::as_array)
        .ok_or_else(|| error("invalid reminder weekdays"))?;
    if days.is_empty() {
        return Err(error("invalid reminder weekdays"));
    }
    let mut seen = HashSet::new();
    for day in days {
        let day = day
            .as_u64()
            .filter(|n| *n < 7)
            .ok_or_else(|| error("invalid reminder weekday"))?;
        if !seen.insert(day) {
            return Err(error("duplicate reminder weekday"));
        }
    }
    if rule
        .get("advanceDays")
        .and_then(Value::as_u64)
        .filter(|n| *n <= 365)
        .is_none()
    {
        return Err(error("invalid reminder advanceDays"));
    }
    status(rule, "nonWorkingDay", &["same", "previous"])?;
    nonempty(rule, "timezone")?;
    Ok(())
}
fn override_rule(value: &Value) -> Result<(), String> {
    if let Some(rule) = value.get("reminder").filter(|r| !r.is_null()) {
        reminder(rule)?;
    }
    Ok(())
}
fn array<'a>(state: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    state
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| error(format!("invalid projects {key}")))
}
fn entities<'a>(state: &'a Value, key: &str) -> Result<Vec<(&'a Value, Entity)>, String> {
    let mut ids = HashSet::new();
    array(state, key)?
        .iter()
        .map(|v| {
            let e: Entity = serde_json::from_value(v.clone())
                .map_err(|_| error(format!("invalid projects {key} entity")))?;
            if e.id.trim().is_empty()
                || !ids.insert(e.id.clone())
                || e.created_at < 0
                || e.updated_at < 0
            {
                return Err(error(format!(
                    "invalid or duplicate projects {key} identity"
                )));
            }
            Ok((v, e))
        })
        .collect()
}
fn name(e: &Entity) -> Result<&str, String> {
    e.name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| error("invalid name"))
}
fn note(v: &Value) -> Result<(), String> {
    if !v.get("note").is_some_and(Value::is_string) {
        return Err(error("invalid note"));
    }
    Ok(())
}

fn bounded_text(value: &Value, key: &str, limit: usize, empty: bool) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= limit && (empty || !s.trim().is_empty()) && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| error(format!("invalid {key}")))
}

fn optional_remote_id(value: &Value, key: &str) -> Result<(), String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(v)
            if v.as_i64()
                .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991) =>
        {
            Ok(())
        }
        _ => Err(error(format!("invalid {key}"))),
    }
}

fn source_identity(value: &Value, kind: &str) -> Result<(String, String, i64), String> {
    let connection = bounded_text(value, "connectionId", 200, false)?;
    let remote = value
        .get("remoteId")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .ok_or_else(|| error("invalid remoteId"))?;
    let id = bounded_text(value, "id", 240, false)?;
    if id != format!("{connection}:{kind}:{remote}") {
        return Err(error("remote identity does not match source"));
    }
    epoch(value, "updatedAt")?;
    Ok((id, connection, remote))
}

fn remote_array<'a>(state: &'a Value, key: &str, max: usize) -> Result<&'a [Value], String> {
    match state.get(key) {
        None => Ok(&[]),
        Some(Value::Array(values)) if values.len() <= max => Ok(values),
        _ => Err(error(format!("invalid {key}"))),
    }
}

fn fields(value: &Value) -> Result<(), String> {
    if value.get("deadline").is_none() {
        return Err(error("missing baseline deadline"));
    }
    bounded_text(value, "title", 10_000, false)?;
    bounded_text(value, "note", 1_000_000, true)?;
    status(value, "status", &["todo", "doing", "done", "cancelled"])?;
    optional_date(value, "deadline")?;
    Ok(())
}

fn timestamp(value: &str) -> bool {
    if !value.is_ascii() || value.len() < 10 || !date(&value[..10]) {
        return false;
    }
    if value.len() == 10 {
        return true;
    }
    let bytes = value.as_bytes();
    if value.len() < 19
        || !matches!(bytes[10], b' ' | b'T')
        || !clock(&value[11..16])
        || bytes[16] != b':'
        || !value[17..19].parse::<u32>().is_ok_and(|s| s < 60)
    {
        return false;
    }
    let mut tail = &value[19..];
    if let Some(fraction) = tail.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        tail = &fraction[digits..];
    }
    tail.is_empty()
        || tail == "Z"
        || (tail.len() == 6 && matches!(tail.as_bytes()[0], b'+' | b'-') && clock(&tail[1..]))
}

fn remote_state(
    conn: &Connection,
    state: &Value,
    items: &HashSet<String>,
    merged: &HashMap<String, String>,
) -> Result<(), String> {
    for value in remote_array(state, "remoteTasks", 100_000)? {
        if [
            "deadline",
            "start",
            "remoteProjectId",
            "executionId",
            "parentRemoteId",
            "lastEditedDate",
        ]
        .iter()
        .any(|key| value.get(key).is_none())
        {
            return Err(error("incomplete remote task"));
        }
        let (id, connection, remote) = source_identity(value, "task")?;
        bounded_text(value, "title", 10_000, false)?;
        bounded_text(value, "note", 1_000_000, true)?;
        bounded_text(value, "status", 100, false)?;
        bounded_text(value, "assignedTo", 1_000, true)?;
        optional_date(value, "deadline")?;
        optional_date(value, "start")?;
        for key in ["remoteProjectId", "executionId", "parentRemoteId"] {
            optional_remote_id(value, key)?;
        }
        let team = value
            .get("teamAccounts")
            .and_then(Value::as_array)
            .filter(|team| team.len() <= 1_000)
            .ok_or_else(|| error("invalid teamAccounts"))?;
        if team.iter().any(|account| {
            !account
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1_000 && !s.contains('\0'))
        }) {
            return Err(error("invalid team account"));
        }
        if let Some(edited) = optional_id(value, "lastEditedDate")? {
            if edited.len() > 100 || !timestamp(&edited) {
                return Err(error("invalid lastEditedDate"));
            }
        }
        conn.execute(
            "INSERT INTO project_remote_tasks VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                connection,
                remote,
                epoch(value, "updatedAt")?,
                value.to_string()
            ],
        )
        .map_err(error)?;
    }
    for value in remote_array(state, "remoteExecutions", 10_000)? {
        if value.get("start").is_none() || value.get("end").is_none() {
            return Err(error("incomplete remote execution"));
        }
        let (id, connection, remote) = source_identity(value, "execution")?;
        bounded_text(value, "name", 10_000, false)?;
        bounded_text(value, "status", 100, false)?;
        let start = optional_date(value, "start")?;
        let end = optional_date(value, "end")?;
        if start
            .as_ref()
            .zip(end.as_ref())
            .is_some_and(|(start, end)| end < start)
        {
            return Err(error("invalid remote execution date range"));
        }
        conn.execute(
            "INSERT INTO project_remote_executions VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                connection,
                remote,
                epoch(value, "updatedAt")?,
                value.to_string()
            ],
        )
        .map_err(error)?;
    }
    for value in remote_array(state, "remoteLinks", 100_000)? {
        let (id, connection, remote) = source_identity(value, "task")?;
        let item = bounded_text(value, "itemId", 200, false)?;
        if !items.contains(&item) || merged.contains_key(&item) {
            return Err(error("invalid remote link work item"));
        }
        fields(
            value
                .get("baseline")
                .ok_or_else(|| error("missing remote baseline"))?,
        )?;
        let mut seen = HashSet::new();
        let divergence = value
            .get("divergedFields")
            .and_then(Value::as_array)
            .ok_or_else(|| error("invalid divergedFields"))?;
        for field in divergence {
            let field = field
                .as_str()
                .filter(|field| ["title", "note", "deadline", "status"].contains(field))
                .ok_or_else(|| error("invalid diverged field"))?;
            if !seen.insert(field) {
                return Err(error("duplicate diverged field"));
            }
        }
        conn.execute(
            "INSERT INTO project_remote_links VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                id,
                connection,
                remote,
                item,
                epoch(value, "updatedAt")?,
                value.to_string()
            ],
        )
        .map_err(error)?;
    }
    for value in remote_array(state, "remoteChanges", 100_000)? {
        known_keys(
            value,
            &[
                "id",
                "connectionId",
                "remoteId",
                "itemId",
                "status",
                "base",
                "local",
                "remote",
                "expected",
                "fields",
                "lastError",
                "updatedAt",
            ],
        )?;
        let (id, connection, remote) = source_identity(value, "task")?;
        let item = bounded_text(value, "itemId", 200, false)?;
        let state = status(
            value,
            "status",
            &["pending", "conflict", "sending", "uncertain", "failed"],
        )?;
        for key in ["base", "local", "remote", "expected"] {
            let snapshot = value
                .get(key)
                .ok_or_else(|| error("missing writeback snapshot"))?;
            known_keys(snapshot, &["title", "note", "deadline", "status"])?;
            fields(snapshot)?;
        }
        write_fields(value.get("fields"), false)?;
        match value.get("lastError") {
            Some(Value::Null) => {}
            Some(Value::String(message)) if message.len() <= 2_000 && !message.contains('\0') => {}
            _ => return Err(error("invalid writeback error")),
        }
        conn.execute(
            "INSERT INTO project_remote_changes VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                id,
                connection,
                remote,
                item,
                state,
                epoch(value, "updatedAt")?,
                value.to_string()
            ],
        )
        .map_err(error)?;
    }
    Ok(())
}

fn write_fields(value: Option<&Value>, optional: bool) -> Result<(), String> {
    let Some(value) = value else {
        return if optional {
            Ok(())
        } else {
            Err(error("missing write fields"))
        };
    };
    let fields = value
        .as_array()
        .filter(|fields| fields.len() <= 3 && (optional || !fields.is_empty()))
        .ok_or_else(|| error("invalid write fields"))?;
    let mut seen = HashSet::new();
    for field in fields {
        let field = field
            .as_str()
            .filter(|field| ["title", "note", "deadline"].contains(field))
            .ok_or_else(|| error("unsupported write field"))?;
        if !seen.insert(field) {
            return Err(error("duplicate write field"));
        }
    }
    Ok(())
}

fn known_keys(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| error("invalid ZenTao metadata object"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(error("unsupported ZenTao metadata field"));
    }
    Ok(())
}

/// Only public connection metadata belongs in module_state and its backups.
pub fn validate_zentao(envelope: &Value) -> Result<(), String> {
    known_keys(envelope, &["state", "version"])?;
    if envelope
        .get("version")
        .is_some_and(|v| v.as_u64().is_none())
    {
        return Err(error("invalid ZenTao metadata version"));
    }
    let state = envelope
        .get("state")
        .ok_or_else(|| error("missing ZenTao metadata state"))?;
    known_keys(state, &["connections", "syncStates"])?;
    let connections = state
        .get("connections")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 100)
        .ok_or_else(|| error("invalid ZenTao connections"))?;
    let mut ids = HashSet::new();
    for connection in connections {
        known_keys(
            connection,
            &[
                "id",
                "name",
                "baseUrl",
                "account",
                "apiVersion",
                "executionIds",
                "autoSync",
                "syncMinutes",
                "createdAt",
                "updatedAt",
                "writeFields",
            ],
        )?;
        let id = bounded_text(connection, "id", 200, false)?;
        if !ids.insert(id) {
            return Err(error("duplicate ZenTao connection"));
        }
        bounded_text(connection, "name", 1_000, false)?;
        let url = bounded_text(connection, "baseUrl", 4_096, true)?;
        if !url.is_empty() {
            let parsed = reqwest::Url::parse(&url).map_err(|_| error("invalid ZenTao base URL"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(error("invalid ZenTao base URL"));
            }
        }
        bounded_text(connection, "account", 1_000, true)?;
        write_fields(connection.get("writeFields"), true)?;
        status(connection, "apiVersion", &["auto", "v1", "v2"])?;
        let scope = connection
            .get("executionIds")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 1_000)
            .ok_or_else(|| error("invalid execution scope"))?;
        let mut executions = HashSet::new();
        for execution in scope {
            let id = execution
                .as_i64()
                .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
                .ok_or_else(|| error("invalid execution scope ID"))?;
            if !executions.insert(id) {
                return Err(error("duplicate execution scope ID"));
            }
        }
        if connection
            .get("autoSync")
            .and_then(Value::as_bool)
            .is_none()
            || !connection
                .get("syncMinutes")
                .and_then(Value::as_u64)
                .is_some_and(|n| (1..=1_440).contains(&n))
        {
            return Err(error("invalid ZenTao synchronization settings"));
        }
        epoch(connection, "createdAt")?;
        epoch(connection, "updatedAt")?;
    }
    let states = state
        .get("syncStates")
        .and_then(Value::as_object)
        .ok_or_else(|| error("invalid ZenTao syncStates"))?;
    for (id, meta) in states {
        if !ids.contains(id) {
            return Err(error("unknown ZenTao sync connection"));
        }
        known_keys(
            meta,
            &[
                "lastSyncAt",
                "lastError",
                "lastCount",
                "resolvedVersion",
                "authRequired",
            ],
        )?;
        if !matches!(meta.get("lastSyncAt"), Some(Value::Null)) {
            epoch(meta, "lastSyncAt")?;
        }
        match meta.get("lastError") {
            Some(Value::Null) => {}
            Some(Value::String(message)) if message.len() <= 2_000 => {}
            _ => return Err(error("invalid ZenTao sync error")),
        }
        if !meta
            .get("lastCount")
            .and_then(Value::as_u64)
            .is_some_and(|n| n <= 100_000)
        {
            return Err(error("invalid ZenTao sync count"));
        }
        if !matches!(meta.get("resolvedVersion"), Some(Value::Null)) {
            status(meta, "resolvedVersion", &["v1", "v2"])?;
        }
        if meta.get("authRequired").and_then(Value::as_bool).is_none() {
            return Err(error("invalid ZenTao auth status"));
        }
    }
    Ok(())
}

pub fn validate_zentao_change(conn: &Connection, envelope: &Value) -> Result<(), String> {
    validate_zentao(envelope)?;
    let Some(previous) = saved(conn, "zentao")? else {
        return Ok(());
    };
    let Some(projects) = saved(conn, "projects")? else {
        return Ok(());
    };
    let cached: HashSet<_> = projects
        .pointer("/state/remoteTasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|task| task.get("connectionId").and_then(Value::as_str))
        .collect();
    let old = previous
        .pointer("/state/connections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let next = envelope
        .pointer("/state/connections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for connection in next {
        let id = connection["id"].as_str().unwrap_or_default();
        if !cached.contains(id) {
            continue;
        }
        let Some(prior) = old.iter().find(|v| v.get("id") == connection.get("id")) else {
            continue;
        };
        let endpoint = |value: &Value| {
            value.get("baseUrl").and_then(Value::as_str).map(|url| {
                reqwest::Url::parse(url)
                    .map(|url| url.to_string().trim_end_matches('/').to_owned())
                    .unwrap_or_else(|_| url.to_owned())
            })
        };
        if endpoint(prior) != endpoint(connection)
            || prior.get("account") != connection.get("account")
        {
            return Err(error(
                "cached source identity is immutable; create another connection",
            ));
        }
    }
    Ok(())
}

fn project_state(conn: &Connection, envelope: Option<&Value>) -> Result<(), String> {
    // Called only within the caller's SQLite write/migration transaction.
    conn.execute_batch("DELETE FROM project_remote_changes; DELETE FROM project_remote_links; DELETE FROM project_remote_tasks; DELETE FROM project_remote_executions; DELETE FROM project_plan_links; DELETE FROM project_memberships; DELETE FROM project_work_items; DELETE FROM project_projects; DELETE FROM project_iterations; DELETE FROM project_areas;").map_err(error)?;
    let Some(envelope) = envelope.filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let state = envelope
        .get("state")
        .filter(|v| v.is_object())
        .ok_or_else(|| error("invalid projects state envelope"))?;
    reminder(
        state
            .get("reminderRule")
            .ok_or_else(|| error("missing reminder rule"))?,
    )?;
    for (v, e) in entities(state, "areas")? {
        conn.execute(
            "INSERT INTO project_areas VALUES(?1,?2,?3,?4)",
            params![e.id, name(&e)?, e.updated_at, v.to_string()],
        )
        .map_err(error)?;
    }
    for (v, e) in entities(state, "projects")? {
        note(v)?;
        override_rule(v)?;
        conn.execute(
            "INSERT INTO project_projects VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                e.id,
                optional_id(v, "areaId")?,
                name(&e)?,
                status(v, "status", &["active", "archived"])?,
                optional_id(v, "folder")?,
                e.updated_at,
                v.to_string()
            ],
        )
        .map_err(error)?;
    }
    for (v, e) in entities(state, "iterations")? {
        let start = nonempty(v, "start")?;
        let end = nonempty(v, "end")?;
        if !date(&start) || !date(&end) || end < start {
            return Err(error("invalid iteration date range"));
        }
        conn.execute(
            "INSERT INTO project_iterations VALUES(?1,?2,?3,?4,?5,?6)",
            params![e.id, name(&e)?, start, end, e.updated_at, v.to_string()],
        )
        .map_err(error)?;
    }
    let mut active = HashMap::new();
    let mut item_ids = HashSet::new();
    let mut merged_items = HashMap::new();
    for (v, e) in entities(state, "items")? {
        note(v)?;
        override_rule(v)?;
        let iteration = optional_id(v, "activeIterationId")?;
        if let Some(iteration) = &iteration {
            active.insert(e.id.clone(), iteration.clone());
        }
        item_ids.insert(e.id.clone());
        if let Some(target) = optional_id(v, "mergedIntoId")? {
            if v.get("status").and_then(Value::as_str) != Some("cancelled") {
                return Err(error("merged work item must be cancelled"));
            }
            merged_items.insert(e.id.clone(), target);
        }
        conn.execute(
            "INSERT INTO project_work_items VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                e.id,
                optional_id(v, "projectId")?,
                optional_id(v, "areaId")?,
                nonempty(v, "title")?,
                status(v, "status", &["todo", "doing", "done", "cancelled"])?,
                optional_date(v, "deadline")?,
                iteration,
                e.updated_at,
                v.to_string()
            ],
        )
        .map_err(error)?;
    }
    for (donor, target) in &merged_items {
        if donor == target || !item_ids.contains(target) || merged_items.contains_key(target) {
            return Err(error("invalid merged work item target"));
        }
    }
    remote_state(conn, state, &item_ids, &merged_items)?;
    let mut ids = HashSet::new();
    let mut open = HashMap::new();
    for v in array(state, "memberships")? {
        let id = nonempty(v, "id")?;
        if !ids.insert(id.clone()) {
            return Err(error("duplicate membership ID"));
        }
        let item = nonempty(v, "itemId")?;
        let iteration = nonempty(v, "iterationId")?;
        let joined = epoch(v, "joinedAt")?;
        let left = match v.get("leftAt") {
            None | Some(Value::Null) => None,
            _ => Some(epoch(v, "leftAt")?),
        };
        if left.is_none() && open.insert(item.clone(), iteration.clone()).is_some() {
            return Err(error("multiple active memberships"));
        }
        if let Some(snapshot) = v.get("snapshot").filter(|s| !s.is_null()) {
            nonempty(snapshot, "title")?;
            status(snapshot, "status", &["todo", "doing", "done", "cancelled"])?;
            optional_date(snapshot, "deadline")?;
        }
        let from = optional_id(v, "carriedFrom")?;
        if from.as_deref() == Some(iteration.as_str()) {
            return Err(error("membership cannot carry from itself"));
        }
        conn.execute(
            "INSERT INTO project_memberships VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                item,
                iteration,
                joined,
                left,
                from,
                epoch(v, "updatedAt")?,
                v.to_string()
            ],
        )
        .map_err(error)?;
    }
    if active != open {
        return Err(error("active iteration and membership disagree"));
    }
    let mut ids = HashSet::new();
    for v in array(state, "deliveries")? {
        let id = nonempty(v, "id")?;
        if !ids.insert(id) || !item_ids.contains(&nonempty(v, "itemId")?) {
            return Err(error("invalid reminder delivery reference"));
        }
        if !date(&nonempty(v, "date")?) {
            return Err(error("invalid delivery date"));
        }
        epoch(v, "notifiedAt")?;
        let slots = v
            .get("slots")
            .and_then(Value::as_array)
            .ok_or_else(|| error("invalid delivery slots"))?;
        if slots.iter().any(|s| !s.as_str().is_some_and(clock)) {
            return Err(error("invalid delivery slot"));
        }
    }
    Ok(())
}

fn plan_links(conn: &Connection, key: &str, envelope: Option<&Value>) -> Result<(), String> {
    conn.execute("DELETE FROM project_plan_links WHERE source_key=?1", [key])
        .map_err(error)?;
    // Existing plan JSON without links is accepted without rewriting or requiring
    // newer envelope fields. Only explicit link metadata is projected.
    let Some(days) = envelope
        .and_then(|v| v.get("state"))
        .and_then(|s| s.get("days"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    for (day, payload) in days {
        let tasks = if key == "plans-archive" {
            payload.get("tasks")
        } else {
            Some(payload)
        };
        let Some(tasks) = tasks.and_then(Value::as_array) else {
            continue;
        };
        for task in tasks {
            if !task
                .as_object()
                .is_some_and(|t| t.contains_key("workItemId"))
            {
                continue;
            }
            let id = nonempty(task, "id")?;
            let item = optional_id(task, "workItemId")?;
            if let Some(item) = &item {
                let merged: Option<String> = conn.query_row(
                    "SELECT json_extract(value_json,'$.mergedIntoId') FROM project_work_items WHERE id=?1",
                    [item], |row| row.get(0),
                ).optional().map_err(error)?.flatten();
                if merged.is_some() {
                    return Err(error("plan cannot reference merged work item"));
                }
            }
            conn.execute(
                "INSERT INTO project_plan_links VALUES(?1,?2,?3,?4)",
                params![key, day, id, item],
            )
            .map_err(error)?;
        }
    }
    Ok(())
}
