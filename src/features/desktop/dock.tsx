import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor } from "@tauri-apps/api/window";
import {
  BookOpen, CalendarCheck, Folder, FolderKanban, LayoutGrid, Search, Settings2, X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useModal } from "@/components/shell/modal-host";
import { inTauri } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { monitorArea } from "./monitors";
import { dockBounds, dockSpringPair, type DockArea } from "./dock-core";
import { toggleDesktopFences } from "@/features/files/desktop-runtime";
import "./dock.css";

/** 与 Rust 侧 `dock_open` 固定的 label 一致。 */
const LABEL = "desktop-dock";

function report(error: unknown) { toast.error(String(error)); }

export function DockWindow() {
  const { t } = useTranslation();
  const modal = useModal();
  const edge = useSettings((s) => s.dockEdge);
  const areaRef = useRef<DockArea | null>(null);
  const expanded = useRef(false);

  const place = useCallback(async (target: boolean) => {
    if (!inTauri) return;
    const monitor = await currentMonitor().catch(() => null);
    if (!monitor) return;
    const raw = monitorArea(monitor);
    const scale = raw.scale || 1;
    // MonitorArea 是物理像素；dock-core 的口径是逻辑像素。
    const area: DockArea = { x: raw.x / scale, y: raw.y / scale, w: raw.w / scale, h: raw.h / scale };
    areaRef.current = area;
    const bounds = dockBounds(area, edge, target);
    if (target === expanded.current) {
      await invoke("window_set_bounds", {
        label: LABEL, x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale),
        width: Math.round(bounds.w * scale), height: Math.round(bounds.h * scale),
      });
      return;
    }
    const { from, to } = dockSpringPair(area, edge, expanded.current, target);
    expanded.current = target;
    await invoke("dock_spring", {
      label: LABEL, fromX: from.x, toX: to.x, fromW: from.w, toW: to.w,
      y: to.y, h: to.h, style: "bouncy",
    });
  }, [edge]);

  useEffect(() => {
    if (!inTauri) return;
    void (async () => {
      await place(false);
      await invoke("window_show_no_activate", { label: LABEL });
    })().catch(report);
  }, [place]);

  const nav = (route: string) => invoke("desktop_open_main", { route }).catch(report);
  const actions = [
    { key: "search", icon: Search, run: () => invoke("search_open_window").catch(report) },
    { key: "fences", icon: LayoutGrid, run: () => toggleDesktopFences() },
    { key: "plans", icon: CalendarCheck, route: "/plans" },
    { key: "projects", icon: FolderKanban, route: "/projects" },
    { key: "files", icon: Folder, route: "/files" },
    { key: "knowledge", icon: BookOpen, route: "/knowledge" },
    { key: "settings", icon: Settings2, route: "/settings" },
  ];

  const close = () => {
    modal.confirm({ title: t("dock.close"), description: t("dock.closeHint"), confirmText: t("dock.close"), danger: true })
      .then((ok) => {
        if (!ok) return;
        useSettings.getState().setDockOpen(false);
        invoke("dock_close").catch(report);
      });
  };

  if (!inTauri) {
    return <div className="dock-root" data-edge={edge}><p className="dock-hint">{t("dock.tauriOnly")}</p></div>;
  }
  return (
    <div className="dock-root" data-edge={edge}
      onMouseEnter={() => void place(true).catch(report)}
      onMouseLeave={() => {
        // 确认弹窗渲染在 portal 里（.dock-root 之外），鼠标移上去会误触发
        // mouseleave，把窗口收起并把弹窗挤成一条。弹窗开着时不收起。
        if (document.querySelector("[role='dialog']")) return;
        void place(false).catch(report);
      }}
      onContextMenu={(event) => { event.preventDefault(); close(); }}>
      <ul className="dock-list" role="toolbar" aria-label={t("dock.title")} aria-orientation="vertical">
        {actions.map(({ key, icon: Icon, route, run }) => (
          <li key={key}>
            <button type="button" className="dock-item" title={t(`dock.${key}`)} aria-label={t(`dock.${key}`)}
              onClick={() => { if (run) void run(); else if (route) nav(route); }}>
              <Icon className="dock-icon" aria-hidden="true" />
              <span className="dock-label">{t(`dock.${key}`)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="dock-close" title={t("dock.close")} aria-label={t("dock.close")} onClick={close}>
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
