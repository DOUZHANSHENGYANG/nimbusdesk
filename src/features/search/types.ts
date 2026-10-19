export type SearchKind = "app" | "file" | "folder" | "plan" | "knowledge" | "feed" | "project" | "bookmark";
export type SearchScope = "all" | "app" | "file" | "plan" | "knowledge" | "feed" | "project";
export interface SearchHit { id: string; kind: SearchKind; title: string; subtitle: string; snippet: string; path?: string; url?: string; route?: string; score: number }
export interface SearchReply { results: SearchHit[]; total: number; indexing: boolean; warnings: string[]; elapsedMs: number }
export interface FileIndexStatus { running: boolean; paused: boolean; total: number; processed: number; indexed: number; failed: number; current: string | null; error: string | null; updatedAt: number | null; nameRunning?: boolean; nameTotal?: number; nameIndexed?: number }
export interface SearchStatus { count: number; indexing: boolean; lastIndexedAt: number | null; error?: string | null; everythingAvailable: boolean; backend: string; files?: FileIndexStatus; everythingPath?: string | null }
export interface EverythingStatus { path: string | null; running: boolean; ipcAvailable: boolean; indexReady: boolean | null; state: "absent" | "installed" | "running_without_ipc" | "indexing" | "ready" | "error"; error?: string | null }
export interface SearchSettingsValue { shortcut: string; fileBackend: "auto" | "everything" | "windows"; everythingInstance: string; everythingPath: string; everythingAutoStart: boolean; documentRoots: string[] | null; documentExcludes: string[]; documentIndexEnabled: boolean; pinyinEnabled: boolean; hideNoisyResults: boolean; nameRoots: string[] | null; nameIndexLimit: number }
export interface SearchHome { pinned: SearchHit[]; recent: SearchHit[] }
export interface SearchAppsStatus { count: number; indexing: boolean; lastIndexedAt: number | null; error: string | null }
export interface SearchPreview { kind: "text" | "image" | "unsupported"; text?: string; dataUrl?: string }
