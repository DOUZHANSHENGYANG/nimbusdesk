import { useEffect } from "react";
import { McpPage as AhubMcpPageView } from "@/ahub/pages/McpPage";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 宿主：把源侧 AgentHub 的 MCP 页**原样**挂进云台。
 *
 * 源侧这两件事在它的 App.tsx 里做：`boot()` 取设置、`ready` 之后 `loadAll()` 拉数据；
 * MCP 页自己不做，所以这里补上 —— 页面本体一行没动，全部改动都在这二十行里。
 *
 * 刻意**不**调源侧的 `boot()`：
 *   · 它会 `applyThemeDom()` 写 <html data-theme>（云台主题走 `.dark` 类）；
 *   · 它会从 AgentHub 自己的 settings.json 切 i18next 语言（云台语言只有一处开关）。
 * 两者都会和云台打架。`refresh()` 只取 info —— MCP 页要用
 * `info.settings.harnessOrder` 排卡片顺序，所以这一步不能省。
 */
export function AhubMcpPage() {
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await useSettings.getState().refresh();
        if (!alive) return;
        // MCP 页不读 ready，但源侧其它三页读；一并置位，免得第二轮再补
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

  return <AhubMcpPageView />;
}
