import { useEffect } from "react";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { inTauri } from "@/lib/tauri";
import { useFiles, useFences } from "@/stores/files";
import { hideFenceTemporarily, restoreFenceOnDesktop } from "./desktop-actions";
import { useSettings } from "@/stores/settings";

let toggling: Promise<void> | null = null;
export function toggleDesktopFences(): Promise<void> {
    if (toggling) return toggling;
    const request = (async () => {
        if (!inTauri) return;
        const windows = (await getAllWebviewWindows()).filter(window => window.label.startsWith('fence-'));
        const visibility = await Promise.all(windows.map(window => window.isVisible()));
        if (visibility.some(Boolean)) { await Promise.all(windows.map(window => hideFenceTemporarily(window.label.slice(6)))); return; }
        const { fences } = useFences.getState();
        const categories = useFiles.getState().categories.filter(category => fences[category.id]?.open);
        if (!categories.length) throw new Error(useSettings.getState().lang === 'en' ? 'Enable a desktop fence in Files first.' : '请先在文件管理中启用一个桌面栅格。');
        for (const category of categories) {
            await restoreFenceOnDesktop(category.id, true);
        }
    })();
    toggling = request;
    void request.finally(() => { toggling = null; }).catch(() => undefined);
    return request;
}

export function setDesktopShortcut(shortcut: string): Promise<void> {
    return invoke('set_fence_shortcut', { shortcut });
}

export function DesktopRuntime() {
    useEffect(() => {
        // FenceWindow also uses Providers: only the main WebView owns global actions.
        if (!inTauri || getCurrentWebviewWindow().label !== 'main') return;
        let stopped = false;
        const applyShortcut = () => {
            if (!stopped && useSettings.persist.hasHydrated()) {
                void setDesktopShortcut(useSettings.getState().fenceShortcut).catch(error => toast.error(String(error)));
            }
        };
        const listener = listen('desktop://toggle-fences', () => {
            if (useFiles.persist.hasHydrated() && useFences.persist.hasHydrated()) void toggleDesktopFences().catch(error => toast.error(String(error)));
        });
        const applyDock = async () => {
            if (stopped || !useSettings.persist.hasHydrated()) return;
            const { dockEnabled, dockOpen, dockEdge, dockShortcut, dockAutoHide } = useSettings.getState();
            try {
                /*
                 * 顺序是有意的：先把总开关交给 Rust，再谈开关窗口与快捷键。
                 * 反过来的话，关闭时那一瞬间 dock_open 还能建出窗口（Rust 侧
                 * 的开关还没被写下去），用户会看到 Dock 闪一下。
                 * 关闭分支到此为止：Rust 已经销毁窗口并注销快捷键。
                 */
                await invoke('dock_set_enabled', { on: dockEnabled });
                if (!dockEnabled) return;
                if (dockOpen) await invoke('dock_open');
                else await invoke('dock_close');
                await invoke('set_dock_shortcut', { shortcut: dockShortcut });
                await invoke('dock_set_autohide', { on: dockAutoHide, edge: dockEdge });
            } catch (error) { toast.error(String(error)); }
        };
        const offDockHydration = useSettings.persist.onFinishHydration(applyDock);
        const offDockSettings = useSettings.subscribe((state, previous) => {
            if (state.dockEnabled !== previous.dockEnabled || state.dockOpen !== previous.dockOpen || state.dockShortcut !== previous.dockShortcut || state.dockAutoHide !== previous.dockAutoHide) void applyDock();
        });
        const offHydration = useSettings.persist.onFinishHydration(applyShortcut);
        const offSettings = useSettings.subscribe((state, previous) => { if (state.fenceShortcut !== previous.fenceShortcut) applyShortcut(); });
        /*
         * 首帧补一次。
         *
         * onFinishHydration 只在「之后」水合时回调；如果挂载时已经水合完
         * （启动快、或从托盘再打开主窗口），那一次回调永远不会来 ——
         * 表现就是「Dock 开关是开的，但第一次打开不出现，得关一次再开」。
         */
        void applyDock();
        applyShortcut();
        return () => { stopped = true; offHydration(); offSettings(); void listener.then(off => off()).catch(() => undefined); offDockHydration(); offDockSettings(); };
    }, []);
    return null;
}
