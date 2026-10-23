use super::{SearchDocument, SearchHit};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};

pub const KEYS: &[&str] = &[
    "plans",
    "plans-archive",
    "files",
    "projects",
    "feed-cache",
    "favorites",
    "custom-feeds",
    "knowledge-settings",
];
pub fn state(value: &Value) -> &Value {
    value.get("state").unwrap_or(value)
}
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}
pub fn route(page: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = tauri::Url::parse(&format!("https://workspace.invalid{page}")).unwrap();
    for (key, value) in pairs {
        url.query_pairs_mut().append_pair(key, value);
    }
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}
fn hit(id: String, kind: &str, title: String, subtitle: String, route: String) -> SearchHit {
    SearchHit {
        id,
        kind: kind.into(),
        title,
        subtitle,
        snippet: String::new(),
        path: None,
        url: None,
        route: Some(route),
        score: 0.0,
    }
}
pub fn from_states(states: &BTreeMap<String, Value>, files_items: &[Value]) -> Vec<SearchDocument> {
    let mut docs = vec![];
    for (key, archived) in [("plans", false), ("plans-archive", true)] {
        let Some(days) = states
            .get(key)
            .map(state)
            .and_then(|s| s.get("days"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (date, value) in days {
            let Some(tasks) = (if archived {
                value.get("tasks")
            } else {
                Some(value)
            })
            .and_then(Value::as_array) else {
                continue;
            };
            for task in tasks {
                let id = text(task, "id");
                let title = text(task, "title");
                if id.is_empty() || title.is_empty() {
                    continue;
                }
                let parent = tasks
                    .iter()
                    .find(|t| text(t, "id") == text(task, "parentId"))
                    .map(|t| text(t, "title"))
                    .unwrap_or_default();
                let attachments = task
                    .get("attachments")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|a| text(a, "name"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                let mut pairs = vec![("date", date.as_str()), ("task", id.as_str())];
                if archived {
                    pairs.push(("archived", "1"));
                }
                let subtitle = format!(
                    "{} · {}{}",
                    date,
                    if archived {
                        "已归档"
                    } else if task.get("done").and_then(Value::as_bool) == Some(true) {
                        "已完成"
                    } else {
                        "计划"
                    },
                    if parent.is_empty() {
                        String::new()
                    } else {
                        format!(" · {parent}")
                    }
                );
                let body = format!(
                    "{} {} {} {} {}",
                    text(task, "note"),
                    parent,
                    attachments,
                    text(task, "start"),
                    text(task, "end")
                );
                docs.push(SearchDocument {
                    hit: hit(
                        format!("plan:{date}:{id}"),
                        "plan",
                        title,
                        subtitle,
                        route("/plans", &pairs),
                    ),
                    body,
                });
            }
        }
    }
    let source_names: BTreeMap<String, String> = states
        .get("custom-feeds")
        .map(state)
        .and_then(|s| s.get("feeds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| (text(v, "id"), text(v, "name")))
        .collect();
    let mut articles: BTreeMap<String, SearchDocument> = BTreeMap::new();
    if let Some(sources) = states
        .get("feed-cache")
        .map(state)
        .and_then(|s| s.get("entriesBySource"))
        .and_then(Value::as_object)
    {
        for (source, entries) in sources {
            for entry in entries.as_array().into_iter().flatten() {
                let url = text(entry, "url");
                if url.is_empty() {
                    continue;
                }
                let name = source_names.get(source).cloned().unwrap_or_else(|| {
                    match source.as_str() {
                        "github-trending" => "GitHub Trending",
                        "hackernews" | "hacker-news" => "Hacker News",
                        "solidot" => "Solidot",
                        "sspai" => "少数派",
                        "v2ex" => "V2EX",
                        "zhihu" => "知乎热榜",
                        _ => source,
                    }
                    .into()
                });
                let mut row = hit(
                    format!("feed:{url}"),
                    "feed",
                    text(entry, "title"),
                    name,
                    route("/feeds", &[("source", source), ("article", &url)]),
                );
                row.url = Some(url.clone());
                let body = format!(
                    "{} {}",
                    entry
                        .pointer("/extra/hover")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    entry
                        .pointer("/content/value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                articles.insert(
                    url,
                    SearchDocument {
                        hit: row,
                        body: plain(&body),
                    },
                );
            }
        }
    }
    for entry in states
        .get("favorites")
        .map(state)
        .and_then(|s| s.get("items"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let url = text(entry, "url");
        if url.is_empty() {
            continue;
        }
        if let Some(existing) = articles.get_mut(&url) {
            let name = text(entry, "sourceName");
            if !name.is_empty() {
                existing.hit.subtitle = name;
            }
            continue;
        }
        let mut row = hit(
            format!("feed:{url}"),
            "feed",
            text(entry, "title"),
            format!("收藏 · {}", text(entry, "sourceName")),
            route("/feeds", &[("source", "__favorites__"), ("article", &url)]),
        );
        row.url = Some(url.clone());
        let body = format!(
            "{} {}",
            entry
                .pointer("/extra/hover")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            entry
                .pointer("/content/value")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        articles.insert(
            url,
            SearchDocument {
                hit: row,
                body: plain(&body),
            },
        );
    }
    docs.extend(articles.into_values());
    // 条目已经搬进行级表：优先用调用方查出来的行；表还空着（老数据尚未搬）时回退读整份 blob
    let legacy_items: Vec<Value> = if files_items.is_empty() {
        states
            .get("files")
            .map(state)
            .and_then(|s| s.get("items"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let legacy_items = legacy_items.as_slice();
    for item in if files_items.is_empty() { legacy_items } else { files_items } {
        let id = text(item, "id");
        let path = text(item, "path");
        let mut row = hit(
            format!("bookmark:{id}"),
            "bookmark",
            text(item, "title"),
            path.clone(),
            route("/files", &[("item", &id)]),
        );
        if text(item, "type") == "url" {
            row.url = Some(path);
        } else {
            row.path = Some(path);
        }
        docs.push(SearchDocument {
            hit: row,
            body: format!(
                "{} {}",
                text(item, "note"),
                item.get("tags").unwrap_or(&Value::Null)
            ),
        });
    }
    if let Some(projects) = states.get("projects").map(state) {
        let rows = |key: &str| projects.get(key).and_then(Value::as_array);
        let name_of = |key: &str, id: &str| {
            rows(key)
                .and_then(|list| list.iter().find(|row| text(row, "id") == id))
                .map(|row| text(row, "name"))
                .unwrap_or_default()
        };
        for project in rows("projects").into_iter().flatten() {
            let id = text(project, "id");
            let name = text(project, "name");
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let area = name_of("areas", &text(project, "areaId"));
            docs.push(SearchDocument {
                hit: hit(
                    format!("project:{id}"),
                    "project",
                    name,
                    area.clone(),
                    route("/projects", &[("project", &id)]),
                ),
                body: format!("{} {area}", text(project, "note")),
            });
        }
        for item in rows("items").into_iter().flatten() {
            let id = text(item, "id");
            let title = text(item, "title");
            // Merged items are aliases of a surviving row; indexing both would duplicate every hit.
            if id.is_empty() || title.is_empty() || !text(item, "mergedIntoId").is_empty() {
                continue;
            }
            let project = name_of("projects", &text(item, "projectId"));
            let status = match text(item, "status").as_str() {
                "doing" => "进行中",
                "done" => "已完成",
                "cancelled" => "已取消",
                _ => "待办",
            };
            let subtitle = if project.is_empty() {
                status.to_string()
            } else {
                format!("{project} · {status}")
            };
            docs.push(SearchDocument {
                hit: hit(
                    format!("project-item:{id}"),
                    "project",
                    title,
                    subtitle,
                    route("/projects", &[("item", &id)]),
                ),
                body: format!("{} {project}", text(item, "note")),
            });
        }
    }
    docs
}

fn plain(html: &str) -> String {
    let mut inside = false;
    let mut out = String::new();
    for c in html.chars().take(300_000) {
        if c == '<' {
            inside = true;
            out.push(' ');
        } else if c == '>' {
            inside = false;
        } else if !inside {
            out.push(c);
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[derive(Clone)]
pub struct NoteFile {
    pub relative: String,
    pub path: PathBuf,
    pub modified: u64,
    pub size: u64,
}
pub fn note_files(
    root: &str,
    folders: crate::knowledge::KnowledgeFolders,
) -> Result<Vec<NoteFile>, String> {
    let folders = crate::knowledge::validate_folders(root, folders)?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let mut files = vec![];
    let mut seen = HashSet::new();
    for folder in [
        folders.experience,
        folders.recipe,
        folders.resource,
        "08-收件箱".into(),
    ] {
        walk(&root, &root.join(folder), 0, &mut files, &mut seen)?;
    }
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(files)
}
fn walk(
    root: &Path,
    directory: &Path,
    depth: usize,
    out: &mut Vec<NoteFile>,
    seen: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    // Check the scope directory itself as well as each descendant. Inboxes may
    // contain legacy junctions; search must never follow them out of the vault.
    if let Ok(metadata) = std::fs::symlink_metadata(directory) {
        if metadata.file_type().is_symlink() {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Ok(());
            }
        }
    }
    if depth > 32 || out.len() >= 10000 {
        return Err("知识索引达到目录深度或一万篇上限".into());
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        if out.len() >= 10000 {
            return Err("知识索引达到一万篇上限".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x402 != 0 {
                continue;
            }
        }
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk(root, &path, depth + 1, out, seen)?;
        } else if metadata.is_file()
            && path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("md"))
            && !path.to_string_lossy().ends_with(".excalidraw.md")
            && seen.insert(path.clone())
        {
            out.push(NoteFile {
                relative: path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
                path,
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or_default(),
                size: metadata.len(),
            });
        }
    }
    Ok(())
}
pub fn note_document(root: &str, file: &NoteFile) -> Result<SearchDocument, String> {
    crate::database::reject_link_components(&file.path)?;
    let mut bytes = vec![];
    std::fs::File::open(&file.path)
        .map_err(|e| e.to_string())?
        .take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let title = body
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            file.path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let mut row = hit(
        format!("knowledge:{}:{}", root.to_lowercase(), file.relative),
        "knowledge",
        title,
        file.relative.clone(),
        route("/knowledge", &[("note", &file.relative)]),
    );
    row.path = Some(file.path.to_string_lossy().into_owned());
    Ok(SearchDocument { hit: row, body })
}
