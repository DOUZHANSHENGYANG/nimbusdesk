//! 工具箱命令层：只做「解析参数 → 调 `crate::agenthub::*` → 回传」。
//!
//! 全部 `async` + `spawn_blocking`：这些操作要遍历目录、写文件，跑在 Tauri 的
//! 主线程上会卡住 UI 事件循环（与 `commands/data.rs` 同一条理由）。

use crate::agenthub::{harness, mcp, models::*, prompts, skills};
use tauri::command;

async fn blocking<T>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[command]
pub async fn tb_root() -> Result<TbRoots, String> {
    blocking(crate::agenthub::roots).await
}

// ---------------- 技能 ----------------

#[command]
pub async fn tb_skill_list() -> Result<Vec<TbSkillMeta>, String> {
    blocking(|| skills::list(&crate::agenthub::skills_dir()?)).await
}

#[command]
pub async fn tb_skill_read(dir_name: String) -> Result<TbSkillDoc, String> {
    blocking(move || skills::read(&crate::agenthub::skills_dir()?, &dir_name)).await
}

#[command]
pub async fn tb_skill_save(
    dir_name: String,
    frontmatter: String,
    body: String,
    tags: Vec<String>,
    publish: bool,
    note: String,
) -> Result<TbSkillMeta, String> {
    blocking(move || {
        skills::save(
            &crate::agenthub::skills_dir()?,
            TbSkillSave {
                dir_name,
                frontmatter,
                body,
                tags,
                publish,
                note,
            },
        )
    })
    .await
}

#[command]
pub async fn tb_skill_create(name: String, description: String) -> Result<TbSkillMeta, String> {
    blocking(move || skills::create(&crate::agenthub::skills_dir()?, &name, &description)).await
}

#[command]
pub async fn tb_skill_restore(dir_name: String, v: u32) -> Result<TbSkillDoc, String> {
    blocking(move || skills::restore(&crate::agenthub::skills_dir()?, &dir_name, v)).await
}

#[command]
pub async fn tb_skill_delete(dir_name: String) -> Result<(), String> {
    blocking(move || skills::delete(&crate::agenthub::skills_dir()?, &dir_name)).await
}

#[command]
pub async fn tb_skill_import(path: String) -> Result<TbSkillMeta, String> {
    blocking(move || skills::import_dir(&crate::agenthub::skills_dir()?, std::path::Path::new(&path))).await
}

#[command]
pub async fn tb_skill_reveal(dir_name: String) -> Result<(), String> {
    blocking(move || {
        let dir = crate::agenthub::skills_dir()?.join(crate::agenthub::safe_dir_name(&dir_name)?);
        if !dir.is_dir() {
            return Err(format!("技能不存在: {dir_name}"));
        }
        tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| e.to_string())
    })
    .await
}

/// 只读：列出技能目录的文件树（深度与条目有上限，绝不跟随符号链接）。
#[command]
pub async fn tb_skill_list_files(dir_name: String) -> Result<TbSkillFileNode, String> {
    blocking(move || skills::list_files(&crate::agenthub::skills_dir()?, &dir_name)).await
}

/// 只读：读技能目录内单个文本文件（越界/二进制/超限一律报错，不截断）。
#[command]
pub async fn tb_skill_read_file(dir_name: String, rel_path: String) -> Result<TbSkillFileContent, String> {
    blocking(move || skills::read_file(&crate::agenthub::skills_dir()?, &dir_name, &rel_path)).await
}

#[command]
pub async fn tb_root_reveal() -> Result<(), String> {
    blocking(move || {
        let root = crate::agenthub::root()?;
        tauri_plugin_opener::reveal_item_in_dir(&root).map_err(|e| e.to_string())
    })
    .await
}

// ---------------- 提示词 ----------------

#[command]
pub async fn tb_prompt_list() -> Result<Vec<TbPrompt>, String> {
    blocking(|| prompts::list(&crate::agenthub::prompts_dir()?)).await
}

#[command]
pub async fn tb_prompt_save(prompt: TbPrompt, publish: bool) -> Result<TbPrompt, String> {
    blocking(move || prompts::save(&crate::agenthub::prompts_dir()?, prompt, publish)).await
}

#[command]
pub async fn tb_prompt_delete(id: String) -> Result<(), String> {
    blocking(move || prompts::delete(&crate::agenthub::prompts_dir()?, &id)).await
}

#[command]
pub async fn tb_prompt_restore(id: String, v: u32) -> Result<TbPrompt, String> {
    blocking(move || prompts::restore(&crate::agenthub::prompts_dir()?, &id, v)).await
}

// ---------------- MCP ----------------

#[command]
pub async fn tb_mcp_list() -> Result<Vec<TbMcpServer>, String> {
    blocking(|| mcp::list(&crate::agenthub::mcp_dir()?)).await
}

#[command]
pub async fn tb_mcp_save(server: TbMcpServer) -> Result<TbMcpServer, String> {
    blocking(move || mcp::save(&crate::agenthub::mcp_dir()?, server)).await
}

#[command]
pub async fn tb_mcp_delete(id: String) -> Result<(), String> {
    blocking(move || mcp::delete(&crate::agenthub::mcp_dir()?, &id)).await
}

#[command]
pub async fn tb_mcp_export(ids: Vec<String>) -> Result<serde_json::Value, String> {
    blocking(move || Ok(mcp::export(&mcp::list(&crate::agenthub::mcp_dir()?)?, &ids))).await
}

// ---------------- 本机工具（探测 / 收集 / 分发） ----------------

#[command]
pub async fn tb_harness_scan() -> Result<Vec<TbHarnessReport>, String> {
    blocking(|| Ok(harness::scan())).await
}

#[command]
pub async fn tb_harness_collect(harness: String, kind: String, names: Vec<String>) -> Result<TbTransferResult, String> {
    blocking(move || {
        harness::collect(
            &crate::agenthub::mcp_dir()?,
            &crate::agenthub::skills_dir()?,
            &harness,
            &kind,
            &names,
        )
    })
    .await
}

#[command]
pub async fn tb_harness_push(harness: String, kind: String, names: Vec<String>) -> Result<TbTransferResult, String> {
    blocking(move || {
        harness::push(
            &crate::agenthub::mcp_dir()?,
            &crate::agenthub::skills_dir()?,
            &harness,
            &kind,
            &names,
        )
    })
    .await
}

#[command]
pub async fn tb_harness_remove(harness: String, kind: String, names: Vec<String>) -> Result<TbTransferResult, String> {
    blocking(move || {
        harness::remove(
            &crate::agenthub::mcp_dir()?,
            &crate::agenthub::skills_dir()?,
            &harness,
            &kind,
            &names,
        )
    })
    .await
}
