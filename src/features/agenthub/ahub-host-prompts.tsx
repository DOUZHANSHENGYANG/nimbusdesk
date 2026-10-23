import { useEffect } from "react";
import "@/ahub/i18n";
import { PromptsPage as AhubPromptsPageView } from "@/ahub/pages/PromptsPage";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 宿主：把源侧 AgentHub 的提示词页**原样**挂进云台。
 *
 * 与 `ahub-host.tsx`（MCP 页）同一套：源侧 `boot()` 取设置、`ready` 之后 `loadAll()` 拉数据，
 * 页面自己不做，所以这里补上。刻意**不**调源侧 `boot()`（理由见 ahub-host.tsx）。
 */
export function AhubPromptsPage() {
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AhubPromptsPageView />
    </div>
  );
}
