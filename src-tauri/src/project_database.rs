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

fn project_state(conn: &Connection, envelope: Option<&Value>) -> Result<(), String> {
    // Called only within the caller's SQLite write/migration transaction.
    conn.execute_batch("DELETE FROM project_plan_links; DELETE FROM project_memberships; DELETE FROM project_work_items; DELETE FROM project_projects; DELETE FROM project_iterations; DELETE FROM project_areas;").map_err(error)?;
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
    for (v, e) in entities(state, "items")? {
        note(v)?;
        override_rule(v)?;
        let iteration = optional_id(v, "activeIterationId")?;
        if let Some(iteration) = &iteration {
            active.insert(e.id.clone(), iteration.clone());
        }
        item_ids.insert(e.id.clone());
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
            conn.execute(
                "INSERT INTO project_plan_links VALUES(?1,?2,?3,?4)",
                params![key, day, id, item],
            )
            .map_err(error)?;
        }
    }
    Ok(())
}
