export type ArchiveKind = "experience" | "recipe" | "resource";
export type NoteKind = ArchiveKind | "inbox" | "note";

export interface VaultInfo { root: string; name: string }
export interface CaptureAttachment { name: string; path: string; mime: string }
export interface AttachmentInput { name: string; mime: string; dataBase64: string }
export interface CaptureInput {
  id: string;
  title: string;
  content: string;
  project: string;
  source: string;
  attachments: AttachmentInput[];
}
export interface CaptureRecord {
  id: string;
  title: string;
  createdAt: number;
  project: string;
  source: string;
  status: "inbox" | "archived";
  attachments: CaptureAttachment[];
  notePath: string;
  archivedPath?: string;
}
export interface KnowledgeNote {
  organized?: boolean;
  frontmatter?: string;
  path: string;
  title: string;
  kind: NoteKind;
  modifiedAt: number;
  preview: string;
}
export interface ReadNote { path: string; content: string; fingerprint: string }
export interface UpdateNoteInput { path: string; content: string; fingerprint: string }
export interface ArchiveInput {
  ids: string[];
  title: string;
  kind: ArchiveKind;
  content: string;
  tags: string[];
  fingerprints: Record<string, string>;
}
export interface OrganizeSuggestion {
  title: string;
  kind: ArchiveKind;
  content: string;
  tags: string[];
}
export interface OrganizeInput extends OrganizeSuggestion {
  sources: {path:string;fingerprint:string}[];
}
