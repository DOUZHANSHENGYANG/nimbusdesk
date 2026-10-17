import { useEffect } from "react";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { inTauri, openFence } from "@/lib/tauri";
import { useFiles, useFences, DEFAULT_FENCE } from "@/stores/files";
import { useSettings } from "@/stores/settings";

let toggling: Promise<void> | null = null;
export function toggleDesktopFences(): Promise<void> {
    if (toggling) return toggling;
    const request = (async () => {
        if (!inTauri) return;
        const windows = (await getAllWebviewWindows()).filter(window => window.label.startsWith('fence-'));
        const visibility = await Promise.all(windows.map(window => window.isVisible()));
        if (visibility.some(Boolean)) { await Promise.all(windows.map(window => window.hide())); return; }
        const { fences } = useFences.getState();
        const categories = useFiles.getState().categories.filter(category => fences[category.id]?.open);
        if (!categories.length) throw new Error(useSettings.getState().lang === 'en' ? 'Enable a desktop fence in Files first.' : '请先在文件管理中启用一个桌面栅格。');
        for (const category of categories) {
            const geometry = fences[category.id] ?? DEFAULT_FENCE;
            await openFence(category.id, category.name, geometry);
            if (windows.some(window => window.label === `fence-${category.id}`)) await emitTo(`fence-${category.id}`, 'desktop://window-action', { action: 'show' });
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
        const offHydration = useSettings.persist.onFinishHydration(applyShortcut);
        const offSettings = useSettings.subscribe((state, previous) => { if (state.fenceShortcut !== previous.fenceShortcut) applyShortcut(); });
        applyShortcut();
        return () => { stopped = true; offHydration(); offSettings(); void listener.then(off => off()).catch(() => undefined); };
    }, []);
    return null;
}
