import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { ShortcutRecorder } from "@/features/knowledge/shortcut-recorder";
import { inTauri, readJson, writeJson } from "@/lib/tauri";
import { openQuickToolsWindow, setQuickToolsShortcut } from "./api";

const KEY = "quick-tools-settings";
const shortcutValue = (value: unknown) => {
  const state = (value as { state?: { shortcut?: unknown } } | null)?.state;
  return typeof state?.shortcut === "string" ? state.shortcut.trim() : "Ctrl+Alt+T";
};

export function QuickToolsSettings() {
  const { i18n } = useTranslation(), en = i18n.language.startsWith("en");
  const [draft, setDraft] = useState("Ctrl+Alt+T"), [saved, setSaved] = useState("Ctrl+Alt+T");
  const [hydrated, setHydrated] = useState(false), [saving, setSaving] = useState(false), [recording, setRecording] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [shortcutError, setShortcutError] = useState("");
  const stored = useRef<unknown>(null), dirty = useRef(false), revision = useRef(0);
  const shortcutRevision = useRef(0);
  const loadShortcutError = useCallback(async () => {
    const ticket = ++shortcutRevision.current;
    try { const value = await invoke<string | null>("quick_tools_shortcut_error"); if (ticket === shortcutRevision.current) setShortcutError(value ?? ""); }
    catch (error) { if (ticket === shortcutRevision.current) setShortcutError(String(error)); }
  }, []);
  const load = useCallback(async () => {
    const ticket = ++revision.current;
    void loadShortcutError();
    try {
      const value = await readJson<unknown>(KEY);
      if (ticket !== revision.current) return;
      stored.current = value; const shortcut = shortcutValue(value);
      setSaved(shortcut); if (!dirty.current) setDraft(shortcut);
      setHydrated(true); setError("");
    } catch (error) { if (ticket === revision.current) { setHydrated(false); setError(String(error)); } }
  }, [loadShortcutError]);
  useEffect(() => {
    let active = true;
    const subscription = inTauri ? listen<{ key: string }>("storage://changed", ({ payload }) => { if (payload.key === KEY) void load(); }) : null;
    const shortcutSubscription = inTauri ? listen<string>("quick-tools://shortcut-error", ({ payload }) => { shortcutRevision.current++; setShortcutError(payload); }) : null;
    void Promise.allSettled([subscription, shortcutSubscription]).then(() => { if (active) void load(); });
    return () => { active = false; revision.current++; shortcutRevision.current++; for (const sub of [subscription, shortcutSubscription]) void sub?.then(stop => stop()).catch(() => undefined); };
  }, [load]);
  async function save() {
    if (!hydrated || saving || recording) return;
    setSaving(true); setError(""); setMessage("");
    const next = draft.trim(), previous = saved;
    let changed = false;
    try {
      if (next !== previous || shortcutError) { await setQuickToolsShortcut(next); changed = true; }
      const value = { state: { shortcut: next }, version: 1 };
      const canonical = await writeJson(KEY, value, { value: stored.current });
      stored.current = canonical ?? value; dirty.current = false;
      setSaved(shortcutValue(stored.current)); setDraft(shortcutValue(stored.current));
      shortcutRevision.current++; setShortcutError("");
      setMessage(en ? "Quick tools settings saved" : "快捷工具设置已保存");
      if (inTauri) await emit("storage://changed", { key: KEY }).catch(() => undefined);
    } catch (error) {
      let failure = String(error);
      if (changed) { try { await setQuickToolsShortcut(previous); } catch (rollback) { failure += `; shortcut restore: ${String(rollback)}`; } }
      setError(failure);
    } finally { setSaving(false); }
  }
  const title = en ? "Selected text quick tools" : "选中文字快捷工具";
  return <section className="search-settings-section" aria-label={title}>
    <div className="search-settings-section-heading"><h3>{title}</h3><Button size="sm" variant="outline" onClick={() => void openQuickToolsWindow().catch(error => setError(String(error)))}>{en ? "Open quick tools" : "打开快捷工具"}</Button></div>
    <p className="search-settings-hint">{en ? "Select text in another app, then press the shortcut. AI runs only after you choose Run. Leave the shortcut empty to disable it." : "在其他应用选中文字，再按快捷键。点击运行后才会发送给 AI；留空可停用快捷键。"}</p>
    <ShortcutRecorder value={draft} onChange={value => { dirty.current = true; setDraft(value); setMessage(""); setError(""); }} en={en} disabled={!hydrated || saving} onRecordingChange={setRecording} placeholder="Ctrl+Alt+T" />
    {!hydrated && error && <p className="search-settings-hint">{en ? "Settings could not be loaded. Saving is disabled to protect stored values." : "设置读取失败，已停用保存，避免覆盖原有配置。"}<Button size="sm" variant="link" onClick={() => void load()}>{en ? "Retry loading settings" : "重新读取设置"}</Button></p>}
    <div className="search-settings-save"><div>{message && <p role="status">{message}</p>}{error && <p role="alert" className="search-settings-error">{error}</p>}{shortcutError && <p role="alert" className="search-settings-error">{shortcutError}</p>}</div><Button disabled={!hydrated || saving || recording || draft === saved && !shortcutError} onClick={() => void save()}>{saving ? en ? "Saving…" : "正在保存…" : en ? "Save" : "保存"}</Button></div>
  </section>;
}
