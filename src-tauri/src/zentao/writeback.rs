use super::client::{Client, Connection, Task};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fields {
    pub title: String,
    pub note: String,
    pub deadline: Option<String>,
    pub status: String,
}

fn valid_day(value: &str) -> bool {
    if value.len() != 10 || !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (
        value[..4].parse::<u32>(),
        value[5..7].parse::<u32>(),
        value[8..].parse::<u32>(),
    ) else {
        return false;
    };
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    y > 0 && d > 0 && d <= days
}

fn validate_changes(config: &Connection, changes: &Value) -> Result<(), String> {
    if config.write_fields.is_empty() {
        return Err("ZENTAO_READ_ONLY".into());
    }
    let values = changes
        .as_object()
        .filter(|v| !v.is_empty() && v.len() <= 3)
        .ok_or("ZENTAO_INVALID_WRITE")?;
    for (field, value) in values {
        if !matches!(field.as_str(), "title" | "note" | "deadline") {
            return Err("ZENTAO_INVALID_WRITE".into());
        }
        if !config.write_fields.contains(field) {
            return Err("ZENTAO_READ_ONLY".into());
        }
        let valid = match field.as_str() {
            "title" => value
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 10_000 && !s.contains('\0')),
            "note" => value
                .as_str()
                .is_some_and(|s| s.len() <= 1_000_000 && !s.contains('\0')),
            _ => value.is_null() || value.as_str().is_some_and(valid_day),
        };
        if !valid {
            return Err("ZENTAO_INVALID_WRITE".into());
        }
    }
    Ok(())
}

pub fn validate_write(
    config: &Connection,
    projects: &Value,
    remote_id: u64,
    changes: &Value,
) -> Result<Value, String> {
    validate_changes(config, changes)?;
    validate_binding(config, projects, remote_id)
}

pub fn validate_intent(
    config: &Connection,
    projects: &Value,
    remote_id: u64,
    expected: &Fields,
    changes: &Value,
) -> Result<Value, String> {
    let mut snapshot = validate_write(config, projects, remote_id, changes)?;
    let queued = projects["state"]["remoteChanges"]
        .as_array()
        .ok_or("ZENTAO_INTENT_CHANGED")?
        .iter()
        .filter(|value| {
            value["connectionId"].as_str() == Some(&config.id)
                && value["remoteId"].as_u64() == Some(remote_id)
        })
        .collect::<Vec<_>>();
    if queued.len() != 1 {
        return Err("ZENTAO_INTENT_CHANGED".into());
    }
    let intent = queued[0];
    let fields = intent["fields"].as_array().ok_or("ZENTAO_INTENT_CHANGED")?;
    let changes = changes.as_object().ok_or("ZENTAO_INVALID_WRITE")?;
    let field_set = fields
        .iter()
        .filter_map(Value::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if intent["status"].as_str() != Some("sending")
        || intent["id"] != snapshot["link"]["id"]
        || intent["itemId"] != snapshot["item"]["id"]
        || fields.len() != changes.len()
        || field_set.len() != fields.len()
        || field_set.iter().any(|field| !changes.contains_key(*field))
        || intent["expected"]
            != serde_json::to_value(expected).map_err(|_| "ZENTAO_INVALID_WRITE")?
        || changes.iter().any(|(field, value)| {
            intent["local"][field] != *value || snapshot["item"][field] != *value
        })
    {
        return Err("ZENTAO_INTENT_CHANGED".into());
    }
    snapshot["intent"] = intent.clone();
    Ok(snapshot)
}

pub fn validate_binding(
    config: &Connection,
    projects: &Value,
    remote_id: u64,
) -> Result<Value, String> {
    if remote_id == 0 || remote_id > 9_007_199_254_740_991 {
        return Err("ZENTAO_INVALID_WRITE".into());
    }
    let state = &projects["state"];
    let matching = |value: &&Value| {
        value["connectionId"].as_str() == Some(&config.id)
            && value["remoteId"].as_u64() == Some(remote_id)
    };
    let links = state["remoteLinks"]
        .as_array()
        .ok_or("ZENTAO_TASK_NOT_BOUND")?
        .iter()
        .filter(matching)
        .collect::<Vec<_>>();
    let cached = state["remoteTasks"]
        .as_array()
        .ok_or("ZENTAO_TASK_NOT_BOUND")?
        .iter()
        .filter(matching)
        .collect::<Vec<_>>();
    if links.len() != 1 || cached.len() != 1 {
        return Err("ZENTAO_TASK_NOT_BOUND".into());
    }
    let item_id = links[0]["itemId"].as_str().ok_or("ZENTAO_TASK_NOT_BOUND")?;
    let items = state["items"]
        .as_array()
        .ok_or("ZENTAO_TASK_NOT_BOUND")?
        .iter()
        .filter(|v| v["id"].as_str() == Some(item_id))
        .collect::<Vec<_>>();
    if items.len() != 1 || !items[0]["mergedIntoId"].is_null() {
        return Err("ZENTAO_TASK_NOT_BOUND".into());
    }
    Ok(json!({"link":links[0],"cached":cached[0],"item":items[0]}))
}

fn ordinary_fields(task: &Task) -> Value {
    json!({"title":task.title,"note":task.note,"deadline":task.deadline})
}

/// The upstream ordinary update route has no portable, verified compare-and-swap
/// contract. Read-before-write and verified readback reduce the race window;
/// neither permits claiming that another client's simultaneous edit is impossible.
pub fn guarded_write<F: FnMut() -> Result<(), String>>(
    client: &mut Client<'_>,
    config: &Connection,
    version: &str,
    token: &str,
    remote_id: u64,
    expected: &Fields,
    changes: &Value,
    mut guard: F,
) -> Result<Task, String> {
    validate_changes(config, changes)?;
    if expected.title.trim().is_empty()
        || expected.title.len() > 10_000
        || expected.title.contains('\0')
        || expected.note.len() > 1_000_000
        || expected.note.contains('\0')
        || expected
            .deadline
            .as_ref()
            .is_some_and(|value| !valid_day(value))
        || !matches!(
            expected.status.as_str(),
            "todo" | "doing" | "done" | "cancelled"
        )
    {
        return Err("ZENTAO_INVALID_WRITE".into());
    }
    let before = client.read_task(version, token, remote_id)?;
    let actual = ordinary_fields(&before);
    let expected = serde_json::to_value(expected).map_err(|_| "ZENTAO_INVALID_WRITE")?;
    if config
        .write_fields
        .iter()
        .any(|field| actual[field] != expected[field])
    {
        return Err("ZENTAO_REMOTE_CHANGED".into());
    }
    // The command supplies a fresh saved-profile and local-link check here.
    guard()?;
    let mut payload = serde_json::Map::new();
    for (field, value) in changes.as_object().ok_or("ZENTAO_INVALID_WRITE")? {
        payload.insert(
            match field.as_str() {
                "title" => "name",
                "note" => "desc",
                _ => "deadline",
            }
            .into(),
            if field == "deadline" && value.is_null() {
                json!("0000-00-00")
            } else {
                value.clone()
            },
        );
    }
    client
        .update_task(version, token, remote_id, Value::Object(payload))
        .map_err(|error| {
            // Explicit authorization denial is a known failure. An unknown update
            // result must not lead to any implicit retry, even on another API version.
            if matches!(error.as_str(), "ZENTAO_AUTH_REQUIRED" | "ZENTAO_FORBIDDEN") {
                error
            } else {
                "ZENTAO_WRITE_UNCERTAIN".into()
            }
        })?;
    let after = client
        .read_task(version, token, remote_id)
        .map_err(|_| "ZENTAO_WRITE_UNCERTAIN")?;
    let actual = ordinary_fields(&after);
    if changes
        .as_object()
        .ok_or("ZENTAO_WRITE_UNCERTAIN")?
        .iter()
        .any(|(field, value)| actual[field] != *value)
    {
        return Err("ZENTAO_WRITE_UNCERTAIN".into());
    }
    guard().map_err(|_| "ZENTAO_WRITE_UNCERTAIN")?;
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn readonly_unknown_fields_and_unbound_tasks_cannot_reach_the_network() {
        let config: Connection = serde_json::from_value(json!({"id":"one","baseUrl":"http://127.0.0.1:1/","account":"dev","apiVersion":"v1","writeFields":[]})).unwrap();
        assert_eq!(
            validate_write(&config, &json!({}), 1, &json!({"title":"new"})).unwrap_err(),
            "ZENTAO_READ_ONLY"
        );
        let mut allowed = config.clone();
        allowed.write_fields = vec!["title".into()];
        assert_eq!(
            validate_write(&allowed, &json!({}), 1, &json!({"status":"done"})).unwrap_err(),
            "ZENTAO_INVALID_WRITE"
        );
        assert_eq!(
            validate_write(&allowed, &json!({}), 1, &json!({"title":"new"})).unwrap_err(),
            "ZENTAO_TASK_NOT_BOUND"
        );
    }

    fn bound() -> Value {
        json!({"state":{"remoteLinks":[{"connectionId":"one","remoteId":1,"itemId":"item"}],"remoteTasks":[{"connectionId":"one","remoteId":1}],"items":[{"id":"item","title":"old","note":"old note","deadline":null,"status":"todo"}]}})
    }
    #[test]
    fn allowlist_and_link_capture_preserve_the_exact_local_mutation_guard() {
        let config: Connection = serde_json::from_value(json!({"id":"one","baseUrl":"http://127.0.0.1:1/","account":"dev","apiVersion":"v1","writeFields":["title","deadline"]})).unwrap();
        let guard = validate_write(
            &config,
            &bound(),
            1,
            &json!({"title":"new","deadline":null}),
        )
        .unwrap();
        assert_eq!(guard["item"]["id"], "item");
        assert_eq!(
            validate_write(&config, &bound(), 1, &json!({"note":"no"})).unwrap_err(),
            "ZENTAO_READ_ONLY"
        );
        for changes in [
            json!({}),
            json!({"title":""}),
            json!({"deadline":"2026-02-30"}),
            json!({"title":"a\u{0000}b"}),
        ] {
            assert_eq!(
                validate_write(&config, &bound(), 1, &changes).unwrap_err(),
                "ZENTAO_INVALID_WRITE"
            );
        }
        let mut duplicate = bound();
        let link = duplicate["state"]["remoteLinks"][0].clone();
        duplicate["state"]["remoteLinks"]
            .as_array_mut()
            .unwrap()
            .push(link);
        assert_eq!(
            validate_write(&config, &duplicate, 1, &json!({"title":"new"})).unwrap_err(),
            "ZENTAO_TASK_NOT_BOUND"
        );
    }

    fn fixture(replies: Vec<(u16, String)>) -> (Connection, std::thread::JoinHandle<Vec<String>>) {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config=serde_json::from_value(json!({"id":"one","baseUrl":format!("http://{}/zentao/",listener.local_addr().unwrap()),"account":"dev","apiVersion":"v1","writeFields":["title","note","deadline"]})).unwrap();
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let mut requests = vec![];
            for (status, body) in replies {
                let until = Instant::now() + Duration::from_secs(3);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(s) => break s,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < until =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => return requests,
                    }
                };
                // On Windows an accepted socket can inherit the listener's
                // nonblocking mode; wait for the full HTTP request body.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = vec![];
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(split) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..split]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= split + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                if status == 0 {
                    continue;
                }
                write!(stream,"HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (config, server)
    }
    fn remote(title: &str) -> String {
        json!({"task":{"id":1,"name":title,"desc":"old note","status":"wait","deadline":"0000-00-00"}}).to_string()
    }
    fn expected() -> Fields {
        Fields {
            title: "old".into(),
            note: "old note".into(),
            deadline: None,
            status: "todo".into(),
        }
    }

    fn sending_intent() -> Value {
        let mut data = bound();
        data["state"]["remoteLinks"][0]["id"] = json!("one:task:1");
        data["state"]["items"][0]["title"] = json!("new");
        data["state"]["remoteChanges"] = json!([{"id":"one:task:1","connectionId":"one","remoteId":1,"itemId":"item","status":"sending","fields":["title"],"local":{"title":"new","note":"old note","deadline":null,"status":"todo"},"expected":expected()}]);
        data
    }
    #[test]
    fn native_writer_requires_exact_persisted_sending_intent_and_current_local_values() {
        let (config, server) = fixture(vec![]);
        server.join().unwrap();
        let data = sending_intent();
        let checked =
            validate_intent(&config, &data, 1, &expected(), &json!({"title":"new"})).unwrap();
        assert_eq!(checked["intent"]["status"], "sending");
        for status in ["pending", "conflict", "uncertain", "failed"] {
            let mut changed = data.clone();
            changed["state"]["remoteChanges"][0]["status"] = json!(status);
            assert_eq!(
                validate_intent(&config, &changed, 1, &expected(), &json!({"title":"new"}))
                    .unwrap_err(),
                "ZENTAO_INTENT_CHANGED"
            );
        }
        for (field, value) in [
            ("fields", json!(["title", "note"])),
            ("fields", json!(["title", "title"])),
            (
                "expected",
                json!({"title":"changed","note":"old note","deadline":null,"status":"todo"}),
            ),
            ("itemId", json!("other")),
            ("id", json!("other")),
        ] {
            let mut changed = data.clone();
            changed["state"]["remoteChanges"][0][field] = value;
            assert_eq!(
                validate_intent(&config, &changed, 1, &expected(), &json!({"title":"new"}))
                    .unwrap_err(),
                "ZENTAO_INTENT_CHANGED"
            );
        }
        let mut missing = data.clone();
        missing["state"]["remoteChanges"] = json!([]);
        assert_eq!(
            validate_intent(&config, &missing, 1, &expected(), &json!({"title":"new"}))
                .unwrap_err(),
            "ZENTAO_INTENT_CHANGED"
        );
        let mut duplicate = data.clone();
        duplicate["state"]["remoteChanges"]
            .as_array_mut()
            .unwrap()
            .push(data["state"]["remoteChanges"][0].clone());
        assert_eq!(
            validate_intent(&config, &duplicate, 1, &expected(), &json!({"title":"new"}))
                .unwrap_err(),
            "ZENTAO_INTENT_CHANGED"
        );
        let mut local_changed = data.clone();
        local_changed["state"]["items"][0]["title"] = json!("typing new text");
        assert_eq!(
            validate_intent(
                &config,
                &local_changed,
                1,
                &expected(),
                &json!({"title":"new"})
            )
            .unwrap_err(),
            "ZENTAO_INTENT_CHANGED"
        );
        assert_eq!(
            validate_intent(
                &config,
                &data,
                1,
                &expected(),
                &json!({"title":"new","deadline":null})
            )
            .unwrap_err(),
            "ZENTAO_INTENT_CHANGED"
        );
        assert_eq!(
            validate_intent(
                &config,
                &data,
                1,
                &expected(),
                &json!({"title":"unapproved"})
            )
            .unwrap_err(),
            "ZENTAO_INTENT_CHANGED"
        );
    }

    #[test]
    fn both_versions_write_only_minimal_put_payload_then_verify_fresh_readback() {
        for version in ["v1", "v2"] {
            let (mut config, server) = fixture(vec![
                (200, remote("old")),
                (200, json!({"result":"success"}).to_string()),
                (200, remote("new")),
            ]);
            config.api_version = version.into();
            let mut client = Client::new(&config).unwrap();
            let mut checks = 0;
            let result = guarded_write(
                &mut client,
                &config,
                version,
                "fixture-token",
                1,
                &expected(),
                &json!({"title":"new","deadline":null}),
                || {
                    checks += 1;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(result.title, "new");
            assert_eq!(checks, 2);
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[0].starts_with(&format!("GET /zentao/api.php/{version}/tasks/1 ")));
            assert!(requests[1].starts_with(&format!("PUT /zentao/api.php/{version}/tasks/1 ")));
            let body = requests[1].split("\r\n\r\n").nth(1).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(body).unwrap(),
                json!({"name":"new","deadline":"0000-00-00"})
            );
            assert!(requests[2].starts_with("GET "));
        }
    }
    #[test]
    fn changed_remote_or_local_guard_rejects_before_any_put() {
        for local_changed in [false, true] {
            let (config, server) = fixture(vec![(
                200,
                remote(if local_changed { "old" } else { "changed" }),
            )]);
            let mut client = Client::new(&config).unwrap();
            let result = guarded_write(
                &mut client,
                &config,
                "v1",
                "fixture-token",
                1,
                &expected(),
                &json!({"title":"new"}),
                || Err("ZENTAO_CONNECTION_CHANGED".into()),
            );
            assert_eq!(
                result.err().unwrap(),
                if local_changed {
                    "ZENTAO_CONNECTION_CHANGED"
                } else {
                    "ZENTAO_REMOTE_CHANGED"
                }
            );
            assert_eq!(server.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn explicit_null_clears_a_real_deadline_and_note_uses_desc_without_other_fields() {
        let before=json!({"task":{"id":1,"name":"old","desc":"old note","status":"wait","deadline":"2026-10-30"}}).to_string();
        let after=json!({"task":{"id":1,"name":"old","desc":"新备注\nline two","status":"wait","deadline":"0000-00-00"}}).to_string();
        let (config, server) = fixture(vec![(200, before), (200, "{}".into()), (200, after)]);
        let mut client = Client::new(&config).unwrap();
        let mut expected = expected();
        expected.deadline = Some("2026-10-30".into());
        let result = guarded_write(
            &mut client,
            &config,
            "v1",
            "fixture-token",
            1,
            &expected,
            &json!({"note":"新备注\nline two","deadline":null}),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(result.deadline, None);
        assert_eq!(result.note, "新备注\nline two");
        let requests = server.join().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            json!({"desc":"新备注\nline two","deadline":"0000-00-00"})
        );
    }
    #[test]
    fn unknown_update_or_unverified_readback_never_retry_and_are_uncertain() {
        for (status, body, readback) in [
            (0, String::new(), None),
            (500, "secret body".into(), None),
            (200, "not json".into(), None),
            (200, "{}".into(), Some((200, remote("unexpected")))),
            (200, "{}".into(), Some((403, "secret body".into()))),
        ] {
            let mut replies = vec![(200, remote("old")), (status, body)];
            if let Some(reply) = readback {
                replies.push(reply);
            }
            let count = replies.len();
            let (config, server) = fixture(replies);
            let mut client = Client::new(&config).unwrap();
            assert_eq!(
                guarded_write(
                    &mut client,
                    &config,
                    "v1",
                    "fixture-token",
                    1,
                    &expected(),
                    &json!({"title":"new"}),
                    || Ok(())
                )
                .err()
                .unwrap(),
                "ZENTAO_WRITE_UNCERTAIN"
            );
            assert_eq!(server.join().unwrap().len(), count);
        }
    }
    #[test]
    fn explicit_permission_denial_is_known_failure_but_postwrite_local_change_is_uncertain() {
        let (config, server) = fixture(vec![(200, remote("old")), (403, "private body".into())]);
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            guarded_write(
                &mut client,
                &config,
                "v1",
                "fixture-token",
                1,
                &expected(),
                &json!({"title":"new"}),
                || Ok(())
            )
            .err()
            .unwrap(),
            "ZENTAO_FORBIDDEN"
        );
        assert_eq!(server.join().unwrap().len(), 2);
        let (config, server) = fixture(vec![
            (200, remote("old")),
            (200, "{}".into()),
            (200, remote("new")),
        ]);
        let mut client = Client::new(&config).unwrap();
        let mut checks = 0;
        assert_eq!(
            guarded_write(
                &mut client,
                &config,
                "v1",
                "fixture-token",
                1,
                &expected(),
                &json!({"title":"new"}),
                || {
                    checks += 1;
                    if checks == 1 {
                        Ok(())
                    } else {
                        Err("ZENTAO_CONNECTION_CHANGED".into())
                    }
                }
            )
            .err()
            .unwrap(),
            "ZENTAO_WRITE_UNCERTAIN"
        );
        assert_eq!(server.join().unwrap().len(), 3);
    }
    #[test]
    fn direct_http_writer_also_denies_readonly_or_unsupported_fields_without_requests() {
        let (mut config, server) = fixture(vec![]);
        config.write_fields.clear();
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            guarded_write(
                &mut client,
                &config,
                "v1",
                "fixture-token",
                1,
                &expected(),
                &json!({"title":"new"}),
                || Ok(())
            )
            .err()
            .unwrap(),
            "ZENTAO_READ_ONLY"
        );
        assert_eq!(server.join().unwrap().len(), 0);
        let (config, server) = fixture(vec![]);
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            guarded_write(
                &mut client,
                &config,
                "v1",
                "fixture-token",
                1,
                &expected(),
                &json!({"status":"done"}),
                || Ok(())
            )
            .err()
            .unwrap(),
            "ZENTAO_INVALID_WRITE"
        );
        assert_eq!(server.join().unwrap().len(), 0);
    }
}
