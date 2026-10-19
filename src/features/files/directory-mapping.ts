import { create } from "zustand";
import { fileDirectorySnapshot, type DirectorySnapshot } from "@/lib/tauri";
import { directoryMappingEpoch, useFiles, type FileCategory } from "@/stores/files";
import { normalizedMappingPath } from "./directory-mapping-core";

export interface DirectoryMappingStatus {
  root?: string;
  busy: boolean;
  error?: string;
  lastSynced?: number;
  count?: number;
}

const idle: DirectoryMappingStatus = { busy: false };
export const useDirectoryMappingStatuses = create<{ statuses: Record<string, DirectoryMappingStatus> }>(() => ({ statuses: {} }));

export function useDirectoryMappingStatus(categoryId: string | null | undefined): DirectoryMappingStatus {
  return useDirectoryMappingStatuses(state => categoryId ? state.statuses[categoryId] ?? idle : idle);
}

function publish(id: string, status: DirectoryMappingStatus) {
  useDirectoryMappingStatuses.setState(state => ({ statuses: { ...state.statuses, [id]: status } }));
}

/** Root checks are insufficient for unmap -> remap of the same path (ABA). */
function stillCurrent(category: FileCategory, epoch: number): boolean {
  const current = useFiles.getState().categories.find(entry => entry.id === category.id);
  return Boolean(current?.syncDir && current.dir && category.dir
    && normalizedMappingPath(current.dir) === normalizedMappingPath(category.dir)
    && directoryMappingEpoch(category.id) === epoch);
}

/** Accept the snapshot already validated by the folder chooser without a second native scan. */
export function acceptMappedSnapshot(id: string, root: string, snapshot: DirectorySnapshot): boolean {
  if (!useFiles.getState().reconcileDirectory(id, root, snapshot)) return false;
  publish(id, { root, busy: false, lastSynced: Date.now(), count: snapshot.entries.length });
  return true;
}

let active = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<() => void> {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

const inflight = new Map<string, { root: string; epoch: number; promise: Promise<void> }>();

/** Manual and scheduled refresh share deduplication and a two-scan native budget. */
export function refreshMappedCategory(id: string): Promise<void> {
  const category = useFiles.getState().categories.find(entry => entry.id === id);
  if (!category?.syncDir || !category.dir) return Promise.resolve();
  const existing = inflight.get(id);
  const root = category.dir;
  const epoch = directoryMappingEpoch(id);
  if (existing && existing.epoch === epoch && normalizedMappingPath(existing.root) === normalizedMappingPath(root)) return existing.promise;
  const previous = useDirectoryMappingStatuses.getState().statuses[id];
  publish(id, { ...(previous?.root && normalizedMappingPath(previous.root) === normalizedMappingPath(root) ? previous : {}),
    root, busy: true, error: undefined });

  let promise!: Promise<void>;
  promise = (async () => {
    const release = await acquire();
    try {
      if (!stillCurrent(category, epoch)) return;
      const snapshot = await fileDirectorySnapshot(root);
      if (!stillCurrent(category, epoch)) return;
      acceptMappedSnapshot(id, root, snapshot);
    } catch (error) {
      // A stale failure must not replace the status of a newer mapping.
      if (!stillCurrent(category, epoch)) return;
      const message = error instanceof Error ? error.message : String(error);
      publish(id, { ...useDirectoryMappingStatuses.getState().statuses[id], root, busy: false, error: message });
      throw error;
    } finally {
      release();
      if (inflight.get(id)?.promise === promise) {
        inflight.delete(id);
        const status = useDirectoryMappingStatuses.getState().statuses[id];
        if (status?.busy) publish(id, { ...status, busy: false });
      }
    }
  })();
  inflight.set(id, { root, epoch, promise });
  return promise;
}
