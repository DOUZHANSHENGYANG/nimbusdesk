//! Only result metadata is persisted. Source bodies and AI inputs never enter history.
use super::SearchHit;
use serde::{Deserialize, Serialize};
const KEY: &str = "search-personalization";
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Home {
    pub pinned: Vec<SearchHit>,
    pub recent: Vec<SearchHit>,
}
fn identity(hit: &SearchHit) -> String {
    if matches!(hit.kind.as_str(), "file" | "folder") {
        hit.path
            .as_ref()
            .map(|p| format!("path:{}", super::path_identity(p)))
            .unwrap_or_else(|| hit.id.clone())
    } else {
        hit.id.clone()
    }
}
fn metadata(mut hit: SearchHit) -> Result<SearchHit, String> {
    if ![
        "file",
        "folder",
        "plan",
        "knowledge",
        "feed",
        "project",
        "bookmark",
        "app",
    ]
    .contains(&hit.kind.as_str())
        || hit.id.is_empty()
        || hit.id.len() > 4096
        || hit.title.len() > 4096
        || hit.subtitle.len() > 32768
        || hit.id.chars().any(char::is_control)
    {
        return Err("无效搜索条目".into());
    }
    if hit.kind == "app" && !hit.id.starts_with("app:") {
        return Err("无效应用条目".into());
    }
    if let Some(path) = &hit.path {
        if path.len() > 32768
            || !std::path::Path::new(path).is_absolute()
            || path.chars().any(char::is_control)
        {
            return Err("无效文件路径".into());
        }
    }
    if let Some(route) = &hit.route {
        if route.len() > 32768 || !crate::commands::search::allowed_route(route) {
            return Err("无效工作台位置".into());
        }
    }
    hit.snippet.clear();
    hit.url = None;
    hit.score = 0.;
    Ok(hit)
}
impl Home {
    fn clean(self) -> Self {
        fn entries(values: Vec<SearchHit>, cap: usize) -> Vec<SearchHit> {
            let mut seen = std::collections::HashSet::new();
            values
                .into_iter()
                .filter_map(|h| metadata(h).ok())
                .filter(|h| seen.insert(identity(h)))
                .take(cap)
                .collect()
        }
        Self {
            pinned: entries(self.pinned, 64),
            recent: entries(self.recent, 40),
        }
    }
    fn opened(&mut self, hit: SearchHit) -> Result<(), String> {
        let hit = metadata(hit)?;
        let id = identity(&hit);
        self.recent.retain(|h| identity(h) != id);
        self.recent.insert(0, hit.clone());
        self.recent.truncate(40);
        for pin in &mut self.pinned {
            if identity(pin) == id {
                *pin = hit.clone();
            }
        }
        Ok(())
    }
    fn pin(&mut self, hit: SearchHit, pinned: bool) -> Result<(), String> {
        let hit = metadata(hit)?;
        let id = identity(&hit);
        let exists = self.pinned.iter().any(|h| identity(h) == id);
        if pinned && !exists && self.pinned.len() >= 64 {
            return Err("最多固定 64 个条目".into());
        }
        self.pinned.retain(|h| identity(h) != id);
        if pinned {
            self.pinned.push(hit);
        }
        Ok(())
    }
}
fn read(root: &std::path::Path) -> Result<Home, String> {
    let value = crate::database::read_at(root, KEY)?;
    value
        .map(|v| {
            serde_json::from_value::<Home>(v)
                .map(Home::clean)
                .map_err(|_| "搜索最近使用或固定数据损坏，已停止写入以保留原数据".into())
        })
        .unwrap_or_else(|| Ok(Home::default()))
}
pub fn home() -> Result<Home, String> {
    crate::commands::data::with_data_dir(read)
}
// Callers serialize this operation with the data-directory lock; accepting an
// explicit root also lets persistence tests use isolated databases.
fn mutate_at(
    root: &std::path::Path,
    change: impl FnOnce(&mut Home) -> Result<(), String>,
) -> Result<Home, String> {
    let mut home = read(root)?;
    change(&mut home)?;
    crate::database::write_at(
        root,
        KEY,
        &serde_json::to_value(&home).map_err(|e| e.to_string())?,
    )?;
    Ok(home)
}
fn mutate(change: impl FnOnce(&mut Home) -> Result<(), String>) -> Result<Home, String> {
    crate::commands::data::with_data_dir(|root| mutate_at(root, change))
}
pub fn pin(hit: SearchHit, pinned: bool) -> Result<Home, String> {
    mutate(|home| home.pin(hit, pinned))
}
pub fn opened(hit: SearchHit) -> Result<Home, String> {
    mutate(|home| home.opened(hit))
}
pub fn clear_recent() -> Result<Home, String> {
    mutate(|home| {
        home.recent.clear();
        Ok(())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn hit(id: usize) -> SearchHit {
        SearchHit {
            id: format!("plan:{id}"),
            kind: "plan".into(),
            title: format!("Task {id}"),
            subtitle: "2026-10-18".into(),
            snippet: "private body".into(),
            path: None,
            url: None,
            route: Some("/plans?date=2026-10-18".into()),
            score: 90.,
        }
    }
    #[test]
    fn recents_deduplicate_bound_and_strip_body() {
        let mut home = Home::default();
        for id in 0..50 {
            home.opened(hit(id)).unwrap();
        }
        home.opened(hit(20)).unwrap();
        assert_eq!(home.recent.len(), 40);
        assert_eq!(home.recent[0].id, "plan:20");
        assert!(home.recent.iter().all(|h| h.snippet.is_empty()));
    }
    #[test]
    fn pinning_is_independent_and_bounded() {
        let mut home = Home::default();
        for id in 0..64 {
            home.pin(hit(id), true).unwrap();
        }
        assert!(home.pin(hit(65), true).is_err());
        home.pin(hit(1), true).unwrap();
        assert_eq!(home.pinned.len(), 64);
        home.pin(hit(1), false).unwrap();
        assert_eq!(home.pinned.len(), 63);
        assert!(home.recent.is_empty());
    }
    #[test]
    fn reject_untrusted_routes_and_launch_data() {
        let mut bad = hit(1);
        bad.route = Some("https://evil.test".into());
        assert!(metadata(bad).is_err());
        let mut app = hit(2);
        app.kind = "app".into();
        assert!(metadata(app).is_err());
    }

    struct TestRoot(std::path::PathBuf);
    impl TestRoot {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "nimbus-personalization-{label}-{}-{}",
                std::process::id(),
                super::super::runtime::now()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn sqlite_restart_preserves_metadata_and_clearing_recent_keeps_pins() {
        let root = TestRoot::new("roundtrip");
        assert!(read(&root.0).unwrap().pinned.is_empty());
        mutate_at(&root.0, |home| home.pin(hit(1), true)).unwrap();
        mutate_at(&root.0, |home| home.opened(hit(2))).unwrap();
        let mut updated = hit(1);
        updated.title = "Updated task title".into();
        updated.url = Some("https://example.invalid/private-query".into());
        mutate_at(&root.0, |home| home.opened(updated)).unwrap();

        // Every operation opens a fresh SQLite connection: this read relies on
        // disk state, with no retained Home value or connection from the writes.
        let reopened = read(&root.0).unwrap();
        assert_eq!(reopened.pinned.len(), 1);
        assert_eq!(reopened.pinned[0].id, "plan:1");
        assert_eq!(reopened.pinned[0].title, "Updated task title");
        assert_eq!(
            reopened
                .recent
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["plan:1", "plan:2"]
        );
        assert!(
            reopened
                .pinned
                .iter()
                .chain(&reopened.recent)
                .all(|item| item.snippet.is_empty() && item.url.is_none() && item.score == 0.)
        );
        let raw = crate::database::read_at(&root.0, KEY)
            .unwrap()
            .unwrap()
            .to_string();
        assert!(!raw.contains("private body"));
        assert!(!raw.contains("private-query"));
        assert!(root.0.join(crate::database::DATABASE_FILE).exists());
        assert!(!root.0.join(format!("{KEY}.json")).exists());
        drop(reopened);

        mutate_at(&root.0, |home| {
            home.recent.clear();
            Ok(())
        })
        .unwrap();
        let reopened = read(&root.0).unwrap();
        assert!(reopened.recent.is_empty());
        assert_eq!(reopened.pinned.len(), 1);
        assert_eq!(reopened.pinned[0].id, "plan:1");
        assert_eq!(reopened.pinned[0].title, "Updated task title");
    }

    #[test]
    fn malformed_sqlite_schema_refuses_mutations_and_preserves_original_value() {
        let root = TestRoot::new("malformed");
        let malformed =
            serde_json::json!({"pinned":[metadata(hit(1)).unwrap()],"recent":"invalid-schema"});
        crate::database::write_at(&root.0, KEY, &malformed).unwrap();
        assert!(read(&root.0).is_err());
        for operation in 0..3 {
            let mut mutation_ran = false;
            let result = mutate_at(&root.0, |home| {
                mutation_ran = true;
                match operation {
                    0 => home.pin(hit(2), true),
                    1 => home.opened(hit(2)),
                    _ => {
                        home.recent.clear();
                        Ok(())
                    }
                }
            });
            assert!(result.is_err());
            assert!(
                !mutation_ran,
                "malformed storage must be rejected before any mutation"
            );
            assert_eq!(
                crate::database::read_at(&root.0, KEY).unwrap(),
                Some(malformed.clone())
            );
        }
    }
}
