import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

export type NotificationSource =
  | "skill"
  | "schedule"
  | "storage"
  | "files"
  | "ai"
  | "knowledge"
  | "system";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface AppNotification {
  id: string;
  source: NotificationSource;
  level: NotificationLevel;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  read: boolean;
  /** 同 dedupeKey 的通知合并成一条，这里记出现次数。 */
  count: number;
  dedupeKey?: string;
  route?: string;
}

export interface NotificationInput {
  source: NotificationSource;
  level: NotificationLevel;
  title: string;
  body?: string;
  dedupeKey?: string;
  route?: string;
}

interface NotificationsState {
  items: AppNotification[];
  /** 系统通知总开关；默认关闭，打开时由 UI 申请权限。 */
  systemEnabled: boolean;
  add: (input: NotificationInput) => AppNotification;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clearRead: () => void;
  clearAll: () => void;
  setSystemEnabled: (enabled: boolean) => void;
}

const MAX_ITEMS = 200;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const useNotifications = create<NotificationsState>()(
  persist(
    (set, get) => ({
      items: [],
      systemEnabled: false,
      add: (input) => {
        const now = Date.now();
        const current = get().items;
        const previous = input.dedupeKey
          ? current.find((item) => item.dedupeKey === input.dedupeKey)
          : undefined;
        const item: AppNotification = previous
          ? {
              ...previous,
              source: input.source,
              level: input.level,
              title: input.title,
              body: input.body ?? previous.body,
              route: input.route ?? previous.route,
              read: false,
              count: (previous.count || 1) + 1,
              updatedAt: now,
            }
          : {
              id: crypto.randomUUID(),
              source: input.source,
              level: input.level,
              title: input.title,
              body: input.body ?? "",
              createdAt: now,
              updatedAt: now,
              read: false,
              count: 1,
              dedupeKey: input.dedupeKey,
              route: input.route,
            };
        const pruned = [item, ...current.filter((entry) => entry.id !== item.id)]
          .filter((entry) => !entry.read || now - entry.updatedAt < MAX_AGE_MS)
          .slice(0, MAX_ITEMS);
        set({ items: pruned });
        return item;
      },
      markRead: (id) =>
        set((state) => ({
          items: state.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
        })),
      markAllRead: () =>
        set((state) => ({ items: state.items.map((item) => ({ ...item, read: true })) })),
      remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
      clearRead: () => set((state) => ({ items: state.items.filter((item) => !item.read) })),
      clearAll: () => set({ items: [] }),
      setSystemEnabled: (systemEnabled) => set({ systemEnabled }),
    }),
    {
      name: "notifications",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 1,
      partialize: (state) => ({ items: state.items, systemEnabled: state.systemEnabled }),
    },
  ),
);
