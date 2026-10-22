// Mirror of Rust models (serde camelCase)
export interface VersionEntry {
  v: number;
  savedAt: string;
  note: string;
  content: string;
}

export interface Origin {
  harness: string;
  file: string;
  importedAt: string;
}

/** 提示词变量类型：渲染时只影响控件与空值判定 */
export type PromptVarType = "text" | "textarea" | "select" | "number" | "boolean";

/** 一个变量的定义（正文里以 {{name}} 引用） */
export interface PromptVariable {
  name: string;
  type: PromptVarType;
  defaultValue: string;
  options: string[];
  required: boolean;
  placeholder: string;
  description: string;
}

export interface Prompt {
  id: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  /** 变量定义。旧数据没有该字段时为 undefined，按空数组处理 */
  variables?: PromptVariable[];
  versions: VersionEntry[];
  createdAt: string;
  updatedAt: string;
}

/** 正文解析对账结果 */
export interface PromptVarReconciled {
  /** 正文中出现的变量（已合并定义） */
  active: PromptVariable[];
  /** 只在定义里、正文已不引用 */
  unused: PromptVariable[];
}

/** 渲染结果 */
export interface PromptVarRendered {
  content: string;
  /** 必填但未给值的变量名 */
  missing: string[];
}

export interface McpServer {
  id: string;
  name: string;
  description: string;
  transport: string; // stdio | http | sse
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  tags: string[];
  enabled: boolean;
  targets: string[];
  targetsInitialized: boolean;
  origin: Origin | null;
  versions: VersionEntry[];
  createdAt: string;
  updatedAt: string;
}

/** MCP 连通性测试结果 */
export interface McpTestResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  /** 超时单独标记，界面显示「⏳ 超时」而不是「❌ 失败」 */
  timedOut: boolean;
}

export interface VetFindingRow {
  rule: string;
  severity: string;
  file: string;
  line: number;
  excerpt: string;
  /** 人工复审：已忽略该条 */
  ignored: boolean;
  ignoredAt: string;
}

export interface VetReportRow {
  verdict: string;
  level: string;
  critical: number;
  high: number;
  medium: number;
  contentHash: string;
  checkedAt: string;
  checkedBy: string;
  findings: VetFindingRow[];
  /** 人工复核结论："" | approved | rejected */
  review: string;
  reviewedAt: string;
  reviewNote: string;
}

export interface SkillMeta {
  name: string;
  dirName: string;
  description: string;
  tags: string[];
  versions: number;
  hasAssets: boolean;
  contentLen: number;
  origin: Origin | null;
  createdAt: string;
  updatedAt: string;
  version: string;
  status: "draft" | "active" | "deprecated" | "archived" | string;
  stale: boolean;
  hasToml: boolean;
  vetVerdict: string;
  vetCritical: number;
  vetHigh: number;
  vetMedium: number;
  vetCheckedAt: string;
  vetPending: number;
  vetIgnored: number;
  /** AI 摘要；null/undefined = 尚无摘要 */
  summary?: SkillSummary | null;
}

/** AI 生成的技能摘要（skills-summary） */
export interface SkillSummary {
  /** 领域范围：一个词或短语 */
  domain: string;
  /** 一句话功能描述（≤40 字） */
  oneLiner: string;
  /** 定性：tool | reference | workflow | knowledge */
  kind: string;
  scriptCount: number;
  referenceCount: number;
  generatedAt: string;
  model: string;
}

/** 批量生成摘要里单个技能的结果 */
export interface SkillSummaryBatchOutcome {
  dirName: string;
  ok: boolean;
  summary: SkillSummary | null;
  error: string;
}

// ---------------- Skills 预设（skill-presets） ----------------

/** 预设：命名的 skills 集合，引用技能目录名 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  /** 引用的技能目录名（`data_root()/skills/<dirName>`） */
  skillDirNames: string[];
  createdAt: string;
  updatedAt: string;
}

/** 导出时被跳过的失效成员 */
export interface SkippedMember {
  dirName: string;
  /** missing（技能目录不存在）| invalid（目录名非法） */
  reason: string;
}

/** 按预设导出的结果 */
export interface PresetExportOutcome {
  /** 生成的 zip 路径；全部成员失效时为空串 */
  zipPath: string;
  exported: string[];
  skipped: SkippedMember[];
}

/** `skill-summary-progress` 事件载荷 */
export interface SkillSummaryProgressEvent {
  dirName: string;
  current: number;
  total: number;
  ok: boolean;
  message: string;
}

export interface SkillDoc {
  meta: SkillMeta;
  frontmatter: Record<string, unknown>;
  body: string;
  versions: VersionEntry[];
}

export interface Settings {
  dataDir: string;
  /** 环境统一存放根目录（一键安装解压到 <envRoot>/<tool>/）。空 = 未设置 */
  envRoot: string;
  language: string;
  theme: string;
  skillSourceDirs: string[];
  harnessOrder: string[];
  /** 【已废弃】旧 OpenAI 兼容接口地址，只在首次迁移时读取 */
  aiBaseUrl: string;
  /** 【已废弃】旧 API Key，迁移进凭据管理器后不再读取 */
  aiApiKey: string;
  /** 【已废弃】旧模型名，迁移时带入提供商 */
  aiModel: string;
  /** 导入时自动生成 AI 摘要（默认关闭） */
  autoSummaryOnImport: boolean;
  /** AI 提供商列表（元信息，不含 key） */
  aiProviders: AiProvider[];
  /** 默认提供商 id */
  aiDefaultProviderId: string;
  /** 旧三字段是否已尝试过迁移（内部标记，保证只迁移一次） */
  aiLegacyMigrated: boolean;
}

/** 一个 AI 提供商（元信息；key 存系统凭据管理器） */
export interface AiProvider {
  id: string;
  name: string;
  /** 协议："openai" | "anthropic" */
  kind: string;
  /** 空 = 用厂商默认 */
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** 凭据管理器引用名（agenthub-ai-<id>） */
  credentialRef: string;
  /** masked key（只读展示，可能为空） */
  keyHint?: string;
}

/** 内置厂商预设 */
export interface AiProviderPreset {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  defaultModel: string;
}

/** 连通性测试结果 */
export interface AiProviderTestResult {
  ok: boolean;
  /** 技术细节（含厂商名与 HTTP 状态） */
  message: string;
  elapsedMs: number;
  model: string;
  /** HTTP 状态码，0 = 未拿到响应 */
  status: number;
  /** "ok" | "http" | "timeout" | "network" | "parse" */
  reason: string;
}

/** 测试时可覆盖已保存配置的草稿（无需先保存即可测试） */
export interface AiProviderDraft {
  kind: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface DataDirs {
  root: string;
  prompts: string;
  mcp: string;
  skills: string;
}

export interface SettingsInfo {
  settings: Settings;
  dataDirs: DataDirs;
}

export interface DetectedServer {
  name: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

export interface DetectedSkill {
  name: string;
  path: string;
  description: string;
}

export interface HarnessReport {
  id: string;
  name: string;
  supportsMcp: boolean;
  supportsSkills: boolean;
  configPath: string;
  exists: boolean;
  mcpServers: DetectedServer[];
  skillsDirs: string[];
  skills: DetectedSkill[];
  notes: string[];
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

export interface ApplyResult {
  applied: string[];
  warnings: string[];
  backups: string[];
  errors: string[];
}

export interface StorageStats {
  prompts: number;
  mcp: number;
  skills: number;
  totalBytes: number;
}

export interface SkillSavePayload {
  dirName: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, unknown>;
  level?: string;
  /** true = 保存并发布（写一条版本快照）；缺省 = 仅暂存 */
  publish?: boolean;
  /** 发布备注，写入版本节点 */
  note?: string;
}

export interface ImportSelection {
  name: string;
  overwrite: boolean;
}

export interface PreImportResult {
  newItems: string[];
  conflicts: string[];
}

export interface VaultVersion {
  v: number;
  savedAt: string;
  hash: string;
  size: number;
  kind: string; // manual | daily | auto | pre-restore
}

export interface VaultEntry {
  harness: string;
  name: string;
  path: string;
  versions: VaultVersion[];
}

export interface VaultIndex {
  watched: string[];
  daily: boolean;
  lastDaily: string;
  entries: VaultEntry[];
}

export interface VaultStatus {
  harness: string;
  name: string;
  path: string;
  exists: boolean;
  watched: boolean;
  versionCount: number;
  lastSavedAt: string;
  upToDate: boolean;
  currentHash: string;
}

/** 技能目录树节点 */
export interface SkillFileNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  ext: string;
  /** dir | markdown | text | code | image | pdf | word | sheet | archive | other */
  kind: string;
  children: SkillFileNode[];
}

/** 技能内文件内容（实时阅读） */
export interface SkillFileContent {
  path: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  text: string;
  dataBase64: string;
  truncated: boolean;
  note: string;
}

// ---------------- 腾讯 SkillHub 市场 ----------------

/** 市场里的一个技能 */
export interface MarketSkill {
  slug: string;
  namespace: string;
  /** 完整坐标，如 `@ake/dev-god` */
  coordinate: string;
  name: string;
  description: string;
  version: string;
  category: string;
  /** enterprise | community | clawhub */
  source: string;
  downloads: number;
  stars: number;
  iconUrl: string;
  verified: boolean;
  publisher: string;
}

export interface MarketPage {
  total: number;
  page: number;
  pageSize: number;
  skills: MarketSkill[];
}

export interface MarketCategory {
  key: string;
  name: string;
  nameEn: string;
}

/** 要安装的市场技能 */
export interface MarketInstallTarget {
  slug: string;
  namespace: string;
  version: string;
  name: string;
}

export interface MarketInstallReport {
  slug: string;
  name: string;
  version: string;
  dirName: string;
  ok: boolean;
  error: string;
}

// ---------------- AI 工具版本管理 ----------------

/** 一个 AI 工具的版本状态 */
export interface ToolVersion {
  id: string;
  name: string;
  /** npm 包名 */
  pkg: string;
  installed: boolean;
  current: string;
  /** registry 最新版（未检查时为空） */
  latest: string;
  hasUpdate: boolean;
  /** 装了但命令跑不起来 */
  broken: boolean;
  runnableNote: string;
}

export interface ToolList {
  tools: ToolVersion[];
  npmAvailable: boolean;
  npmNote: string;
}

/** 单个工具的更新结果 */
export interface ToolUpdateOutcome {
  id: string;
  name: string;
  ok: boolean;
  from: string;
  to: string;
  message: string;
}

/** 导入前的技能预览（尚未进中枢） */
export interface ImportPreview {
  name: string;
  description: string;
  /** SKILL.md 正文（已剥离 frontmatter） */
  body: string;
  /** frontmatter 原文 */
  frontmatter: string;
  files: { path: string; size: number }[];
  /** 中枢里已有同名技能 */
  existsInHub: boolean;
}

// ---------------- CLI 环境中心 ----------------

/** 一个被发现的 CLI 工具 */
export interface DiscoveredCli {
  name: string;
  /** package-manager | path | known-root */
  source: string;
  /** 更细的来源：npm / pnpm / pip / cargo / choco / PATH / 具体根目录（SDK 附带时带 |sdk 后缀） */
  sourceDetail: string;
  installPath: string;
  version: string;
  /** version-control | language | package-manager | container | build | cloud | ai-agent | productivity | other */
  category: string;
  installed: boolean;
}

export interface ScanSource {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  note: string;
}

export interface CliScanReport {
  tools: DiscoveredCli[];
  sources: ScanSource[];
  scannedAt: string;
}

/** 一键安装的结果 */
export interface InstallOutcome {
  tool: string;
  ok: boolean;
  message: string;
  installPath: string;
  pathAdded: boolean;
}

export interface CliExample {
  description: string;
  command: string;
}

export interface CliExplain {
  name: string;
  description: string;
  examples: CliExample[];
  /** tldr-zh | tldr-en | probe | "" */
  source: string;
  version: string;
  installPath: string;
  /** 探测超时（界面标「未响应」） */
  timedOut: boolean;
  note: string;
}

export interface ChangeAction {
  tool: string;
  file: string;
  target: string;
  current: string;
  next: string;
  createsFile: boolean;
}

export interface ChangePlan {
  actions: ChangeAction[];
  warnings: string[];
}

export interface MirrorTool {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  current: string;
  recommended: string;
  writable: boolean;
  note: string;
  /** 最近一次备份路径（没有则为空） */
  backup: string;
  /** 该工具是否安装在本机（未安装时只展示推荐值，不写入） */
  installed: boolean;
}

export interface ApplyOutcome {
  tool: string;
  ok: boolean;
  backup: string;
  message: string;
  verified: boolean;
}

export interface TldrStatus {
  ready: boolean;
  languages: string[];
  updatedAt: string;
}


// ---------------- Skills 批量导入（skills-import） ----------------

/** 程序修复记录：dir-rename | name-sync | md-case | name-normalize */
export interface FixRecord {
  kind: string;
  from: string;
  to: string;
}

/** 来源：url | local-path | manual | custom */
export interface SourceInfo {
  kind: string;
  value: string;
  /** high | low */
  confidence: string;
}

export interface CandidateSkill {
  /** 用户认得的原始目录绝对路径（修复只动暂存副本，这里不变），也是前端选择项的 key */
  originalPath: string;
  /** 暂存副本路径（所有修复都在这里执行，落库也用它）；空表示未暂存 */
  stagedPath: string;
  /** 探查时看到的原目录名 */
  originalName: string;
  /** 修复后应落盘的目录名 */
  fixedName: string;
  hasSkillMd: boolean;
  skillMdName: string;
  skillMdDescription: string;
  fixes: FixRecord[];
  /** 需要 AI 补全 description */
  needsAi: boolean;
  /** 程序无法修复时的原因 */
  problem: string;
  source: SourceInfo;
}

export interface UnrepairableItem {
  path: string;
  reason: string;
}

export interface ExploreReport {
  /** 暂存会话 id：向导关闭/取消时用它清理整个暂存根目录 */
  sessionId: string;
  root: string;
  candidates: CandidateSkill[];
  unrepairable: UnrepairableItem[];
}

export interface ImportOutcomeItem {
  path: string;
  dirName: string;
  name: string;
  ok: boolean;
  message: string;
  error: string;
  fixes: FixRecord[];
}

export interface ImportBatchReport {
  root: string;
  total: number;
  succeeded: number;
  failed: number;
  aborted: boolean;
  outcomes: ImportOutcomeItem[];
}

/** `import-progress` 事件载荷 */
export interface ImportProgressEvent {
  /** exploring | fixing | ai-fixing | source-detecting | importing | done | aborted */
  stage: string;
  current: number;
  total: number;
  path: string;
  message: string;
}