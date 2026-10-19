use reqwest::{Url, blocking::Client as HttpClient, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const PAGE_SIZE: u64 = 100;
const MAX_REQUESTS: usize = 1400;
const MAX_PAGES: u64 = 200;
const MAX_BODY: u64 = 8 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub base_url: String,
    pub account: String,
    pub api_version: String,
    #[serde(default)]
    pub execution_ids: Vec<u64>,
    #[serde(default)]
    pub write_fields: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub api_version: String,
    pub tasks: Vec<Task>,
    pub executions: Vec<Execution>,
    pub unavailable_ids: Vec<u64>,
    pub fetched_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub connection_id: String,
    pub remote_id: u64,
    pub title: String,
    pub note: String,
    pub status: String,
    pub deadline: Option<String>,
    pub start: Option<String>,
    pub remote_project_id: Option<u64>,
    pub execution_id: Option<u64>,
    pub parent_remote_id: Option<u64>,
    pub assigned_to: String,
    pub team_accounts: Vec<String>,
    pub last_edited_date: Option<String>,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub connection_id: String,
    pub remote_id: u64,
    pub name: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub status: String,
    pub updated_at: u64,
}

fn bounded_text(value: &str, limit: usize, empty: bool) -> Result<(), String> {
    if value.len() > limit {
        return Err("ZENTAO_RESPONSE_LIMIT".into());
    }
    if value.contains('\0') || (!empty && value.trim().is_empty()) {
        return Err("ZENTAO_INVALID_RESPONSE".into());
    }
    Ok(())
}
fn clock(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && value[..2].parse::<u32>().is_ok_and(|n| n < 24)
        && value[3..].parse::<u32>().is_ok_and(|n| n < 60)
}
fn timestamp(value: &str) -> bool {
    if !value.is_ascii()
        || value.len() < 10
        || value.len() > 100
        || date(&json!(&value[..10]), false).is_null()
    {
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
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
        || !value[17..19].parse::<u32>().is_ok_and(|n| n < 60)
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
impl Task {
    fn validate(&self) -> Result<(), String> {
        bounded_text(&self.title, 10_000, false)?;
        bounded_text(&self.note, 1_000_000, true)?;
        bounded_text(&self.status, 100, false)?;
        bounded_text(&self.assigned_to, 1_000, true)?;
        if self.team_accounts.len() > 1_000 {
            return Err("ZENTAO_RESPONSE_LIMIT".into());
        }
        for account in &self.team_accounts {
            bounded_text(account, 1_000, false)?;
        }
        if self
            .last_edited_date
            .as_ref()
            .is_some_and(|s| !timestamp(s))
        {
            return Err("ZENTAO_INVALID_RESPONSE".into());
        }
        Ok(())
    }
}
impl Execution {
    fn validate(&self) -> Result<(), String> {
        bounded_text(&self.name, 10_000, false)?;
        bounded_text(&self.status, 100, false)?;
        if self
            .start
            .as_ref()
            .zip(self.end.as_ref())
            .is_some_and(|(start, end)| end < start)
        {
            return Err("ZENTAO_INVALID_RESPONSE".into());
        }
        Ok(())
    }
}

pub fn endpoint(input: &str) -> Result<String, String> {
    let mut url = Url::parse(input.trim()).map_err(|_| "ZENTAO_INVALID_URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || input.len() > 2048
    {
        return Err("ZENTAO_INVALID_URL".into());
    }
    let mut path = url.path().trim_end_matches('/').to_owned();
    for suffix in ["/api.php/v1", "/api.php/v2", "/api.php"] {
        if let Some(prefix) = path.strip_suffix(suffix) {
            path = prefix.to_owned();
            break;
        }
    }
    path.push('/');
    url.set_path(&path);
    Ok(url.to_string())
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| value.get("id").and_then(number))
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
}
fn count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}
fn account(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value.get("account").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
}
fn date(value: &Value, timestamp: bool) -> Value {
    let Some(s) = value.as_str().map(str::trim) else {
        return Value::Null;
    };
    let Some(day) = s.get(..10) else {
        return Value::Null;
    };
    let bytes = day.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return Value::Null;
    }
    let year = day[..4].parse::<u16>().unwrap_or(0);
    let month = day[5..7].parse::<u8>().unwrap_or(0);
    let day_num = day[8..10].parse::<u8>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if year == 0 || day_num == 0 || day_num > max {
        return Value::Null;
    }
    Value::String(if timestamp {
        s.to_owned()
    } else {
        day.to_owned()
    })
}
fn accounts(value: &Value) -> Vec<String> {
    let entries: Vec<String> = match value {
        Value::Array(items) => items.iter().map(account).collect(),
        Value::Object(map) => map.values().map(account).collect(),
        Value::String(s) => s.split(',').map(|s| s.trim().to_owned()).collect(),
        _ => vec![],
    };
    let mut seen = BTreeSet::new();
    entries
        .into_iter()
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}
fn normalize_task(connection: &str, value: &Value, parent: Option<u64>, at: u64) -> Value {
    let id = number(&value["id"]).unwrap_or(0);
    json!({"id":format!("{connection}:task:{id}"),"connectionId":connection,"remoteId":id,
        "title":value["name"].as_str().or_else(||value["title"].as_str()).unwrap_or(""),
        "note":value["desc"].as_str().or_else(||value["description"].as_str()).unwrap_or(""),
        "status":value["status"].as_str().unwrap_or(""),"deadline":date(&value["deadline"],false),
        "start":date(&value["estStarted"],false),"remoteProjectId":number(&value["project"]),
        "executionId":number(&value["execution"]),"parentRemoteId":number(&value["parent"]).or(parent),
        "assignedTo":account(&value["assignedTo"]),"teamAccounts":accounts(&value["team"]),
        "lastEditedDate":date(&value["lastEditedDate"],true),"updatedAt":at})
}
fn collect_tasks(
    connection: &str,
    value: &Value,
    parent: Option<u64>,
    at: u64,
    tasks: &mut BTreeMap<u64, Value>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || tasks.len() > 50_000 {
        return Err("ZENTAO_RESPONSE_LIMIT".into());
    }
    let id = number(&value["id"]).ok_or("ZENTAO_INVALID_RESPONSE")?;
    let mut task = normalize_task(connection, value, parent, at);
    if let Some(existing) = tasks.get(&id) {
        if parent.is_none() {
            if task["parentRemoteId"].is_null() {
                task["parentRemoteId"] = existing["parentRemoteId"].clone();
            }
            tasks.insert(id, task);
        } else if existing["parentRemoteId"].is_null() && !task["parentRemoteId"].is_null() {
            let mut enriched = existing.clone();
            enriched["parentRemoteId"] = task["parentRemoteId"].clone();
            tasks.insert(id, enriched);
        }
    } else {
        tasks.insert(id, task);
    }
    if let Some(children) = value.get("children") {
        match children {
            Value::Array(items) => {
                for child in items {
                    collect_tasks(connection, child, Some(id), at, tasks, depth + 1)?;
                }
            }
            Value::Object(items) => {
                for child in items.values() {
                    collect_tasks(connection, child, Some(id), at, tasks, depth + 1)?;
                }
            }
            Value::Null => (),
            _ => return Err("ZENTAO_INVALID_RESPONSE".into()),
        }
    }
    Ok(())
}

fn detail_candidates(value: &Value, ids: &mut BTreeSet<u64>) {
    let mut stack = vec![value];
    while let Some(task) = stack.pop() {
        if (task["isChild"].as_bool() == Some(true) || task["status"].as_str() == Some("changed"))
            && let Some(id) = number(&task["id"])
        {
            ids.insert(id);
        }
        match task.get("children") {
            Some(Value::Array(children)) => stack.extend(children),
            Some(Value::Object(children)) => stack.extend(children.values()),
            _ => (),
        }
    }
}
fn belongs_to_account(task: &Value, account: &str) -> bool {
    task["assignedTo"].as_str() == Some(account)
        || task["teamAccounts"]
            .as_array()
            .is_some_and(|team| team.iter().any(|member| member.as_str() == Some(account)))
}

pub struct Client<'a> {
    config: &'a Connection,
    base: String,
    http: HttpClient,
    started: Instant,
    requests: usize,
    request_timeout: Duration,
}
impl<'a> Client<'a> {
    pub fn new(config: &'a Connection) -> Result<Self, String> {
        if config.account.trim().is_empty()
            || config.account.len() > 256
            || config.account.contains(['\0', '\r', '\n'])
            || !matches!(config.api_version.as_str(), "auto" | "v1" | "v2")
            || config.execution_ids.len() > 100
            || config.execution_ids.contains(&0)
            || config.write_fields.len() > 3
            || config
                .write_fields
                .iter()
                .any(|field| !matches!(field.as_str(), "title" | "note" | "deadline"))
            || config.write_fields.iter().collect::<BTreeSet<_>>().len()
                != config.write_fields.len()
        {
            return Err("ZENTAO_INVALID_CONFIG".into());
        }
        Ok(Self {
            config,
            base: endpoint(&config.base_url)?,
            http: HttpClient::builder()
                .redirect(Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| "ZENTAO_NETWORK_ERROR")?,
            started: Instant::now(),
            requests: 0,
            request_timeout: Duration::from_secs(15),
        })
    }
    fn request(
        &mut self,
        version: &str,
        path: &str,
        token: Option<&str>,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let method = if body.is_some() {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        self.request_with_method(version, path, token, query, body, method)
    }
    fn request_with_method(
        &mut self,
        version: &str,
        path: &str,
        token: Option<&str>,
        query: &[(&str, String)],
        body: Option<Value>,
        method: reqwest::Method,
    ) -> Result<Value, String> {
        if !matches!(version, "v1" | "v2") || self.requests >= MAX_REQUESTS {
            return Err("ZENTAO_REQUEST_LIMIT".into());
        }
        let remaining = Duration::from_secs(120)
            .checked_sub(self.started.elapsed())
            .ok_or("ZENTAO_TIMEOUT")?;
        self.requests += 1;
        let url = format!("{}api.php/{version}/{path}", self.base);
        let auth_request =
            method == reqwest::Method::POST && matches!(path, "tokens" | "users/login");
        let mut request = self.http.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        request = request
            .header("Accept", "application/json")
            .query(query)
            .timeout(remaining.min(self.request_timeout));
        if let Some(token) = token {
            if token.is_empty() || token.len() > 2048 || token.contains(['\0', '\r', '\n']) {
                return Err("ZENTAO_INVALID_SECRET".into());
            }
            request = request.header("Token", token);
        }
        let response = request.send().map_err(|e| {
            if e.is_timeout() {
                "ZENTAO_TIMEOUT"
            } else {
                "ZENTAO_NETWORK_ERROR"
            }
        })?;
        let code = response.status().as_u16();
        if (300..400).contains(&code) {
            return Err("ZENTAO_REDIRECT_BLOCKED".into());
        }
        if !(200..300).contains(&code) {
            return Err(match code {
                400 if auth_request => "ZENTAO_AUTH_REQUIRED",
                401 => "ZENTAO_AUTH_REQUIRED",
                403 => "ZENTAO_FORBIDDEN",
                404 | 405 | 501 => "ZENTAO_UNSUPPORTED_ROUTE",
                429 => "ZENTAO_RATE_LIMITED",
                500..=599 => "ZENTAO_SERVER_ERROR",
                _ => "ZENTAO_REQUEST_FAILED",
            }
            .into());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY)
        {
            return Err("ZENTAO_RESPONSE_LIMIT".into());
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "ZENTAO_NETWORK_ERROR")?;
        if bytes.len() as u64 > MAX_BODY {
            return Err("ZENTAO_RESPONSE_LIMIT".into());
        }
        let mut value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "ZENTAO_INVALID_RESPONSE")?;
        if !value.is_object() {
            return Err("ZENTAO_INVALID_RESPONSE".into());
        }
        if value["status"].as_str() == Some("fail") || value["result"].as_str() == Some("fail") {
            return Err(match count(&value["code"]) {
                Some(401) => "ZENTAO_AUTH_REQUIRED",
                Some(403) => "ZENTAO_FORBIDDEN",
                Some(404 | 405) => "ZENTAO_UNSUPPORTED_ROUTE",
                Some(429) => "ZENTAO_RATE_LIMITED",
                _ if auth_request => "ZENTAO_AUTH_REQUIRED",
                _ => "ZENTAO_REMOTE_ERROR",
            }
            .into());
        }
        if value["data"].is_string() {
            value["data"] = serde_json::from_str(value["data"].as_str().unwrap_or(""))
                .map_err(|_| "ZENTAO_INVALID_RESPONSE")?;
        }
        if value.get("data").is_some_and(Value::is_object) {
            value = value["data"].take();
        }
        Ok(value)
    }
    pub fn read_task(
        &mut self,
        version: &str,
        token: &str,
        remote_id: u64,
    ) -> Result<Task, String> {
        if remote_id == 0 || remote_id > 9_007_199_254_740_991 {
            return Err("ZENTAO_INVALID_WRITE".into());
        }
        let value = self.request(
            version,
            &format!("tasks/{remote_id}"),
            Some(token),
            &[],
            None,
        )?;
        let task = value.get("task").unwrap_or(&value);
        if number(&task["id"]) != Some(remote_id) {
            return Err("ZENTAO_INVALID_RESPONSE".into());
        }
        let parsed: Task =
            serde_json::from_value(normalize_task(&self.config.id, task, None, now()))
                .map_err(|_| "ZENTAO_INVALID_RESPONSE")?;
        parsed.validate()?;
        Ok(parsed)
    }
    pub(super) fn update_task(
        &mut self,
        version: &str,
        token: &str,
        remote_id: u64,
        body: Value,
    ) -> Result<(), String> {
        self.request_with_method(
            version,
            &format!("tasks/{remote_id}"),
            Some(token),
            &[],
            Some(body),
            reqwest::Method::PUT,
        )?;
        Ok(())
    }
    fn version(&mut self) -> Result<String, String> {
        if self.config.api_version != "auto" {
            return Ok(self.config.api_version.clone());
        }
        match self.request(
            "v2",
            "my/tasks",
            None,
            &[("pageID", "1".into()), ("recPerPage", "1".into())],
            None,
        ) {
            Ok(v) if v.get("tasks").is_some() => Ok("v2".into()),
            Err(e) if e == "ZENTAO_AUTH_REQUIRED" || e == "ZENTAO_FORBIDDEN" => Ok("v2".into()),
            Err(e) if e == "ZENTAO_UNSUPPORTED_ROUTE" => Ok("v1".into()),
            Err(e) => Err(e),
            _ => Err("ZENTAO_INVALID_RESPONSE".into()),
        }
    }
    pub fn authenticate(
        &mut self,
        password: Option<&str>,
        token: Option<&str>,
    ) -> Result<(String, String), String> {
        let version = self.version()?;
        if let Some(password) = password.filter(|s| !s.is_empty()) {
            if password.len() > 1024 || password.contains('\0') {
                return Err("ZENTAO_INVALID_SECRET".into());
            }
            let path = if version == "v1" {
                "tokens"
            } else {
                "users/login"
            };
            let data = self.request(
                &version,
                path,
                None,
                &[],
                Some(json!({"account":self.config.account.trim(),"password":password})),
            )?;
            let token = data["token"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("ZENTAO_INVALID_RESPONSE")?;
            if data["user"]["account"]
                .as_str()
                .is_some_and(|account| account != self.config.account.trim())
            {
                return Err("ZENTAO_ACCOUNT_MISMATCH".into());
            }
            Ok((version, token.to_owned()))
        } else {
            Ok((
                version,
                token
                    .filter(|s| !s.is_empty())
                    .ok_or("ZENTAO_AUTH_REQUIRED")?
                    .to_owned(),
            ))
        }
    }
    fn pages(
        &mut self,
        version: &str,
        path: &str,
        token: &str,
        at: u64,
        tasks: &mut BTreeMap<u64, Value>,
    ) -> Result<(BTreeSet<u64>, BTreeSet<u64>), String> {
        let mut consumed = 0;
        let mut previous = String::new();
        let mut top_ids = BTreeSet::new();
        let mut details = BTreeSet::new();
        for page in 1..=MAX_PAGES {
            let data = self.request(
                version,
                path,
                Some(token),
                &[
                    ("page", page.to_string()),
                    ("limit", PAGE_SIZE.to_string()),
                    ("pageID", page.to_string()),
                    ("recPerPage", PAGE_SIZE.to_string()),
                    ("mergeChildren", "0".into()),
                    ("type", "assignedTo".into()),
                ],
                None,
            )?;
            let values = data.get("tasks").ok_or("ZENTAO_INVALID_RESPONSE")?;
            let list: Vec<&Value> = match values {
                Value::Array(items) => items.iter().collect(),
                Value::Object(map) => map.values().collect(),
                _ => return Err("ZENTAO_INVALID_RESPONSE".into()),
            };
            let signature = list
                .iter()
                .map(|v| number(&v["id"]).unwrap_or(0).to_string())
                .collect::<Vec<_>>()
                .join(",");
            if !signature.is_empty() && signature == previous {
                return Err("ZENTAO_PAGINATION_STALLED".into());
            }
            previous = signature;
            for task in &list {
                let id = number(&task["id"]).ok_or("ZENTAO_INVALID_RESPONSE")?;
                if !top_ids.insert(id) {
                    return Err("ZENTAO_PAGINATION_STALLED".into());
                }
                collect_tasks(&self.config.id, task, None, at, tasks, 0)?;
                detail_candidates(task, &mut details);
            }
            let returned = list.len() as u64;
            consumed += returned;
            let pager = data.get("pager").unwrap_or(&data);
            let response_page = count(&pager["pageID"]).or_else(|| count(&data["page"]));
            if response_page.is_some_and(|value| value != page) {
                return Err("ZENTAO_PAGINATION_STALLED".into());
            }
            let total = count(&pager["recTotal"]).or_else(|| count(&data["total"]));
            let size = count(&pager["recPerPage"])
                .or_else(|| count(&data["limit"]))
                .filter(|s| *s > 0)
                .unwrap_or(PAGE_SIZE);
            if let Some(total) = total {
                if consumed > total {
                    return Err("ZENTAO_PAGINATION_STALLED".into());
                }
                if consumed == total {
                    return Ok((top_ids, details));
                }
                if returned == 0 {
                    return Err("ZENTAO_PAGINATION_STALLED".into());
                }
            } else if returned < size {
                return Ok((top_ids, details));
            }
        }
        Err("ZENTAO_REQUEST_LIMIT".into())
    }
    pub fn validate(&mut self, version: &str, token: &str) -> Result<(), String> {
        let path = if version == "v1" { "tasks" } else { "my/tasks" };
        let value = self.request(
            version,
            path,
            Some(token),
            &[
                ("page", "1".into()),
                ("limit", "1".into()),
                ("pageID", "1".into()),
                ("recPerPage", "1".into()),
                ("mergeChildren", "0".into()),
            ],
            None,
        )?;
        if !value
            .get("tasks")
            .is_some_and(|v| v.is_array() || v.is_object())
        {
            return Err("ZENTAO_INVALID_RESPONSE".into());
        }
        // A manually supplied session token must belong to the configured account.
        // v1 /user returns the current profile; v2 /users/0 resolves profile(0),
        // whose upstream controller uses the currently authenticated user.
        let identity = self.request(
            version,
            if version == "v1" { "user" } else { "users/0" },
            Some(token),
            &[],
            None,
        )?;
        let profile = identity
            .get("profile")
            .or_else(|| identity.get("user"))
            .unwrap_or(&identity);
        let actual = profile["account"]
            .as_str()
            .ok_or("ZENTAO_INVALID_RESPONSE")?;
        if actual != self.config.account.trim() {
            return Err("ZENTAO_ACCOUNT_MISMATCH".into());
        }
        Ok(())
    }
    pub fn fetch(
        &mut self,
        version: &str,
        token: &str,
        tracked: &[u64],
    ) -> Result<FetchResult, String> {
        if tracked.len() > 1000 || tracked.contains(&0) {
            return Err("ZENTAO_INVALID_CONFIG".into());
        }
        let at = now();
        let mut tasks = BTreeMap::new();
        let mut unavailable = BTreeSet::new();
        let path = if version == "v1" { "tasks" } else { "my/tasks" };
        let (top_ids, details) = self.pages(version, path, token, at, &mut tasks)?;
        tasks.retain(|id, task| {
            top_ids.contains(id) || belongs_to_account(task, self.config.account.trim())
        });
        // The my-task route owns assignment filtering; execution selection only narrows it.
        if !self.config.execution_ids.is_empty() {
            tasks.retain(|_, v| {
                number(&v["executionId"]).is_some_and(|id| self.config.execution_ids.contains(&id))
            });
        }
        // My-task presentation rows can rewrite parent/name/status. Read only
        // those affected IDs to recover canonical source fields before import.
        for id in details
            .into_iter()
            .filter(|id| tasks.contains_key(id))
            .collect::<Vec<_>>()
        {
            match self.request(version, &format!("tasks/{id}"), Some(token), &[], None) {
                Ok(value) => {
                    let task = value.get("task").unwrap_or(&value);
                    if number(&task["id"]) != Some(id) {
                        return Err("ZENTAO_INVALID_RESPONSE".into());
                    }
                    tasks.insert(id, normalize_task(&self.config.id, task, None, at));
                }
                Err(error)
                    if error == "ZENTAO_FORBIDDEN" || error == "ZENTAO_UNSUPPORTED_ROUTE" =>
                {
                    tasks.remove(&id);
                    unavailable.insert(id);
                }
                Err(error) => return Err(error),
            }
        }
        for id in tracked.iter().copied().collect::<BTreeSet<_>>() {
            if tasks.contains_key(&id) || unavailable.contains(&id) {
                continue;
            }
            match self.request(version, &format!("tasks/{id}"), Some(token), &[], None) {
                Ok(value) => {
                    let task = value.get("task").unwrap_or(&value);
                    if number(&task["id"]) != Some(id) {
                        return Err("ZENTAO_INVALID_RESPONSE".into());
                    }
                    // A tracked task may now be assigned elsewhere. Its children
                    // are not additional assignment candidates for this snapshot.
                    tasks.insert(id, normalize_task(&self.config.id, task, None, at));
                }
                Err(e) if e == "ZENTAO_FORBIDDEN" || e == "ZENTAO_UNSUPPORTED_ROUTE" => {
                    unavailable.insert(id);
                }
                Err(e) => return Err(e),
            }
        }
        let executions = tasks
            .values()
            .filter_map(|task| number(&task["executionId"]))
            .collect::<BTreeSet<_>>();
        let mut metadata = vec![];
        for id in executions {
            match self.request(version, &format!("executions/{id}"), Some(token), &[], None) {
                Ok(data) => {
                    let e = data.get("execution").unwrap_or(&data);
                    if number(&e["id"]) != Some(id) {
                        return Err("ZENTAO_INVALID_RESPONSE".into());
                    }
                    metadata.push(json!({"id":format!("{}:execution:{id}",self.config.id),"connectionId":self.config.id,"remoteId":id,"name":e["name"].as_str().unwrap_or(""),"start":date(&e["begin"],false),"end":date(&e["end"],false),"status":e["status"].as_str().unwrap_or(""),"updatedAt":at}));
                }
                Err(e) if e == "ZENTAO_FORBIDDEN" || e == "ZENTAO_UNSUPPORTED_ROUTE" => (),
                Err(e) => return Err(e),
            }
        }
        let tasks = tasks
            .into_values()
            .map(serde_json::from_value)
            .collect::<Result<Vec<Task>, _>>()
            .map_err(|_| "ZENTAO_INVALID_RESPONSE")?;
        let executions = metadata
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<Vec<Execution>, _>>()
            .map_err(|_| "ZENTAO_INVALID_RESPONSE")?;
        for task in &tasks {
            task.validate()?;
        }
        for execution in &executions {
            execution.validate()?;
        }
        Ok(FetchResult {
            api_version: version.to_owned(),
            tasks,
            executions,
            unavailable_ids: unavailable.into_iter().collect(),
            fetched_at: at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn endpoint_preserves_subpath_and_rejects_credential_urls() {
        assert_eq!(
            endpoint("https://example.test/zentao/").unwrap(),
            "https://example.test/zentao/"
        );
        assert!(endpoint("https://person:private@example.test/").is_err());
        assert!(endpoint("https://example.test/?token=private").is_err());
    }
    #[test]
    fn task_zero_dates_and_account_objects_normalize() {
        let task = normalize_task(
            "one",
            &json!({"id":3,"name":"Work","assignedTo":{"account":"dev"},"team":[{"account":"dev"},"qa"],"deadline":"0000-00-00","estStarted":"2026-10-18","project":{"id":4},"execution":"5"}),
            Some(2),
            7,
        );
        assert_eq!(task["id"], "one:task:3");
        assert_eq!(task["deadline"], Value::Null);
        assert_eq!(task["assignedTo"], "dev");
        assert_eq!(task["parentRemoteId"], 2);
        assert_eq!(task["teamAccounts"], json!(["dev", "qa"]));
        assert_eq!(task["remoteProjectId"], 4);
    }

    fn fixture(
        replies: Vec<(u16, &'static str, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/zentao/", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = vec![];
            listener.set_nonblocking(true).unwrap();
            for (status, headers, body) in replies {
                let until = Instant::now() + Duration::from_secs(3);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(socket) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < until =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => panic!("fixture did not receive the expected request"),
                    }
                };
                // Winsock accepts inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut data = vec![];
                let mut buf = [0; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(split) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..split]);
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= split + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(data).unwrap());
                write!(stream,"HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (address, handle)
    }
    fn connection(address: String, version: &str) -> Connection {
        serde_json::from_value(json!({"id":"test","baseUrl":address,"account":"dev","apiVersion":version,"executionIds":[]})).unwrap()
    }
    #[test]
    fn v1_auth_pagination_children_and_tracked_missing_are_atomic() {
        let (address, server) = fixture(vec![
            (201, "", r#"{"token":"fixture-value"}"#),
            (
                200,
                "",
                r#"{"page":1,"total":3,"limit":2,"tasks":[{"id":1,"name":"parent","status":"wait","children":[{"id":2,"name":"child"}]},{"id":2,"name":"child","status":"wait","parent":1}]}"#,
            ),
            (
                200,
                "",
                r#"{"page":2,"total":3,"limit":2,"tasks":[{"id":3,"name":"other","status":"wait"}]}"#,
            ),
            (404, "", r#"{"error":"private-body"}"#),
        ]);
        let config = connection(address, "v1");
        let mut client = Client::new(&config).unwrap();
        let (version, token) = client.authenticate(Some("fixture-password"), None).unwrap();
        let result = client.fetch(&version, &token, &[9]).unwrap();
        assert_eq!(result.tasks.len(), 3);
        assert_eq!(result.tasks[1].parent_remote_id, Some(1));
        assert_eq!(result.unavailable_ids, vec![9]);
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("POST /zentao/api.php/v1/tokens "));
        assert!(requests[1].contains("mergeChildren=0"));
        assert!(
            requests[1]
                .to_ascii_lowercase()
                .contains("token: fixture-value")
        );
        assert!(requests[2].contains("page=2"));
    }
    #[test]
    fn v2_auto_probe_login_envelope_and_header() {
        let (address, server) = fixture(vec![
            (401, "", r#"{"status":"fail"}"#),
            (
                200,
                "",
                r#"{"status":"success","token":"fixture-value","user":{"account":"dev"}}"#,
            ),
            (
                200,
                "",
                r#"{"status":"success","data":{"tasks":[],"pager":{"pageID":1,"recTotal":0,"recPerPage":100}}}"#,
            ),
        ]);
        let config = connection(address, "auto");
        let mut client = Client::new(&config).unwrap();
        let (version, token) = client.authenticate(Some("fixture-password"), None).unwrap();
        assert_eq!(version, "v2");
        assert!(
            client
                .fetch(&version, &token, &[])
                .unwrap()
                .tasks
                .is_empty()
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /zentao/api.php/v2/my/tasks?"));
        assert!(requests[1].starts_with("POST /zentao/api.php/v2/users/login "));
        assert!(
            requests[2]
                .to_ascii_lowercase()
                .contains("token: fixture-value")
        );
    }
    #[test]
    fn errors_and_second_page_failure_never_return_partial_data_or_server_text() {
        for (status, code) in [
            (401, "ZENTAO_AUTH_REQUIRED"),
            (403, "ZENTAO_FORBIDDEN"),
            (429, "ZENTAO_RATE_LIMITED"),
        ] {
            let (address, server) = fixture(vec![(status, "", "private-body")]);
            let config = connection(address, "v1");
            let mut client = Client::new(&config).unwrap();
            assert_eq!(
                client.fetch("v1", "fixture-value", &[]).err().unwrap(),
                code
            );
            server.join().unwrap();
        }
        let (address, server) = fixture(vec![
            (
                200,
                "",
                r#"{"page":1,"total":2,"limit":1,"tasks":[{"id":1}]}"#,
            ),
            (500, "", "private-body"),
        ]);
        let config = connection(address, "v1");
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            client.fetch("v1", "fixture-value", &[]).err().unwrap(),
            "ZENTAO_SERVER_ERROR"
        );
        server.join().unwrap();
    }
    #[test]
    fn html_login_redirect_and_wrong_password_do_not_fallback() {
        for (status, headers, body, code) in [
            (
                200,
                "Content-Type: text/html\r\n",
                "<html>login private-body</html>",
                "ZENTAO_INVALID_RESPONSE",
            ),
            (
                302,
                "Location: https://example.test/private\r\n",
                "",
                "ZENTAO_REDIRECT_BLOCKED",
            ),
            (401, "", "private-body", "ZENTAO_AUTH_REQUIRED"),
        ] {
            let (address, server) = fixture(vec![(status, headers, body)]);
            let config = connection(address, "v2");
            let mut client = Client::new(&config).unwrap();
            assert_eq!(
                client
                    .authenticate(Some("fixture-password"), None)
                    .err()
                    .unwrap(),
                code
            );
            assert_eq!(server.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn auto_falls_back_only_for_an_unsupported_nonwriting_probe() {
        let (address, server) = fixture(vec![
            (404, "", r#"{"status":"fail"}"#),
            (201, "", r#"{"token":"fixture-value"}"#),
        ]);
        let config = connection(address, "auto");
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            client
                .authenticate(Some("fixture-password"), None)
                .unwrap()
                .0,
            "v1"
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET "));
        assert!(requests[1].starts_with("POST /zentao/api.php/v1/tokens "));
    }

    #[test]
    fn pagination_must_advance_and_finish_without_an_early_empty_page() {
        for second in [
            r#"{"page":1,"total":2,"limit":1,"tasks":[{"id":1}]}"#,
            r#"{"page":2,"total":2,"limit":1,"tasks":[]}"#,
        ] {
            let (address, server) = fixture(vec![
                (
                    200,
                    "",
                    r#"{"page":1,"total":2,"limit":1,"tasks":[{"id":1}]}"#,
                ),
                (200, "", second),
            ]);
            let config = connection(address, "v1");
            let mut client = Client::new(&config).unwrap();
            assert_eq!(
                client.fetch("v1", "fixture-value", &[]).err().unwrap(),
                "ZENTAO_PAGINATION_STALLED"
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn flat_task_data_wins_over_nested_summary_and_keeps_parent_identity() {
        let mut tasks = BTreeMap::new();
        collect_tasks(
            "one",
            &json!({"id":1,"children":[{"id":2,"name":"summary"}]}),
            None,
            5,
            &mut tasks,
            0,
        )
        .unwrap();
        collect_tasks(
            "one",
            &json!({"id":2,"name":"full","desc":"details","assignedTo":{"account":"dev"}}),
            None,
            5,
            &mut tasks,
            0,
        )
        .unwrap();
        assert_eq!(tasks[&2]["title"], "full");
        assert_eq!(tasks[&2]["parentRemoteId"], 1);
        assert_eq!(tasks[&2]["assignedTo"], "dev");
    }

    #[test]
    fn snapshot_reads_lost_assignment_and_execution_metadata_without_writes() {
        let (address, server) = fixture(vec![
            (
                200,
                "",
                r#"{"tasks":[{"id":1,"name":"Task","status":"wait","execution":5}],"pager":{"pageID":1,"recTotal":1,"recPerPage":100}}"#,
            ),
            (
                200,
                "",
                r#"{"task":{"id":9,"name":"reassigned","status":"doing","assignedTo":"other","execution":5}}"#,
            ),
            (403, "", "private-body"),
            (
                200,
                "",
                r#"{"execution":{"id":5,"name":"Sprint","begin":"0000-00-00","end":"2026-10-19","status":"doing"}}"#,
            ),
        ]);
        let config = connection(address, "v2");
        let mut client = Client::new(&config).unwrap();
        let result = client.fetch("v2", "fixture-value", &[9, 10]).unwrap();
        assert_eq!(result.tasks.len(), 2);
        assert_eq!(result.tasks[1].assigned_to, "other");
        assert_eq!(result.unavailable_ids, vec![10]);
        assert_eq!(result.executions[0].start, None);
        assert!(
            server
                .join()
                .unwrap()
                .iter()
                .all(|request| request.starts_with("GET "))
        );
    }

    #[test]
    fn login_failure_envelope_cannot_be_treated_as_a_valid_session() {
        let (address, server) = fixture(vec![(
            200,
            "",
            r#"{"status":"fail","message":"private-body"}"#,
        )]);
        let config = connection(address, "v2");
        let mut client = Client::new(&config).unwrap();
        assert_eq!(
            client
                .authenticate(Some("fixture-password"), None)
                .err()
                .unwrap(),
            "ZENTAO_AUTH_REQUIRED"
        );
        server.join().unwrap();
    }

    #[test]
    fn response_size_request_budget_and_timeout_are_bounded() {
        let (address, server) = fixture(vec![(200, "Content-Length: 999999999\r\n", "{}")]);
        let config = connection(address, "v1");
        let mut client = Client::new(&config).unwrap();
        // Duplicate contradictory lengths are rejected before any JSON can be accepted.
        assert!(client.fetch("v1", "fixture-value", &[]).is_err());
        server.join().unwrap();
        client.requests = MAX_REQUESTS;
        assert_eq!(
            client.fetch("v1", "fixture-value", &[]).err().unwrap(),
            "ZENTAO_REQUEST_LIMIT"
        );

        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = connection(format!("http://{}/", listener.local_addr().unwrap()), "v1");
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });
        let mut client = Client::new(&config).unwrap();
        client.request_timeout = Duration::from_millis(40);
        assert_eq!(
            client.fetch("v1", "fixture-value", &[]).err().unwrap(),
            "ZENTAO_TIMEOUT"
        );
        server.join().unwrap();
    }

    #[test]
    fn session_validation_checks_actual_account_before_vault_can_be_saved() {
        for (version, profile, expected) in [
            ("v1", r#"{"profile":{"account":"dev"}}"#, Ok(())),
            (
                "v2",
                r#"{"user":{"account":"other"}}"#,
                Err("ZENTAO_ACCOUNT_MISMATCH".to_owned()),
            ),
        ] {
            let (address, server) = fixture(vec![(200, "", r#"{"tasks":[]}"#), (200, "", profile)]);
            let config = connection(address, version);
            let mut client = Client::new(&config).unwrap();
            assert_eq!(client.validate(version, "fixture-value"), expected);
            let requests = server.join().unwrap();
            assert!(requests[1].starts_with(if version == "v1" {
                "GET /zentao/api.php/v1/user "
            } else {
                "GET /zentao/api.php/v2/users/0 "
            }));
        }
    }

    #[test]
    fn presentation_child_and_changed_status_rows_are_reread_once_as_canonical_tasks() {
        let (address, server) = fixture(vec![
            (
                200,
                "",
                r#"{"tasks":[{"id":2,"name":"Parent / Child","status":"changed","parent":0,"isChild":true,"assignedTo":"dev","children":[{"id":99,"name":"Someone else","status":"wait","assignedTo":"other"}]}],"total":1,"page":1,"limit":100}"#,
            ),
            (
                200,
                "",
                r#"{"task":{"id":2,"name":"Child","status":"doing","parent":1,"assignedTo":"dev","children":[{"id":99,"name":"Someone else","status":"wait","assignedTo":"other"}]}}"#,
            ),
        ]);
        let config = connection(address, "v2");
        let mut client = Client::new(&config).unwrap();
        let result = client.fetch("v2", "fixture-value", &[2]).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].title, "Child");
        assert_eq!(result.tasks[0].status, "doing");
        assert_eq!(result.tasks[0].parent_remote_id, Some(1));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.starts_with("GET ")));
        assert!(requests[1].starts_with("GET /zentao/api.php/v2/tasks/2 "));
    }

    #[test]
    fn remote_byte_limits_and_malformed_timestamps_reject_the_entire_snapshot() {
        for patch in [
            json!({"name":"x".repeat(10_001)}),
            json!({"desc":"中".repeat(400_000)}),
            json!({"status":"x".repeat(101)}),
            json!({"lastEditedDate":"2026-10-18malformed"}),
        ] {
            let mut task = json!({"id":1,"name":"Task","status":"wait","assignedTo":"dev"});
            task.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            let body = Box::leak(
                json!({"tasks":[task],"page":1,"total":1,"limit":100})
                    .to_string()
                    .into_boxed_str(),
            );
            let (address, server) = fixture(vec![(200, "", body)]);
            let config = connection(address, "v2");
            let mut client = Client::new(&config).unwrap();
            assert!(client.fetch("v2", "fixture-value", &[]).is_err());
            server.join().unwrap();
        }
        let (address, server) = fixture(vec![
            (
                200,
                "",
                r#"{"tasks":[{"id":1,"name":"Task","status":"wait","execution":5}],"total":1}"#,
            ),
            (
                200,
                "",
                r#"{"execution":{"id":5,"name":"Sprint","status":"doing","begin":"2026-10-19","end":"2026-10-18"}}"#,
            ),
        ]);
        let config = connection(address, "v2");
        let mut client = Client::new(&config).unwrap();
        assert!(client.fetch("v2", "fixture-value", &[]).is_err());
        server.join().unwrap();
    }
}
