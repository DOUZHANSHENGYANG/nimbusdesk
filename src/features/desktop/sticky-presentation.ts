/** Logical pixels; ordinary window geometry is deliberately kept separate. */
export interface StickyAppearance {
  stickyColor?: string;
  tabWidth?: number;
  tabHeight?: number;
  previewWidth?: number;
  previewHeight?: number;
}

export const STICKY_LIMITS = {
  tabWidth: { min: 96, max: 280, fallback: 112 },
  tabHeight: { min: 40, max: 120, fallback: 44 },
  previewWidth: { min: 280, max: 900 },
  previewHeight: { min: 240, max: 1000 },
} as const;

export type StickyDimension = keyof typeof STICKY_LIMITS;

export function stickyColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

/** Invalid updates are ignored, while explicit undefined restores that setting. */
export function stickyAppearancePatch(value: unknown): Partial<StickyAppearance> {
  const patch: Partial<StickyAppearance> = {};
  if (!value || typeof value !== "object") return patch;
  const source = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(source, "stickyColor")) {
    const color = stickyColor(source.stickyColor);
    if (color || source.stickyColor === undefined) patch.stickyColor = color;
  }
  for (const key of Object.keys(STICKY_LIMITS) as StickyDimension[]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const number = source[key];
    if (number === undefined) patch[key] = undefined;
    else if (typeof number === "number" && Number.isFinite(number)) {
      const { min, max } = STICKY_LIMITS[key];
      patch[key] = Math.min(max, Math.max(min, Math.round(number)));
    }
  }
  return patch;
}

export function stickyAppearance(value: unknown): StickyAppearance & { tabWidth: number; tabHeight: number } {
  const patch = stickyAppearancePatch(value);
  // Optional resets must not erase normalized arrow defaults.
  return { ...patch, tabWidth: patch.tabWidth ?? 112, tabHeight: patch.tabHeight ?? 44 };
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

/** Inline opaque colors prevent hover/active utilities making the arrow transparent. */
export function stickyColorStyle(value: StickyAppearance): { backgroundColor?: string; color?: string; borderColor?: string } {
  const backgroundColor = stickyColor(value.stickyColor);
  if (!backgroundColor) return {};
  const light = luminance(backgroundColor);
  const color = (light + .05) / .05 >= 1.05 / (light + .05) ? "#000000" : "#ffffff";
  return { backgroundColor, color, borderColor: backgroundColor };
}
