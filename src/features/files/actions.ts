import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useFiles, type FileItem } from "@/stores/files";
import { useModal } from "@/components/shell/modal-host";
import { copyText } from "@/lib/clipboard";
import {
  createEntry,
  deleteEntry,
  deleteEntries,
  openPath,
  openUrl,
  pickFolder,
  renameEntry,
  revealInExplorer,
} from "@/lib/tauri";
import { inTauri } from "@/lib/tauri";

/** Rust 侧错误码 → 可读文案（未命中则回落到原始字符串） */
const ERR_KEYS: Record<string, string> = {
  "empty-name": "files.err.emptyName",
  "invalid-name": "files.err.invalidName",
  "reserved-name": "files.err.reservedName",
  "already-exists": "files.err.alreadyExists",
  "not-found": "files.err.notFound",
  "parent-missing": "files.err.parentMissing",
  "unsupported-platform": "files.err.unsupported",
};

/**
 * 文件条目动作层：文件管理页与桌面栅栏共用同一套右键菜单行为，
 * 保证「重命名/删除同步磁盘」的语义在两处完全一致。
 */
export function useFileActions() {
  const { t } = useTranslation();
  const { confirm, prompt } = useModal();

  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const updateItem = useFiles((s) => s.updateItem);
  const removeItem = useFiles((s) => s.removeItem);
  const addItem = useFiles((s) => s.addItem);
  const setCategoryDir = useFiles((s) => s.setCategoryDir);

  const explain = useCallback(
    (e: unknown): string => {
      const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      const key = ERR_KEYS[raw.trim()];
      return key ? t(key) : raw;
    },
    [t],
  );

  const categoryOf = useCallback(
    (categoryId: string) => categories.find((c) => c.id === categoryId),
    [categories],
  );

  /* ── 打开 / 定位 / 复制 ─────────────────────────────── */

  const open = useCallback(
    async (item: FileItem) => {
      try {
        if (item.type === "url") await openUrl(item.path);
        else await openPath(item.path);
      } catch {
        toast.error(t("files.openErr"));
      }
    },
    [t],
  );

  const reveal = useCallback(
    async (item: FileItem) => {
      if (item.type === "url") {
        void copyText(item.path);
        toast.success(t("files.copied"));
        return;
      }
      try {
        await revealInExplorer(item.path);
      } catch (e) {
        toast.error(explain(e));
      }
    },
    [explain, t],
  );

  const copyPath = useCallback(
    async (item: FileItem) => {
      if (await copyText(item.path)) toast.success(t("files.copied"));
    },
    [t],
  );

  /* ── 新建（落到分类绑定目录，并同时登记为条目） ───────── */

  /** 分类未绑定目录时提示先绑定；返回可用的目标目录 */
  const ensureDir = useCallback(
    async (categoryId: string): Promise<string | null> => {
      const cat = categoryOf(categoryId);
      if (cat?.dir) return cat.dir;
      const ok = await confirm({
        title: t("files.bindDirTitle"),
        description: t("files.bindDirHint"),
        confirmText: t("files.bindDirPick"),
      });
      if (!ok) return null;
      const picked = await pickFolder();
      if (!picked) return null;
      setCategoryDir(categoryId, picked);
      return picked;
    },
    [categoryOf, confirm, setCategoryDir, t],
  );

  const create = useCallback(
    async (categoryId: string, kind: "folder" | "file", initialName?: string) => {
      if (!inTauri) return null;
      const dir = await ensureDir(categoryId);
      if (!dir) return null;

      // 默认名遵循 Windows 习惯；重名由 Rust 侧拒绝并提示
      const base =
        initialName?.trim() ||
        (kind === "folder" ? t("files.newFolderName") : t("files.newFileName"));
      const entered = initialName
        ? base
        : await prompt({
            title: kind === "folder" ? t("files.newFolder") : t("files.newFile"),
            initial: base,
          });
      if (entered === null) return null; // 用户取消
      const name = entered.trim() || base;

      try {
        const created = await createEntry(dir, name, kind);
        const fileName = created.split(/[\\/]/).filter(Boolean).pop() ?? name;
        // 同时登记为条目，栅栏/列表里立刻可见
        addItem({ categoryId, type: kind, title: fileName, path: created, tags: [] });
        toast.success(t("files.created", { name: fileName }));
        return created;
      } catch (e) {
        toast.error(explain(e));
        return null;
      }
    },
    [addItem, ensureDir, explain, prompt, t],
  );

  /* ── 重命名（同步磁盘 + 条目） ─────────────────────── */

  const rename = useCallback(
    async (item: FileItem, initialName?: string) => {
      if (item.type === "url") {
        const next = await prompt({ title: t("files.renameItem"), initial: item.title });
        if (next === null) return false;
        const clean = next.trim();
        if (!clean) return false;
        updateItem(item.id, { title: clean });
        return true;
      }
      if (!inTauri) return false;

      const current = item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.title;
      const next =
        initialName !== undefined
          ? initialName.trim()
          : (await prompt({ title: t("files.renameItem"), initial: current }))?.trim();
      if (!next) return false;
      if (next === current) return true;

      try {
        const newPath = await renameEntry(item.path, next);
        // 磁盘已改名 → 条目路径与标题同步（避免出现幽灵条目）
        updateItem(item.id, { path: newPath, title: next });
        toast.success(t("files.renamed"));
        return true;
      } catch (e) {
        toast.error(explain(e));
        return false;
      }
    },
    [explain, prompt, t, updateItem],
  );

  /* ── 删除（磁盘进回收站 + 移除条目） ───────────────── */

  const remove = useCallback(
    async (item: FileItem) => {
      const isUrl = item.type === "url";
      const ok = await confirm({
        title: isUrl ? t("files.removeItemConfirm") : t("files.deleteDiskConfirm"),
        description: isUrl ? item.title : `${item.title}\n${t("files.deleteDiskHint")}`,
        danger: true,
        confirmText: isUrl ? t("common.confirm") : t("files.deleteToRecycle"),
      });
      if (!ok) return;
      if (!isUrl && inTauri) {
        try {
          await deleteEntry(item.path);
        } catch (e) {
          // 磁盘上已不存在 → 只清理条目，不阻断
          const msg = typeof e === "string" ? e : String(e);
          if (msg !== "not-found") {
            toast.error(explain(e));
            return;
          }
        }
      }
      removeItem(item.id);
    },
    [confirm, explain, removeItem, t],
  );

  /** 批量删除：一次回收站操作，保证可整体撤销 */
  const removeMany = useCallback(
    async (targets: FileItem[]) => {
      if (!targets.length) return;
      const ok = await confirm({
        title: t("files.deleteDiskConfirm"),
        description: t("files.deleteCountHint", { count: targets.length }),
        danger: true,
        confirmText: t("files.deleteToRecycle"),
      });
      if (!ok) return;
      const local = targets.filter((i) => i.type !== "url").map((i) => i.path);
      if (local.length && inTauri) {
        try {
          await deleteEntries(local);
        } catch (e) {
          const msg = typeof e === "string" ? e : String(e);
          if (msg !== "not-found") {
            toast.error(explain(e));
            return;
          }
        }
      }
      for (const it of targets) removeItem(it.id);
    },
    [confirm, explain, removeItem, t],
  );

  /* ── 分类目录绑定 ─────────────────────────────────── */

  const bindDir = useCallback(
    async (categoryId: string) => {
      const picked = await pickFolder();
      if (!picked) return;
      setCategoryDir(categoryId, picked);
      toast.success(t("files.dirBound"));
    },
    [setCategoryDir, t],
  );

  const unbindDir = useCallback(
    async (categoryId: string) => {
      setCategoryDir(categoryId, null);
      toast.success(t("files.dirUnbound"));
    },
    [setCategoryDir, t],
  );

  return useMemo(
    () => ({
      items,
      categories,
      categoryOf,
      open,
      reveal,
      copyPath,
      create,
      rename,
      remove,
      removeMany,
      bindDir,
      unbindDir,
      explain,
    }),
    [
      bindDir,
      categories,
      categoryOf,
      copyPath,
      create,
      explain,
      items,
      open,
      remove,
      removeMany,
      rename,
      reveal,
      unbindDir,
    ],
  );
}

export type FileActions = ReturnType<typeof useFileActions>;
