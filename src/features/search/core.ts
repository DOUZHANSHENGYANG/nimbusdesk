import type { SearchSettingsValue, SearchHit, SearchHome, SearchScope } from "./types.ts";

export const DEFAULT_SEARCH_SETTINGS: SearchSettingsValue = { shortcut: "Ctrl+Alt+K", fileBackend: "auto", everythingInstance: "", everythingPath: "", everythingAutoStart: false, documentRoots: null, documentExcludes: [], documentIndexEnabled: true, pinyinEnabled: true, hideNoisyResults: true, nameRoots: null, nameIndexLimit: 250000 };
const paths = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((path): path is string => typeof path === "string").map(path => path.trim()).filter(Boolean))] : [];

/** A bad field cannot prevent the other stored fields from being restored. */
export function normalizeSearchSettings(value: unknown): SearchSettingsValue {
  const state = value && typeof value === "object" && "state" in value ? value.state : null;
  const data = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return {
    shortcut: typeof data.shortcut === "string" ? data.shortcut.trim() : DEFAULT_SEARCH_SETTINGS.shortcut,
    fileBackend: data.fileBackend === "everything" || data.fileBackend === "windows" ? data.fileBackend : "auto",
    everythingInstance: typeof data.everythingInstance === "string" ? data.everythingInstance.slice(0, 128) : "",
    everythingPath: typeof data.everythingPath === "string" ? data.everythingPath.trim() : "",
    everythingAutoStart: data.everythingAutoStart === true,
    documentRoots: Array.isArray(data.documentRoots) ? paths(data.documentRoots) : null,
    documentExcludes: paths(data.documentExcludes),
    documentIndexEnabled: data.documentIndexEnabled !== false,
    pinyinEnabled: data.pinyinEnabled !== false,
    hideNoisyResults: data.hideNoisyResults !== false,
    nameRoots: Array.isArray(data.nameRoots) ? paths(data.nameRoots) : null,
    nameIndexLimit: typeof data.nameIndexLimit === "number" && Number.isFinite(data.nameIndexLimit) ? Math.min(5000000, Math.max(10000, Math.floor(data.nameIndexLimit))) : 250000,
  };
}

export function searchHomeGroups(home: SearchHome, scope: SearchScope): SearchHome {
  const matches = (hit: SearchHit) => scope === "all" || (scope === "file" ? ["file", "folder"].includes(hit.kind) : hit.kind === scope);
  const pinned = home.pinned.filter(matches);
  const identities = new Set(pinned.map(searchHitIdentity));
  const recent = home.recent.filter(hit => matches(hit) && !identities.has(searchHitIdentity(hit)));
  return { pinned, recent };
}

export function searchHitIdentity(hit: SearchHit): string {
  if ((hit.kind !== "file" && hit.kind !== "folder") || !hit.path) return `id:${hit.id}`;
  let path = hit.path.replace(/\\/g, "/").toLocaleLowerCase();
  if (path.startsWith("//?/unc/")) path = `//${path.slice(8)}`;
  else if (path.startsWith("//?/")) path = path.slice(4);
  return `path:${path.replace(/\/$/, "")}`;
}
export function mergeSearchHits(...groups: SearchHit[][]): SearchHit[] {
  const results = new Map<string, SearchHit>();
  for (const hit of groups.flat()) {
    const key = searchHitIdentity(hit), previous = results.get(key);
    if (!previous) { results.set(key, hit); continue; }
    const best = hit.score > previous.score ? hit : previous;
    results.set(key, { ...best, snippet: best.snippet || previous.snippet || hit.snippet });
  }
  const executable = (hit: SearchHit) => hit.kind === "file" && /\.(exe|bat|cmd|ps1?|com)$/i.test(hit.path || hit.title);
  return [...results.values()].sort((a, b) => Number(b.kind === "app") - Number(a.kind === "app") || Number(executable(b)) - Number(executable(a)) || b.score - a.score);
}

/** Invalidate as soon as input changes, before the debounce timer fires. */
export function createRequestGate() {
  let revision = 0;
  return { invalidate: () => ++revision, current: (ticket: number) => ticket === revision };
}

export function moveSelection(current: number, count: number, direction: number) {
  return count ? (current + direction + count) % count : -1;
}
