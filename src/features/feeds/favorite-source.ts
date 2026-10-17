import type { FavEntry } from "@/stores/favorites";
import type { SourceAdapter, SourceEntry } from "@/sources/types";

/** Older favorites may predate sourceName; recover their origin without rewriting them. */
export function favoriteSourceName(
  entry: Pick<FavEntry, "url" | "sourceName">,
  sources: SourceAdapter[],
  cache: Record<string, SourceEntry[]>,
): string {
  if (entry.sourceName?.trim()) return entry.sourceName.trim();
  const cached = sources.find(source => cache[source.id]?.some(item => item.url === entry.url));
  if (cached) return cached.name;
  try {
    const host = new URL(entry.url).hostname;
    const source = sources.find(item => {
      try { return new URL(item.homepage).hostname === host; } catch { return false; }
    });
    return source?.name ?? host;
  } catch {
    return "";
  }
}
