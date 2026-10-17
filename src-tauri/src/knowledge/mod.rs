//! Obsidian vault storage. Markdown is the content source; JSON only tracks capture metadata.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFolders {
    pub experience: String,
    pub recipe: String,
    pub resource: String,
}
impl Default for KnowledgeFolders {
    fn default() -> Self {
        Self {
            experience: "02-工作/开发经验".into(),
            recipe: "02-工作/开发配方".into(),
            resource: "04-资源收藏".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub project: String,
    pub source: String,
    pub attachments: Vec<AttachmentInput>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAttachment {
    pub name: String,
    pub path: String,
    pub mime: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecord {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub project: String,
    pub source: String,
    pub status: String,
    pub attachments: Vec<CaptureAttachment>,
    pub note_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeNote {
    pub path: String,
    pub title: String,
    pub kind: String,
    pub modified_at: u64,
    pub preview: String,
    #[serde(default)]
    pub frontmatter: String,
    #[serde(default)]
    pub organized: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadNote {
    pub path: String,
    pub content: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub path: String,
    pub content: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInput {
    pub ids: Vec<String>,
    pub title: String,
    pub kind: String,
    pub content: String,
    pub tags: Vec<String>,
    pub fingerprints: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeSource {
    pub path: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeInput {
    pub sources: Vec<OrganizeSource>,
    pub title: String,
    pub kind: String,
    pub content: String,
    pub tags: Vec<String>,
}

mod storage;
pub use storage::{
    archive_with_folders, bind, capture, captures, image, organize_with_folders, read,
    scan_with_folders, search_with_folders, templates, update, validate_folders,
};

#[cfg(test)]
pub use storage::{archive, scan, search};

#[cfg(test)]
mod tests;
