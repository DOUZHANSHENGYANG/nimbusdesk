export interface SelectionSnapshot { text: string; source: string; error: string | null; revision: number }
/** Event subscription precedes snapshot fetch; a delayed fetch must not replace a newer capture. */
export function acceptSelection(current: SelectionSnapshot | null, incoming: SelectionSnapshot): boolean {
  return Number.isSafeInteger(incoming.revision) && incoming.revision >= 0
    && typeof incoming.text === "string" && incoming.text.length <= 32_768
    && ["uia", "manual"].includes(incoming.source)
    && (!current || incoming.revision > current.revision);
}
