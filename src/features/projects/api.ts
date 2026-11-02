import { invoke } from "@tauri-apps/api/core";

export interface ProjectFile { name: string; path: string; directory: boolean; size: number }export interface ProjectDocument { kind: "text" | "markdown" | "image" | "external"; content: string | null; dataUrl: string | null }
export const createProjectRoot = (projectId: string) => invoke<string>("project_create_root", { projectId });export const listProjectFiles = (projectId: string, path = "") => invoke<ProjectFile[]>("project_list_files", { projectId, path });
export const readProjectFile = (projectId: string, path: string) => invoke<ProjectDocument>("project_read_file", { projectId, path });
export const writeProjectText = (projectId: string, path: string, expected: string, content: string) => invoke<void>("project_write_text", { projectId, path, expected, content });
export const createProjectEntry = (projectId: string, path: string, name: string, kind: "folder" | "text" | "markdown") => invoke<string>("project_create_entry", { projectId, path, name, kind });
export const moveProjectFile = (projectId: string, path: string, destination: string) => invoke<string>("project_transfer_file", { projectId, path, destination });
export const importProjectFile = (projectId: string, source: string, path = "", moveSource = false) => invoke<string>("project_import_file", { projectId, source, path, moveSource });
export const trashProjectFile = (projectId: string, path: string) => invoke<void>("project_trash_file", { projectId, path });
export const openProjectFile = (projectId: string, path = "") => invoke<void>("project_open_file", { projectId, path });

/** 本地 git 仓库的只读状态；错误按 kind 分类（notFound / noGit / notRepo / failed） */
export interface GitRepoError { kind: "notFound" | "noGit" | "notRepo" | "failed"; message: string }
export interface GitRepoStatus {
  path: string; name: string; branch: string; dirty: boolean; changed: number;
  commit: { short: string; subject: string; date: string } | null;
}
export const gitRepoStatus = (path: string) => invoke<GitRepoStatus>("git_repo_status", { path });
