import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  ExternalLink,
  Monitor,
  X,
  MoreHorizontal,
  FolderOpen,
  Copy,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  useFiles,
  useFences,
  DEFAULT_FENCE,
  type FileItem,
  type ItemType,
} from "@/stores/files";
import {
  openPath,
  openUrl,
  revealInExplorer,
  openFence,
  closeFence,
  pickFolder,
  pickFile,
  fetchSiteMeta,
} from "@/lib/tauri";
import { useModal } from "@/components/shell/modal-host";
import { copyText } from "@/lib/clipboard";
import { motion } from "motion/react";
import { ItemIcon } from "@/features/files/icons";
import { useFileActions, type FileActions } from "@/features/files/actions";
import { usePopupMenu } from "@/features/files/use-popup-menu";
import { ITEM_ATTR } from "@/features/files/menu-model";

/** 分类 chip 上的标记：右键时据此判断命中了哪个分类 */
const CAT_ATTR = "data-cat-id";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

function nameFromPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 文件管理：分类 + 多标签 + 三类绑定（文件夹/文件/网站）+ 桌面栅栏开关 */
export function FilesPage() {
  const { t } = useTranslation();
  const { confirm, alert, prompt } = useModal();
  const categories = useFiles((s) => s.categories);
  const items = useFiles((s) => s.items);
  const addCategory = useFiles((s) => s.addCategory);
  const renameCategory = useFiles((s) => s.renameCategory);
  const removeCategory = useFiles((s) => s.removeCategory);
  const fences = useFences((s) => s.fences);
  const setOpen = useFences((s) => s.setOpen);
  const filesHydrated = useFiles.persist.hasHydrated();
  const fencesHydrated = useFences.persist.hasHydrated();

  const [selected, setSelected] = useState<string | null>(null); // null = 全部
  const [search, setSearch] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [modal, setModal] = useState<{ open: boolean; editing: FileItem | null }>({
    open: false,
    editing: null,
  });
  const restored = useRef(new Set<string>());
  /** 浮窗菜单触发的分类改名目标 */
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);

  const actions = useFileActions();

  // 首次使用：默认分类
  useEffect(() => {
    if (filesHydrated && categories.length === 0) {
      addCategory(t("files.defaultCategory"));
    }
  }, [filesHydrated, categories.length, addCategory, t]);

  // 启动恢复已开启的栅栏
  useEffect(() => {
    if (!filesHydrated || !fencesHydrated) return;
    for (const cat of categories) {
      const f = fences[cat.id];
      if (f?.open && !restored.current.has(cat.id)) {
        restored.current.add(cat.id);
        void openFence(cat.id, cat.name, f).catch(() => undefined);
      }
    }
  }, [filesHydrated, fencesHydrated, categories, fences]);

  const scoped = selected ? items.filter((i) => i.categoryId === selected) : items;

  const allTags = useMemo(
    () => [...new Set(scoped.flatMap((i) => i.tags))].sort(),
    [scoped],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped
      .filter((i) => activeTags.every((tag) => i.tags.includes(tag)))
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          i.path.toLowerCase().includes(q),
      );
  }, [scoped, activeTags, search]);

  const gridRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const cards = gridRef.current?.querySelectorAll<HTMLElement>("[data-card]");
      if (cards?.length) {
        gsap.from(cards, { autoAlpha: 0, y: 8, duration: 0.28, stagger: 0.02, ease: "power2.out", clearProps: "all" });
      }
    },
    { dependencies: [filtered.length, selected, search, activeTags.join(",")], scope: gridRef },
  );

  const openItem = (item: FileItem) => {
    const p = item.type === "url" ? openUrl(item.path) : openPath(item.path);
    void p.catch(() => toast.error(t("files.openErr")));
  };

  // 删除统一走 actions（本地文件进回收站，网址仅移出列表）
  const onDeleteItem = (item: FileItem) => void actions.remove(item);

  const toggleFence = async (catId: string, name: string) => {
    const f = fences[catId] ?? DEFAULT_FENCE;
    if (f.open) {
      await closeFence(catId).catch(() => undefined);
      setOpen(catId, false);
    } else {
      const n = Object.keys(fences).length;
      const geo = f.w > 0 ? f : { ...DEFAULT_FENCE, x: 220 + ((n * 56) % 420), y: 140 + ((n * 40) % 260) };
      await openFence(catId, name, geo).catch((e) => toast.error(String(e)));
      setOpen(catId, true);
      toast.success(t("files.fenceOpened"));
    }
  };

  const onAddCategory = async () => {
    const name = await prompt({ title: t("files.addCategory") });
    if (!name?.trim()) return;
    const dup = categories.some((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (dup) {
      await alert({ title: t("files.dupCategory") });
      return;
    }
    addCategory(name.trim());
  };

  /** 双击/菜单就地改名：重名返回 false（保持编辑态），成功返回 true */
  const onRenameConfirm = async (catId: string, name: string): Promise<boolean> => {
    const clean = name.trim();
    if (!clean) return false;
    const dup = categories.some(
      (c) => c.id !== catId && c.name.toLowerCase() === clean.toLowerCase(),
    );
    if (dup) {
      toast.error(t("files.dupCategory"));
      return false;
    }
    renameCategory(catId, clean);
    return true;
  };

  const onDeleteCategory = async (catId: string) => {
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return;
    if (items.some((i) => i.categoryId === catId)) {
      await alert({ title: t("files.categoryHasItems") });
      return;
    }
    const ok = await confirm({
      title: t("files.deleteCategoryConfirm", { name: cat.name }),
      danger: true,
    });
    if (ok) {
      void closeFence(catId).catch(() => undefined);
      setOpen(catId, false);
      removeCategory(catId);
      if (selected === catId) setSelected(null);
    }
  };

  const openMenu = usePopupMenu({
    actions,
    onToggleFence: (id) => {
      const cat = categories.find((c) => c.id === id);
      if (cat) void toggleFence(cat.id, cat.name);
    },
    onCategoryRename: (id) => setRenamingCategoryId(id),
    onCategoryDelete: (id) => void onDeleteCategory(id),
  });

  /** 条目网格右键：命中条目 → 条目菜单；否则空白菜单 */
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = (e.target as HTMLElement).closest(`[${ITEM_ATTR}]`);
    const id = el?.getAttribute(ITEM_ATTR) ?? null;
    const item = id ? items.find((i) => i.id === id) : undefined;
    void openMenu(
      item ? { kind: "item", item } : { kind: "blank", categoryId: selected },
      { x: e.clientX, y: e.clientY },
    );
  };

  /** 分类 rail 右键：命中 chip → 分类菜单；否则空白菜单 */
  const onRailContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest(`[${CAT_ATTR}]`);
    const id = el?.getAttribute(CAT_ATTR) ?? null;
    if (!id) return; // chip 之外的空白不接管，避免与页面其他区域冲突
    e.preventDefault();
    void openMenu({ kind: "category", categoryId: id }, { x: e.clientX, y: e.clientY });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6 pb-10">
        {/* 分类 chip 右键由该容器统一处理（浮窗菜单） */}
        {/* ── 分类 rail ── */}
        <div className="flex flex-wrap items-center gap-1.5" onContextMenu={onRailContextMenu}>
          <CategoryChip
            label={t("files.all")}
            count={items.length}
            active={selected === null}
            onClick={() => setSelected(null)}
          />
          {categories.map((cat) => (
            <CategoryChip
              key={cat.id}
              catId={cat.id}
              label={cat.name}
              count={items.filter((i) => i.categoryId === cat.id).length}
              active={selected === cat.id}
              fenceOn={fences[cat.id]?.open ?? false}
              forceRename={renamingCategoryId === cat.id}
              actions={actions}
              onClick={() => setSelected(cat.id)}
              onToggleFence={() => void toggleFence(cat.id, cat.name)}
              onRenameConfirm={onRenameConfirm}
              onDelete={() => void onDeleteCategory(cat.id)}
              onCopyPaths={async () => {
                const paths = items
                  .filter((i) => i.categoryId === cat.id)
                  .map((i) => i.path);
                if (!paths.length) return;
                if (await copyText(paths.join("\n"))) toast.success(t("files.copied"));
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => void onAddCategory()}
            title={t("files.addCategory")}
            className="grid size-7 place-items-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-brand/50 hover:text-brand"
          >
            <Plus className="size-4" />
          </button>
        </div>

        {/* ── 搜索 + 添加 ── */}
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 focus-within:border-brand/50">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("files.searchPlaceholder")}
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setModal({ open: true, editing: null })}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-brand-strong"
          >
            <Plus className="size-4" />
            {t("files.addItem")}
          </button>
        </div>

        {/* ── 标签筛选 ── */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  setActiveTags((s) => (s.includes(tag) ? s.filter((x) => x !== tag) : [...s, tag]))
                }
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  activeTags.includes(tag)
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                #{tag}
              </button>
            ))}
            {activeTags.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTags([])}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}

        {/* ── 条目网格（右键菜单在独立浮窗渲染，可溢出窗口边界） ── */}
        <div
          ref={gridRef}
          onContextMenu={onContextMenu}
          className="grid min-h-24 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5"
        >
            {filtered.map((item) => (
              <div
                key={item.id}
                {...{ [ITEM_ATTR]: item.id }}
                data-card
                onClick={() => openItem(item)}
                className="group relative cursor-pointer rounded-xl border border-border bg-card p-3 shadow-[var(--pr-shadow-1)] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[var(--pr-shadow-2)]"
              >
                  <div className="flex items-start gap-2">
                    <ItemIcon
                      type={item.type}
                      path={item.path}
                      iconUrl={item.iconUrl}
                      className="size-5"
                    />
                    <p className="min-w-0 flex-1 break-all text-[13px] font-medium leading-5">
                      {item.title}
                    </p>
                  </div>

                  {item.note && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={item.note}>
                      {item.note}
                    </p>
                  )}
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60" title={item.path}>
                {item.path}
              </p>

              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {/* 属性：系统固有维度，始终展示 */}
                <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                  {t(`files.type.${item.type}`)}
                </span>
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-brand/10 px-1.5 text-[10px] text-brand">
                    #{tag}
                  </span>
                ))}
              </div>

                  {/* 悬停操作 */}
                  <div className="absolute inset-x-2 top-2 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <CardAction
                      title={t("files.copyPath")}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (await copyText(item.path)) toast.success(t("files.copied"));
                      }}
                    >
                      <Copy className="size-3.5" />
                    </CardAction>
                    {item.type !== "url" && (
                      <CardAction
                        title={t("files.ctx.reveal")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void revealInExplorer(item.path).catch(() => toast.error(t("files.openErr")));
                        }}
                      >
                        <ExternalLink className="size-3.5" />
                      </CardAction>
                    )}
                    <CardAction
                      title={t("files.editItem")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setModal({ open: true, editing: item });
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </CardAction>
                    <CardAction
                      title={t("files.ctx.deleteDisk")}
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteItem(item);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </CardAction>
                  </div>
              </div>
            ))}
        </div>

        {filtered.length === 0 && (
          <p className="py-10 text-center text-[13px] text-muted-foreground">{t("files.empty")}</p>
        )}
      </div>

      {/* ── 添加/编辑条目弹窗 ── */}
      <ItemModal
        key={modal.editing?.id ?? "new"}
        open={modal.open}
        editing={modal.editing}
        defaultCategory={selected}
        onClose={() => setModal({ open: false, editing: null })}
      />
    </div>
  );
}

function CategoryChip({
  catId,
  label,
  count,
  active,
  fenceOn,
  actions,
  forceRename,
  onClick,
  onToggleFence,
  onRenameConfirm,
  onDelete,
  onCopyPaths,
}: {
  catId?: string;
  label: string;
  count: number;
  active: boolean;
  fenceOn?: boolean;
  actions?: FileActions;
  /** 由浮窗菜单触发的外来改名请求 */
  forceRename?: boolean;
  onClick: () => void;
  onToggleFence?: () => void;
  onRenameConfirm?: (id: string, name: string) => Promise<boolean>;
  onDelete?: () => void;
  onCopyPaths?: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const boundDir = catId ? actions?.categoryOf(catId)?.dir : undefined;

  const startRename = () => {
    setDraft(label);
    setRenaming(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  // 浮窗菜单请求改名 → 进入编辑态
  useEffect(() => {
    if (forceRename) startRename();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceRename]);

  const commit = async () => {
    if (!renaming || !catId) return;
    const ok = await onRenameConfirm?.(catId, draft);
    if (ok) setRenaming(false); // 重名 → 保持编辑态让用户改
  };

  const chip = (
    <div
      {...(catId ? { [CAT_ATTR]: catId } : {})}
      className={cn(
        "flex items-center gap-0.5 rounded-full border py-1 pl-3 pr-1 text-[12px] font-medium transition-colors",
        active
          ? "border-brand bg-brand/10 text-brand"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setRenaming(false);
          }}
          className="w-24 bg-transparent text-[12px] outline-none"
        />
      ) : (
        <button type="button" onClick={onClick} onDoubleClick={startRename} className="flex items-center gap-1.5">
          {label}
          <span className="rounded-full bg-muted px-1.5 text-[10px]">{count}</span>
        </button>
      )}

      {boundDir && !renaming && (
        <FolderOpen className="size-3 shrink-0 text-brand/70" aria-label={boundDir} />
      )}

      {onToggleFence && !renaming && (
        <button
          type="button"
          title={t("files.fence")}
          onClick={onToggleFence}
          className={cn(
            "grid size-5 place-items-center rounded-full transition-colors",
            fenceOn ? "text-brand" : "text-muted-foreground/60 hover:text-foreground",
          )}
        >
          <Monitor className="size-3" />
        </button>
      )}

      {catId && onRenameConfirm && onDelete && !renaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={label}
              className="grid size-5 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onClick={onToggleFence}>
              <Monitor className="size-3.5" />
              {t("files.fence")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={startRename}>
              <Pencil className="size-3.5" />
              {t("files.renameCategory")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions?.bindDir(catId)}>
              <FolderOpen className="size-3.5" />
              {boundDir ? t("files.ctx.changeDir") : t("files.ctx.bindDir")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onCopyPaths?.()}>
              <Copy className="size-3.5" />
              {t("files.copyPaths")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              {t("files.deleteCategory")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return chip;
}

function CardAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded-md bg-card/90 text-muted-foreground backdrop-blur transition-colors",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ── 添加/编辑条目弹窗 ────────────────────────────────── */

const TYPES: ItemType[] = ["folder", "file", "url"];
const URL_RE = /^https?:\/\/\S+\.\S+/i;

function ItemModal({
  open,
  editing,
  defaultCategory,
  onClose,
}: {
  open: boolean;
  editing: FileItem | null;
  defaultCategory: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const categories = useFiles((s) => s.categories);
  const addItem = useFiles((s) => s.addItem);
  const updateItem = useFiles((s) => s.updateItem);

  const [type, setType] = useState<ItemType>(editing?.type ?? "folder");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [path, setPath] = useState(editing?.path ?? "");
  const [categoryId, setCategoryId] = useState(
    editing?.categoryId ?? defaultCategory ?? categories[0]?.id ?? "",
  );
  const [tagsText, setTagsText] = useState((editing?.tags ?? []).join(", "));
  const [note, setNote] = useState(editing?.note ?? "");
  const [fetchedIcon, setFetchedIcon] = useState<string | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const [fetchingMeta, setFetchingMeta] = useState(false);

  /** 从系统选择器选路径：自动填 path + 默认标题 */
  const applyPicked = (picked: string | null) => {
    if (!picked) return;
    setPath(picked);
    if (!title.trim()) setTitle(nameFromPath(picked));
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      if (type === "folder") applyPicked(await pickFolder());
      else if (type === "file") applyPicked(await pickFile());
    } finally {
      setBrowsing(false);
    }
  };

  const isLocal = type !== "url";
  const urlInvalid = type === "url" && path.trim() !== "" && !URL_RE.test(path.trim());

  // 网站链接 → 自动抓取 title / description / favicon（700ms 防抖，只填空字段）
  useEffect(() => {
    if (type !== "url" || urlInvalid) return;
    const target = path.trim();
    const timer = setTimeout(async () => {
      setFetchingMeta(true);
      try {
        const meta = await fetchSiteMeta(target);
        if (meta.title) setTitle((prev) => (prev.trim() ? prev : meta.title!));
        if (meta.description) setNote((prev) => (prev.trim() ? prev : meta.description!));
        if (meta.iconUrl) setFetchedIcon(meta.iconUrl);
        if (meta.title || meta.description || meta.iconUrl) {
          toast.success(t("files.metaFetched"));
        }
      } catch {
        /* 抓取失败静默，用户可手填 */
      } finally {
        setFetchingMeta(false);
      }
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, type]);

  const save = () => {
    if (!title.trim() || !path.trim() || !categoryId) return;
    if (type === "url" && !URL_RE.test(path.trim())) {
      toast.error(t("files.openErr"));
      return;
    }
    const tags = tagsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const iconUrl = type === "url" ? fetchedIcon ?? editing?.iconUrl : undefined;
    if (editing) {
      updateItem(editing.id, {
        type, title: title.trim(), path: path.trim(), categoryId, tags,
        note: note.trim() || undefined, iconUrl,
      });
    } else {
      addItem({ type, title: title.trim(), path: path.trim(), categoryId, tags, note: note.trim() || undefined, iconUrl });
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl border-border bg-popover">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {editing
              ? t("files.editItem")
              : t("files.newItem", { name: categories.find((c) => c.id === categoryId)?.name ?? "" })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 属性（系统固有）：由来源决定，创建后不可改 ——
              磁盘上文件夹就是文件夹，改属性不成立。
              编辑时只展示当前值（静态徽标），新建时才允许选择。 */}
          <Field label={t("files.attrLabel")} hint={t("files.attrHint")}>
            {editing ? (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-1.5">
                <span className="rounded-md bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                  {t("files.attrLocked")}
                </span>
                <span className="text-[12px] font-semibold text-foreground">
                  {t(`files.type.${type}`)}
                </span>
              </div>
            ) : (
              <div className="relative flex rounded-xl border border-border bg-muted/40 p-1">
                {TYPES.map((ty) => (
                  <button
                    key={ty}
                    type="button"
                    onClick={() => setType(ty)}
                    className="relative flex-1 rounded-lg py-1.5 text-[12px]"
                  >
                    {type === ty && (
                      <motion.span
                        layoutId="item-type-pill"
                        className="absolute inset-0 rounded-lg bg-card shadow-[var(--pr-shadow-1)] ring-1 ring-border"
                        transition={{ type: "spring", stiffness: 550, damping: 42 }}
                      />
                    )}
                    <span
                      className={cn(
                        "relative z-10",
                        type === ty ? "font-semibold text-brand" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`files.type.${ty}`)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label={t("files.titleLabel")}>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-brand/50"
            />
          </Field>

          <Field label={fetchingMeta ? t("files.fetching") : t("files.pathLabel")}>
            {isLocal ? (
              /* 本地路径：系统选择器 + 只读回显 */
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] text-muted-foreground">
                  {path || t("files.browse")}
                </code>
                <button
                  type="button"
                  onClick={() => void browse()}
                  disabled={browsing}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12px] transition-colors hover:border-brand/50 hover:text-brand"
                >
                  <FolderOpen className="size-3.5" />
                  {t("files.browse")}
                </button>
              </div>
            ) : (
              /* 网址：文本输入 + 校验 */
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="https://"
                className={cn(
                  "w-full rounded-lg border bg-background px-3 py-2 font-mono text-[12px] outline-none",
                  urlInvalid ? "border-destructive" : "border-border focus:border-brand/50",
                )}
              />
            )}
          </Field>

          <Field label={t("files.noteLabel")}>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[12px] outline-none focus:border-brand/50"
            />
          </Field>

          <Field label={t("files.categoryLabel")}>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setCategoryId(cat.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                    categoryId === cat.id
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t("files.tagsLabel")} hint={t("files.tagsHint")}>
            <TagEditor value={tagsText} onChange={setTagsText} placeholder={t("files.tagsAdd")} />
          </Field>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-full bg-brand px-4 py-1.5 text-[13px] font-medium text-white hover:bg-brand-strong"
          >
            {t("common.confirm")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * 标签编辑器：把逗号分隔串呈现为可逐个删除的 chip。
 * 直接在输入框里编辑逗号串对用户不直观（看不到已有标签的边界）。
 */
function TagEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const tags = value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const commit = () => {
    const clean = draft.trim().replace(/[,，]/g, "");
    if (!clean || tags.includes(clean)) {
      setDraft("");
      return;
    }
    onChange([...tags, clean].join(", "));
    setDraft("");
  };

  const removeAt = (i: number) => {
    onChange(tags.filter((_, idx) => idx !== i).join(", "));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 focus-within:border-brand/50">
      {tags.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand"
        >
          #{tag}
          <button
            type="button"
            onClick={() => removeAt(i)}
            title="×"
            className="text-brand/60 transition-colors hover:text-brand"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === "，") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && tags.length) {
            removeAt(tags.length - 1);
          }
        }}
        onBlur={commit}
        placeholder={tags.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-foreground/90">
        {label}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground/70">{hint}</span>}
      </span>
      {children}
    </div>
  );
}
