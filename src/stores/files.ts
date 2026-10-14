import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/* ── 文件条目库：files.json ───────────────────────────── */

export type ItemType = "folder" | "file" | "url";

export interface FileCategory {
  id: string;
  name: string;
  createdAt: number;
}

export interface FileItem {
  id: string;
  categoryId: string;
  type: ItemType;
  title: string;
  /** 本地路径或网址 */
  path: string;
  tags: string[];
  /** 网站图标 URL（favicon，可空 → 扩展名兜底图标） */
  iconUrl?: string;
  /** 描述（网站 SEO description 或手动备注） */
  note?: string;
  createdAt: number;
}

interface FilesState {
  categories: FileCategory[];
  items: FileItem[];
  addCategory: (name: string) => string;
  renameCategory: (id: string, name: string) => void;
  removeCategory: (id: string) => void;
  addItem: (item: Omit<FileItem, "id" | "createdAt">) => void;
  addItems: (items: Omit<FileItem, "id" | "createdAt">[]) => void;
  updateItem: (id: string, patch: Partial<Omit<FileItem, "id" | "createdAt">>) => void;
  removeItem: (id: string) => void;
  /** 栅栏内拖拽排序：把 dragged 移到 target 之前（同分类内） */
  reorderItem: (draggedId: string, targetId: string) => void;
}

function uid() {
  return crypto.randomUUID();
}

export const useFiles = create<FilesState>()(
  persist(
    (set, get) => ({
      categories: [],
      items: [],

      addCategory: (name) => {
        const clean = name.trim();
        // 同名防重：已存在（忽略大小写）直接返回既有 id
        const dup = get().categories.find((c) => c.name.toLowerCase() === clean.toLowerCase());
        if (dup) return dup.id;
        const id = uid();
        set((s) => ({
          categories: [...s.categories, { id, name: clean, createdAt: Date.now() }],
        }));
        return id;
      },

      renameCategory: (id, name) => {
        const clean = name.trim();
        if (!clean) return;
        const dup = get().categories.find(
          (c) => c.id !== id && c.name.toLowerCase() === clean.toLowerCase(),
        );
        if (dup) return;
        set((s) => ({
          categories: s.categories.map((c) => (c.id === id ? { ...c, name: clean } : c)),
        }));
      },

      removeCategory: (id) =>
        set((s) => ({
          categories: s.categories.filter((c) => c.id !== id),
          items: s.items.filter((i) => i.categoryId !== id),
        })),

      addItem: (item) => get().addItems([item]),

      addItems: (items) =>
        set((s) => {
          const existing = new Set(s.items.map((i) => `${i.categoryId}|${i.path}`));
          const fresh = items
            .filter((i) => !existing.has(`${i.categoryId}|${i.path}`))
            .map((i) => ({ ...i, id: uid(), createdAt: Date.now() }));
          if (fresh.length === 0) return s;
          return { items: [...s.items, ...fresh] };
        }),

      updateItem: (id, patch) =>
        set((s) => ({
          items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        })),

      removeItem: (id) =>
        set((s) => ({ items: s.items.filter((i) => i.id !== id) })),

      reorderItem: (draggedId, targetId) =>
        set((s) => {
          if (draggedId === targetId) return s;
          const items = [...s.items];
          const from = items.findIndex((i) => i.id === draggedId);
          const to = items.findIndex((i) => i.id === targetId);
          if (from < 0 || to < 0) return s;
          // 仅同分类内排序
          if (items[from].categoryId !== items[to].categoryId) return s;
          const [moved] = items.splice(from, 1);
          const idx = items.findIndex((i) => i.id === targetId);
          items.splice(idx, 0, moved);
          return { items };
        }),
    }),
    { name: "files", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);

/* ── 栅栏几何/开关：fences.json ───────────────────────── */

export interface FenceState {
  x: number;
  y: number;
  w: number;
  h: number;
  ghost: boolean;
  open: boolean;
  /** 置顶（覆盖 always-on-bottom） */
  pinned?: boolean;
  /** 内容缩放（Ctrl+滚轮，0.7–1.6） */
  scale?: number;
}

interface FencesStoreState {
  fences: Record<string, FenceState>;
  setGeometry: (categoryId: string, geo: { x: number; y: number; w: number; h: number }) => void;
  setGhost: (categoryId: string, ghost: boolean) => void;
  setOpen: (categoryId: string, open: boolean) => void;
  setPinned: (categoryId: string, pinned: boolean) => void;
  setScale: (categoryId: string, scale: number) => void;
}

export const DEFAULT_FENCE: FenceState = { x: 180, y: 160, w: 280, h: 340, ghost: true, open: false };

export const useFences = create<FencesStoreState>()(
  persist(
    (set) => ({
      fences: {},

      setGeometry: (categoryId, geo) =>
        set((s) => ({
          fences: {
            ...s.fences,
            [categoryId]: { ...(s.fences[categoryId] ?? DEFAULT_FENCE), ...geo },
          },
        })),

      setGhost: (categoryId, ghost) =>
        set((s) => ({
          fences: {
            ...s.fences,
            [categoryId]: { ...(s.fences[categoryId] ?? DEFAULT_FENCE), ghost },
          },
        })),

      setPinned: (categoryId, pinned) =>
        set((s) => ({
          fences: {
            ...s.fences,
            [categoryId]: { ...(s.fences[categoryId] ?? DEFAULT_FENCE), pinned },
          },
        })),

      setScale: (categoryId, scale) =>
        set((s) => ({
          fences: {
            ...s.fences,
            [categoryId]: { ...(s.fences[categoryId] ?? DEFAULT_FENCE), scale },
          },
        })),

      setOpen: (categoryId, open) =>
        set((s) => ({
          fences: {
            ...s.fences,
            [categoryId]: { ...(s.fences[categoryId] ?? DEFAULT_FENCE), open },
          },
        })),
    }),
    { name: "fences", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
