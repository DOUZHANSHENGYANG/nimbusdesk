import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import { readJson, writeJson, inTauri } from "@/lib/tauri";
import { DEFAULT_SEARCH_SETTINGS, normalizeSearchSettings } from "./core";
import { searchStatus, setSearchShortcut } from "./api";
import type { SearchSettingsValue, SearchStatus } from "./types";

interface State { settings: SearchSettingsValue; hydrated: boolean; error: string; status: SearchStatus | null }
export const useSearchStore = create<State>(() => ({ settings: DEFAULT_SEARCH_SETTINGS, hydrated: false, error: "", status: null }));
let hydration: Promise<void> | undefined;
let stored: unknown = null;

export function hydrateSearchSettings(): Promise<void> {
  if (useSearchStore.getState().hydrated) return Promise.resolve();
  if (hydration) return hydration;
  hydration = readJson<unknown>("search-settings").then(value => {
    stored = value;
    useSearchStore.setState({ settings: normalizeSearchSettings(value), hydrated: true, error: "" });
  }).catch(error => {
    useSearchStore.setState({ error: String(error) });
    throw error;
  }).finally(() => { hydration = undefined; });
  return hydration;
}

/** Explicit saves only: reading defaults never schedules a write. */
export async function saveSearchSettings(next: SearchSettingsValue) {
  await hydrateSearchSettings();
  const previous = useSearchStore.getState().settings;
  const normalized = normalizeSearchSettings({ state: next });
  const changed = normalized.shortcut !== previous.shortcut;
  if (changed) await setSearchShortcut(normalized.shortcut);
  try {
    const value = { state: normalized, version: 1 };
    const canonical = await writeJson("search-settings", value, { value: stored });
    stored = canonical ?? value;
    useSearchStore.setState({ settings: normalizeSearchSettings(stored), error: "" });
    if (inTauri) await emit("storage://changed", { key: "search-settings" }).catch(() => undefined);
  } catch (error) {
    if (changed) {
      try { await setSearchShortcut(previous.shortcut); }
      catch (rollback) { throw new Error(`${String(error)}; shortcut restore: ${String(rollback)}`); }
    }
    throw error;
  }
}

export async function updateSearchStatus() {
  const status = await searchStatus();
  useSearchStore.setState({ status });
  return status;
}
