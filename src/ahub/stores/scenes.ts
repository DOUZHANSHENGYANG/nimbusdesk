import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/** 场景分三类：技能 / MCP / 提示词各管各的成员空间，互不干扰。 */
export type SceneKind = "skills" | "mcp" | "prompts";

export interface Scene {
  id: string;
  name: string;
  /** 成员 id：技能存 dirName，MCP / 提示词存各自的 id */
  members: string[];
}

const empty = (): Record<SceneKind, Scene[]> => ({ skills: [], mcp: [], prompts: [] });
const noActive = (): Record<SceneKind, string | null> => ({ skills: null, mcp: null, prompts: null });

interface ScenesState {
  scenes: Record<SceneKind, Scene[]>;
  active: Record<SceneKind, string | null>;
  create(kind: SceneKind, name: string, members: string[]): string;
  rename(kind: SceneKind, id: string, name: string): void;
  setMembers(kind: SceneKind, id: string, members: string[]): void;
  remove(kind: SceneKind, id: string): void;
  setActive(kind: SceneKind, id: string | null): void;
}

/**
 * 场景 = 一组技能 / MCP / 提示词的组合（"开发环境"、"论文写作环境"）。
 *
 * 语义刻意保持轻：选中场景只是**过滤视图**，不动磁盘、不往任何宿主部署。
 * 要带走就导出 zip，用户自己手动装——不引入"环境"、"项目"这类更重的概念。
 */
export const useScenes = create<ScenesState>()(
  persist(
    (set) => ({
      scenes: empty(),
      active: noActive(),
      create(kind, name, members) {
        const trimmed = name.trim();
        if (!trimmed) throw new Error("Enter a scene name");
        const scene: Scene = { id: crypto.randomUUID(), name: trimmed.slice(0, 60), members: [...new Set(members)] };
        set((state) => ({ scenes: { ...state.scenes, [kind]: [...state.scenes[kind], scene] } }));
        return scene.id;
      },
      rename(kind, id, name) {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          scenes: {
            ...state.scenes,
            [kind]: state.scenes[kind].map((scene) => (scene.id === id ? { ...scene, name: trimmed.slice(0, 60) } : scene)),
          },
        }));
      },
      setMembers(kind, id, members) {
        set((state) => ({
          scenes: {
            ...state.scenes,
            [kind]: state.scenes[kind].map((scene) => (scene.id === id ? { ...scene, members: [...new Set(members)] } : scene)),
          },
        }));
      },
      remove(kind, id) {
        set((state) => ({
          scenes: { ...state.scenes, [kind]: state.scenes[kind].filter((scene) => scene.id !== id) },
          active: { ...state.active, [kind]: state.active[kind] === id ? null : state.active[kind] },
        }));
      },
      setActive(kind, id) {
        set((state) => ({ active: { ...state.active, [kind]: state.active[kind] === id ? null : id } }));
      },
    }),
    {
      name: "scenes",
      version: 1,
      storage: createJSONStorage(() => tauriJsonStorage),
      partialize: (state) => ({ scenes: state.scenes, active: state.active }),
      merge: (saved, current) => {
        const data = (saved ?? {}) as Partial<ScenesState>;
        return {
          ...current,
          scenes: { ...empty(), ...(data.scenes ?? {}) },
          active: { ...noActive(), ...(data.active ?? {}) },
        };
      },
    },
  ),
);

/** 当前生效的场景（没选或成员被删空时返回 null）。 */
export function useActiveScene(kind: SceneKind): Scene | null {
  return useScenes((state) => {
    const id = state.active[kind];
    return id ? state.scenes[kind].find((scene) => scene.id === id) ?? null : null;
  });
}
