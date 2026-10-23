import { useEffect } from "react";
import { startForegroundInterval } from "@/lib/visibility";
import { toast } from "sonner";
import { useProjects } from "./store";
import { createProjectReminderRunner } from "./runtime-core";
import { inTauri } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { requestNotificationPermission, sendNotification } from "@/lib/notify";
import { i18n } from "@/lib/i18n";

// Shared across StrictMode effect restarts: an in-flight successful notification
// must still save its ledger, and a remount must not create another sender.
let warned = false;
const tick = createProjectReminderRunner({
  getData: () => useProjects.getState(),
  notify: async due => {
    const en = i18n.language.startsWith("en");
    const ok = await sendNotification(en ? "Project deadlines" : "项目截止提醒", due.slice(0, 5).map(d => `${d.title} · ${d.deadline}`).join("\n") + (due.length > 5 ? `\n+${due.length - 5}` : ""));
    if (!ok && !warned) {
      warned = true;
      toast.warning(en ? "Project reminders need system notification permission" : "项目提醒未发送，请检查系统通知权限", { action: { label: en ? "Allow" : "授权通知", onClick: () => { void requestNotificationPermission().then(() => { warned = false; }); } } });
    }
    return ok;
  },
  save: async rows => { for (const row of rows) useProjects.getState().markDelivered(row); await flushAllStorage(); },
});
export function ProjectRuntime() {
  useEffect(() => {
    if (!inTauri) return;
    let stopped = false;
    const run = () => { if (!stopped && useProjects.persist.hasHydrated()) void tick().catch(error => toast.error(String(error))); };
    const unsubscribe = useProjects.persist.onFinishHydration(run);
    // 唤醒（focus / 变可见）统一交给 startForegroundInterval 的 catchUp，
    // 不再各自挂监听 —— 否则同一件事会有两个owner，且隐藏时也会被触发一次
    run(); const stop = startForegroundInterval(run, 30_000);
    return () => { stopped = true; unsubscribe(); stop(); };
  }, []);
  return null;
}
