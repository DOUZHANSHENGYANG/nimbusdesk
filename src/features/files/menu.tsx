import { useCallback, useState } from "react";
import {
  FolderPlus,
  FilePlus2,
  Pencil,
  Trash2,
  ExternalLink,
  FolderOpen,
  Copy,
  FolderTree,
  FolderX,
  Monitor,
  FileText,
  FileSpreadsheet,
  FileCode,
  FileImage,
  FileArchive,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { FileItem } from "@/stores/files";
import type { FileActions } from "@/features/files/actions";

/** 条目上的标记：右键时据此判断命中了哪一条 */
export const ITEM_ATTR = "data-item-id";

/** Windows「新建」子菜单里的常见类型（扩展名 → 图标 + i18n key） */
const NEW_TYPES = [
  { ext: "txt", Icon: FileText, key: "txt" },
  { ext: "md", Icon: FileText, key: "md" },
  { ext: "docx", Icon: FileText, key: "docx" },
  { ext: "xlsx", Icon: FileSpreadsheet, key: "xlsx" },
  { ext: "pptx", Icon: FileText, key: "pptx" },
  { ext: "json", Icon: FileCode, key: "json" },
  { ext: "html", Icon: FileCode, key: "html" },
  { ext: "png", Icon: FileImage, key: "png" },
  { ext: "zip", Icon: FileArchive, key: "zip" },
] as const;

/* ── 菜单内容片段（由 FileAreaContextMenu 按目标选择） ── */

function ItemMenuItems({
  item,
  actions,
  onRenameInline,
}: {
  item: FileItem;
  actions: FileActions;
  onRenameInline?: (item: FileItem) => void;
}) {
  const { t } = useTranslation();
  const isUrl = item.type === "url";

  return (
    <>
      <ContextMenuItem onSelect={() => void actions.open(item)}>
        <ExternalLink className="size-3.5" />
        {t("files.ctx.open")}
      </ContextMenuItem>
      {!isUrl && (
        <ContextMenuItem onSelect={() => void actions.reveal(item)}>
          <FolderOpen className="size-3.5" />
          {t("files.ctx.reveal")}
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem
        onSelect={() => {
          if (onRenameInline) onRenameInline(item);
          else void actions.rename(item);
        }}
      >
        <Pencil className="size-3.5" />
        {t("files.ctx.rename")}
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void actions.copyPath(item)}>
        <Copy className="size-3.5" />
        {t("files.copyPath")}
        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem variant="destructive" onSelect={() => void actions.remove(item)}>
        <Trash2 className="size-3.5" />
        {isUrl ? t("files.ctx.remove") : t("files.ctx.deleteDisk")}
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function BlankMenuItems({
  categoryId,
  actions,
}: {
  categoryId: string | null;
  actions: FileActions;
}) {
  const { t } = useTranslation();
  const cat = categoryId ? actions.categoryOf(categoryId) : undefined;
  const canCreate = !!categoryId && actions.categories.length > 0;

  return (
    <>
      {/* 新建：与 Windows 一致，常用类型收进二级菜单 */}
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={!canCreate}>
          <FilePlus2 className="size-3.5" />
          {t("files.ctx.new")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-44">
          <ContextMenuItem
            onSelect={() => categoryId && void actions.create(categoryId, "folder")}
          >
            <FolderPlus className="size-3.5" />
            {t("files.ctx.newFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {NEW_TYPES.map(({ ext, Icon, key }) => (
            <ContextMenuItem
              key={ext}
              onSelect={() => categoryId && void actions.create(categoryId, "file", { ext })}
            >
              <Icon className="size-3.5" />
              {t(`files.newType.${key}`)}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />

      <ContextMenuItem
        disabled={!categoryId}
        onSelect={() => categoryId && void actions.bindDir(categoryId)}
      >
        <FolderTree className="size-3.5" />
        {cat?.dir ? t("files.ctx.changeDir") : t("files.ctx.bindDir")}
      </ContextMenuItem>
      {cat?.dir && (
        <ContextMenuItem onSelect={() => categoryId && void actions.unbindDir(categoryId)}>
          <FolderX className="size-3.5" />
          {t("files.ctx.unbindDir")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => void actions.chooseRoot()}>
        <FolderOpen className="size-3.5" />
        {actions.filesRoot ? t("files.ctx.changeRoot") : t("files.ctx.setRoot")}
      </ContextMenuItem>
    </>
  );
}

/**
 * 文件区域右键菜单（文件管理页 / 栅栏共用）。
 *
 * 只有一个 ContextMenu 实例：右键在条目上 → 条目菜单；右键在空白处 → 新建/绑定菜单。
 * 用「单一菜单 + 按目标切换内容」而不是嵌套触发器 —— 嵌套的 ContextMenu.Trigger
 * 会因事件冒泡双双打开菜单。
 *
 * 条目需带 `data-item-id` 属性（见 ITEM_ATTR）以便识别命中目标。
 */
export function FileAreaContextMenu({
  items,
  actions,
  categoryId,
  onRenameInline,
  children,
}: {
  items: FileItem[];
  actions: FileActions;
  /** 空白处新建/绑定目录的上下文分类 */
  categoryId: string | null;
  /** 提供则「重命名」走就地编辑（栅栏用） */
  onRenameInline?: (item: FileItem) => void;
  children: React.ReactNode;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);

  // 捕获阶段记录命中目标：先于 Radix 的冒泡处理，菜单渲染时已拿到正确 target
  const captureTarget = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest(`[${ITEM_ATTR}]`);
    setTargetId(el?.getAttribute(ITEM_ATTR) ?? null);
  }, []);

  const target = targetId ? items.find((i) => i.id === targetId) : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onContextMenuCapture={captureTarget} className="contents">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {target ? (
          <ItemMenuItems item={target} actions={actions} onRenameInline={onRenameInline} />
        ) : (
          <BlankMenuItems categoryId={categoryId} actions={actions} />
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 分类 chip 右键菜单（分类级：新建 / 改名 / 栅栏 / 绑定目录 / 删除） */
export function CategoryContextMenu({
  categoryId,
  actions,
  onRename,
  onDelete,
  onToggleFence,
  fenceOn,
  children,
}: {
  categoryId: string;
  actions: FileActions;
  onRename: () => void;
  onDelete: () => void;
  onToggleFence: () => void;
  fenceOn: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const cat = actions.categoryOf(categoryId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onSelect={() => void actions.create(categoryId, "folder")}>
          <FolderPlus className="size-3.5" />
          {t("files.ctx.newFolder")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void actions.create(categoryId, "file")}>
          <FilePlus2 className="size-3.5" />
          {t("files.ctx.newFile")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onRename}>
          <Pencil className="size-3.5" />
          {t("files.renameCategory")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggleFence}>
          <Monitor className="size-3.5" />
          {fenceOn ? t("files.ctx.fenceOff") : t("files.ctx.fenceOn")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void actions.bindDir(categoryId)}>
          <FolderTree className="size-3.5" />
          {cat?.dir ? t("files.ctx.changeDir") : t("files.ctx.bindDir")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {t("files.deleteCategory")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
