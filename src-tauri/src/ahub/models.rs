use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub v: u32,
    pub saved_at: String,
    #[serde(default)]
    pub note: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub harness: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 变量定义（正文里 {{name}} 的元数据）。旧文件没有这个字段 → 空数组，
    /// 正文无占位符时行为与之前完全一致。
    #[serde(default)]
    pub variables: Vec<crate::ahub::prompt_vars::PromptVariable>,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
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
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub targets: Vec<String>,
    /// 是否已完成 targets 的初始回填（一次性迁移标志，防止用户移除后被重新加回）
    #[serde(default)]
    pub targets_initialized: bool,
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_transport() -> String {
    "stdio".into()
}
fn default_version() -> String {
    "0.0.0".into()
}
fn default_status() -> String {
    "draft".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub dir_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub versions: u32,
    #[serde(default)]
    pub has_assets: bool,
    #[serde(default)]
    pub content_len: usize,
    #[serde(default)]
    pub origin: Option<Origin>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default = "default_status")]
    pub status: String,
    /// 安全审查结论（来自 [vet]；空 = 从未审查）
    #[serde(default)]
    pub vet_verdict: String,
    #[serde(default)]
    pub vet_critical: u32,
    #[serde(default)]
    pub vet_high: u32,
    #[serde(default)]
    pub vet_medium: u32,
    #[serde(default)]
    pub vet_checked_at: String,
    /// 待人工复审的问题条数（已减去被忽略的）
    #[serde(default)]
    pub vet_pending: u32,
    /// 被人工忽略的问题条数
    #[serde(default)]
    pub vet_ignored: u32,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub has_toml: bool,
    /// AI 摘要（来自 .hub.json；None = 尚无摘要，界面显示空态）
    #[serde(default)]
    pub summary: Option<SkillSummary>,
}

/// Skill document: metadata + parsed frontmatter + body (markdown after frontmatter)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDoc {
    pub meta: SkillMeta,
    pub frontmatter: BTreeMap<String, serde_json::Value>,
    pub body: String,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub data_dir: String,
    /// 环境统一存放根目录（一键安装的工具解压到 <env_root>/<tool-name>/）。空 = 未设置。
    #[serde(default)]
    pub env_root: String,
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub skill_source_dirs: Vec<String>,
    /// 用户自定义的 harness 展示顺序（存 harness id）
    #[serde(default)]
    pub harness_order: Vec<String>,
    /// 【已废弃】旧的 OpenAI 兼容接口地址。只在首次迁移时读取，之后不再参与 AI 调用；
    /// 配置统一走 `ai_providers` / `ai_default_provider_id`（spec `legacy-migration`）。
    #[serde(default)]
    pub ai_base_url: String,
    /// 【已废弃】旧的 API Key。迁移时写入凭据管理器后不再读取；明文留在旧字段里不再使用。
    #[serde(default)]
    pub ai_api_key: String,
    /// 【已废弃】旧的模型名。迁移时带入提供商，之后不再读取。
    #[serde(default)]
    pub ai_model: String,
    /// 导入时自动生成 AI 摘要（默认关闭）
    #[serde(default)]
    pub auto_summary_on_import: bool,
    /// AI 提供商列表（元信息，不含 API key —— key 存系统凭据管理器）
    #[serde(default)]
    pub ai_providers: Vec<crate::ahub::aiprovider::AiProvider>,
    /// 默认提供商的 id；同一时刻只有一个默认
    #[serde(default)]
    pub ai_default_provider_id: String,
    /// 旧三字段是否已尝试过迁移（内部标记）。
    /// 旧字段按 spec 保留不删，所以需要这个标记来保证迁移「只执行一次」——
    /// 否则用户删光所有提供商后，旧配置会被再次迁回来。
    #[serde(default)]
    pub ai_legacy_migrated: bool,
}

fn default_lang() -> String {
    "zh".into()
}
fn default_theme() -> String {
    "dark".into()
}

/// 一条安全审查发现（持久化到 .hub.json，供「人工复审」界面逐条处置）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VetFindingRow {
    #[serde(default)]
    pub rule: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub line: usize,
    #[serde(default)]
    pub excerpt: String,
    /// 人工复审：已忽略该条
    #[serde(default)]
    pub ignored: bool,
    #[serde(default)]
    pub ignored_at: String,
}

/// 最近一次安全审查的完整快照（含逐条发现与人工复审痕迹）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VetReportRow {
    #[serde(default)]
    pub verdict: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub critical: u32,
    #[serde(default)]
    pub high: u32,
    #[serde(default)]
    pub medium: u32,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub checked_at: String,
    #[serde(default)]
    pub checked_by: String,
    #[serde(default)]
    pub findings: Vec<VetFindingRow>,
    /// 人工复核结论："" | approved | rejected（覆盖机器 verdict 的展示）
    #[serde(default)]
    pub review: String,
    #[serde(default)]
    pub reviewed_at: String,
    #[serde(default)]
    pub review_note: String,
}

/// AI 生成的技能摘要（skills-summary）。
///
/// 存于技能目录的 `.hub.json`；`domain` / `one_liner` / `kind` 由 AI 产出，
/// 规模统计与时间、模型由程序补齐（见 skillsummary.rs）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    /// 领域范围：一个词或短语
    #[serde(default)]
    pub domain: String,
    /// 一句话功能描述（≤40 字）
    #[serde(default)]
    pub one_liner: String,
    /// 定性：tool | reference | workflow | knowledge
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub script_count: usize,
    #[serde(default)]
    pub reference_count: usize,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub model: String,
}

/// .hub.json sidecar next to SKILL.md (hub metadata, does not pollute the standard)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHub {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub origin: Option<Origin>,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
    /// 最近一次审查的发现明细 + 人工复审状态（AgentHub 私有，不写入 SKILL.toml）
    #[serde(default)]
    pub vet_report: Option<VetReportRow>,
    /// AI 摘要：存在即避免重复调用 AI（spec summary-storage）
    #[serde(default)]
    pub summary: Option<SkillSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSavePayload {
    #[serde(default)]
    pub dir_name: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub frontmatter: BTreeMap<String, serde_json::Value>,
    /// true = 保存并发布：把落盘后的内容记一条版本快照。
    /// false（缺省）= 仅暂存：只写文件，时间轴不动。
    /// 与提示词 save_prompt 的 publish 同语义，避免「保存」与「发布」两套含义。
    #[serde(default)]
    pub publish: bool,
    /// 发布时的备注（写入版本节点）
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirs {
    pub root: String,
    pub prompts: String,
    pub mcp: String,
    pub skills: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInfo {
    pub settings: Settings,
    pub data_dirs: DataDirs,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub prompts: usize,
    pub mcp: usize,
    pub skills: usize,
    pub total_bytes: u64,
}

/// 批量接入协议 / 审查 的单技能结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardOutcome {
    pub dir_name: String,
    pub ok: bool,
    pub created_toml: bool,
    pub version: String,
    pub verdict: String,
    pub level: String,
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub error: String,
}

/// 批量接入协议 / 审查 的汇总
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardReport {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub created: usize,
    pub rejected: usize,
    pub review: usize,
    pub install: usize,
    pub outcomes: Vec<OnboardOutcome>,
}

/// 单个技能的打包结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOutcome {
    pub dir_name: String,
    pub name: String,
    pub version: String,
    pub ok: bool,
    /// 产物目录路径（成功时）
    pub path: String,
    /// 规范性警告（不阻断，但违反 SSEP 分发约定）
    pub warnings: Vec<String>,
    pub error: String,
}

/// 批量打包汇总
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackBatchReport {
    pub out_dir: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub warned: usize,
    /// 生成的仓库索引路径（out_dir/index.json）
    pub index_path: String,
    pub outcomes: Vec<PackOutcome>,
}

/// 技能目录树节点
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileNode {
    /// 相对技能根目录的路径（用 / 分隔）
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// 扩展名（小写，不含点）
    pub ext: String,
    /// 预览类别：markdown | text | code | image | pdf | word | other
    pub kind: String,
    #[serde(default)]
    pub children: Vec<SkillFileNode>,
}

/// 文本类文件的读取结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileContent {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: String,
    pub size: u64,
    /// 文本内容（kind 为文本类时）
    pub text: String,
    /// 二进制内容的 base64（kind 为 image/pdf 时，供前端内联展示）
    pub data_base64: String,
    /// 是否因过大而截断
    pub truncated: bool,
    /// 不可预览时的说明
    pub note: String,
}

// ---------------- CLI 环境中心 ----------------

/// 一个被发现的 CLI 工具。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCli {
    /// 命令名（不含扩展名）
    pub name: String,
    /// package-manager | path | known-root
    pub source: String,
    /// 更细的来源标识：npm / pnpm / pip / cargo / choco / PATH / 具体根目录
    pub source_detail: String,
    pub install_path: String,
    pub version: String,
    /// version-control | language | package-manager | container | build | cloud | ai-agent | productivity | other
    pub category: String,
    pub installed: bool,
}

/// 一个扫描来源的状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSource {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub count: usize,
    pub note: String,
}

/// 一次完整扫描的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliScanReport {
    pub tools: Vec<DiscoveredCli>,
    pub sources: Vec<ScanSource>,
    pub scanned_at: String,
}

/// 一个常用示例命令。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliExample {
    pub description: String,
    pub command: String,
}

/// 某个 CLI 的用途解释。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliExplain {
    pub name: String,
    pub description: String,
    pub examples: Vec<CliExample>,
    /// tldr-zh | tldr-en | probe | ""
    pub source: String,
    pub version: String,
    pub install_path: String,
    /// 探测超时（界面标「未响应」）
    pub timed_out: bool,
    pub note: String,
}

/// 变更计划里的一项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeAction {
    pub tool: String,
    pub file: String,
    /// 改哪一项（如 registry、[global] index-url）
    pub target: String,
    pub current: String,
    pub next: String,
    /// 目标文件原本不存在，写入即创建
    pub creates_file: bool,
}

/// 变更计划：只预览，不落盘。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePlan {
    pub actions: Vec<ChangeAction>,
    pub warnings: Vec<String>,
}

/// 一个工具的镜像现状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorTool {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub current: String,
    pub recommended: String,
    pub writable: bool,
    pub note: String,
    /// 最近一次备份路径（没有则为空）
    pub backup: String,
    /// 该工具是否安装在本机（未安装时只展示推荐值，不写入）
    pub installed: bool,
}

/// 单个工具的写入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub tool: String,
    pub ok: bool,
    pub backup: String,
    pub message: String,
    /// 写入后读回校验是否通过
    pub verified: bool,
}

/// 一键安装的结果（env-setup）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub tool: String,
    pub ok: bool,
    pub message: String,
    pub install_path: String,
    pub path_added: bool,
}
