import { useEffect } from "react";
import { inTauri } from "@/lib/tauri";
import { useFiles } from "@/stores/files";
import { refreshMappedCategory } from "./directory-mapping";

export const DIRECTORY_MAPPING_INTERVAL_MS = 5_000;

/** Main-window owner. Failures keep cached content and remain visible in category status. */
export function startDirectoryMappingRuntime(): () => void {
  let stopped = false;
  let initialized = false;
  let mapped = new Map<string, string>();
  const refresh = (id: string) => { void refreshMappedCategory(id).catch(() => undefined); };
  const inspect = (all = false) => {
    if (stopped || !useFiles.persist.hasHydrated()) return;
    const next = new Map(useFiles.getState().categories.filter(category => category.syncDir && category.dir)
      .map(category => [category.id, category.dir!]));
    // Store writes during refresh may synchronously reenter the subscriber.
    const previous = mapped;
    mapped = next;
    const first = !initialized;
    initialized = true;
    for (const [id, root] of next) if (all || first || previous.get(id) !== root) refresh(id);
  };
  const unsubscribe = useFiles.subscribe(() => inspect());
  const unhydrate = useFiles.persist.onFinishHydration(() => inspect());
  const interval = setInterval(() => inspect(true), DIRECTORY_MAPPING_INTERVAL_MS);
  const focus = () => inspect(true);
  if (typeof window !== "undefined") window.addEventListener("focus", focus);
  inspect();
  return () => {
    stopped = true;
    clearInterval(interval);
    unsubscribe();
    unhydrate();
    if (typeof window !== "undefined") window.removeEventListener("focus", focus);
  };
}

export function DirectoryMappingRuntime() {
  useEffect(() => {
    if (!inTauri) return;
    return startDirectoryMappingRuntime();
  }, []);
  return null;
}
