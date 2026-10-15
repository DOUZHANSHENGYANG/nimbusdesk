import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFiles, useFences, type FileItem } from "@/stores/files";
import { useSettings } from "@/stores/settings";
import type { FileActions } from "@/features/files/actions";
import type { MenuIconKey, MenuNode } from "@/features/files/menu-model";
import {
  beginMenu,
  closeMenu,
  emitMenuRequest,
  ensurePopupReady,
  ownerLabel,
  revealMenu,
  subscribeMenuSize,
  useMenuActions,
  type MenuAction,
} from "@/features/files/popup";

/** Windows「新建」子菜单里的常见类型 */
const NEW_TYPES: { ext: string; icon: MenuIconKey; key: string }[] = [
  { ext: "txt", icon: "text", key: "txt" },
  { ext: "md", icon: "text", key: "md" },
  { ext: "docx", icon: "text", key: "docx" },
  { ext: "xlsx", icon: "sheet", key: "xlsx" },
  { ext: "pptx", icon: "text", key: "pptx" },
  { ext: "json", icon: "code", key: "json" },
  { ext: "html", icon: "code", key: "html" },
  { ext: "png", icon: "image", key: "png" },
  { ext: "zip", icon: "archive", key: "zip" },
];

/** 一次菜单请求的上下文：动作执行时据此找到目标 */
type Target =
  | { kind: "item"; item: FileItem }
  | { kind: "blank"; categoryId: string | null }
  | { kind: "category"; categoryId: string };

/**
 * 右键菜单开启器。
 *
 * 菜单在独立浮窗里渲染才能溢出窗口边界，因此这里负责：
 * 构建菜单树（已翻译）→ 发给浮窗 → 等浮窗回报尺寸 → 定位显示 → 接收并执行动作。
 *
 * @param onRenameInline 提供则「重命名」走就地编辑（栅栏用）
 * @param onToggleFence  分类菜单里的栅栏开关
 */
export function usePopupMenu({
  actions,
  onRenameInline,
  onToggleFence,
  onCategoryRename,
  onCategoryDelete,
  onCategoryAddChild,
}: {
  actions: FileActions;
  onRenameInline?: (item: FileItem) => void;
  onToggleFence?: (categoryId: string) => void;
  onCategoryRename?: (categoryId: string) => void;
  onCategoryDelete?: (categoryId: string) => void;
  onCategoryAddChild?: (categoryId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useSettings((s) => s.theme);
  const filesRoot = useSettings((s) => s.filesRoot);
  const categories = useFiles((s) => s.categories);
  const fences = useFences((s) => s.fences);

  /** 当前打开的菜单目标：动作执行时用它还原上下文 */
  const targetRef = useRef<Target | null>(null);
  /** 锚点：菜单展开起点（CSS 像素，相对当前窗口） */
  const anchorRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  /** 当前菜单归属窗口 label；close 时带上，避免误关别的窗口刚开的菜单 */
  const ownerRef = useRef("main");
  /** 当前菜单的尺寸监听取消函数（下次打开 / 动作完成时清理） */
  const unlistenRef = useRef<(() => void) | null>(null);

  const stopListening = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  const open = useCallback(
    async (target: Target, at: { x: number; y: number }) => {
      targetRef.current = target;
      anchorRef.current = { x: at.x, y: at.y, w: 0, h: 0 };
      stopListening(); // 丢弃上一个菜单残留的监听

      const cat =
        target.kind === "category"
          ? categories.find((c) => c.id === target.categoryId)
          : target.kind === "blank" && target.categoryId
            ? categories.find((c) => c.id === target.categoryId)
            : undefined;

      let nodes: MenuNode[];
      if (target.kind === "item") {
        nodes = buildItemMenu(t, target.item);
      } else if (target.kind === "category" && cat) {
        nodes = buildCategoryMenu(t, cat, fences[cat.id]?.open ?? false, !cat.parentId);
      } else {
        nodes = buildBlankMenu(t, cat, !!filesRoot, categories.length > 0);
      }

      // 顺序很关键，几处都踩过坑：
      // 1) 先确保浮窗「存在且已注册监听」。事件只投递给已存在的 WebView，
      //    首次打开若直接发数据会丢事件；且新窗口的 JS 还没挂载完也收不到。
      // 2) 再分配序号、先订阅尺寸、最后发菜单。浮窗是复用的，
      //    若先发菜单再订阅，预热窗口的尺寸回报会早于订阅而丢失。
      // 3) 尺寸回报可能多次（展开子菜单后变大），每次都重新定位并放大窗口。
      const ready = await ensurePopupReady();
      if (!ready) return; // 浮窗起不来就别发菜单，否则无人接收


      const seq = beginMenu();
      const owner = ownerLabel();
      ownerRef.current = owner;

      let revealed = false;
      unlistenRef.current = await subscribeMenuSize(seq, (s) => {
        revealed = true;
        void revealMenu(anchorRef.current, s);
      });

      await emitMenuRequest(seq, owner, nodes, i18n.language, theme);

      // 兜底：浮窗若因异常始终没回报尺寸，收起并清理，避免悬挂监听
      window.setTimeout(() => {
        if (!revealed && ownerRef.current === owner) {
          void closeMenu(owner);
          stopListening();
        }
      }, 1500);
    },
    [categories, filesRoot, fences, i18n.language, stopListening, t, theme],
  );

  // 浮窗回传动作 → 在这里执行（只有打开方持有 actions / store）
  useMenuActions((a: MenuAction) => {
    const target = targetRef.current;
    stopListening();
    void closeMenu(ownerRef.current);
    targetRef.current = null;
    if (!target) return;

    if (target.kind === "item") {
      const item = target.item;
      switch (a.action) {
        case "open":
          void actions.open(item);
          break;
        case "reveal":
          void actions.reveal(item);
          break;
        case "rename":
          if (onRenameInline) onRenameInline(item);
          else void actions.rename(item);
          break;
        case "copy":
          void actions.copyPath(item);
          break;
        case "delete":
          void actions.remove(item);
          break;
      }
      return;
    }

    const categoryId = target.categoryId;
    switch (a.action) {
      case "newFolder":
        if (categoryId) void actions.create(categoryId, "folder");
        break;
      case "newFile":
        if (categoryId) void actions.create(categoryId, "file", a.value ? { ext: a.value } : undefined);
        break;
      case "bindDir":
        if (categoryId) void actions.bindDir(categoryId);
        break;
      case "unbindDir":
        if (categoryId) void actions.unbindDir(categoryId);
        break;
      case "setRoot":
        void actions.chooseRoot();
        break;
      case "renameCategory":
        if (categoryId) onCategoryRename?.(categoryId);
        break;
      case "newSubCategory":
        if (categoryId) onCategoryAddChild?.(categoryId);
        break;
      case "deleteCategory":
        if (categoryId) onCategoryDelete?.(categoryId);
        break;
      case "toggleFence":
        if (categoryId) onToggleFence?.(categoryId);
        break;
    }
  });

  // 窗口尺寸变化时菜单位置就失效了，收起（与原生菜单行为一致）。
  // 注意：这里刻意不监听 blur —— 浮窗显示时会 set_focus()，打开方随即失焦，
  // 监听 blur 会把刚打开的菜单立刻关掉（表现为菜单一闪即消）。
  // 「点到别处关闭」由浮窗自身的 blur 负责。
  useEffect(() => {
    const onResize = () => {
      stopListening();
      void closeMenu(ownerRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      stopListening();
    };
  }, [stopListening]);

  return open;
}

/* ── 菜单树构建（翻译在此完成，浮窗只渲染） ── */

type T = (key: string, opts?: Record<string, unknown>) => string;

function buildItemMenu(t: T, item: FileItem): MenuNode[] {
  const isUrl = item.type === "url";
  return [
    { kind: "item", action: "open", label: t("files.ctx.open"), icon: "open" },
    ...(isUrl
      ? []
      : [
          {
            kind: "item" as const,
            action: "reveal",
            label: t("files.ctx.reveal"),
            icon: "reveal" as const,
          },
        ]),
    { kind: "sep" },
    { kind: "item", action: "rename", label: t("files.ctx.rename"), icon: "rename", shortcut: "F2" },
    { kind: "item", action: "copy", label: t("files.copyPath"), icon: "copy", shortcut: "Ctrl+C" },
    { kind: "sep" },
    {
      kind: "item",
      action: "delete",
      label: isUrl ? t("files.ctx.remove") : t("files.ctx.deleteDisk"),
      icon: "delete",
      shortcut: "Del",
      destructive: true,
    },
  ];
}

function buildBlankMenu(
  t: T,
  cat: { dir?: string } | undefined,
  hasRoot: boolean,
  hasCategories: boolean,
): MenuNode[] {
  return [
    {
      kind: "sub",
      label: t("files.ctx.new"),
      icon: "newFile",
      items: [
        {
          kind: "item",
          action: "newFolder",
          label: t("files.ctx.newFolder"),
          icon: "newFolder",
          disabled: !hasCategories,
        },
        { kind: "sep" },
        ...NEW_TYPES.map(({ ext, icon, key }) => ({
          kind: "item" as const,
          action: "newFile",
          value: ext,
          label: t(`files.newType.${key}`),
          icon,
          disabled: !hasCategories,
        })),
      ],
    },
    { kind: "sep" },
    {
      kind: "item",
      action: "bindDir",
      label: cat?.dir ? t("files.ctx.changeDir") : t("files.ctx.bindDir"),
      icon: "bindDir",
    },
    ...(cat?.dir
      ? [
          {
            kind: "item" as const,
            action: "unbindDir",
            label: t("files.ctx.unbindDir"),
            icon: "unbindDir" as const,
          },
        ]
      : []),
    {
      kind: "item",
      action: "setRoot",
      label: hasRoot ? t("files.ctx.changeRoot") : t("files.ctx.setRoot"),
      icon: "root",
    },
  ];
}

function buildCategoryMenu(
  t: T,
  cat: { id: string; dir?: string },
  fenceOn: boolean,
  /** 是否顶级分类：只有顶级能再建子分类（单层约束） */
  isTop: boolean,
): MenuNode[] {
  return [
    {
      kind: "sub",
      label: t("files.ctx.new"),
      icon: "newFile",
      items: [
        { kind: "item", action: "newFolder", label: t("files.ctx.newFolder"), icon: "newFolder" },
        { kind: "sep" },
        ...NEW_TYPES.map(({ ext, icon, key }) => ({
          kind: "item" as const,
          action: "newFile",
          value: ext,
          label: t(`files.newType.${key}`),
          icon,
        })),
      ],
    },
    { kind: "sep" },
    {
      kind: "item",
      action: "renameCategory",
      label: t("files.renameCategory"),
      icon: "rename",
    },
    ...(isTop
      ? [
          {
            kind: "item" as const,
            action: "newSubCategory",
            label: t("files.addSubCategory"),
            icon: "newFolder" as const,
          },
        ]
      : []),
    {
      kind: "item",
      action: "toggleFence",
      label: fenceOn ? t("files.ctx.fenceOff") : t("files.ctx.fenceOn"),
      icon: fenceOn ? "fenceOff" : "fence",
    },
    {
      kind: "item",
      action: "bindDir",
      label: cat.dir ? t("files.ctx.changeDir") : t("files.ctx.bindDir"),
      icon: "bindDir",
    },
    { kind: "sep" },
    {
      kind: "item",
      action: "deleteCategory",
      label: t("files.deleteCategory"),
      icon: "delete",
      destructive: true,
    },
  ];
}
