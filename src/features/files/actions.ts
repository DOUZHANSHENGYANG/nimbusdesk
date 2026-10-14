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
  ensureDir as ensureDirOnDisk,
  openPath,
  openUrl,
  pickFolder,
  renameEntry,
  revealInExplorer,
} from "@/lib/tauri";
import { inTauri } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";

/** Rust 侧错误码 → 可读文案（未命中则回落到原始字符串） */
const ERR_KEYS: Record<string, string> = {
  "empty-name": "files.err.emptyName",
  "invalid-name": "files.err.invalidName",
  "reserved-name": "files.err.reservedName",
  "already-exists": "files.err.alreadyExists",
  "not-found": "files.err.notFound",
  "parent-missing": "files.err.parentMissing",
  "not-a-dir": "files.err.notADir",
  "unsupported-platform": "files.err.unsupported",
};

/**
 * 文件条目动作层：文件管理页与桌面栅栏共用同一套右键菜单行为，
 * 保证「重命名/删除同步磁盘」的语义在两处完全一致。
 */
export function useFileActions() {
  const { t } = useTranslation();
  const { confirm, prompt } = useModal();
  const filesRoot = useSettings((s) => s.filesRoot);
  const setFilesRoot = useSettings((s) => s.setFilesRoot);

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

  /* ── 目录解析 ─────────────────────────────────────────
     优先级：分类自带 dir → <全局根目录>/<分类名>（自动创建）
     这样只要设一次根目录，所有分类都能直接新建，无需逐个绑定。 */

  const resolveDir = useCallback(
    async (categoryId: string): Promise<string | null> => {
      const cat = categoryOf(categoryId);
      if (!cat) return null;
      if (cat.dir) return cat.dir;
      if (!filesRoot) return null;
      const sep = filesRoot.includes("\\") ? "\\" : "/";
      const target = `${filesRoot.replace(/[\\/]+$/, "")}${sep}${cat.name}`;
      try {
        return await ensureDirOnDisk(target);
      } catch (e) {
        toast.error(explain(e));
        return null;
      }
    },
    [categoryOf, explain, filesRoot],
  );

  /** 选择一个全局根目录：所有分类的默认落盘位置 */
  const chooseRoot = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setFilesRoot(picked);
    toast.success(t("files.rootBound", { dir: picked }));
  }, [setFilesRoot, t]);

  const clearRoot = useCallback(() => {
    setFilesRoot(null);
    toast.success(t("files.rootCleared"));
  }, [setFilesRoot, t]);

  /** 解析可写目录；未配置根目录且分类未绑定时，引导选择根目录 */
  const ensureDir = useCallback(
    async (categoryId: string): Promise<string | null> => {
      const ready = await resolveDir(categoryId);
      if (ready) return ready;
      if (!filesRoot) {
        const ok = await confirm({
          title: t("files.rootTitle"),
          description: t("files.rootHint"),
          confirmText: t("files.rootPick"),
        });
        if (!ok) return null;
        const picked = await pickFolder();
        if (!picked) return null;
        setFilesRoot(picked);
        const sep = picked.includes("\\") ? "\\" : "/";
        const cat = categoryOf(categoryId);
        try {
          return await ensureDirOnDisk(`${picked.replace(/[\\/]+$/, "")}${sep}${cat?.name ?? "files"}`);
        } catch (e) {
          toast.error(explain(e));
          return null;
        }
      }
      return null;
    },
    [categoryOf, confirm, explain, filesRoot, resolveDir, setFilesRoot, t],
  );

  /**
   * 新建文件/文件夹。`ext` 用于 Windows 风格「新建 → 某类型文件」：
   * 传入扩展名时自动补后缀并预填对应默认名，不再询问。
   */
  const create = useCallback(
    async (
      categoryId: string,
      kind: "folder" | "file",
      opts?: { name?: string; ext?: string },
    ) => {
      if (!inTauri) return null;
      const dir = await ensureDir(categoryId);
      if (!dir) return null;

      // 默认名遵循 Windows 习惯（新建文本文档 / 新建文件夹…）
      const fallback =
        kind === "folder" ? t("files.newFolderName") : t(`files.newFileNames.${opts?.ext ?? "txt"}` as const);
      const base = opts?.name?.trim() || fallback || t("files.newFileName");

      // 指定了类型 → 直接创建（Windows 也是立即落盘再让用户改名）
      let name = opts?.ext ? `${base}.${opts.ext}` : base;
      if (!opts?.ext && !opts?.name) {
        const entered = await prompt({
          title: kind === "folder" ? t("files.newFolder") : t("files.newFile"),
          initial: base,
        });
        if (entered === null) return null; // 用户取消
        name = entered.trim() || base;
      }

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
      filesRoot,
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
      chooseRoot,
      clearRoot,
      explain,
    }),
    [
      bindDir,
      categories,
      categoryOf,
      chooseRoot,
      clearRoot,
      copyPath,
      create,
      explain,
      filesRoot,
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
