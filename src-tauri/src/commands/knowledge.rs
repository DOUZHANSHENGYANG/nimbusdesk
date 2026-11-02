use crate::knowledge::{
    self, ArchiveInput, CaptureInput, CaptureRecord, KnowledgeFolders, KnowledgeNote,
    OrganizeInput, ReadNote, UpdateNoteInput, VaultInfo,
};

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| format!("知识库后台任务失败: {error}"))?
}

#[tauri::command]
pub async fn knowledge_bind(root: String) -> Result<VaultInfo, String> {
    blocking(move || knowledge::bind(&root)).await
}
#[tauri::command]
pub async fn knowledge_captures(root: String) -> Result<Vec<CaptureRecord>, String> {
    blocking(move || knowledge::captures(&root)).await
}
#[tauri::command]
pub async fn knowledge_scan(
    root: String,
    folders: Option<KnowledgeFolders>,
) -> Result<Vec<KnowledgeNote>, String> {
    blocking(move || knowledge::scan_with_folders(&root, &folders.unwrap_or_default())).await
}
#[tauri::command]
pub async fn knowledge_validate_folders(
    root: String,
    folders: KnowledgeFolders,
) -> Result<KnowledgeFolders, String> {
    blocking(move || knowledge::validate_folders(&root, folders)).await
}
#[tauri::command]
pub async fn knowledge_templates(root: String) -> Result<Vec<KnowledgeNote>, String> {
    blocking(move || knowledge::templates(&root)).await
}
#[tauri::command]
pub async fn knowledge_search(
    root: String,
    query: String,
    folders: Option<KnowledgeFolders>,
) -> Result<Vec<KnowledgeNote>, String> {
    blocking(move || knowledge::search_with_folders(&root, &query, &folders.unwrap_or_default()))
        .await
}
#[tauri::command]
pub async fn knowledge_read(root: String, path: String) -> Result<ReadNote, String> {
    blocking(move || knowledge::read(&root, &path)).await
}
#[tauri::command]
pub async fn knowledge_update(root: String, input: UpdateNoteInput) -> Result<ReadNote, String> {
    blocking(move || knowledge::update(&root, input)).await
}
#[tauri::command]
pub async fn knowledge_capture(root: String, input: CaptureInput) -> Result<CaptureRecord, String> {
    blocking(move || knowledge::capture(&root, input)).await
}
#[tauri::command]
pub async fn knowledge_archive(
    root: String,
    input: ArchiveInput,
    folders: Option<KnowledgeFolders>,
) -> Result<KnowledgeNote, String> {
    blocking(move || knowledge::archive_with_folders(&root, input, &folders.unwrap_or_default()))
        .await
}
#[tauri::command]
pub async fn knowledge_organize(
    root: String,
    input: OrganizeInput,
    folders: Option<KnowledgeFolders>,
) -> Result<KnowledgeNote, String> {
    blocking(move || knowledge::organize_with_folders(&root, input, &folders.unwrap_or_default()))
        .await
}
#[tauri::command]
pub async fn knowledge_image(root: String, path: String) -> Result<String, String> {
    blocking(move || knowledge::image(&root, &path)).await
}

#[tauri::command]
pub async fn knowledge_import(root: String, source: String, folder: String) -> Result<String, String> {
    blocking(move || knowledge::import_file(&root, &source, &folder)).await
}

#[tauri::command]
pub async fn knowledge_create_note(
    root: String,
    folder: String,
    name: String,
    content: String,
) -> Result<String, String> {
    blocking(move || knowledge::create_note(&root, &folder, &name, &content)).await
}

#[tauri::command]
pub async fn knowledge_rename(root: String, path: String, name: String) -> Result<String, String> {
    blocking(move || knowledge::rename_note(&root, &path, &name)).await
}

#[tauri::command]
pub async fn knowledge_move(root: String, path: String, folder: String) -> Result<String, String> {
    blocking(move || knowledge::move_note(&root, &path, &folder)).await
}

/// 跑知识库自己的 py 工具（体检 / 分诊 / 闭环 / 检索），返回脚本的 JSON 文本。
#[tauri::command]
pub async fn knowledge_vault_tool(
    root: String,
    action: String,
    argument: Option<String>,
) -> Result<String, String> {
    blocking(move || knowledge::run_tool(&root, &action, &argument.unwrap_or_default())).await
}
