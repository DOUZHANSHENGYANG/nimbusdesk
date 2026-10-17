use crate::{
    commands::data::with_data_dir,
    task_attachments::{self, AttachmentFile, TaskAttachment},
};

#[tauri::command]
pub async fn task_attachments_add(
    task_id: String,
    paths: Vec<String>,
) -> Result<Vec<TaskAttachment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_data_dir(|root| task_attachments::add_files(root, &task_id, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_attachment_location(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_data_dir(|root| {
            task_attachments::location(root, &path).map(|p| p.to_string_lossy().into_owned())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_attachments_export(paths: Vec<String>) -> Result<Vec<AttachmentFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_data_dir(|root| task_attachments::export_files(root, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn task_attachments_import(files: Vec<AttachmentFile>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_data_dir(|root| task_attachments::import_files(root, &files))
    })
    .await
    .map_err(|e| e.to_string())?
}
