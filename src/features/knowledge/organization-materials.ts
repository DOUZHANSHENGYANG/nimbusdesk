import type { OrganizeMaterial } from "./organize";
import type { CaptureRecord, KnowledgeNote, ReadNote } from "./types";

/** Reads selected managed sources without mutating captures or their ownership. */
export async function loadOrganizationMaterials(
  notes: KnowledgeNote[], captures: CaptureRecord[], paths: string[],
  read: (path: string) => Promise<ReadNote>, blockedPath?: string,
): Promise<OrganizeMaterial[]> {
  const selected = [...new Set(paths)].map((path) => {
    const note = notes.find((item) => item.path === path);
    if (!note || path === blockedPath) throw new Error("Selected material is unavailable or has unsaved edits.");
    return note;
  });
  return Promise.all(selected.map(async (source) => {
    const note = await read(source.path);
    const owned = captures.find((capture) => capture.notePath === source.path);
    if (owned) return { capture: owned, note };
    return {
      capture: { id: crypto.randomUUID(), title: source.title, createdAt: Date.now(), project: "", source: source.path, status: "inbox", attachments: [], notePath: source.path },
      note, origin: "note",
    };
  }));
}
