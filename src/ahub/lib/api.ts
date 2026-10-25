import { invoke } from "@tauri-apps/api/core";
import type { SkillFileNode } from "@/ahub/lib/types";
import type {
  ApplyResult,
  CliExplain,
  CliScanReport,
  DiscoveredCli,
  ChangePlan,
  HarnessReport,
  ImportResult,
  ImportSelection,
  PreImportResult,
  McpServer,
  McpTestResult,
  MirrorTool,
  ApplyOutcome,
  InstallOutcome,
  TldrStatus,
  Prompt,
  SettingsInfo,
  SkillDoc,
  SkillMeta,
  SkillSavePayload,
  StorageStats,
  ImportPreview,
  PromptVariable,
  PromptVarReconciled,
  PromptVarRendered,
  ToolList,
  ToolUpdateOutcome,
  VaultIndex,
  VaultStatus,
  VaultVersion,
  MarketCategory,
  MarketInstallReport,
  MarketInstallTarget,
  MarketPage,
  ExploreReport,
  CandidateSkill,
  SourceInfo,
  ImportBatchReport,
  SkillSummary,
  SkillSummaryBatchOutcome,
  Preset,
  PresetExportOutcome,
  McpPreset,
  AiProvider,
  AiProviderDraft,
  AiProviderPreset,
  AiProviderTestResult,
} from "./types";

export const api = {
  getSettings: () => invoke<SettingsInfo>("get_settings"),
  setDataDir: (path: string) => invoke<SettingsInfo>("ahub_set_data_dir", { path }),
  setPrefs: (language?: string, theme?: string) =>
    invoke<SettingsInfo>("set_prefs", { language, theme }),
  setHarnessOrder: (order: string[]) => invoke<SettingsInfo>("set_harness_order", { order }),
  addSkillSourceDir: (path: string) => invoke<SettingsInfo>("add_skill_source_dir", { path }),
  removeSkillSourceDir: (path: string) => invoke<SettingsInfo>("remove_skill_source_dir", { path }),

  listPrompts: () => invoke<Prompt[]>("list_prompts"),
  /** publish=true 时后端额外记一条版本；默认只暂存不记版本 */
  savePrompt: (prompt: Prompt, publish = false) =>
    invoke<Prompt>("save_prompt", { prompt, publish }),
  deletePrompt: (id: string) => invoke<void>("delete_prompt", { id }),

  listMcp: () => invoke<McpServer[]>("list_mcp"),
  saveMcp: (server: McpServer) => invoke<McpServer>("save_mcp", { server }),
  deleteMcp: (id: string) => invoke<void>("delete_mcp", { id }),
  exportMcpConfig: (ids: string[]) => invoke<unknown>("export_mcp_config", { ids }),
  testMcpConnectivity: (mcp: McpServer) => invoke<McpTestResult>("test_mcp_connectivity", { mcp }),
  aiSuggestTags: (name: string, description: string) => invoke<string[]>("ai_suggest_tags", { name, description }),

  // ── AI 提供商（ai-provider） ──
  aiProviderList: () => invoke<AiProvider[]>("ai_provider_list"),
  aiProviderPresets: () => invoke<AiProviderPreset[]>("ai_provider_presets"),
  aiProviderCreate: (name: string, kind: string, baseUrl: string, model: string, apiKey: string) =>
    invoke<AiProvider>("ai_provider_create", { name, kind, baseUrl, model, apiKey }),
  /** apiKey 传空串/undefined = 不修改已有凭据 */
  aiProviderUpdate: (
    id: string,
    patch: { name?: string; kind?: string; baseUrl?: string; model?: string; apiKey?: string },
  ) =>
    invoke<AiProvider>("ai_provider_update", {
      id,
      name: patch.name ?? null,
      kind: patch.kind ?? null,
      baseUrl: patch.baseUrl ?? null,
      model: patch.model ?? null,
      apiKey: patch.apiKey ?? null,
    }),
  aiProviderDelete: (id: string) => invoke<void>("ai_provider_delete", { id }),
  aiProviderSetDefault: (id: string) => invoke<void>("ai_provider_set_default", { id }),
  aiProviderSetEnabled: (id: string, enabled: boolean) =>
    invoke<AiProvider>("ai_provider_set_enabled", { id, enabled }),
  /** 测试连接：`draft` 用表单当前值覆盖已保存配置，用户不必先保存 */
  aiProviderTest: (id: string, draft?: AiProviderDraft) =>
    invoke<AiProviderTestResult>("ai_provider_test", { id, draft: draft ?? null }),

  listSkills: () => invoke<SkillMeta[]>("list_skills"),
  readSkill: (dirName: string) => invoke<SkillDoc>("read_skill", { dirName }),
  saveSkill: (payload: SkillSavePayload) => invoke<SkillMeta>("save_skill", { payload }),
  deleteSkill: (dirName: string) => invoke<void>("delete_skill", { dirName }),
  clearSkillVersions: (dirName: string) => invoke<number>("clear_skill_versions", { dirName }),
  ensureSkillProtocol: (dirName: string) => invoke<{ created: boolean; version: string }>("ensure_skill_protocol", { dirName }),
  releaseSkillVersion: (dirName: string, level: string, note: string) =>
    invoke<{ version: string; snapshot: number }>("release_skill_version", { dirName, level, note }),
  importSkillFolder: (path: string, overwrite: boolean) =>
    invoke<SkillMeta>("import_skill_folder", { path, overwrite }),
  importSkillZip: (path: string, overwrite: boolean) =>
    invoke<SkillMeta>("import_skill_zip", { path, overwrite }),

  // ── Skills 批量导入（skills-import） ──
  /** 探查导入根目录（文件夹或 zip）：自身含 SKILL.md → 唯一候选，否则每个下一级子目录一个候选。
   *  `sessionId` 复用同一个暂存会话（合并多路径探查时传同一个 id） */
  skillImportExplore: (path: string, sessionId?: string) =>
    invoke<ExploreReport>("skill_import_explore", { path, sessionId: sessionId ?? null }),
  /** 执行程序修复（目录改名 / SKILL.md 大小写 / frontmatter name），只动暂存副本 */
  skillImportApplyFixes: (report: ExploreReport) =>
    invoke<ExploreReport>("skill_import_apply_fixes", { report }),
  /** 对单个候选调 AI 补全 description（写回暂存副本） */
  skillImportAiFix: (path: string, stagedPath?: string) =>
    invoke<CandidateSkill>("skill_import_ai_fix", { path, stagedPath: stagedPath ?? null }),
  /** 执行批量导入：修复 → AI → 来源 → 落库 → 写 SKILL.toml [source]；进度走 import-progress 事件。
   *  `overwrite` 为 true 时覆盖同名技能，false 则把冲突记为失败 */
  skillImportExecute: (
    root: string,
    selected: string[],
    staged: Record<string, string>,
    sources: Record<string, SourceInfo>,
    overwrite: boolean,
    sessionId: string,
    /** 本次导入是否生成 AI 摘要（缺省 = 跟随全局设置「导入时自动生成摘要」） */
    generateSummary?: boolean,
  ) =>
    invoke<ImportBatchReport>("skill_import_execute", {
      root,
      selected,
      staged,
      sources,
      overwrite,
      sessionId,
      generateSummary: generateSummary ?? null,
    }),
  /** 生成单个技能的 AI 摘要（写入 .hub.json） */
  skillGenerateSummary: (dirName: string) =>
    invoke<SkillSummary>("skill_generate_summary", { dirName }),
  /** 批量生成摘要：逐个串行，进度走 skill-summary-progress 事件 */
  skillGenerateSummaryBatch: (dirNames: string[]) =>
    invoke<SkillSummaryBatchOutcome[]>("skill_generate_summary_batch", { dirNames }),
  /** 「导入时自动生成摘要」全局开关 */
  setAutoSummaryOnImport: (enabled: boolean) =>
    invoke<SettingsInfo>("set_auto_summary_on_import", { enabled }),
  /** 用户选择终止：推一条 aborted 事件并清理解压出的临时目录 */
  skillImportAbort: (root: string, paths: string[]) =>
    invoke<number>("skill_import_abort", { root, paths }),
  /** 清理整个暂存会话目录（向导关闭/取消时调用），原目录不受影响 */
  skillImportCleanup: (sessionId: string) =>
    invoke<number>("skill_import_cleanup", { sessionId }),
  skillExtension: (dirName: string) =>
    invoke<{ doc: Record<string, unknown> | null; stale: boolean; treeHash: string; violations: { rule: string; severity: string; message: string }[]; hasToml: boolean }>("skill_extension", { dirName }),
  setSkillStatus: (dirName: string, status: string, supersededBy: string) =>
    invoke<SkillMeta>("set_skill_status", { dirName, status, supersededBy }),
  packSkill: (dirName: string, outDir: string) =>
    invoke<string>("pack_skill", { dirName, outDir }),
  onboardSkillsBatch: (dirNames: string[], onlyMissing: boolean, vet: boolean) =>
    invoke<{
      total: number;
      succeeded: number;
      failed: number;
      created: number;
      rejected: number;
      review: number;
      install: number;
      outcomes: {
        dirName: string;
        ok: boolean;
        createdToml: boolean;
        version: string;
        verdict: string;
        level: string;
        critical: number;
        high: number;
        medium: number;
        error: string;
      }[];
    }>("onboard_skills_batch", { dirNames, onlyMissing, vet }),
  seedSkillVersion: (dirName: string, note: string) => invoke<boolean>("seed_skill_version", { dirName, note }),
  packSkillsBatch: (dirNames: string[], outDir: string) =>
    invoke<{
      outDir: string;
      total: number;
      succeeded: number;
      failed: number;
      warned: number;
      indexPath: string;
      outcomes: {
        dirName: string;
        name: string;
        version: string;
        ok: boolean;
        path: string;
        warnings: string[];
        error: string;
      }[];
    }>("pack_skills_batch", { dirNames, outDir }),
  checkPackReady: (dirName: string) => invoke<string[]>("check_pack_ready", { dirName }),

  // ── Skills 预设（skill-presets） ──
  presetList: () => invoke<Preset[]>("preset_list"),
  presetCreate: (name: string, description: string, skillDirNames: string[]) =>
    invoke<Preset>("preset_create", { name, description, skillDirNames }),
  presetUpdate: (
    id: string,
    patch: { name?: string; description?: string; skillDirNames?: string[] },
  ) => invoke<Preset>("preset_update", { id, ...patch }),
  presetDelete: (id: string) => invoke<void>("preset_delete", { id }),
  presetExport: (id: string, targetDir: string) =>
    invoke<PresetExportOutcome>("preset_export", { id, targetDir }),

  // ── MCP 预设（mcp-presets） ──
  mcpPresetList: () => invoke<McpPreset[]>("mcp_preset_list"),
  mcpPresetCreate: (name: string, description: string, serverNames: string[]) =>
    invoke<McpPreset>("mcp_preset_create", { name, description, serverNames }),
  mcpPresetUpdate: (
    id: string,
    patch: { name?: string; description?: string; serverNames?: string[] },
  ) => invoke<McpPreset>("mcp_preset_update", { id, ...patch }),
  mcpPresetDelete: (id: string) => invoke<void>("mcp_preset_delete", { id }),

  readVetReport: (dirName: string) => invoke<import("@/ahub/lib/types").VetReportRow | null>("read_vet_report", { dirName }),
  reviewVetFinding: (dirName: string, rule: string, file: string, line: number, ignored: boolean) =>
    invoke<[number, number]>("review_vet_finding", { dirName, rule, file, line, ignored }),
  ignoreAllVetFindings: (dirName: string) => invoke<number>("ignore_all_vet_findings", { dirName }),
  setVetReview: (dirName: string, verdict: string, note: string) =>
    invoke<void>("set_vet_review", { dirName, verdict, note }),
  vetSkill: (dirName: string) =>
    invoke<{ verdict: string; level: string; critical: number; high: number; medium: number; findings: { rule: string; severity: string; file: string; line: number; excerpt: string }[]; contentHash: string; checkedAt: string; checkedBy: string }>("vet_skill", { dirName }),
  installSkillPack: (path: string, overwrite: boolean) =>
    invoke<{ name: string; version: string; verdict: string; warnings: string[]; path: string }>("install_skillpack", { path, overwrite }),
  parseSkillIndex: (path: string) =>
    invoke<{ base: string; entries: { name: string; version: string; hash: string; ref: string }[] }>("parse_skill_index", { path }),
  installFromIndex: (path: string, name: string, version: string, overwrite: boolean) =>
    invoke<{ name: string; version: string; verdict: string; warnings: string[]; path: string }>("install_from_index", { path, name, version, overwrite }),
  authStatus: () =>
    invoke<{ github: boolean; gitee: boolean; login: string; repoUrl: string }>("auth_status"),
  authGithubStart: () =>
    invoke<{ userCode: string; verificationUri: string; expiresIn: number; interval: number }>("auth_github_start"),
  authGithubPoll: (deviceCode: string) =>
    invoke<{ ok: boolean; login: string; provider: string; error: string }>("auth_github_poll", { deviceCode }),
  authSavePat: (provider: string, pat: string) =>
    invoke<{ ok: boolean; login: string }>("auth_save_pat", { provider, pat }),
  authLogout: () => invoke<void>("auth_logout"),
  authCreateRepo: (provider: string) => invoke<string>("auth_create_repo", { provider }),
  syncStatus: () =>
    invoke<{ initialized: boolean; hasRemote: boolean; remoteUrl: string; branch: string; dirtyFiles: string[]; lastCommit: string; ahead: number }>("sync_status"),
  syncSetRemote: (url: string) => invoke<void>("sync_set_remote", { url }),
  syncPush: (message: string, authed: boolean, provider: string) => invoke<string>("sync_push", { message, authed, provider }),
  syncPull: (authed: boolean, provider: string) => invoke<string>("sync_pull", { authed, provider }),
  gitFetchSkills: (url: string) =>
    invoke<{ tempDir: string; skills: { path: string; name: string; description: string }[] }>("git_fetch_skills", { url }),
  cleanupGitTemp: (path: string) => invoke<void>("cleanup_git_temp", { path }),
  // ---------------- 腾讯 SkillHub 市场 ----------------
  skillhubSearch: (p: { keyword: string; category: string; source: string; sort: string; page: number; pageSize: number }) =>
    invoke<MarketPage>("skillhub_search", {
      keyword: p.keyword,
      category: p.category,
      source: p.source,
      sort: p.sort,
      page: p.page,
      pageSize: p.pageSize,
    }),
  skillhubCategories: () => invoke<MarketCategory[]>("skillhub_categories"),
  skillhubInstall: (targets: MarketInstallTarget[], overwrite: boolean) =>
    invoke<MarketInstallReport[]>("skillhub_install", { targets, overwrite }),
  checkUpstream: (dirName: string) =>
    invoke<{ watched: boolean; mode: string; remote: string; remoteHead: string; lastHead: string; changed: boolean; note: string; checkedAt: string }>("check_upstream", { dirName }),
  updateSkillExt: (
    dirName: string,
    payload: {
      deps?: { name: string; semver: string; reason: string }[];
      runtime?: { requiresScripts: string; requiresNetwork: string; minProtocol: number; config: string };
      upstream?: { watch: boolean; mode: string; remote: string };
    },
  ) =>
    invoke<SkillMeta>("update_skill_ext", { dirName, ...payload }),

  scanHarnesses: () => invoke<HarnessReport[]>("scan_harnesses"),
  scanHarness: (harness: string) => invoke<HarnessReport>("scan_harness", { harness }),
  preImport: (harness: string, kind: string, names: string[]) =>
    invoke<PreImportResult>("pre_import", { harness, kind, names }),
  importFromHarness: (harness: string, kind: string, selections: ImportSelection[]) =>
    invoke<ImportResult>("import_from_harness", { harness, kind, selections }),
  applyToHarness: (harness: string, kind: string, names: string[]) =>
    invoke<ApplyResult>("apply_to_harness", { harness, kind, names }),
  removeFromHarness: (harness: string, kind: string, names: string[]) =>
    invoke<ApplyResult>("remove_from_harness", { harness, kind, names }),
  readHarnessConfig: (harness: string) =>
    invoke<{ path: string; text: string; exists: boolean; format: string }>("read_harness_config", { harness }),
  writeHarnessConfig: (harness: string, text: string) =>
    invoke<{ path: string; backup: string | null }>("write_harness_config", { harness, text }),
  mergeHarnessConfig: (harness: string, text: string, json: string) =>
    invoke<string>("merge_harness_config", { harness, text, json }),
  /** 预览尚未导入的技能目录 */
  previewSkillDir: (path: string) => invoke<ImportPreview>("preview_skill_dir", { path }),
  readImportFile: (path: string) => invoke<{ name: string; text: string }>("read_import_file", { path }),

  // 配置版本库
  vaultStatus: () => invoke<VaultStatus[]>("vault_status"),
  vaultIndex: () => invoke<VaultIndex>("vault_index"),
  vaultInstalledCount: () => invoke<number>("vault_installed_count"),
  vaultSetWatched: (watched: string[]) => invoke<VaultIndex>("vault_set_watched", { watched }),
  vaultSetDaily: (daily: boolean) => invoke<VaultIndex>("vault_set_daily", { daily }),
  vaultSnapshot: (harnesses: string[], kind: string) => invoke<VaultVersion[]>("vault_snapshot", { harnesses, kind }),
  vaultMaybeDaily: () => invoke<number>("vault_maybe_daily"),
  vaultReadVersion: (harness: string, v: number) => invoke<string>("vault_read_version", { harness, v }),
  vaultRestore: (harness: string, v: number) => invoke<string>("vault_restore", { harness, v }),
  vaultClear: (harnesses: string[]) => invoke<void>("vault_clear", { harnesses }),

  listSkillFiles: (dirName: string) =>
    invoke<{
      path: string;
      name: string;
      isDir: boolean;
      size: number;
      ext: string;
      kind: string;
      children: SkillFileNode[];
    }>("list_skill_files", { dirName }),
  readSkillFile: (dirName: string, relPath: string) =>
    invoke<{
      path: string;
      name: string;
      ext: string;
      kind: string;
      size: number;
      text: string;
      dataBase64: string;
      truncated: boolean;
      note: string;
    }>("read_skill_file", { dirName, relPath }),
  openPath: (path: string) => invoke<void>("ahub_open_path", { path }),
  openSkillFile: (dirName: string, relPath: string) => invoke<void>("open_skill_file", { dirName, relPath }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  storageStats: () => invoke<StorageStats>("storage_stats"),

  // ── 提示词变量 ──
  parsePromptVars: (content: string, defined: PromptVariable[], forEditor: boolean) =>
    invoke<PromptVarReconciled>("parse_prompt_vars", { content, defined, forEditor }),
  renderPromptVars: (content: string, defined: PromptVariable[], values: Record<string, string>) =>
    invoke<PromptVarRendered>("render_prompt_vars", { content, defined, values }),
  renamePromptVar: (content: string, from: string, to: string) =>
    invoke<string>("rename_prompt_var", { content, from, to }),
  removePromptVar: (content: string, name: string) => invoke<string>("remove_prompt_var", { content, name }),
  validatePromptVarName: (name: string, defined: PromptVariable[], current?: string) =>
    invoke<string | null>("validate_prompt_var_name", { name, defined, current: current ?? null }),

  // ── AI 工具版本管理 ──
  toolList: () => invoke<ToolList>("tool_list"),
  toolCheckLatest: () => invoke<ToolList>("tool_check_latest"),
  toolUpdate: (ids: string[]) => invoke<ToolUpdateOutcome[]>("tool_update", { ids }),

  // ── CLI 环境中心：扫描与用途解释 ──
  cliScan: () => invoke<CliScanReport>("cli_scan"),
  cliExplain: (name: string, installPath: string) =>
    invoke<CliExplain>("cli_explain", { name, installPath }),
  cliExplainVersions: (items: [string, string][]) =>
    invoke<Record<string, string>>("cli_explain_versions", { items }),
  cliTldrStatus: () => invoke<TldrStatus>("cli_tldr_status"),
  cliTldrEnsure: () => invoke<TldrStatus>("cli_tldr_ensure"),
  cliTldrClear: () => invoke<void>("cli_tldr_clear"),

  // ── CLI 环境中心：镜像配置 ──
  mirrorList: () => invoke<MirrorTool[]>("mirror_list"),
  mirrorPlan: (ids: string[]) => invoke<ChangePlan>("mirror_plan", { ids }),
  mirrorApply: (ids: string[]) => invoke<ApplyOutcome[]>("mirror_apply", { ids }),
  mirrorRollback: (id: string) => invoke<string>("mirror_rollback", { id }),

  // ── 环境设置与一键安装（env-setup） ──
  getEnvRoot: () => invoke<string>("get_env_root"),
  setEnvRoot: (path: string) => invoke<void>("set_env_root", { path }),
  installTool: (toolId: string, downloadUrl: string, toolName: string) =>
    invoke<InstallOutcome>("install_tool", { toolId, downloadUrl, toolName }),
  diskScan: () => invoke<DiscoveredCli[]>("disk_scan"),
  diskScanCached: () => invoke<DiscoveredCli[] | null>("disk_scan_cached"),
  restorePathBackup: () => invoke<string>("restore_path_backup"),
};

/** 读取剪贴板文本。失败返回 null（而不是空串），便于区分「空」与「读不到」。 */
export async function pasteText(): Promise<string | null> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
