import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShortcutRow } from "@/components/ui/shortcut-row";
import { useSettings } from "@/stores/settings";
import { useKnowledge } from "@/features/knowledge/store";
import { setCaptureShortcut } from "@/features/knowledge/api";
import { setDesktopShortcut } from "@/features/files/desktop-runtime";
import { loadQuickToolsShortcut, saveQuickToolsShortcut } from "@/features/search/quick-tools-settings";
import { saveSearchSettings, useSearchStore } from "@/features/search/store";
import { invoke } from "@tauri-apps/api/core";
import { flushAllStorage } from "@/lib/storage";

/**
 * 设置 › 快捷键：**全局快捷键只在这一页注册**。
 *
 * 六条捷径原本散在各自的设置卡片里（快速面板 / Dock / 桌面栅格 / 搜索 / 知识库 /
 * 快捷工具），每处都重写一遍「录制 → 保存 → 报错」的样板，用户也得记「哪个功能
 * 在哪张卡上」。现在位置统一、行样式统一，只有**存到哪**还在各自的功能里
 * —— 那条捷径怎么注册、要不要落盘、失败怎么回滚，都留在原处（见各行 save）。
 */
export function ShortcutsSettings() {
  const { t } = useTranslation();
  const en = useSettings((s) => s.lang) === "en";
  const quickPanelShortcut = useSettings((s) => s.quickPanelShortcut);
  const dockShortcut = useSettings((s) => s.dockShortcut);
  const fenceShortcut = useSettings((s) => s.fenceShortcut);
  const captureShortcut = useKnowledge((s) => s.shortcut);
  const searchSettings = useSearchStore((s) => s.settings);
  const [quickTools, setQuickTools] = useState<string | null>(null);
  const [quickToolsError, setQuickToolsError] = useState("");

  // 快捷工具的快捷键存在它自己的记录里（不在 settings store），所以单独取一次
  useEffect(() => {
    void loadQuickToolsShortcut().then(setQuickTools).catch((cause) => setQuickToolsError(String(cause)));
  }, []);

  return (
    <>
      <p className="text-[12px] leading-5 text-muted-foreground">{t("settings.shortcuts.hint")}</p>

      <ShortcutRow
        label={t("settings.shortcuts.quickPanel")}
        hint={t("settings.shortcuts.quickPanelHint")}
        value={quickPanelShortcut}
        save={async (next) => {
          // 先让 Rust 侧注册热键，成功后再更新本地镜像 —— 只写 store 不会注册
          await invoke("set_quick_panel_shortcut", { shortcut: next.trim() });
          useSettings.getState().setQuickPanelShortcut(next.trim());
        }}
        placeholder="Ctrl+Shift+Space"
        en={en}
      />

      <ShortcutRow
        label={t("settings.shortcuts.dock")}
        hint={t("settings.shortcuts.dockHint")}
        value={dockShortcut}
        save={async (next) => {
          await invoke("set_dock_shortcut", { shortcut: next.trim() });
          useSettings.getState().setDockShortcut(next.trim());
        }}
        placeholder="Ctrl+Alt+D"
        en={en}
      />

      <ShortcutRow
        label={t("settings.shortcuts.fence")}
        hint={t("settings.shortcuts.fenceHint")}
        value={fenceShortcut}
        save={async (next) => {
          // 一步注册热键、一步保存记录：注册失败则不写记录，两者不会各自为政
          await setDesktopShortcut(next);
          useSettings.getState().setFenceShortcut(next);
        }}
        placeholder="Ctrl+Alt+F"
        en={en}
      />

      <ShortcutRow
        label={t("settings.shortcuts.search")}
        hint={t("settings.shortcuts.searchHint")}
        value={searchSettings.shortcut}
        save={(next) => saveSearchSettings({ ...searchSettings, shortcut: next })}
        placeholder="Ctrl+Alt+K"
        en={en}
      />

      <ShortcutRow
        label={t("settings.shortcuts.capture")}
        hint={t("settings.shortcuts.captureHint")}
        value={captureShortcut}
        save={async (next) => {
          await setCaptureShortcut(next);
          useKnowledge.getState().setShortcut(next);
          await flushAllStorage();
        }}
        en={en}
      />

      {quickToolsError ? <p role="alert" className="text-xs text-destructive">{quickToolsError}</p> : null}
      {quickTools !== null ? (
        <ShortcutRow
          label={t("settings.shortcuts.quickTools")}
          hint={t("settings.shortcuts.quickToolsHint")}
          value={quickTools}
          save={async (next) => {
            await saveQuickToolsShortcut(next);
            setQuickTools(await loadQuickToolsShortcut());
          }}
          placeholder="Ctrl+Alt+T"
          en={en}
        />
      ) : null}
    </>
  );
}
