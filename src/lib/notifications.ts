import { sendNotification } from "@/lib/notify";
import { useNotifications, type NotificationInput } from "@/stores/notifications";

export interface NotifyOptions extends NotificationInput {
  /** 允许在应用不在前台时发 Windows 系统通知。 */
  system?: boolean;
}

/**
 * 统一通知发布口：所有功能只依赖这里，不直接碰 Zustand store。
 *
 * `system` 只是“允许发”，真正是否发还取决于通知中心里的系统通知总开关和
 * 系统权限；窗口在前台时不重复弹系统通知，避免应用内和 Windows 各弹一次。
 */
export function notify(input: NotifyOptions): string {
  const item = useNotifications.getState().add(input);
  if (input.system) {
    void maybeSystem(item.title, item.body);
  }
  return item.id;
}

async function maybeSystem(title: string, body: string) {
  if (!useNotifications.getState().systemEnabled) return;
  if (typeof document !== "undefined" && document.hasFocus()) return;
  await sendNotification(`NimbusDesk · ${title}`, body);
}
