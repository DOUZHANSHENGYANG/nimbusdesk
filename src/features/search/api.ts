import { invoke } from "@tauri-apps/api/core";
import type { EverythingStatus, SearchHit, SearchPreview, SearchReply, SearchScope, SearchStatus } from "./types";

export const searchQuery = (query: string, scope: SearchScope, includeFiles?: boolean) => invoke<SearchReply>("search_query", { query, scope, limit: 60, ...(includeFiles === undefined ? {} : { includeFiles }) });
export const searchStatus = () => invoke<SearchStatus>("search_status");
export const refreshSearch = () => invoke<void>("search_refresh");
export const openSearchWindow = () => invoke<void>("search_open_window");
export const setSearchShortcut = (shortcut: string) => invoke<void>("search_set_shortcut", { shortcut });
export const openSearchResult = (result: SearchHit, action: "open" | "reveal" = "open") => invoke<void>("search_open_result", { result, action });
export const previewSearchResult = (path: string) => invoke<SearchPreview>("search_preview", { path });
export const searchDocumentDefaults = () => invoke<string[]>("search_document_defaults");
export const pauseSearchIndex = (paused: boolean) => invoke<void>("search_index_pause", { paused });
export const detectEverything = (path?: string, instance?: string) => invoke<EverythingStatus>("search_everything_detect", { path, instance });
export const startEverything = (path?: string, instance?: string) => invoke<EverythingStatus>("search_everything_start", { path, instance });
