import { invoke } from "@tauri-apps/api/core";

/** 工具箱落盘模型。字段与 Rust 侧 `agenthub::models` 一一对应（camelCase）。 */

export interface TbVersion {
  v: number;
  savedAt: string;
  note: string;
  content: string;
}

export interface TbOrigin {
  harness: string;
  file: string;
  importedAt: string;
}

export interface TbPrompt {
  id: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  versions: TbVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface TbMcpServer {
  id: string;
  name: string;
  description: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  tags: string[];
  enabled: boolean;
  origin: TbOrigin | null;
  versions: TbVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface TbSkillMeta {
  dirName: string;
  name: string;
  description: string;
  tags: string[];
  bytes: number;
  fileCount: number;
  updatedAt: string;
  origin: TbOrigin | null;
  versions: number;
}

export interface TbSkillDoc {
  meta: TbSkillMeta;
  /** frontmatter 原文（不含首尾 `---` 行） */
  frontmatter: string;
  body: string;
  path: string;
  versionList: TbVersion[];
}

export interface TbRoots {
  root: string;
  skills: string;
  prompts: string;
  mcp: string;
}

export interface TbTransferItem {
  name: string;
  code: string;
  detail: string;
}

export interface TbTransferResult {
  applied: string[];
  skipped: TbTransferItem[];
  errors: TbTransferItem[];
  backups: string[];
}

export interface TbNote {
  code: string;
  path: string;
}

export interface TbDetectedServer {
  name: string;
  transport: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

export interface TbDetectedSkill {
  name: string;
  path: string;
  description: string;
}

export interface TbHarnessReport {
  id: string;
  name: string;
  supportsMcp: boolean;
  supportsSkills: boolean;
  configPath: string;
  exists: boolean;
  mcpServers: TbDetectedServer[];
  skillsDirs: string[];
  skills: TbDetectedSkill[];
  notes: TbNote[];
}

export const tbRoot = () => invoke<TbRoots>("tb_root");
export const tbRootReveal = () => invoke<void>("tb_root_reveal");

export const tbSkillList = () => invoke<TbSkillMeta[]>("tb_skill_list");
export const tbSkillRead = (dirName: string) => invoke<TbSkillDoc>("tb_skill_read", { dirName });
export const tbSkillSave = (input: {
  dirName: string;
  frontmatter: string;
  body: string;
  tags: string[];
  publish: boolean;
  note: string;
}) => invoke<TbSkillMeta>("tb_skill_save", input);
export const tbSkillCreate = (name: string, description: string) =>
  invoke<TbSkillMeta>("tb_skill_create", { name, description });
export const tbSkillDelete = (dirName: string) => invoke<void>("tb_skill_delete", { dirName });
export const tbSkillImport = (path: string) => invoke<TbSkillMeta>("tb_skill_import", { path });
export const tbSkillReveal = (dirName: string) => invoke<void>("tb_skill_reveal", { dirName });
export const tbSkillRestore = (dirName: string, v: number) =>
  invoke<TbSkillDoc>("tb_skill_restore", { dirName, v });

export const tbPromptList = () => invoke<TbPrompt[]>("tb_prompt_list");
export const tbPromptSave = (prompt: TbPrompt, publish: boolean) =>
  invoke<TbPrompt>("tb_prompt_save", { prompt, publish });
export const tbPromptDelete = (id: string) => invoke<void>("tb_prompt_delete", { id });
export const tbPromptRestore = (id: string, v: number) => invoke<TbPrompt>("tb_prompt_restore", { id, v });

export const tbMcpList = () => invoke<TbMcpServer[]>("tb_mcp_list");
export const tbMcpSave = (server: TbMcpServer) => invoke<TbMcpServer>("tb_mcp_save", { server });
export const tbMcpDelete = (id: string) => invoke<void>("tb_mcp_delete", { id });
export const tbMcpExport = (ids: string[]) => invoke<{ mcpServers: Record<string, unknown> }>("tb_mcp_export", { ids });

export const tbHarnessScan = () => invoke<TbHarnessReport[]>("tb_harness_scan");
export const tbHarnessCollect = (harness: string, kind: "mcp" | "skills", names: string[]) =>
  invoke<TbTransferResult>("tb_harness_collect", { harness, kind, names });
export const tbHarnessPush = (harness: string, kind: "mcp" | "skills", names: string[]) =>
  invoke<TbTransferResult>("tb_harness_push", { harness, kind, names });
export const tbHarnessRemove = (harness: string, kind: "mcp" | "skills", names: string[]) =>
  invoke<TbTransferResult>("tb_harness_remove", { harness, kind, names });
