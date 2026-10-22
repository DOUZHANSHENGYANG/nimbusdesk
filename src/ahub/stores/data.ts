import { create } from "zustand";
import { api } from "@/ahub/lib/api";
import type { McpServer, Prompt, SkillMeta, SkillSavePayload } from "@/ahub/lib/types";

interface DataState {
  prompts: Prompt[];
  mcp: McpServer[];
  skills: SkillMeta[];
  loading: boolean;
  loadAll: () => Promise<void>;
  loadPrompts: () => Promise<void>;
  loadMcp: () => Promise<void>;
  loadSkills: () => Promise<void>;
  savePrompt: (p: Prompt, publish?: boolean) => Promise<Prompt>;
  deletePrompt: (id: string) => Promise<void>;
  saveMcp: (s: McpServer) => Promise<McpServer>;
  deleteMcp: (id: string) => Promise<void>;
  saveSkill: (payload: SkillSavePayload) => Promise<SkillMeta>;
  deleteSkill: (dirName: string) => Promise<void>;
}

export const useData = create<DataState>((set, get) => ({
  prompts: [],
  mcp: [],
  skills: [],
  loading: false,

  loadAll: async () => {
    set({ loading: true });
    await Promise.all([get().loadPrompts(), get().loadMcp(), get().loadSkills()]);
    set({ loading: false });
  },

  loadPrompts: async () => {
    try {
      set({ prompts: await api.listPrompts() });
    } catch {
      /* ignore */
    }
  },
  loadMcp: async () => {
    try {
      set({ mcp: await api.listMcp() });
    } catch {
      /* ignore */
    }
  },
  loadSkills: async () => {
    try {
      set({ skills: await api.listSkills() });
    } catch {
      /* ignore */
    }
  },

  savePrompt: async (p, publish = false) => {
    const saved = await api.savePrompt(p, publish);
    await get().loadPrompts();
    return saved;
  },
  deletePrompt: async (id) => {
    await api.deletePrompt(id);
    await get().loadPrompts();
  },

  saveMcp: async (s) => {
    const saved = await api.saveMcp(s);
    await get().loadMcp();
    return saved;
  },
  deleteMcp: async (id) => {
    await api.deleteMcp(id);
    await get().loadMcp();
  },

  saveSkill: async (payload) => {
    const meta = await api.saveSkill(payload);
    await get().loadSkills();
    return meta;
  },
  deleteSkill: async (dirName) => {
    await api.deleteSkill(dirName);
    await get().loadSkills();
  },
}));
