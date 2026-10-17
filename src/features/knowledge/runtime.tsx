import { useEffect } from "react";
import { toast } from "sonner";
import { inTauri } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { setCaptureShortcut } from "./api";
import { useKnowledge } from "./store";
import { startOrganizationRuntime } from "./background-organization";

/** Only the main window registers shortcuts. Hidden capture windows share configuration. */
export function KnowledgeRuntime() {
  useEffect(() => startOrganizationRuntime(), []);
  useEffect(() => {
    if (!inTauri) return;
    const register = () => {
      void setCaptureShortcut(useKnowledge.getState().shortcut).catch(() => {
        toast.error(useSettings.getState().lang === "en" ? "Capture shortcut is unavailable. Change it in Settings → Knowledge." : "收集快捷键不可用，可到「设置 → 知识库」更换组合键。");
      });
    };
    if (useKnowledge.persist.hasHydrated()) { register(); return; }
    return useKnowledge.persist.onFinishHydration(register);
  }, []);
  return null;
}
