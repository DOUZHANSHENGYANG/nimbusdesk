import { AnimatePresence, motion } from "motion/react";
import { Copy, FolderOpen, FolderPlus, Pencil, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "@/stores/settings";
import { openPath, pickFolder } from "@/lib/tauri";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { quickDirName } from "./quick-access";

/**
 * 快捷访问目录抽屉。
 *
 * 只做三件事：绑定/重绑目录（系统选目录框）、复制全路径、删除绑定；
 * 点一行在文件管理器里打开。条目/文件拖到行上由文件页统一判定（`data-drop-quick`），
 * 这里只负责把落点高亮出来。
 */
export function QuickAccessDrawer({
  open,
  onClose,
  dropDirId,
}: {
  open: boolean;
  onClose: () => void;
  /** 正在被拖拽悬停的目录 id（文件页指针判定后回填） */
  dropDirId: string | null;
}) {
  const { t } = useTranslation();
  const dirs = useSettings((s) => s.quickDirs);
  const setQuickDirs = useSettings((s) => s.setQuickDirs);

  const bind = async (replaceId?: string) => {
    const path = await pickFolder();
    if (!path) return;
    const entry = { id: replaceId ?? crypto.randomUUID(), name: quickDirName(path), path };
    setQuickDirs(replaceId ? dirs.map((dir) => (dir.id === replaceId ? entry : dir)) : [...dirs, entry]);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[60] bg-black/30"
            aria-hidden
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={t("files.quickAccess")}
            data-quick-drawer
            className="fixed inset-y-0 right-0 z-[61] flex w-[320px] max-w-[90vw] flex-col gap-3 border-l border-border bg-popover p-4 shadow-2xl"
            initial={{ x: 320 }}
            animate={{ x: 0 }}
            exit={{ x: 320 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
          >
            <header className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold">{t("files.quickAccess")}</span>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("files.quickAccessClose")}
                className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </header>

            <button
              type="button"
              onClick={() => void bind()}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[12px] text-muted-foreground transition-colors hover:border-brand/50 hover:text-foreground"
            >
              <FolderPlus className="size-3.5" />
              {t("files.quickAccessAdd")}
            </button>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {dirs.length === 0 ? (
                <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">{t("files.quickAccessEmpty")}</p>
              ) : (
                dirs.map((dir) => (
                  <div
                    key={dir.id}
                    data-drop-quick={dir.id}
                    className={cn(
                      "group flex items-center gap-1 rounded-lg border border-transparent px-1.5 py-1.5 transition-colors",
                      dropDirId === dir.id ? "border-brand bg-brand/10" : "hover:bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void openPath(dir.path).catch((error) => toast.error(String(error)))}
                      title={dir.path}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-[12px] text-foreground">{dir.name}</span>
                    </button>
                    <button
                      type="button"
                      title={t("files.quickAccessCopy")}
                      aria-label={t("files.quickAccessCopy")}
                      onClick={() => void copyText(dir.path).then((ok) => (ok ? toast.success(t("files.quickAccessCopied")) : toast.error(t("files.copyFailed"))))}
                      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Copy className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("files.quickAccessRebind")}
                      aria-label={t("files.quickAccessRebind")}
                      onClick={() => void bind(dir.id)}
                      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("files.quickAccessRemove")}
                      aria-label={t("files.quickAccessRemove")}
                      onClick={() => setQuickDirs(dirs.filter((entry) => entry.id !== dir.id))}
                      className="grid size-6 shrink-0 place-items-center rounded text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
