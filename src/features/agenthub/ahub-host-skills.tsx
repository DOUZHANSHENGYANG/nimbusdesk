import { useEffect } from "react";
import "@/ahub/i18n";
import { SkillsPage as AhubSkillsPageView } from "@/ahub/pages/SkillsPage";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 宿主：把源侧 AgentHub 的技能页**原样**挂进云台。
 *
 * 与 `ahub-host.tsx`（MCP 页）同一套：源侧这两件事在它的 App.tsx 里做 ——
 * `boot()` 取设置、`ready` 之后 `loadAll()` 拉数据；页面自己不做，这里补上。
 * 不调源侧 `boot()` 的两个理由见 `ahub-host.tsx`（theme / lang 会与云台打架）。
 *
 * 技能页比 MCP 页多读两处设置：`info.dataDirs`（数据目录桥①）与
 * `info.settings.harnessOrder`，所以 `refresh()` 必须成功。
 */
export function AhubSkillsPage() {
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
      <AhubSkillsPageView />
    </div>
  );
}
