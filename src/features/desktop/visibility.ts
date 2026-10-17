// Ephemeral per-WebView intent survives paper/capsule React remounts. Restarting
// restores persisted open windows; hiding never changes that persisted choice.
const hidden = new Set<string>();
export function setDesktopVisibility(label: string, visible: boolean) {
  if (visible) hidden.delete(label); else hidden.add(label);
}
export const isDesktopVisible = (label: string) => !hidden.has(label);
