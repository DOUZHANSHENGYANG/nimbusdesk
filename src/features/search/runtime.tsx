import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "@/lib/tauri";
import { refreshSearch } from "./api";
import { hydrateSearchSettings, updateSearchStatus, useSearchStore } from "./store";
import type { SearchStatus } from "./types";

let started = false;
/** Main-window only. Native startup owns shortcut restoration. */
export function SearchRuntime() {
  useEffect(() => {
    if (!inTauri) return;
    if (!started) {
      started = true;
      void hydrateSearchSettings().then(() => refreshSearch()).catch(error => useSearchStore.setState({ error: String(error) }));
    }
    void updateSearchStatus().catch(() => undefined);
    const subscription = listen<SearchStatus>("search://status", event => useSearchStore.setState({ status: event.payload }));
    return () => { void subscription.then(stop => stop()).catch(() => undefined); };
  }, []);
  return null;
}
