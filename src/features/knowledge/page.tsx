import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, FolderOpen, Hash, Plus, RefreshCw, Search, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

import { pickFolder, openPath, revealInExplorer, openUrl, inTauri } from "@/lib/tauri";
import { bindVault, scanNotes, searchNotes, listCaptures, readNote, openCaptureWindow, moveNote, renameNote } from "./api";
import { useKnowledge } from "./store";
import { useKnowledgeCopy } from "./copy";
import { CaptureForm } from "./capture";
import { NoteReader } from "./note-reader";
import type { OrganizeMaterial } from "./organize";
import { OrganizationWorkspace } from "./organization-workspace";
import { OrganizationLauncher } from "./organization-launcher";
import { setOrganizationBlockedPath } from './background-organization';
import { useOrganizationJobs } from './organization-jobs';
import { organizationWritesNote } from './background-organization-core';
import { TagBrowser, UNTAGGED, noteTags } from "./tag-browser";
import { NoteTags } from "./note-tags";
import { VaultManager } from "./vault-manager";
import { useManagerCopy } from "./manager-copy";

import type { CaptureRecord, KnowledgeNote, ReadNote } from "./types";
import "./knowledge-workspace.css";


const NOTES_PER_PAGE = 30;

export function KnowledgePage() {
  const root = useKnowledge((s) => s.vaultRoot);
  const bindings = useKnowledge((s) => s.folderBindings);
  // Remount on binding changes so old selections, fingerprints and AI responses cannot cross vaults.
  return <VaultPage key={`${root ?? "unbound"}:${JSON.stringify(bindings)}`} root={root} />;
}

function VaultPage({ root }: { root: string | null }) {
  const c = useKnowledgeCopy();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedNote = searchParams.get("note") || "";
  const routeRequest = `${location.key}:${requestedNote}`;
  const [consumedRoute, setConsumedRoute] = useState("");
  const m = useManagerCopy();
  // 带 ?note= 进来的是「看某篇笔记」（首页/搜索跳转），其余默认落在管理面。
  const [mode, setMode] = useState<"manage" | "notes">(requestedNote ? "notes" : "manage");
  const { t, i18n } = useTranslation();
  const name = useKnowledge((s) => s.vaultName);
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const queryRef = useRef(query); queryRef.current = query;
  const scanRequest = useRef(0);
  const readRequest = useRef(0);
  const [active, setActive] = useState<KnowledgeNote | null>(null);
  const [detail, setDetail] = useState<ReadNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [reading, setReading] = useState(false);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);

  const job = useOrganizationJobs(state=>state.job);
  const [noteInfoOpen, setNoteInfoOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  // 三个区：人类工作区 / AI 工作区 / 正式区。分类是区里的目录。
  const [moveOpen, setMoveOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [materials, setMaterials] = useState<OrganizeMaterial[] | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const noteItems = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const initiallySelected = useRef(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!root) return;
    const request = ++scanRequest.current;
    const needle = queryRef.current.trim();
    const isCurrent = () => mounted.current && request === scanRequest.current && needle === queryRef.current.trim();
    setLoading(true); setScanCompleted(false); setError("");
    try {
      const [nextNotes, nextCaptures] = await Promise.all([needle ? searchNotes(root, needle) : scanNotes(root), listCaptures(root)]);
      if (isCurrent()) {
        // 库根下散落的单文件（AGENTS.md / README.md）不属于任何区，列表里一律不显示。
      setNotes(nextNotes.filter((note) => note.path.includes("/"))); setCaptures(nextCaptures);
        // Reading again refreshes the original content and fingerprint after external edits.
        setActive((old) => old ? nextNotes.find((note) => note.path === old.path) ?? (needle ? old : null) : null);
      }
    } catch (e) { if (isCurrent()) setError(String(e)); }
    finally { if (isCurrent()) { setLoading(false); setScanCompleted(true); } }
  }, [root]);
  useEffect(() => { const timer = setTimeout(() => void refresh(), query.trim() ? 250 : 0); return () => clearTimeout(timer); }, [query, refresh]);
  useEffect(() => { const focus = () => { void refresh(); }; window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus); }, [refresh]);
  useEffect(() => {
    if(job?.root===root && job.finishedAt)void refresh();
  },[job?.id,job?.finishedAt,root,refresh]);
  useEffect(()=>{
    if(!root||!active)return;
    setOrganizationBlockedPath(root,active.path,noteDirty);
    return()=>setOrganizationBlockedPath(root,active.path,false);
  },[root,active?.path,noteDirty]);
  useEffect(() => {
    if (!root || !active) { setDetail(null); return; }
    let current = true;
    const request = ++readRequest.current;
    const isCurrent = () => current && request === readRequest.current;
    // Refresh the same note in place so window focus cannot unmount an editor.
    setDetail((old) => old?.path === active.path ? old : null); setReading(true); setError("");
    void readNote(root, active.path).then((value) => { if (isCurrent()) setDetail(value); }).catch((e) => { if (isCurrent()) setError(String(e)); }).finally(() => { if (isCurrent()) setReading(false); });
    return () => { current = false; };
  }, [root, active]);
  async function bind() {
    if (binding) return;
    setBinding(true);
    try { const directory = await pickFolder(); if (!directory) return; const vault = await bindVault(directory); useKnowledge.getState().setVault(vault.root, vault.name); }
    catch (e) { setError(String(e)); }
    finally { if (mounted.current) setBinding(false); }
  }
  function noteSaved(saved: ReadNote) { readRequest.current++; setReading(false); setDetail(saved); void refresh(); }
  function chooseTag(value: string | null) { setTag(value); }
  function chooseNote(note: KnowledgeNote) {
    initiallySelected.current = true;
    if (active?.path !== note.path) setNoteDirty(true);
    setNoteInfoOpen(false);
    setActive(note);
  }
  async function submitRename() {
    if (!root || !active || !renameValue.trim()) return;
    try {
      const path = await renameNote(root, active.path, renameValue.trim());
      setRenameOpen(false); setNotice(c.renamed.replace("{path}", path)); await refresh();
    } catch (e) { setError(String(e)); }
  }
  async function submitMove() {
    if (!root || !active || !dest) return;
    try {
      const path = await moveNote(root, active.path, dest);
      setMoveOpen(false); setNotice(c.moved.replace("{path}", path)); await refresh();
    } catch (e) { setError(String(e)); }
  }
  function clearFilters() { setCategory("all"); setTag(null); queryRef.current = ""; setQuery(""); }
  function navigateNotes(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(noteItems.current?.querySelectorAll<HTMLButtonElement>(".knowledge-note-open") ?? []);
    if (!buttons.length) return;
    const position = buttons.indexOf((event.target as HTMLElement).closest("button") as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    buttons[index].focus({ preventScroll: true });
    buttons[index].scrollIntoView({ block: "nearest", behavior: "instant" });
    buttons[index].click();
  }
  function handleOpen(mode: "default" | "reveal" | "obsidian") {
    if (!root || !active) return;
    const absolute = `${root.replace(/[\\/]$/, "")}/${active.path}`;
    const operation = mode === "reveal" ? revealInExplorer(absolute) : mode === "obsidian" ? openUrl(`obsidian://open?path=${encodeURIComponent(absolute)}`) : openPath(absolute);
    void operation.catch((e) => setError(String(e)));
  }
  const captureForPath = useMemo(() => new Map(captures.map((capture) => [capture.notePath, capture])), [captures]);
  const needle = query.trim().toLocaleLowerCase();
  const categoryNotes = useMemo(() => notes.filter((note) => {
    const capture = captureForPath.get(note.path);
    if (note.kind.startsWith("00-") || note.kind === "inbox") return false;
    if (category !== "all" && note.kind !== category) return false;
    return category !== "inbox" || capture?.status !== "archived";
  }), [notes, category, captureForPath]);
  const filtered = useMemo(() => categoryNotes.filter((note) => {
    const tags = noteTags(note);
    if (tag === UNTAGGED ? tags.length > 0 : tag !== null && !tags.includes(tag)) return false;
    return true;
  }), [categoryNotes, tag]);
  useEffect(() => {
    if (!requestedNote || consumedRoute === routeRequest || !root) return;
    const normalize = (value: string) => value.replace(/\\/g, "/").toLocaleLowerCase();
    if (active && normalize(active.path) !== normalize(requestedNote) && noteDirty) {
      setNotice(i18n.language.startsWith("en") ? "Save the current note to open the search result. Your draft is kept." : "请先保存当前笔记，再打开搜索结果；当前草稿已保留。");
      return;
    }
    if (query || category !== "all" || tag !== null) {
      if (query) setScanCompleted(false);
      clearFilters(); return;
    }
    if (loading || !scanCompleted) return;
    const target = notes.find(note => normalize(note.path) === normalize(requestedNote));
    if (!target) {
      setNotice(i18n.language.startsWith("en") ? "This note moved or is outside the managed folders." : "这篇笔记已移动，或不在当前管理目录中。");
      setConsumedRoute(routeRequest); return;
    }
    initiallySelected.current = true;
    setConsumedRoute(routeRequest); setNotice(""); setNoteInfoOpen(false); setActive(target);
    setPageIndex(Math.floor(notes.indexOf(target) / NOTES_PER_PAGE));
  }, [requestedNote, routeRequest, consumedRoute, root, active, noteDirty, query, category, tag, loading, scanCompleted, notes, i18n.language]);
  useEffect(() => {
    if ((!requestedNote || consumedRoute === routeRequest) && !loading && !active && !initiallySelected.current && filtered[0]) {
      initiallySelected.current = true;
      setActive(filtered[0]);
    }
  }, [filtered, loading, active, requestedNote, consumedRoute, routeRequest]);
  const currentCapture = active ? captureForPath.get(active.path) : null;
  // 归档区只展示正式区（01~04）；两个工作区的内容在「工作区」面里管。
  const formalNotes = useMemo(() => notes.filter((note) => !note.kind.startsWith("00-") && note.kind !== "inbox"), [notes]);
  const categories = useMemo(() => {
    const kinds = Array.from(new Set(formalNotes.map((note) => note.kind)));
    kinds.sort((a, b) => a.localeCompare(b));
    return ["all", ...kinds];
  }, [formalNotes]);
  const folders = useMemo(() => Array.from(new Set(notes.map((note) => note.path.replace(/[\\/][^\\/]*$/, "")))).sort(), [notes]);
  const categoryName = (kind: string) => kind === "all" ? c.all : kind === "inbox" ? c.inbox : kind === "note" ? c.note : kind.replace(/^[0-9]+[-_.\s]*/, "");
  const totalPages = Math.max(1, Math.ceil(filtered.length / NOTES_PER_PAGE));
  const currentPage = Math.min(pageIndex, totalPages - 1);
  const pageNotes = filtered.slice(currentPage * NOTES_PER_PAGE, (currentPage + 1) * NOTES_PER_PAGE);
  useEffect(() => { setPageIndex(0); }, [query, category, tag]);
  useEffect(() => { setPageIndex((old) => Math.min(old, totalPages - 1)); }, [totalPages]);
  useEffect(() => { noteItems.current?.scrollTo({ top: 0 }); }, [currentPage, query, category, tag]);

  /**
   * 同目录的笔记（最多 3 条）。用已经拉到的列表算，不再发第二次查询 ——
   * 这里回答的是「旁边还有什么」，不是全库精确检索。
   */
  const relatedNotes = active
    ? notes
        .filter((note) => note.path !== active.path && note.path.replace(/[\\/][^\\/]*$/, "") === active.path.replace(/[\\/][^\\/]*$/, ""))
        .slice(0, 3)
    : [];

  return <div className="workbench-ui knowledge-workspace" onKeyDown={(event) => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || target.closest("input,textarea,[contenteditable=true],[role=dialog],[role=menu]")) return;
    if (event.key === "/" || ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f")) {
      if (!root) return;
      event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select();
    }
  }}>
    <header className="knowledge-header">
      <button type="button" onClick={() => void bind()} disabled={binding} title={root || c.bindHint} aria-label={`${root ? c.change : c.bind}: ${name || "Obsidian"}`} className="knowledge-vault-switch">
        <span className="knowledge-vault-icon"><FolderOpen /></span>
        <span className="knowledge-vault-name"><strong>{name || c.bind}</strong></span>
        <span className="knowledge-vault-change">{c.changeVault}<ChevronDown /></span>
      </button>
      {root && <nav className="knowledge-modes" aria-label={c.title}>
        <button type="button" aria-pressed={mode === "manage"} onClick={() => setMode("manage")}>{m.tabs.manage}</button>
        <button type="button" aria-pressed={mode === "notes"} onClick={() => setMode("notes")}>{m.tabs.notes}</button>
      </nav>}
      <div className="knowledge-header-actions">
      {root && <><Button variant="ghost" size="icon" title={c.refresh} aria-label={c.refresh} onClick={() => void refresh()} disabled={loading || binding}><RefreshCw className={loading ? "animate-spin" : ""} /></Button><Button variant="ghost" size="icon" aria-label={c.organizationSettings} title={c.organizationSettings} onClick={() => navigate("/settings?tab=knowledge")}><Settings2 /></Button><Button size="sm" onClick={() => { if (inTauri) void openCaptureWindow().catch((e) => setError(String(e))); else setCaptureOpen(true); }}><Plus />{c.openCapture}</Button></>}
    </div></header>
    {error && !materials && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!root ? <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-8"><BookOpen className="size-10 text-muted-foreground" /><p className="text-sm">{c.unbound}</p><p className="text-xs text-muted-foreground">{c.bindHint}</p><Button onClick={() => void bind()}>{c.bind}</Button></div> : mode === "manage" ? <VaultManager root={root} /> : <>
      <div className="knowledge-controls">
        <div className="knowledge-filter-bar">
          <nav aria-label={c.title} className="knowledge-categories">{categories.map((kind) => <button key={kind} type="button" aria-pressed={category === kind} onClick={() => setCategory(kind)}>{categoryName(kind)}<span>{formalNotes.filter((note) => (kind === "all" || note.kind === kind) && (kind !== "inbox" || captureForPath.get(note.path)?.status !== "archived")).length}</span></button>)}</nav>
          <div className="knowledge-tag-tools">
            <span className="knowledge-tag-title"><Hash aria-hidden="true" />{c.tagBrowse}</span>
            <div className="knowledge-search-field knowledge-tag-search">
              <Search aria-hidden="true" /><input aria-label={c.findTag} placeholder={c.findTag} value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && tagQuery) { event.preventDefault(); setTagQuery(""); } }} />
              {tagQuery && <span className="knowledge-search-suffix"><button type="button" aria-label={c.clearTagSearch} title={c.clearTagSearch} onClick={() => setTagQuery("")}><X /></button></span>}
            </div>
          </div>
        </div>
        <TagBrowser notes={categoryNotes} selected={tag} onSelect={chooseTag} query={tagQuery} />
      </div>
      <div className="knowledge-reading-layout">
        <aside className="knowledge-note-list" aria-label={c.notesLabel}>
          <div className="knowledge-list-search"><div className="knowledge-search-field knowledge-main-search"><Search aria-hidden="true" /><input ref={searchInput} type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} /><span className="knowledge-search-suffix">{query ? <button type="button" aria-label={c.clearSearch} title={c.clearSearch} onClick={() => { setQuery(""); searchInput.current?.focus(); }}><X /></button> : <kbd aria-hidden="true" title="Ctrl+F">/</kbd>}</span></div></div>
          <div ref={noteItems} className="knowledge-note-items" onKeyDown={navigateNotes} aria-busy={loading}>{loading && !pageNotes.length && <p role="status" className="knowledge-list-message">{c.loading}</p>}{!loading && filtered.length === 0 && <div className="knowledge-list-message"><p>{needle || tag ? c.noMatching : c.empty}</p>{(needle || tag || category !== "all") && <button onClick={clearFilters}>{c.resetFilters}</button>}</div>}{pageNotes.map((note) => {
          return <div key={note.path} className="knowledge-note-item" data-active={active?.path === note.path}>
            <button className="knowledge-note-open" title={note.title} aria-current={active?.path === note.path ? "true" : undefined} onClick={() => chooseNote(note)}><h3>{note.title}</h3><span className="knowledge-note-category">{categoryName(note.kind)}</span></button>
          </div>;
        })}</div><nav className="knowledge-pagination" aria-label={c.notePagination}><Button variant="ghost" size="icon" aria-label={c.previousPage} disabled={currentPage === 0} onClick={() => setPageIndex(currentPage - 1)}><ArrowLeft /></Button><span aria-live="polite">{currentPage + 1} / {totalPages}</span><Button variant="ghost" size="icon" aria-label={c.nextPage} disabled={currentPage >= totalPages - 1} onClick={() => setPageIndex(currentPage + 1)}><ArrowRight /></Button></nav></aside>
        <article className="knowledge-reader-pane" aria-label={c.readingMode}>{!active ? <div className="knowledge-reader-empty"><span className="knowledge-reader-empty-icon"><BookOpen /></span><h2>{c.readingMode}</h2><p>{c.readerHint}</p></div> : <div className="knowledge-note-document">
          {!loading && !filtered.some((note) => note.path === active.path) && <div className="knowledge-outside-filter" role="status"><span>{c.readingOutsideFilter}</span><button onClick={clearFilters}>{c.resetFilters}</button></div>}
          {detail?.path === active.path ? <NoteReader key={detail.path} root={root} note={detail} title={active.title} onOpen={handleOpen} onInfo={() => setNoteInfoOpen(true)} recipe={active.path.includes("配方")} onSaved={noteSaved} onDirtyChange={setNoteDirty} /> : reading && <p role="status" className="p-5 text-sm text-muted-foreground">{c.loading}</p>}
        </div>}</article>
        {/* 第三列：文档信息常驻。弹窗只留「采集来源」那几项（原始项目/来源/目标），
            两处不重复：这里放当前文档本身的事实，以及可以直接改的标签。 */}
        {active && <aside className={railOpen ? "knowledge-info-rail" : "knowledge-info-rail is-collapsed"} aria-label={c.noteInfo}>
          <button type="button" className="knowledge-rail-toggle" aria-expanded={railOpen} aria-label={railOpen ? c.hideInfo : c.showInfo} title={railOpen ? c.hideInfo : c.showInfo} onClick={() => setRailOpen(!railOpen)}>{railOpen ? <ArrowRight /> : <ArrowLeft />}</button>
          {railOpen && <><h2>{c.noteInfo}</h2>
          <div className="knowledge-rail-row"><span>{c.originalPath}</span><b title={active.path}>{active.path}</b></div>
          <div className="knowledge-rail-row"><span>{c.kind}</span><b>{categoryName(active.kind)}</b></div>
          <div className="knowledge-rail-actions">
            <button type="button" className="knowledge-rail-action" onClick={() => { setDest(active.path.replace(/[\\\\/][^\\\\/]*$/, "")); setMoveOpen(true); }}>{c.moveTo}</button>
            <button type="button" className="knowledge-rail-action" onClick={() => { setRenameValue(active.title); setRenameOpen(true); }}>{c.rename}</button>
          </div>
          <div className="knowledge-rail-label">{t("knowledgeRail.tags")}</div>
          {detail?.path === active.path && <NoteTags key={active.path} root={root} note={detail} disabled={noteDirty || organizationWritesNote(job, root, active.path)} onUpdated={noteSaved} onSelect={(value) => chooseTag(value)} />}
          <div className="knowledge-rail-label">{t("knowledgeRail.relatedNotes")}</div>
          {relatedNotes.map((note) => (
            <div key={note.path} className="knowledge-rail-note">
              <button type="button" onClick={() => chooseNote(note)} title={note.title}>{note.title}</button>
              <small>{t("knowledgeRail.sameFolder")}</small>
            </div>
          ))}
          {relatedNotes.length === 0 && <p className="knowledge-rail-empty">{t("knowledgeRail.noRelated")}</p>}
        </>}
        </aside>}
      </div>
    </>}
    {root && active && <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent className="workbench-ui sm:max-w-md"><DialogHeader><DialogTitle>{c.rename}</DialogTitle><DialogDescription>{active.path}</DialogDescription></DialogHeader><label className="workbench-field"><span>{c.newNoteTitle}</span><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }} /></label><div className="mt-4 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setRenameOpen(false)}>{c.cancel}</Button><Button size="sm" disabled={!renameValue.trim()} onClick={() => void submitRename()}>{c.rename}</Button></div></DialogContent></Dialog>}
    {root && active && <Dialog open={moveOpen} onOpenChange={setMoveOpen}><DialogContent className="workbench-ui sm:max-w-md"><DialogHeader><DialogTitle>{c.moveTo}</DialogTitle><DialogDescription>{active.path}</DialogDescription></DialogHeader><label className="workbench-field"><span>{c.folderLabel}</span><select value={dest} onChange={(event) => setDest(event.target.value)}>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select></label><div className="mt-4 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setMoveOpen(false)}>{c.cancel}</Button><Button size="sm" disabled={!dest || dest === active.path.replace(/[\\/][^\\/]*$/, "")} onClick={() => void submitMove()}>{c.move}</Button></div></DialogContent></Dialog>}    <Dialog open={captureOpen} onOpenChange={setCaptureOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{c.capture}</DialogTitle><DialogDescription>{c.collectionHint}</DialogDescription></DialogHeader><CaptureForm onSaved={() => void refresh()} /></DialogContent></Dialog>
    {root && active && <Dialog open={noteInfoOpen} onOpenChange={setNoteInfoOpen}><DialogContent className="workbench-ui knowledge-note-info"><DialogHeader><DialogTitle>{c.noteInfo}</DialogTitle><DialogDescription>{active.title}</DialogDescription></DialogHeader><dl className="knowledge-info-fields"><div><dt>{c.originalPath}</dt><dd>{active.path}</dd></div><div><dt>{c.kind}</dt><dd>{categoryName(active.kind)}</dd></div>{currentCapture?.project && <div><dt>{c.originalProject}</dt><dd>{currentCapture.project}</dd></div>}{currentCapture?.source && <div><dt>{c.originalSource}</dt><dd>{currentCapture.source}</dd></div>}{currentCapture?.archivedPath && <div><dt>{c.target}</dt><dd>{currentCapture.archivedPath}</dd></div>}</dl></DialogContent></Dialog>}
    {root && launcherOpen && <OrganizationLauncher root={root} blockedPath={noteDirty ? active?.path : undefined} onClose={() => setLauncherOpen(false)} onSelected={(next) => { setLauncherOpen(false); setNotice(""); setMaterials(next); }} />}
    {root && materials && <OrganizationWorkspace root={root} materials={materials} onClose={() => setMaterials(null)} onArchived={() => { setMaterials(null); setNotice(c.archiveSuccess); setActive(null); setCategory("all"); setTag(null); queryRef.current = ""; setQuery(""); void refresh(); }} />}

  </div>;
}
