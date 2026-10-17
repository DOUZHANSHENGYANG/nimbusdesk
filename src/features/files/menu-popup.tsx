import { useCallback, useEffect, useRef, useState } from "react";
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
  MonitorOff,
  Folder,
  FileText,
  FileSpreadsheet,
  FileCode,
  FileImage,
  FileArchive,
  ArrowRightLeft,
  type LucideIcon,
} from "lucide-react";
import { Providers } from "@/app/providers";
import { changeLang, i18n } from "@/lib/i18n";
import { applyTheme, type ThemeMode } from "@/lib/theme";
import {
  markPopupReady,
  reportMenuSize,
  sendMenuAction,
  useMenuBounds,
  useMenuHost,
  useReadyResponder,
  type MenuPayload,
} from "@/features/files/popup";
import type { IconMap, MenuNode } from "@/features/files/menu-model";
import { cn } from "@/lib/utils";

/** 图标名 → 组件。LucideIcon 无法跨窗口传递，故用名字映射。 */
const ICONS: IconMap = {
  open: ExternalLink,
  reveal: FolderOpen,
  rename: Pencil,
  copy: Copy,
  delete: Trash2,
  newFolder: FolderPlus,
  newFile: FilePlus2,
  folder: Folder,
  text: FileText,
  sheet: FileSpreadsheet,
  code: FileCode,
  image: FileImage,
  archive: FileArchive,
  bindDir: FolderTree,
  unbindDir: FolderX,
  root: FolderOpen,
  fence: Monitor,
  fenceOff: MonitorOff,
  moveTo: ArrowRightLeft,
  category: Folder,
};

/**
 * 右键菜单浮窗。
 *
 * 菜单在独立窗口里渲染，才能溢出栅栏窗口边界（WebView 内的 DOM 无法超出自身窗口）。
 * 本组件不订阅任何 store：菜单树由打开方翻译好后随事件发来，
 * 避免两个窗口水合时序不一致导致菜单显示错数据。
 *
 * 尺寸由「所有菜单列」的外接矩形决定（子菜单绝对定位，不在父元素盒模型内），
 * 否则窗口只按主菜单尺寸创建，子菜单会被裁掉。
 */
export function MenuPopupWindow() {
  const [payload, setPayload] = useState<MenuPayload | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 子菜单展开/收起时递增，触发重新测量与窗口放大 */
  const [subVersion, setSubVersion] = useState(0);
  // 换菜单、展开/收起子菜单都要重测；version 同时作为「尺寸归属」标识
  const bounds = useMenuBounds(rootRef, `${payload?.seq ?? 0}:${subVersion}`);

  const onOpen = useCallback((p: MenuPayload) => {
    setSubVersion(0);
    setPayload(p);
  }, []);

  const onClose = useCallback(() => setPayload(null), []);

  useMenuHost(onOpen, onClose);
  useReadyResponder();

  // 挂载完成 → 广播 ready，通知打开方「可以发菜单数据了」。
  // 事件只投递给已注册监听的 WebView，而浮窗是懒创建的；
  // 打开方必须等到 ready 才能安全地发菜单，否则首次打开会丢事件。
  useEffect(() => {
    void markPopupReady().catch(() => undefined);
  }, []);

  // 语言/主题跟随打开方（浮窗自身没有设置来源）
  useEffect(() => {
    if (!payload) return;
    if (i18n.language !== payload.lang) changeLang(payload.lang as never);
    applyTheme(payload.theme as ThemeMode);
  }, [payload]);
  useEffect(() => {
    if (!payload) return;
    const frame = requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [payload]);
  // 渲染完成 / 子菜单展开 → 回报尺寸，打开方据此定位并放大窗口。
  // 只在 key 匹配当前菜单时才回报：否则换了菜单后会把上一份尺寸先报出去，
  // 打开方就会按旧尺寸定位窗口（表现为菜单位置/大小错一下）。
  const version = `${payload?.seq ?? 0}:${subVersion}`;
  useEffect(() => {
    if (!payload || bounds.key !== version || bounds.w === 0 || bounds.h === 0) return;
    void reportMenuSize(payload.seq, payload.owner, bounds.w, bounds.h).catch(() => undefined);
  }, [payload, bounds.key, bounds.w, bounds.h, version]);

  // Esc / 失焦关闭（「点到别处」由这里的 blur 负责，打开方不监听 blur）
  useEffect(() => {
    if (!payload) return;
    const owner = payload.owner;
    const openedAt = Date.now();
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && (e.key === "Escape" || e.key === "Tab")) {
        e.preventDefault();
        void sendMenuAction(owner, { action: "close" });
      }
    };
    const onBlur = () => {
      // 刚 show + set_focus 的瞬间可能有一次多余 blur（如焦点短暂转移），
      // 一开就关会让菜单看起来「闪一下消失」。给 250ms 的防抖窗口。
      if (Date.now() - openedAt < 250) return;
      void sendMenuAction(owner, { action: "close" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [payload]);

  const run = (node: MenuNode) => {
    if (node.kind !== "item" || node.disabled || !payload) return;
    void sendMenuAction(payload.owner, { action: node.action, value: node.value });
  };

  return (
    <Providers>
      {/* 不铺满窗口：窗口此刻只有 1×1（等尺寸回报后才放大），
          铺满会把菜单挤成 1px。菜单按内容自适应宽度（w-max），
          而 getBoundingClientRect 与窗口裁剪无关，所以测量结果仍然准确。 */}
      <div className="fixed top-0 left-0 bg-transparent">
        <div
          ref={rootRef}
          data-menu-col
          role="menu"
          onKeyDown={navigateMenu}
          className="w-max min-w-48 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {payload?.nodes.map((node, i) => (
            <MenuRow
              key={`${payload?.seq}-${i}`}
              node={node}
              onRun={run}
              onSubToggle={() => setSubVersion((v) => v + 1)}
            />
          ))}
        </div>
      </div>
    </Providers>
  );
}

function MenuRow({
  node,
  onRun,
  onSubToggle,
}: {
  node: MenuNode;
  onRun: (n: MenuNode) => void;
  onSubToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  if (node.kind === "sep") {
    return <div role="separator" className="-mx-1 my-1 h-px bg-border" />;
  }

  if (node.kind === "sub") {
    const closeSubmenu = () => { setOpen(false); onSubToggle(); };
    const openSubmenu = () => {
      setOpen(true);
      onSubToggle();
      requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }));
    };
    return (
      <div
        className="relative"
        onMouseEnter={() => {
          setOpen(true);
          onSubToggle();
        }}
        onMouseLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) closeSubmenu();
        }}
        onBlurCapture={(event) => {
          if (open && !event.currentTarget.contains(event.relatedTarget)) closeSubmenu();
        }}
        onKeyDown={(event) => {
          if (open && (event.key === "Escape" || event.key === "ArrowLeft")) {
            event.preventDefault();
            event.stopPropagation();
            closeSubmenu();
            triggerRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={openSubmenu}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              openSubmenu();
            }
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
        >
          {node.icon && <Icon name={node.icon} />}
          <span className="flex-1">{node.label}</span>
          <span className="text-muted-foreground">›</span>
        </button>
        {open && (
          <div
            ref={submenuRef}
            data-menu-col
            role="menu"
            aria-label={node.label}
            className="absolute top-0 left-full ml-0.5 min-w-44 rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10"
          >
            {node.items.map((child, i) => (
              <MenuRow key={i} node={child} onRun={onRun} onSubToggle={onSubToggle} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      disabled={node.disabled}
      onClick={() => onRun(node)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm",
        "disabled:pointer-events-none disabled:opacity-50",
        node.destructive
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {node.icon && <Icon name={node.icon} />}
      <span className="flex-1">{node.label}</span>
      {node.shortcut && (
        <span className="text-xs tracking-widest text-muted-foreground">{node.shortcut}</span>
      )}
    </button>
  );
}

/** Arrow navigation stays in the active column, even when nested menus are open. */
function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="menuitem"]');
  const column = target?.closest("[data-menu-col]");
  if (!target || !column) return;
  const items = Array.from(column.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'))
    .filter(item => item.closest("[data-menu-col]") === column);
  if (!items.length) return;
  const index = items.indexOf(target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus({ preventScroll: true });
}

function Icon({ name }: { name: keyof IconMap }) {
  const C = ICONS[name] as LucideIcon | undefined;
  if (!C) return null;
  return <C className="size-3.5 shrink-0" />;
}
