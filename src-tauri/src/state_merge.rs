//! Three-way state merge for independent main/paper WebViews.
use serde_json::Value;
pub fn merge(base: &Value, local: &Value, remote: &Value) -> Result<Value, String> {
    merge_value(Some(base), Some(local), Some(remote), 0)?.ok_or_else(conflict)
}

fn conflict() -> String {
    "STORAGE_CONFLICT: 另一窗口修改了相同内容，请保留当前内容并刷新后重试。".into()
}

fn merge_value(base: Option<&Value>, local: Option<&Value>, remote: Option<&Value>, depth: usize) -> Result<Option<Value>, String> {
    if local == base { return Ok(remote.cloned()); }
    if remote == base || local == remote { return Ok(local.cloned()); }
    if depth > 128 { return Err(conflict()); }
    if let (Some(Value::Object(left)), Some(Value::Object(right))) = (local, remote) {
        let original = base.and_then(Value::as_object);
        if base.is_some() && original.is_none() { return Err(conflict()); }
        let keys: std::collections::BTreeSet<_> = left.keys().chain(right.keys()).chain(original.into_iter().flat_map(|m| m.keys())).collect();
        let mut result = serde_json::Map::new();
        for key in keys {
            let value = if key == "updatedAt" && left.get(key).is_some_and(Value::is_number) && right.get(key).is_some_and(Value::is_number) {
                let a = left.get(key).unwrap(); let b = right.get(key).unwrap();
                Some(if a.as_f64() >= b.as_f64() { a } else { b }.clone())
            } else {
                merge_value(original.and_then(|m| m.get(key)), left.get(key), right.get(key), depth + 1)?
            };
            if let Some(value) = value { result.insert(key.clone(), value); }
        }
        return Ok(Some(Value::Object(result)));
    }
    if let (Some(Value::Array(left)), Some(Value::Array(right))) = (local, remote) {
        let original = base.and_then(Value::as_array);
        if base.is_some() && original.is_none() { return Err(conflict()); }
        // Ordered string sets (e.g. open paper dates) can change in two windows.
        let old_values = original.map(Vec::as_slice).unwrap_or_default();
        if left.iter().chain(right).chain(old_values).all(Value::is_string) {
            let mut result = Vec::new();
            for value in left.iter().chain(right) {
                if result.contains(value) { continue; }
                let was = old_values.contains(value);
                let a = left.contains(value); let b = right.contains(value);
                if if a == was { b } else { a } { result.push(value.clone()); }
            }
            return Ok(Some(Value::Array(result)));
        }
        fn indexed(values: &[Value]) -> Result<std::collections::BTreeMap<&str, &Value>, String> {
            let mut map = std::collections::BTreeMap::new();
            for value in values {
                let id = value.get("id").and_then(Value::as_str).ok_or_else(conflict)?;
                if map.insert(id, value).is_some() { return Err(conflict()); }
            }
            Ok(map)
        }
        let old = indexed(original.map(Vec::as_slice).unwrap_or_default())?;
        let a = indexed(left)?; let b = indexed(right)?;
        let mut result = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for item in left.iter().chain(right.iter()) {
            let id = item.get("id").and_then(Value::as_str).ok_or_else(conflict)?;
            if seen.insert(id) {
                if let Some(value) = merge_value(old.get(id).copied(), a.get(id).copied(), b.get(id).copied(), depth + 1)? { result.push(value); }
            }
        }
        return Ok(Some(Value::Array(result)));
    }
    Err(conflict())
}
#[cfg(test)]
mod tests {
 use super::*;
 use serde_json::json;
 #[test]
 fn independent_task_fields_and_additions_are_preserved() {
  let base=json!({"state":{"days":{"2026-10-17":[{"id":"a","title":"task","done":false,"note":"","updatedAt":1}]}},"version":4});
  let mut local=base.clone(); local["state"]["days"]["2026-10-17"][0]["done"]=json!(true); local["state"]["days"]["2026-10-17"][0]["updatedAt"]=json!(2);
  let mut remote=base.clone(); remote["state"]["days"]["2026-10-17"][0]["note"]=json!("remote note"); remote["state"]["days"]["2026-10-17"][0]["updatedAt"]=json!(3);
  let result=merge(&base,&local,&remote).unwrap();
  assert_eq!(result["state"]["days"]["2026-10-17"][0]["note"],"remote note");
  assert_eq!(result["state"]["days"]["2026-10-17"][0]["done"],true);
  assert_eq!(result["state"]["days"]["2026-10-17"][0]["updatedAt"],3);
 }
 #[test]
 fn task_additions_deletion_and_attachment_ids_merge() {
  assert_eq!(merge(&json!([]),&json!([{"id":"a"}]),&json!([{"id":"b"}])).unwrap(),json!([{"id":"a"},{"id":"b"}]));
  assert_eq!(merge(&json!([{"id":"a"},{"id":"b"}]),&json!([{"id":"b"}]),&json!([{"id":"a"},{"id":"b"},{"id":"c"}])).unwrap(),json!([{"id":"b"},{"id":"c"}]));
  assert_eq!(merge(&json!(["old"]),&json!(["today"]),&json!(["old","tomorrow"])).unwrap(),json!(["today","tomorrow"]));
 }
 #[test]
 fn true_conflicts_and_delete_versus_edit_are_visible() {
  assert!(merge(&json!({"title":"a"}),&json!({"title":"b"}),&json!({"title":"c"})).is_err());
  assert!(merge(&json!([{"id":"a","title":"old"}]),&json!([]),&json!([{"id":"a","title":"new"}])).is_err());
 }
 #[test]
 fn unchanged_fields_do_not_erase_remote_state_and_null_is_tombstone() {
  assert_eq!(merge(&json!({"a":1}),&json!({"a":1}),&json!({"a":2})).unwrap(),json!({"a":2}));
  assert_eq!(merge(&json!({"a":1}),&Value::Null,&json!({"a":1})).unwrap(),Value::Null);
 }
}
