import type { CaptureInput, ReadNote } from "./types";

export interface StoredDraft { revision: number; input: CaptureInput }
let database: Promise<IDBDatabase> | undefined;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nimbus-knowledge-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Draft database is blocked by another window")); };
  });
  return database;
}
function vaultKey(root: string) { return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
export function newCapture(): CaptureInput {
  return { id: crypto.randomUUID(), title: "", content: "", project: "", source: "", attachments: [] };
}
export async function loadDraft(root: string): Promise<StoredDraft | null> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("drafts").objectStore("drafts").get(vaultKey(root));
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}
/** Revision comparison happens in a single transaction, including across WebViews. */
export async function writeDraft(root: string, input: CaptureInput, revision: number): Promise<number> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    const store = transaction.objectStore("drafts");
    const request = store.get(vaultKey(root));
    let conflict = false;
    request.onsuccess = () => {
      const current = request.result as StoredDraft | undefined;
      if ((current?.revision ?? 0) !== revision) { conflict = true; transaction.abort(); return; }
      store.put({ revision: revision + 1, input }, vaultKey(root));
    };
    transaction.oncomplete = () => resolve(revision + 1);
    transaction.onabort = () => reject(new Error(conflict ? "DRAFT_CONFLICT" : transaction.error?.message ?? "Draft write failed"));
    transaction.onerror = () => reject(transaction.error);
  });
}

export interface NoteDraft { base: ReadNote; content: string }
const noteMemory = new Map<string, NoteDraft>();
const noteKey = (root: string, path: string) => `note:${vaultKey(root)}:${path.replace(/\\/g, "/")}`;

export async function loadNoteDraft(root: string, path: string): Promise<NoteDraft | null> {
  const key = noteKey(root, path);
  if (noteMemory.has(key)) return noteMemory.get(key)!;
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("drafts").objectStore("drafts").get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function writeNoteDraft(root: string, draft: NoteDraft): Promise<void> {
  const key = noteKey(root, draft.base.path);
  noteMemory.set(key, draft);
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put(draft, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** A completed save must not clear a newer edit from another mounted reader. */
export async function clearNoteDraft(root: string, draft: NoteDraft): Promise<void> {
  const key = noteKey(root, draft.base.path);
  const matches = (value: NoteDraft | undefined) => value?.base.fingerprint === draft.base.fingerprint && value.content === draft.content;
  if (matches(noteMemory.get(key))) noteMemory.delete(key);
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readwrite");
    const store = transaction.objectStore("drafts");
    const request = store.get(key);
    request.onsuccess = () => { if (matches(request.result)) store.delete(key); };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
