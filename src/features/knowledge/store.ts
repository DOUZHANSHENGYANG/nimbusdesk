import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { DEFAULT_KNOWLEDGE_FOLDERS, foldersForVault, normalizeFolders, vaultKey, type KnowledgeFolders } from "./folders";
import { normalizeOrganizationPreferences, type OrganizationPreferences } from "./auto-organize";

interface KnowledgeSettings {
  vaultRoot: string | null;
  vaultName: string;
  shortcut: string;
  folderBindings: Record<string, KnowledgeFolders>;
  organization: OrganizationPreferences;
  setOrganization: (value: OrganizationPreferences) => void;
  setVault: (root: string, name: string) => void;
  setShortcut: (shortcut: string) => void;
  setFolders: (root: string, folders: KnowledgeFolders) => void;
}

export const useKnowledge = create<KnowledgeSettings>()(persist((set) => ({
  vaultRoot: null,
  vaultName: "",
  shortcut: "Ctrl+Alt+Space",
  folderBindings: {},
  organization: normalizeOrganizationPreferences(null),
  setOrganization: (value) => set({organization:normalizeOrganizationPreferences(value)}),
  setVault: (vaultRoot, vaultName) => set((state) => ({ vaultRoot, vaultName, folderBindings: { ...state.folderBindings, [vaultKey(vaultRoot)]: foldersForVault(state.folderBindings, vaultRoot) } })),
  setShortcut: (shortcut) => set({ shortcut }),
  setFolders: (root, folders) => set((state) => ({ folderBindings: { ...state.folderBindings, [vaultKey(root)]: normalizeFolders(folders) } })),
}), { name: "knowledge-settings", version: 1, storage: createJSONStorage(() => tauriJsonStorage),
  migrate: (persisted) => {
    const old = persisted as Partial<KnowledgeSettings>;
    const folderBindings = old.folderBindings ?? {};
    if (old.vaultRoot && !folderBindings[vaultKey(old.vaultRoot)]) folderBindings[vaultKey(old.vaultRoot)] = { ...DEFAULT_KNOWLEDGE_FOLDERS };
    return { ...old, folderBindings };
  },
}));

export function getKnowledgeFolders(root: string): KnowledgeFolders {
  return foldersForVault(useKnowledge.getState().folderBindings, root);
}

onStorageSynced((key, value) => {
  if (key !== "knowledge-settings" || !value || typeof value !== "object") return;
  const state = (value as { state?: Partial<KnowledgeSettings> }).state;
  if (!state) return;
  useKnowledge.setState({
    ...(state.vaultRoot === null || typeof state.vaultRoot === "string" ? { vaultRoot: state.vaultRoot } : {}),
    ...(typeof state.vaultName === "string" ? { vaultName: state.vaultName } : {}),
    ...(typeof state.shortcut === "string" ? { shortcut: state.shortcut } : {}),
    ...(state.folderBindings ? { folderBindings: state.folderBindings } : {}),
    ...(state.organization ? { organization: normalizeOrganizationPreferences(state.organization) } : {}),
  });
});
