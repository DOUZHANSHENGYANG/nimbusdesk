import { invoke } from "@tauri-apps/api/core";
import type { ArchiveInput, CaptureInput, CaptureRecord, KnowledgeNote, ReadNote, UpdateNoteInput, VaultInfo, OrganizeInput } from "./types";
import { getKnowledgeFolders } from "./store";
import type { KnowledgeFolders } from "./folders";

export const bindVault = (root: string) => invoke<VaultInfo>("knowledge_bind", { root });
export const listCaptures = (root: string) => invoke<CaptureRecord[]>("knowledge_captures", { root });
export const scanNotes = (root: string, folders: KnowledgeFolders = getKnowledgeFolders(root)) => invoke<KnowledgeNote[]>("knowledge_scan", { root, folders });
export const listTemplates = (root: string) => invoke<KnowledgeNote[]>("knowledge_templates", { root });
export const searchNotes = (root: string, query: string) => invoke<KnowledgeNote[]>("knowledge_search", { root, query, folders: getKnowledgeFolders(root) });
export const readNote = (root: string, path: string) => invoke<ReadNote>("knowledge_read", { root, path });
export const updateNote = (root: string, input: UpdateNoteInput) => invoke<ReadNote>("knowledge_update", { root, input });
export const saveCapture = (root: string, input: CaptureInput) => invoke<CaptureRecord>("knowledge_capture", { root, input });
export const archiveCaptures = (root: string, input: ArchiveInput) => invoke<KnowledgeNote>("knowledge_archive", { root, input, folders: getKnowledgeFolders(root) });
export const organizeNotes = (root: string, input: OrganizeInput, folders: KnowledgeFolders = getKnowledgeFolders(root)) => invoke<KnowledgeNote>("knowledge_organize", { root, input, folders });
export const validateKnowledgeFolders = (root: string, folders: KnowledgeFolders) => invoke<KnowledgeFolders>("knowledge_validate_folders", { root, folders });
export const imageData = (root: string, path: string) => invoke<string>("knowledge_image", { root, path });
export const openCaptureWindow = () => invoke<void>("open_capture");
export const setCaptureShortcut = (shortcut: string) => invoke<void>("set_capture_shortcut", { shortcut });
