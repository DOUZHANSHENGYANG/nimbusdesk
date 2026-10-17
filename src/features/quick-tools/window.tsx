import { useCallback, useEffect, useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowUpRight, Braces, Bug, CaseSensitive, Languages, LoaderCircle, Pin, PinOff, Regex, Settings2, Sparkles, X } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inTauri, windowReady } from "@/lib/tauri";
import { i18n } from "@/lib/i18n";
import { applyTheme } from "@/lib/theme";
import { copyText } from "@/lib/clipboard";
import { onStorageSynced } from "@/lib/storage";
import { useSettings } from "@/stores/settings";
import { useProviders } from "@/features/ai/providers";
import { chatWithProvider } from "@/features/ai/client";
import { useToolsPreferences } from "@/features/tools/preferences";
import { toolIds, type ToolId } from "@/features/tools/core";
import { useToolsCopy } from "@/features/tools/copy";
import { toolErrorMessage } from "@/features/tools/errors";
import { runTool, StaleToolRequest, type ToolResult } from "@/features/tools/request";
import { ToolOptionsBar } from "@/features/tools/options";
import { ToolResults } from "@/features/tools/results";
import { acceptSelection, type SelectionSnapshot } from "./core";
import "@/features/tools/tools.css";
import "./quick-tools.css";

const icons = { format: Braces, translate: Languages, naming: CaseSensitive, diagnose: Bug, regex: Regex };
export function QuickToolsWindow() {
  const [ready, setReady] = useState(false);
  const theme = useSettings(s => s.theme), lang = useSettings(s => s.lang);
  useEffect(() => {
    document.documentElement.classList.add("quick-tools-root");
    let active = true;
    void Promise.all([useSettings.persist.rehydrate(), useProviders.persist.rehydrate(), useToolsPreferences.persist.rehydrate()])
      .then(() => { if (active) setReady(true); }).finally(() => { if (active && inTauri) void windowReady(); });
    const stop = onStorageSynced(key => { if (key === "settings") void useSettings.persist.rehydrate(); });
    return () => { active = false; stop(); document.documentElement.classList.remove("quick-tools-root"); };
  }, []);
  useEffect(() => { applyTheme(theme); void i18n.changeLanguage(lang); }, [theme, lang]);
  return <I18nextProvider i18n={i18n}><TooltipProvider><QuickToolsSurface ready={ready} /></TooltipProvider></I18nextProvider>;
}

export function QuickToolsSurface({ ready = true }: { ready?: boolean }) {
  const c = useToolsCopy(), lang = useSettings(s => s.lang), en = lang === "en";
  const [tool, setTool] = useState<ToolId>("translate");
  const options = useToolsPreferences(s => s.options[tool]), update = useToolsPreferences(s => s.update);
  const providers = useProviders(s => s.providers), defaultId = useProviders(s => s.defaultTextId);
  const provider = providers.find(p => p.id === defaultId);
  const [input, setInput] = useState(""), inputRef = useRef("");
  const [result, setResult] = useState<ToolResult | null>(null), [resultKey, setResultKey] = useState("");
  const [error, setError] = useState(""), [captureHint, setCaptureHint] = useState("");
  const [busy, setBusy] = useState(false), [pinned, setPinned] = useState(false);
  const currentSelection = useRef<SelectionSnapshot | null>(null), revision = useRef(0), working = useRef(false), alive = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const key = JSON.stringify({ tool, options, lang });
  const currentKey = useRef(key); currentKey.current = key;
  const edit = useCallback((value: string) => { revision.current++; inputRef.current = value; setInput(value); setError(""); }, []);
  useEffect(() => {
    alive.current = true;
    const receive = (incoming: SelectionSnapshot) => {
      if (!alive.current || !acceptSelection(currentSelection.current, incoming)) return;
      currentSelection.current = incoming;
      edit(incoming.text); setResult(null); setResultKey("");
      setCaptureHint(incoming.error || (incoming.text ? (en ? "Selected text · edit before running" : "已读取选中文字，可先修改再运行") : (en ? "Paste text to begin" : "粘贴文字，选择工具后运行")));
      requestAnimationFrame(() => textarea.current?.focus());
    };
    const subscription = inTauri ? listen<SelectionSnapshot>("quick-tools://selection", e => receive(e.payload)) : null;
    if (subscription) void subscription.then(() => invoke<SelectionSnapshot>("quick_tools_selection")).then(receive).catch(() => { if (alive.current) setCaptureHint(en ? "Paste text to begin" : "未能读取选区，请手动粘贴"); });
    return () => { alive.current = false; void subscription?.then(stop => stop()).catch(() => undefined); };
  }, [edit, en]);
  const hide = useCallback(() => { if (inTauri) void getCurrentWebviewWindow().hide().catch(() => undefined); }, []);
  useEffect(() => { const handle = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.isComposing && !document.querySelector('[data-state="open"][role="dialog"]')) { e.preventDefault(); hide(); } }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [hide]);
  async function openMain(route: string) { try { if (inTauri) await invoke("quick_tools_open_main", { route }); } catch { setError(en ? "Could not open the main window" : "无法打开主窗口，请稍后重试"); } }
  async function run() {
    if (working.current || !ready || !provider || !inputRef.current.trim()) return;
    working.current = true; setBusy(true); setError("");
    const source = inputRef.current, ticket = revision.current, snapshotKey = currentKey.current;
    const snapshot = { ...useToolsPreferences.getState().options[tool] };
    const current = () => alive.current && revision.current === ticket && currentKey.current === snapshotKey;
    try { const value = await runTool(tool, source, snapshot, lang, chatWithProvider, current); if (current()) { setResult(value); setResultKey(snapshotKey); } }
    catch (error) { if (current() && !(error instanceof StaleToolRequest)) setError(toolErrorMessage(error, c)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="quick-tools developer-tools workbench-ui">
    <header className="quick-tools-header"><div className="quick-tools-drag" data-tauri-drag-region><Sparkles aria-hidden="true" /><h1 data-tauri-drag-region>{en ? "Quick tools" : "快捷工具"}</h1></div><div className="quick-tools-actions"><button aria-pressed={pinned} title={en ? "Always on top" : "置顶"} aria-label={en ? "Always on top" : "置顶"} onClick={async () => { try { if (inTauri) await getCurrentWebviewWindow().setAlwaysOnTop(!pinned); setPinned(!pinned); } catch { setError(en ? "Unable to pin window" : "窗口置顶失败"); } }}>{pinned ? <PinOff /> : <Pin />}</button><button title={en ? "Open full tools" : "打开完整工具"} aria-label={en ? "Open full tools" : "打开完整工具"} onClick={() => void openMain(`/tools?tool=${tool}`)}><ArrowUpRight /></button><button title={en ? "Hide" : "隐藏"} aria-label={en ? "Hide" : "隐藏"} onClick={hide}><X /></button></div></header>
    <nav className="quick-tools-tabs" aria-label={en ? "Tools" : "工具"}>{toolIds.map(id => { const Icon = icons[id]; return <button key={id} aria-pressed={tool === id} onClick={() => { if (tool !== id) { revision.current++; setTool(id); setResult(null); setError(""); } }}><Icon /><span>{c[id]}</span></button>; })}</nav>
    <main className="quick-tools-body"><div className="quick-tools-config"><ToolOptionsBar tool={tool} options={options} update={patch => update(tool, patch)} c={c} /></div>
      <div className="quick-tools-input-heading"><label htmlFor="quick-tools-input">{c.source}</label><span aria-live="polite">{captureHint || (en ? "Paste or type text" : "粘贴或输入文字")}</span></div>
      <div className="tool-composer"><textarea ref={textarea} id="quick-tools-input" className={`tool-input ${tool === "format" ? "tool-code" : ""}`} value={input} onChange={e => edit(e.target.value)} placeholder={c.sourcePlaceholder} spellCheck={false} maxLength={120_000} onKeyDown={e => { if (e.ctrlKey && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void run(); } }} /><div className="tool-composer-footer"><span className="quick-tools-send-hint">{en ? "Send current input on run" : "运行时发送当前输入"}</span><button className="quick-tools-run" disabled={!ready || !provider || !input.trim() || busy} onClick={() => void run()}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{busy ? c.working : c[`${tool}Run`]}<kbd>Ctrl ↵</kbd></button></div></div>
      {error && <p className="tool-error" role="alert">{error}</p>}
      {!provider && ready && <button className="quick-tools-unconfigured" onClick={() => void openMain("/settings?tab=ai")}><Settings2 />{c.unconfigured}</button>}
      {result && <section className="quick-tools-result" aria-label={c.result}><ToolResults tool={tool} result={result} stale={result.source !== input || resultKey !== key} c={c} copy={async text => { const copied = await copyText(text); if (!copied) setError(c.copyFailed); return copied; }} apply={() => edit(result.text)} /></section>}
    </main><footer className="quick-tools-footer"><span className="tools-model-dot" data-connected={Boolean(provider)} /><span>{provider?.model || c.unconfigured}</span><span className="quick-tools-local">{en ? "Temporary · not saved" : "临时内容 · 不落盘"}</span></footer>
  </div>;
}
