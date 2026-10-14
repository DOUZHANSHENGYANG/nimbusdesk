/** 外链跳系统浏览器（Tauri opener / 浏览器 dev 退 window.open） */
export async function openExternal(url: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank");
  }
}
