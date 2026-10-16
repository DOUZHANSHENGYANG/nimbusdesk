import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/* ── 文件条目库：files.json ───────────────────────────── */

export type ItemType = "folder" | "file" | "url";

export interface FileCategory {
  id: string;
  name: string;
  createdAt: number;
  /** 绑定的真实磁盘目录：右键「新建文件/文件夹」在此目录中创建 */
  dir?: string;
  /** 父分类 id。单层子分类：有父的分类不能再有子分类（由 UI 保证） */
  parentId?: string;
  /** 最后修改时间 —— 仅供备份合并判断「同 id 谁更新」 */
  updatedAt?: number;
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
  /** 最后修改时间 —— 仅供备份合并判断「同 id 谁更新」 */
  updatedAt?: number;
}

interface FilesState {
  categories: FileCategory[];
  items: FileItem[];
  /** 新建分类；parentId 给定时建为子分类 */
  addCategory: (name: string, parentId?: string) => string;
  renameCategory: (id: string, name: string) => void;
  removeCategory: (id: string) => void;
  /** 把分类移到另一个父分类下（null = 提升为顶级） */
  setCategoryParent: (id: string, parentId: string | null) => void;
  /** 绑定/更换分类的真实磁盘目录（null = 解绑） */
  setCategoryDir: (id: string, dir: string | null) => void;
  addItem: (item: Omit<FileItem, "id" | "createdAt">) => void;
  addItems: (items: Omit<FileItem, "id" | "createdAt">[]) => void;
  updateItem: (id: string, patch: Partial<Omit<FileItem, "id" | "createdAt">>) => void;
  removeItem: (id: string) => void;
  /** 拖拽排序：把 itemId 移到 anchorId 之前（anchorId=null 表示移到自己分类末尾） */
  moveItemBefore: (itemId: string, anchorId: string | null) => void;
}

function uid() {
  return crypto.randomUUID();
}

export const useFiles = create<FilesState>()(
  persist(
    (set, get) => ({
      categories: [],
      items: [],

      addCategory: (name, parentId) => {
        const clean = name.trim();
        // 同名防重：同一层级内已存在（忽略大小写）直接返回既有 id
        const dup = get().categories.find(
          (c) =>
            c.name.toLowerCase() === clean.toLowerCase() &&
            (c.parentId ?? null) === (parentId ?? null),
        );
        if (dup) return dup.id;
        const id = uid();
        set((s) => ({
          categories: [
            ...s.categories,
            { id, name: clean, createdAt: Date.now(), updatedAt: Date.now(), parentId },
          ],
        }));
        return id;
      },

      renameCategory: (id, name) => {
        const clean = name.trim();
        if (!clean) return;
        // 同层级内防重
        const self = get().categories.find((c) => c.id === id);
        const dup = get().categories.find(
          (c) =>
            c.id !== id &&
            c.name.toLowerCase() === clean.toLowerCase() &&
            (c.parentId ?? null) === (self?.parentId ?? null),
        );
        if (dup) return;
        set((s) => ({
          categories: s.categories.map((c) =>
            c.id === id ? { ...c, name: clean, updatedAt: Date.now() } : c,
          ),
        }));
      },

      /**
       * 改父分类。单层约束：不能把有子分类的分类挂到别人下面，
       * 也不能挂到自己的子分类下（那会形成两级以上）。
       */
      setCategoryParent: (id, parentId) =>
        set((s) => {
          if (id === parentId) return s;
          if (parentId && s.categories.some((c) => c.parentId === id)) return s;
          if (parentId && s.categories.find((c) => c.id === parentId)?.parentId) return s;
          return {
            categories: s.categories.map((c) =>
              c.id === id
                ? { ...c, parentId: parentId ?? undefined, updatedAt: Date.now() }
                : c,
            ),
          };
        }),

      setCategoryDir: (id, dir) =>
        set((s) => ({
          categories: s.categories.map((c) =>
            c.id === id
              ? { ...c, dir: dir?.trim() || undefined, updatedAt: Date.now() }
              : c,
          ),
        })),

      // 删除分类时，其子分类一并删除（避免留下悬空的 parentId）
      removeCategory: (id) =>
        set((s) => {
          const kids = new Set(s.categories.filter((c) => c.parentId === id).map((c) => c.id));
          const gone = new Set([id, ...kids]);
          return {
            categories: s.categories.filter((c) => !gone.has(c.id)),
            items: s.items.filter((i) => !gone.has(i.categoryId)),
          };
        }),

      addItem: (item) => get().addItems([item]),

      addItems: (items) =>
        set((s) => {
          const existing = new Set(s.items.map((i) => `${i.categoryId}|${i.path}`));
          const now = Date.now();
          const fresh = items
            .filter((i) => !existing.has(`${i.categoryId}|${i.path}`))
            .map((i) => ({ ...i, id: uid(), createdAt: now, updatedAt: now }));
          if (fresh.length === 0) return s;
          return { items: [...s.items, ...fresh] };
        }),

      updateItem: (id, patch) =>
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i,
          ),
        })),


      removeItem: (id) =>
        set((s) => ({ items: s.items.filter((i) => i.id !== id) })),

      moveItemBefore: (itemId, anchorId) =>
        set((s) => {
          if (itemId === anchorId) return s;
          const moving = s.items.find((i) => i.id === itemId);
          if (!moving) return s;
          // 本分类条目序列内重排，再按原槽位回填（items 里各分类是交错的）
          const group = s.items.filter((i) => i.categoryId === moving.categoryId);
          const from = group.findIndex((i) => i.id === itemId);
          if (from < 0) return s;
          const [moved] = group.splice(from, 1);
          const at = anchorId === null ? group.length : group.findIndex((i) => i.id === anchorId);
          if (anchorId !== null && at < 0) return s;
          group.splice(at, 0, moved);
          let cursor = 0;
          const items = s.items.map((i) =>
            i.categoryId === moving.categoryId ? group[cursor++] : i,
          );
          return { items };
        }),
    }),
    {
      name: "files",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 2,
      /**
       * v1 → v2：补 `updatedAt`（备份合并要「同 id 比时间新者胜」）。
       *
       * 用 `createdAt` 兜底而不是 `Date.now()` —— 后者会让全部历史条目
       * 在同一次启动里「一起变新」，之后从备份恢复时把所有旧版本都判成过时。
       */
      migrate: (persisted, version) => {
        const state = persisted as
          | { categories?: { createdAt?: number; updatedAt?: number }[]; items?: { createdAt?: number; updatedAt?: number }[] }
          | undefined;
        if (!state || version >= 2) return persisted as never;
        const stamp = <T extends { createdAt?: number; updatedAt?: number }>(x: T): T =>
          x.updatedAt ? x : { ...x, updatedAt: x.createdAt ?? Date.now() };
        return {
          categories: (state.categories ?? []).map(stamp),
          items: (state.items ?? []).map(stamp),
        } as never;
      },
    },
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
