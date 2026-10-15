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

/**
 * 文件库根目录在数据目录下的固定子目录名。
 *
 * 刻意不本地化：它是磁盘上真实存在的目录名，若随界面语言变化，
 * 切换语言后根路径就变了，之前建的分类文件夹会全部变成孤儿。
 */
const CATEGORIES_DIR = "categories";

/** 拼接路径，保留首段原有的分隔符风格（Windows 反斜杠 / POSIX 斜杠） */
function joinPath(base: string, name: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/**
 * 分类的目录层级路径（不含根目录）。
 * 单层子分类：有 parentId 的返回 [父名, 子名]，否则 [自身名]。
 * 顺带防环：parentId 链异常时退化成 [自身名]，避免死循环。
 */
function categoryPath(
  categoryId: string,
  categories: { id: string; name: string; parentId?: string }[],
): string[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const self = byId.get(categoryId);
  if (!self) return [];
  const parent = self.parentId ? byId.get(self.parentId) : undefined;
  return parent ? [parent.name, self.name] : [self.name];
}
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
  const dataDir = useSettings((s) => s.dataDir);

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
     优先级：分类自带 dir → <根目录>/<父分类名>/<分类名>（自动创建）
     根目录默认 = <数据目录>/categories（固定名，不随语言变），无需用户配置；
     用户若显式选过根目录（filesRoot 覆盖）则用那个。 */

  const defaultRoot = useMemo(
    () => (dataDir ? joinPath(dataDir, CATEGORIES_DIR) : null),
    [dataDir],
  );
  const effectiveRoot = filesRoot ?? defaultRoot;

  const resolveDir = useCallback(
    async (categoryId: string): Promise<string | null> => {
      const cat = categoryOf(categoryId);
      if (!cat) return null;
      if (cat.dir) return cat.dir;
      if (!effectiveRoot) return null;
      // 父分类绑定了目录 → 子分类建在父目录里面；
      // 否则退到 <根>/<父名>/<子名>
      const parent = cat.parentId ? categoryOf(cat.parentId) : undefined;
      const base = parent?.dir ?? effectiveRoot;
      const segs = parent?.dir ? [cat.name] : categoryPath(categoryId, categories);
      const target = segs.reduce((acc, name) => joinPath(acc, name), base);
      try {
        return await ensureDirOnDisk(target);
      } catch (e) {
        toast.error(explain(e));
        return null;
      }
    },
    [categories, categoryOf, effectiveRoot, explain],
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

  /**
   * 解析可写目录。
   * 根目录现在总有默认值（<数据目录>/分类），所以不再需要引导用户选择；
   * 仍可能失败的情形是数据目录尚未解析出来（启动早期），此时如实报错。
   */
  const ensureDir = useCallback(
    async (categoryId: string): Promise<string | null> => {
      const ready = await resolveDir(categoryId);
      if (ready) return ready;
      if (!effectiveRoot) {
        toast.error(t("files.rootUnavailable"));
      }
      return null;
    },
    [effectiveRoot, resolveDir, t],
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
