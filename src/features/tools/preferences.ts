import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { defaultOptions, toolIds, formats, codeLanguages, namingKinds, type ToolId, type ToolOptions } from "./core";

interface Preferences { options: Record<ToolId, ToolOptions>; update: (tool: ToolId, change: Partial<ToolOptions>) => void; reset: (tool: ToolId) => void }
const initial = () => Object.fromEntries(toolIds.map((tool) => [tool, { ...defaultOptions }])) as Record<ToolId, ToolOptions>;
function clean(value: unknown): ToolOptions {
  const result = { ...defaultOptions };
  if (!value || typeof value !== "object") return result;
  const data = value as Partial<ToolOptions>;
  if (data.format && Object.prototype.hasOwnProperty.call(formats, data.format)) result.format = data.format;
  if (data.mode && ["repair", "optimize", "explain"].includes(data.mode)) result.mode = data.mode;
  if (data.codeLanguage && codeLanguages.some((item) => item === data.codeLanguage)) result.codeLanguage = data.codeLanguage;
  if (data.namingKind && namingKinds.includes(data.namingKind)) result.namingKind = data.namingKind;
  if (data.translationStyle && ["natural", "technical", "literal"].includes(data.translationStyle)) result.translationStyle = data.translationStyle;
  for (const key of ["target", "sourceLanguage", "instruction"] as const) if (typeof data[key] === "string") result[key] = data[key].slice(0, key === "instruction" ? 4_000 : 100);
  return result;
}
export const useToolsPreferences = create<Preferences>()(persist((set) => ({
  options: initial(),
  update: (tool, change) => set((state) => ({ options: { ...state.options, [tool]: clean({ ...state.options[tool], ...change }) } })),
  reset: (tool) => set((state) => ({ options: { ...state.options, [tool]: { ...defaultOptions } } })),
}), {
  name: "tools-settings", version: 1, storage: createJSONStorage(() => tauriJsonStorage),
  partialize: (state) => ({ options: state.options }),
  merge: (persisted, current) => {
    const saved = persisted as { options?: Partial<Record<ToolId, unknown>> } | undefined;
    return { ...current, options: Object.fromEntries(toolIds.map((tool) => [tool, clean(saved?.options?.[tool])])) as Record<ToolId, ToolOptions> };
  },
}));
onStorageSynced((key) => { if (key === "tools-settings") void useToolsPreferences.persist.rehydrate(); });
