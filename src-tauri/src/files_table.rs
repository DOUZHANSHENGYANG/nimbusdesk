//! `files` 的行级存储。
//!
//! 原来 `files` 是 `module_state` 里的**一整份 JSON**：`{ categories: [...], items: [...] }`。
//! 改一个条目就要把整份文档序列化、过一趟 IPC、再让 SQLite 重写整行 —— 整目录映射进来的
//! 分类到几千条之后，单次写入 5–25 ms，连续整理文件时每秒四次，主线程与磁盘都在白忙。
//!
//! 这里把它拆成行级表：一条条目一行、一个分类一行，写一条就是一条 UPDATE。
//! **payload 仍是 JSON**（不是逐字段列）：字段还在演进，逐字段列表会让每次加字段都变成一次
//! schema 迁移；行级 + JSON payload 兼顾「写入粒度」与「字段演化」，代价只是读回来时要反序列化。
//!
//! 顺序单独存一列 `ord`：界面里的条目顺序是数组顺序（拖动排序靠它），行表本身没有顺序，
//! 所以推送改动时一并带上位置。只有内容变了的行才重写 payload，只有位置变了的行只更新 `ord`。
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// 建表语句（幂等）。随 `open()` 一起执行。
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS file_categories(
  id TEXT PRIMARY KEY NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_items(
  id TEXT PRIMARY KEY NOT NULL,
  category_id TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_items_category ON file_items(category_id);
";

fn sqlite_error(error: rusqlite::Error) -> String {
    format!("SQLite files: {error}")
}

/// 确保表存在。
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(sqlite_error)
}

/// 读出整份 `{ categories, items }`（顺序由 `ord` 决定）。
pub fn load(conn: &Connection) -> Result<Value, String> {
    let mut categories = conn
        .prepare("SELECT payload FROM file_categories ORDER BY ord ASC, rowid ASC")
        .map_err(sqlite_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
        .collect::<Vec<_>>();
    let items = conn
        .prepare("SELECT payload FROM file_items ORDER BY ord ASC, rowid ASC")
        .map_err(sqlite_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
        .collect::<Vec<_>>();
    categories.shrink_to_fit();
    Ok(json!({ "categories": categories, "items": items }))
}

fn updated_at(value: &Value) -> i64 {
    value.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)
}

fn id_of(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

/// 应用一份增量。
///
/// 形状（前端按「上一份快照」比对后算出，只含真正变了的实体）：
/// ```json
/// {
///   "categories": { "upsert": [{ "value": {...}, "order": 0 }], "remove": ["id"] },
///   "items":      { "upsert": [{ "value": {...}, "order": 3 }],
///                   "reorder": [{ "id": "x", "order": 5 }],
///                   "remove": ["id"] }
/// }
/// ```
/// 删分类会连带删掉它的条目（否则会留下孤儿行，读回来时没有分类可归）。
pub fn apply(conn: &mut Connection, delta: &Value) -> Result<(), String> {
    let transaction = conn.transaction().map_err(sqlite_error)?;
    {
        let mut upsert_category = transaction
            .prepare(
                "INSERT INTO file_categories(id, ord, updated_at, payload) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, updated_at = excluded.updated_at, payload = excluded.payload",
            )
            .map_err(sqlite_error)?;
        for entry in delta
            .get("categories")
            .and_then(|c| c.get("upsert"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(value) = entry.get("value") else { continue };
            let Some(id) = id_of(value) else { continue };
            let order = entry.get("order").and_then(Value::as_i64).unwrap_or(0);
            let payload = serde_json::to_string(value).map_err(|e| e.to_string())?;
            upsert_category
                .execute(params![id, order, updated_at(value), payload])
                .map_err(sqlite_error)?;
        }

        let mut upsert_item = transaction
            .prepare(
                "INSERT INTO file_items(id, category_id, ord, updated_at, payload) VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, ord = excluded.ord,
                   updated_at = excluded.updated_at, payload = excluded.payload",
            )
            .map_err(sqlite_error)?;
        for entry in delta
            .get("items")
            .and_then(|i| i.get("upsert"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(value) = entry.get("value") else { continue };
            let Some(id) = id_of(value) else { continue };
            let category_id = value
                .get("categoryId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let order = entry.get("order").and_then(Value::as_i64).unwrap_or(0);
            let payload = serde_json::to_string(value).map_err(|e| e.to_string())?;
            upsert_item
                .execute(params![id, category_id, order, updated_at(value), payload])
                .map_err(sqlite_error)?;
        }

        let mut reorder_item = transaction
            .prepare("UPDATE file_items SET ord = ?2 WHERE id = ?1")
            .map_err(sqlite_error)?;
        for entry in delta
            .get("items")
            .and_then(|i| i.get("reorder"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
            let order = entry.get("order").and_then(Value::as_i64).unwrap_or(0);
            reorder_item.execute(params![id, order]).map_err(sqlite_error)?;
        }

        let mut remove_item = transaction
            .prepare("DELETE FROM file_items WHERE id = ?1")
            .map_err(sqlite_error)?;
        for id in delta
            .get("items")
            .and_then(|i| i.get("remove"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            remove_item.execute(params![id]).map_err(sqlite_error)?;
        }

        let mut remove_category_items = transaction
            .prepare("DELETE FROM file_items WHERE category_id = ?1")
            .map_err(sqlite_error)?;
        let mut remove_category = transaction
            .prepare("DELETE FROM file_categories WHERE id = ?1")
            .map_err(sqlite_error)?;
        for id in delta
            .get("categories")
            .and_then(|c| c.get("remove"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            remove_category_items.execute(params![id]).map_err(sqlite_error)?;
            remove_category.execute(params![id]).map_err(sqlite_error)?;
        }
    }
    transaction.commit().map_err(sqlite_error)
}

/// 读条目时给搜索索引用：`(id, payload)`，避免为了建索引再反序列化整个文档。
pub fn search_entries(conn: &Connection) -> Result<Vec<Value>, String> {
    let rows = conn
        .prepare("SELECT payload FROM file_items ORDER BY ord ASC, rowid ASC")
        .map_err(sqlite_error)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn category(id: &str, name: &str) -> Value {
        json!({ "id": id, "name": name, "createdAt": 1, "updatedAt": 1 })
    }

    fn item(id: &str, category: &str, title: &str) -> Value {
        json!({ "id": id, "categoryId": category, "type": "file", "title": title,
                "path": format!("E:/{id}.txt"), "tags": [], "createdAt": 1, "updatedAt": 1 })
    }

    fn upsert(items: Value) -> Value {
        json!({ "items": { "upsert": items } })
    }

    #[test]
    fn applying_a_delta_only_touches_what_changed() {
        let mut conn = memory();
        apply(
            &mut conn,
            &json!({ "categories": { "upsert": [{ "value": category("work", "工作"), "order": 0 }] },
                     "items": { "upsert": [{ "value": item("a", "work", "A"), "order": 0 },
                                            { "value": item("b", "work", "B"), "order": 1 }] } }),
        )
        .unwrap();

        let snapshot = load(&conn).unwrap();
        assert_eq!(snapshot["categories"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["items"].as_array().unwrap().len(), 2);
        let title = |snapshot: &Value, id: &str| {
            snapshot["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == id)
                .unwrap()["title"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(title(&snapshot, "a"), "A");

        // 只改一条：另一条的行内容必须原样保留
        apply(&mut conn, &upsert(json!([{ "value": item("a", "work", "A2"), "order": 0 }]))).unwrap();
        let snapshot = load(&conn).unwrap();
        assert_eq!(title(&snapshot, "a"), "A2");
        assert_eq!(title(&snapshot, "b"), "B");
    }

    #[test]
    fn order_follows_the_pushed_index_and_reorder_is_cheap() {
        let mut conn = memory();
        apply(
            &mut conn,
            &json!({ "categories": { "upsert": [{ "value": category("work", "工作"), "order": 0 }] },
                     "items": { "upsert": [{ "value": item("a", "work", "A"), "order": 0 },
                                            { "value": item("b", "work", "B"), "order": 1 }] } }),
        )
        .unwrap();
        let ids = |snapshot: &Value| {
            snapshot["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&load(&conn).unwrap()), vec!["a", "b"]);

        // 拖动排序：只推位置，不动 payload
        apply(&mut conn, &json!({ "items": { "reorder": [{ "id": "a", "order": 5 }] } })).unwrap();
        assert_eq!(ids(&load(&conn).unwrap()), vec!["b", "a"]);
    }

    #[test]
    fn removing_things_leaves_no_orphan_rows() {
        let mut conn = memory();
        apply(
            &mut conn,
            &json!({ "categories": { "upsert": [{ "value": category("work", "工作"), "order": 0 }] },
                     "items": { "upsert": [{ "value": item("a", "work", "A"), "order": 0 },
                                            { "value": item("b", "work", "B"), "order": 1 }] } }),
        )
        .unwrap();
        apply(&mut conn, &json!({ "items": { "remove": ["a"] } })).unwrap();
        assert_eq!(load(&conn).unwrap()["items"].as_array().unwrap().len(), 1);

        // 删分类要连带删掉它的条目，否则读回来会有归不了类的孤儿
        apply(&mut conn, &json!({ "categories": { "remove": ["work"] } })).unwrap();
        let snapshot = load(&conn).unwrap();
        assert!(snapshot["categories"].as_array().unwrap().is_empty());
        assert!(snapshot["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn search_entries_reads_the_same_rows() {
        let mut conn = memory();
        apply(&mut conn, &upsert(json!([{ "value": item("a", "work", "A"), "order": 0 }]))).unwrap();
        let entries = search_entries(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["path"], "E:/a.txt");
    }
}
