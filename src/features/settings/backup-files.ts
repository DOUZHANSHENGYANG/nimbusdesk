/** Attachment material in a portable backup, separate from SQLite task metadata. */
export interface BackupAttachmentFile { path: string; dataBase64: string }
export const MAX_BACKUP_ATTACHMENT_BYTES = 128 * 1024 * 1024;

function stateOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = (value as { state?: unknown }).state ?? value;
  return state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : null;
}

function attachmentSizes(data: Record<string, unknown>): Map<string, number> {
  const paths = new Map<string, number>();
  for (const key of ["plans", "plans-archive"]) {
    const days = stateOf(data[key])?.days;
    if (!days || typeof days !== "object" || Array.isArray(days)) continue;
    for (const day of Object.values(days)) {
      const tasks = Array.isArray(day) ? day : stateOf(day)?.tasks;
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        const attachments = task?.attachments;
        if (attachments == null) continue;
        if (!Array.isArray(attachments)) throw new Error("invalid-task-attachments");
        for (const item of attachments) {
          if (!item || typeof item.path !== "string" || !/^modules\/plans\/tasks\/[^/\\:]+\/attachments\/[^/\\:]+\/[^/\\:]+$/.test(item.path)
            || item.path.split("/").some((part: string) => part === "." || part === "..")
            || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 64 * 1024 * 1024) throw new Error("invalid-task-attachment");
          if (paths.has(item.path) && paths.get(item.path) !== item.size) throw new Error("conflicting-attachment-size");
          paths.set(item.path, item.size);
        }
      }
    }
  }
  if ([...paths.values()].reduce((sum, size) => sum + size, 0) > MAX_BACKUP_ATTACHMENT_BYTES) throw new Error("backup-attachments-too-large");
  return paths;
}

export function collectAttachmentPaths(data: Record<string, unknown>): string[] {
  return [...attachmentSizes(data).keys()];
}

/** Reject incomplete backups before any task metadata can be restored. */
export function validateAttachmentFiles(data: Record<string, unknown>, value: unknown): BackupAttachmentFile[] {
  const expected = attachmentSizes(data);
  if (value != null && !Array.isArray(value)) throw new Error("invalid-backup-attachments");
  const files: BackupAttachmentFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of (value ?? []) as BackupAttachmentFile[]) {
    if (!file || typeof file.path !== "string" || typeof file.dataBase64 !== "string" || seen.has(file.path) || !expected.has(file.path)) throw new Error("invalid-backup-attachment");
    const encoded = file.dataBase64;
    if (encoded.length > Math.ceil(MAX_BACKUP_ATTACHMENT_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("invalid-attachment-base64");
    const size = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    bytes += size;
    if (size !== expected.get(file.path)) throw new Error("attachment-size-mismatch");
    if (bytes > MAX_BACKUP_ATTACHMENT_BYTES) throw new Error("backup-attachments-too-large");
    seen.add(file.path);
    files.push({ path: file.path, dataBase64: encoded });
  }
  if (seen.size !== expected.size) throw new Error("backup-attachment-missing");
  return files;
}
