import { useEffect } from "react";
import { ToolManagerPage as AhubToolManagerPageView } from "@/ahub/pages/ToolManagerPage";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 宿主：把源侧 AgentHub 的本机工具页**原样**挂进云台。
 *
 * 与 `ahub-host.tsx`（MCP 页）同一套。工具页的版本表从 `loadAll()` 来，缺了会一直空着。
 */
export function AhubHarnessPage() {
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await useSettings.getState().refresh();
        if (!alive) return;
        useSettings.setState({ ready: true });
        await useData.getState().loadAll();
      } catch {
        /* refresh/loadAll 内部各自吞错，这里只是别再抛到控制台 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return <AhubToolManagerPageView />;
}
