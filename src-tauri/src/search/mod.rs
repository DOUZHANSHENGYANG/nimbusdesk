use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub snippet: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub route: Option<String>,
    pub score: f64,
}
pub struct SearchDocument {
    pub hit: SearchHit,
    pub body: String,
}
mod content;
pub mod filters;
pub mod personalization;
pub mod apps;
pub mod files;
mod sources;
pub use content::ContentIndex;
pub mod runtime;
pub mod everything_app;
mod pinyin;
mod file_index;
pub mod extract;
pub mod extract_worker;
pub mod file_runtime;
mod name_enum;
pub fn path_identity(path:&str)->String {file_index::normalize(path)}
/// Registered apps rank first, followed by executable files; folders stay ordinary.
pub fn compare_hits(a: &SearchHit, b: &SearchHit) -> std::cmp::Ordering {
    fn executable(hit: &SearchHit) -> bool {
        hit.kind == "file" && hit.path.as_deref().unwrap_or(&hit.title)
            .rsplit_once('.').is_some_and(|(_, extension)| matches!(extension.to_ascii_lowercase().as_str(), "exe" | "bat" | "cmd" | "ps1" | "ps" | "com"))
    }
    fn priority(hit: &SearchHit) -> u8 { if hit.kind == "app" { 2 } else if executable(hit) { 1 } else { 0 } }
    priority(b).cmp(&priority(a)).then_with(|| b.score.total_cmp(&a.score))
        .then_with(|| a.title.cmp(&b.title)).then_with(|| a.id.cmp(&b.id))
}
pub fn sources_key(key: &str) -> bool {
    key == "search-settings" || sources::KEYS.contains(&key)
}

#[cfg(test)]
mod tests;
