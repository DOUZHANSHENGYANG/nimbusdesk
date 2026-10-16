/**
 * 系统通知封装。
 *
 * 走 `tauri-plugin-notification`；权限被拒时**如实告诉用户**而不是静默失败 ——
 * 「设了提醒却从来不响」用户会以为软件坏了，实际是系统权限。
 */

import { inTauri } from "@/lib/tauri";

export type NotifyPermission = "granted" | "denied" | "unsupported";

/** 动态 import 插件，保证浏览器 dev 模式（无 Tauri）不炸 */
async function plugin() {
  if (!inTauri) return null;
  try {
    return await import("@tauri-apps/plugin-notification");
  } catch {
    return null;
  }
}

/** 查询当前通知权限。浏览器 dev 返回 unsupported */
export async function notificationPermission(): Promise<NotifyPermission> {
  const mod = await plugin();
  if (!mod) return "unsupported";
  try {
    return (await mod.isPermissionGranted()) ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** 申请通知权限。已授予直接返回 granted */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  const mod = await plugin();
  if (!mod) return "unsupported";
  try {
    if (await mod.isPermissionGranted()) return "granted";
    return (await mod.requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** 发送一条通知。失败返回 false（调用方可据此提示，不抛错） */
export async function sendNotification(title: string, body: string): Promise<boolean> {
  const mod = await plugin();
  if (!mod) return false;
  try {
    if (!(await mod.isPermissionGranted())) return false;
    await mod.sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
