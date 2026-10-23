import { useEffect } from "react";
import { startForegroundInterval } from "@/lib/visibility";
import { useZentao } from "./zentao-store";
import { useProjects } from "./store";
import { usePlans, usePlansArchive } from "../plans/store";
import { syncZenConnection, useZentaoRuntimeState } from "./zentao-controller";

const attempted = new Map<string, number>();
/** Main window only. Auth failures wait for a manual test, network failures back off. */
export function ZentaoRuntime() {
  useEffect(() => {
    const tick = () => {
      if (![useZentao, useProjects, usePlans, usePlansArchive].every(s => s.persist.hasHydrated())) return;
      const now = Date.now(), state = useZentao.getState();
      for (const c of state.connections) {
        const meta = state.syncStates[c.id];
        if (!c.autoSync || !c.baseUrl || !c.account || meta?.authRequired || useZentaoRuntimeState.getState().busy[c.id]) continue;
        if (now - Math.max(meta?.lastSyncAt ?? 0, attempted.get(c.id) ?? 0) < c.syncMinutes * 60_000) continue;
        attempted.set(c.id, now); void syncZenConnection(c.id).catch(() => undefined);
      }
    };
    const unsubscribers = [useZentao, useProjects, usePlans, usePlansArchive].map(s => s.persist.onFinishHydration(tick));
    // 唤醒（focus / 变可见）由 startForegroundInterval 的 catchUp 负责，不再自己挂监听
    const unsubscribe = useZentao.subscribe(tick), stop = startForegroundInterval(tick, 30_000);
    tick();
    return () => { stop(); unsubscribe(); unsubscribers.forEach(fn => fn()); };
  }, []);
  return null;
}
