import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, ExternalLink, RefreshCw, CheckCircle2, Circle, FolderPlus, X, Pause, Play, FileSearch } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ShortcutRecorder } from "@/features/knowledge/shortcut-recorder";
import { searchCopy, searchExtensionCopy } from "./copy";
import { detectEverything, openSearchWindow, pauseSearchIndex, refreshSearch, searchDocumentDefaults, startEverything } from "./api";
import { hydrateSearchSettings, saveSearchSettings, updateSearchStatus, useSearchStore } from "./store";
import type { EverythingStatus, SearchSettingsValue } from "./types";
import "./search.css";

export function SearchSettings() {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith("en"), c = searchCopy(en), e = searchExtensionCopy(en);
  const { settings, hydrated, status, error } = useSearchStore();
  const [draft, setDraft] = useState<SearchSettingsValue>(settings);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [recording, setRecording] = useState(false);
  const [message, setMessage] = useState(""), [localError, setLocalError] = useState("");
  const [defaults, setDefaults] = useState<string[]>([]), [defaultsError, setDefaultsError] = useState("");
  const [everything, setEverything] = useState<EverythingStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const probeRevision = useRef(0);
  const [action, setAction] = useState<"detect" | "start" | "pause" | "picker" | null>(null);
  useEffect(() => { void hydrateSearchSettings().catch(() => undefined); void loadDefaults(); }, []);
  useEffect(() => { if (!dirty) setDraft(settings); }, [settings, dirty]);
  useEffect(() => {
    if (!hydrated) return;
    const ticket = ++probeRevision.current;
    setEverything(null); setDetecting(true);
    void detectEverything(settings.everythingPath, settings.everythingInstance).then(value => {
      if (ticket === probeRevision.current) setEverything(value);
    }).catch(() => undefined).finally(() => { if (ticket === probeRevision.current) setDetecting(false); });
    return () => { probeRevision.current++; };
  }, [hydrated, settings.everythingPath, settings.everythingInstance]);
  useEffect(() => {
    const update = () => { void updateSearchStatus().catch(() => undefined); };
    update(); const timer = setInterval(update, 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!hydrated || dirty || action !== null || everything?.state !== "indexing") return;
    let active = true, pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      const ticket = probeRevision.current;
      void detectEverything(settings.everythingPath, settings.everythingInstance).then(value => {
        if (active && ticket === probeRevision.current) setEverything(value);
      }).catch(() => undefined).finally(() => { pending = false; });
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [hydrated, dirty, action, everything?.state, settings.everythingPath, settings.everythingInstance]);
  async function loadDefaults() {
    try { setDefaults(await searchDocumentDefaults()); setDefaultsError(""); }
    catch (error) { setDefaultsError(String(error)); }
  }
  function patch(value: Partial<SearchSettingsValue>) { if (value.everythingPath !== undefined || value.everythingInstance !== undefined) { probeRevision.current++; setDetecting(false); } setDraft(current => ({ ...current, ...value })); setDirty(true); setMessage(""); setLocalError(""); }
  async function save() {
    setSaving(true); setMessage(""); setLocalError("");
    try { await saveSearchSettings(draft); setDirty(false); setMessage(c.saved); await refreshSearch(); await updateSearchStatus(); }
    catch (error) { setLocalError(String(error)); }
    finally { setSaving(false); }
  }
  async function rebuild() {
    setLocalError("");
    try { await refreshSearch(); setMessage(c.rebuilding); await updateSearchStatus(); }
    catch (error) { setLocalError(String(error)); }
  }
  async function probe(start: boolean) {
    const ticket = ++probeRevision.current;
    setAction(start ? "start" : "detect"); setEverything(null); setDetecting(true); setLocalError("");
    try { const value = await (start ? startEverything : detectEverything)(draft.everythingPath, draft.everythingInstance); if (ticket === probeRevision.current) setEverything(value); await updateSearchStatus(); }
    catch (error) { setLocalError(String(error)); }
    finally { setAction(null); if (ticket === probeRevision.current) setDetecting(false); }
  }
  async function choose(kind: "program" | "roots" | "excludes") {
    setAction("picker"); setLocalError("");
    try {
      const selected = await open(kind === "program" ? { directory: false, multiple: false, filters: [{ name: "Everything", extensions: ["exe"] }] } : { directory: true, multiple: true });
      if (!selected) return;
      if (kind === "program") { probeRevision.current++; patch({ everythingPath: Array.isArray(selected) ? selected[0] : selected }); setEverything(null); }
      else {
        const entries = Array.isArray(selected) ? selected : [selected];
        const current = kind === "roots" ? draft.documentRoots ?? defaults : draft.documentExcludes;
        const paths = [...new Map([...current, ...entries].map(path => [path.replace(/\\/g, "/").toLocaleLowerCase(), path])).values()];
        patch(kind === "roots" ? { documentRoots: paths } : { documentExcludes: paths });
      }
    } catch (error) { setLocalError(String(error)); }
    finally { setAction(null); }
  }
  async function pause() {
    setAction("pause"); setLocalError("");
    try { await pauseSearchIndex(!status?.files?.paused); await updateSearchStatus(); }
    catch (error) { setLocalError(String(error)); }
    finally { setAction(null); }
  }
  const disabled = !hydrated || saving, busy = disabled || action !== null;
  const roots = draft.documentRoots ?? defaults, files = status?.files;
  const lastIndexed = status?.lastIndexedAt;
  const timestamp = lastIndexed ? new Date(lastIndexed < 1e12 ? lastIndexed * 1000 : lastIndexed) : null;
  const pathList = (paths: string[], exclude: boolean) => <ul className="search-folder-list">{paths.map(path => <li key={path}><span title={path}>{path}</span><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`${e.remove} ${path}`} onClick={() => patch(exclude ? { documentExcludes: paths.filter(item => item !== path) } : { documentRoots: paths.filter(item => item !== path) })}><X /></Button></li>)}</ul>;
  return <section className="search-settings workbench-ui" aria-label={c.settingsTitle}>
    <header className="search-settings-header"><div><h2><Search className="size-4" />{c.settingsTitle}</h2><p>{c.settingsHint}</p></div><Button variant="outline" onClick={() => void openSearchWindow().catch(error => setLocalError(String(error)))}>{c.launch}</Button></header>
    {!hydrated && error && <div role="alert" className="search-settings-error"><p>{c.loadError}</p><Button variant="outline" size="sm" onClick={() => void hydrateSearchSettings().catch(() => undefined)}>{c.retry}</Button></div>}
    <div className="search-settings-section"><ShortcutRecorder value={draft.shortcut} onChange={shortcut => patch({ shortcut })} en={en} disabled={disabled} onRecordingChange={setRecording} placeholder="Ctrl+Alt+K" /><p className="search-settings-hint">{c.shortcutHint}</p></div>
    <section className="search-settings-section" aria-label={e.program}>
      <div className="search-settings-section-heading"><h3>{e.program}</h3><span className="search-service-status" role="status">{!detecting && everything?.state === "ready" ? <CheckCircle2 /> : <Circle />}{detecting ? action === "start" ? e.launching : e.probing : everything ? e.states[everything.state] : e.unknown}</span></div>
      <div className="search-setting-field"><label htmlFor="search-file-provider">{c.provider}</label><select id="search-file-provider" value={draft.fileBackend} disabled={disabled} onChange={event => patch({ fileBackend: event.target.value as SearchSettingsValue["fileBackend"] })}><option value="auto">{c.auto}</option><option value="everything">{c.everything}</option><option value="windows">{c.windows}</option></select></div>
      <div className="search-setting-field"><label htmlFor="search-everything-path">{e.path}</label><div className="search-path-picker"><Input id="search-everything-path" value={draft.everythingPath} placeholder={status?.everythingPath || "Everything.exe"} disabled={busy} onChange={event => { probeRevision.current++; patch({ everythingPath: event.target.value }); setEverything(null); }} /><Button variant="outline" disabled={busy} onClick={() => void choose("program")}>{e.browse}</Button></div><p className="search-settings-hint">{e.pathHint}</p></div>
      <div className="search-program-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => void probe(false)}><RefreshCw className={action === "detect" ? "animate-spin" : ""} />{action === "detect" ? e.probing : e.detect}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void probe(true)}><Play />{action === "start" ? e.launching : e.start}</Button><Button size="sm" variant="link" onClick={() => void openUrl("https://www.voidtools.com/downloads/").catch(error => setLocalError(String(error)))}>{c.download}<ExternalLink /></Button></div>
      {everything?.path && !draft.everythingPath && <p className="search-detected-path" title={everything.path}>{everything.path}</p>}
      {everything?.error && <p role="alert" className="search-settings-error">{everything.error}</p>}
      {everything?.running && !everything.ipcAvailable && <p className="search-settings-hint">{e.serviceHint}</p>}
      {everything?.running && everything.indexReady === null && everything.ipcAvailable && <p className="search-settings-hint">{e.permissionHint}</p>}
      <div className="search-setting-toggle"><label htmlFor="search-everything-autostart">{e.autoStart}</label><Switch id="search-everything-autostart" checked={draft.everythingAutoStart} disabled={disabled} onCheckedChange={everythingAutoStart => patch({ everythingAutoStart })} /></div>
      <details className="search-settings-advanced"><summary>{e.instanceMore}</summary><div className="search-setting-field"><label htmlFor="search-everything-instance">{c.instance}</label><Input id="search-everything-instance" value={draft.everythingInstance} maxLength={128} disabled={disabled || draft.fileBackend === "windows"} onChange={event => { patch({ everythingInstance: event.target.value }); setEverything(null); }} placeholder={c.instanceHint} /></div></details>
    </section>
    <section className="search-settings-section" aria-label={e.documents}>
      <div className="search-settings-section-heading"><h3><FileSearch />{e.documents}</h3><Switch aria-label={e.enable} checked={draft.documentIndexEnabled} disabled={disabled} onCheckedChange={documentIndexEnabled => patch({ documentIndexEnabled })} /></div><p className="search-settings-hint">{e.documentHint}</p>
      <div className="search-scope-heading"><span>{draft.documentRoots === null ? e.defaultScope : e.customScope}</span><div><Button size="sm" variant="ghost" disabled={busy || draft.documentRoots === null} onClick={() => { patch({ documentRoots: null }); void loadDefaults(); }}>{e.reset}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void choose("roots")}><FolderPlus />{e.add}</Button></div></div>
      {defaultsError && draft.documentRoots === null ? <div role="alert" className="search-settings-error">{e.defaultsError}<Button size="sm" variant="link" onClick={() => void loadDefaults()}>{e.retryDefaults}</Button></div> : roots.length ? pathList(roots, false) : <p className="search-settings-hint search-empty-scope">{e.emptyScope}</p>}
      <details className="search-settings-advanced"><summary>{e.exclusions}{draft.documentExcludes.length > 0 && <span className="tabular-nums"> · {draft.documentExcludes.length}</span>}</summary><div className="search-scope-heading"><span>{draft.documentExcludes.length ? e.exclusions : e.noExclusions}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void choose("excludes")}><FolderPlus />{e.addExclusion}</Button></div>{pathList(draft.documentExcludes, true)}</details>
      <p className="search-settings-hint">{e.sourcesHint}</p>
    </section>
    <section className="search-settings-section"><div className="search-setting-toggle"><div><label htmlFor="search-pinyin">{e.pinyin}</label><p id="search-pinyin-hint" className="search-settings-hint">{e.pinyinHint}</p></div><Switch id="search-pinyin" checked={draft.pinyinEnabled} disabled={disabled} aria-describedby="search-pinyin-hint" onCheckedChange={pinyinEnabled => patch({ pinyinEnabled })} /></div></section>
    <section className="search-settings-section search-index-progress" aria-label={e.progress}>
      <div className="search-settings-section-heading"><h3>{e.progress}</h3><div className="search-index-actions"><Button size="sm" variant="ghost" disabled={busy || !files} onClick={() => void pause()}>{files?.paused ? <Play /> : <Pause />}{files?.paused ? e.resume : e.pause}</Button><Button size="sm" variant="outline" disabled={busy || dirty || status?.indexing || files?.running} title={dirty ? e.unsaved : undefined} onClick={() => void rebuild()}><RefreshCw />{c.rebuild}</Button></div></div>
      {files ? <><p className="search-settings-hint">{en ? "Document text index" : "文档正文索引"}</p><div className="search-index-summary"><strong>{files.processed.toLocaleString()} <span>/ {files.total.toLocaleString()}</span></strong><span>{files.paused ? e.paused : files.running ? e.running : files.total > 0 && files.processed >= files.total ? e.complete : e.waiting}</span></div><progress max={Math.max(1, files.total)} value={files.processed} aria-label={e.processed} /><div className="search-index-counts"><span>{e.indexed} <b>{files.indexed.toLocaleString()}</b></span><span>{e.failed} <b>{files.failed.toLocaleString()}</b></span></div>{files.current && <p className="search-detected-path" title={files.current}>{files.current}</p>}{files.error && <p role="status" className="search-settings-error">{files.error}</p>}</> : <p className="search-settings-hint">{e.noIndex}</p>}
      {files && (files.nameRunning || !!files.nameTotal) && <div className="search-name-progress"><span>{en ? "File name / pinyin index" : "文件名 / 拼音索引"}</span><strong>{(files.nameIndexed ?? 0).toLocaleString()} / {(files.nameTotal ?? 0).toLocaleString()}</strong><span>{files.paused ? e.paused : files.nameRunning ? e.running : (files.nameTotal ?? 0) > 0 && (files.nameIndexed ?? 0) >= (files.nameTotal ?? 0) ? e.complete : (files.nameIndexed ?? 0) > 0 ? en ? "Partially indexed" : "部分完成" : e.waiting}</span></div>}
      <dl className="search-index-meta"><dt>{c.indexed}</dt><dd>{status ? status.count.toLocaleString() : "—"}</dd><dt>{c.lastIndexed}</dt><dd>{timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toLocaleString(en ? "en-US" : "zh-CN") : c.never}</dd><dt>{c.backend}</dt><dd>{status?.backend || "—"}</dd></dl>
      {status?.error && <p role="status" className="search-settings-hint">{status.error}</p>}
    </section>
    <footer className="search-settings-save"><div><p role="status">{message || (dirty ? e.unsaved : e.unchanged)}</p>{localError && <p role="alert" className="search-settings-error">{localError}</p>}</div><Button onClick={() => void save()} disabled={busy || !dirty || recording}>{saving ? c.saving : c.save}</Button></footer>
  </section>;
}
