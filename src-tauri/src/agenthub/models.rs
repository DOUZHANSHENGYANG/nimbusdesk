//! 工具箱（AgentHub「工具箱」迁移）的落盘模型。
//!
//! 与源侧 JSON 结构**字段级兼容**：用户把 AgentHub 的 `prompts/*.json`、
//! `mcp/*.json`、`skills/<dir>/` 复制进来即可直接使用。
//!
//! `extra` 是 `#[serde(flatten)]` 兜住的未知字段。源侧结构体里有
//! `variables` / `targets` / `vetReport` / `summary` 等本模块不处理的字段，
//! 若不带 `extra`，保存一次就会把它们从用户文件里抹掉。

use serde::{Deserialize, Serialize};
use serde_json::Map;

/// 一条版本快照：`savedAt` + `note` + 当时的正文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TbVersion {
    pub v: u32,
    pub saved_at: String,
    #[serde(default)]
    pub note: String,
    pub content: String,
}

/// 某条数据来自哪个外部工具（收集进来时记录）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TbOrigin {
    #[serde(default)]
    pub harness: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub imported_at: String,
}

fn default_transport() -> String {
    "stdio".into()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TbPrompt {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub versions: Vec<TbVersion>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// 保留未知字段（源侧的 `variables` 等），见模块头注释。
    #[serde(flatten, default)]
    pub extra: Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TbMcpServer {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub origin: Option<TbOrigin>,
    #[serde(default)]
    pub versions: Vec<TbVersion>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten, default)]
    pub extra: Map<String, serde_json::Value>,
}

/// 列表页一行的技能摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TbSkillMeta {
    pub dir_name: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// 目录内所有文件字节数合计
    pub bytes: u64,
    pub file_count: usize,
    /// 目录内最新修改时间（ISO8601 UTC）
    pub updated_at: String,
    #[serde(default)]
    pub origin: Option<TbOrigin>,
    #[serde(default)]
    pub versions: usize,
}

/// 打开一个技能：frontmatter 与正文都按**原文**给出。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TbSkillDoc {
    pub meta: TbSkillMeta,
    /// frontmatter 原文（不含首尾 `---` 行；没有 frontmatter 时为空串）
    pub frontmatter: String,
    /// 正文（frontmatter 之后的部分）
    pub body: String,
    pub path: String,
    #[serde(default)]
    pub version_list: Vec<TbVersion>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TbSkillSave {
    pub dir_name: String,
    #[serde(default)]
    pub frontmatter: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub publish: bool,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbRoots {
    pub root: String,
    pub skills: String,
    pub prompts: String,
    pub mcp: String,
}

/// 收集 / 分发的一次结果汇总。
///
/// 逐项结果是 **(name, code, detail)** 而不是成句的中文：界面要按语言渲染，
/// 后端给编码，前端查 `toolbox.reason.<code>`；`detail` 只放系统原文（如
/// "拒绝访问"），它本来就无法翻译。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TbTransferResult {
    pub applied: Vec<String>,
    pub skipped: Vec<TbTransferItem>,
    pub errors: Vec<TbTransferItem>,
    /// 写入前生成的备份路径（安全边界的证据，界面要展示给用户）
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbTransferItem {
    pub name: String,
    pub code: String,
    pub detail: String,
}

/// 探测过程中的说明项（同样是编码，界面查 `toolbox.note.<code>`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbNote {
    pub code: String,
    pub path: String,
}

/// 一个外部工具的现状（探测结果）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbHarnessReport {
    pub id: String,
    pub name: String,
    pub supports_mcp: bool,
    pub supports_skills: bool,
    pub config_path: String,
    pub exists: bool,
    pub mcp_servers: Vec<TbDetectedServer>,
    pub skills_dirs: Vec<String>,
    pub skills: Vec<TbDetectedSkill>,
    pub notes: Vec<TbNote>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbDetectedServer {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TbDetectedSkill {
    pub name: String,
    pub path: String,
    pub description: String,
}
