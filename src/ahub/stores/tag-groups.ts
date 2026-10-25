import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import {
  addGroup as addGroupTo,
  assignTag,
  pruneGroups,
  removeGroup as removeGroupFrom,
  renameGroup as renameGroupIn,
  type TagGroup,
} from "@/ahub/lib/tag-groups";

interface TagGroupsState {
  groups: TagGroup[];
  create: (name: string) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  /** 给标签换组；传 null = 挪回「未分组」 */
  assign: (tag: string, groupId: string | null) => void;
  /** 数据变化后自愈：抹掉已经不存在的标签 */
  prune: (allTags: string[]) => void;
}

/**
 * 标签分组表。
 *
 * 标签本身还是技能/MCP/提示词上的字符串数组，这里只记「哪个标签归哪一组」——
 * 所以加分组不需要迁移任何旧数据，删分组也只是把标签放回「未分组」，不会丢标签。
 */
export const useTagGroups = create<TagGroupsState>()(
  persist(
    (set) => ({
      groups: [],
      create: (name) => {
        const id = crypto.randomUUID();
        set((state) => ({ groups: addGroupTo(state.groups, id, name.trim() || "新分组") }));
        return id;
      },
      rename: (id, name) => set((state) => ({ groups: renameGroupIn(state.groups, id, name) })),
      remove: (id) => set((state) => ({ groups: removeGroupFrom(state.groups, id) })),
      assign: (tag, groupId) => set((state) => ({ groups: assignTag(state.groups, tag, groupId) })),
      prune: (allTags) => set((state) => ({ groups: pruneGroups(state.groups, allTags) })),
    }),
    { name: "tag-groups", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
