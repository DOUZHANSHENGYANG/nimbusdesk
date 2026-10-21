import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RiBookOpenLine as BookOpen, RiFolderOpenLine as FolderOpen, RiAddLine as Plus, RiRefreshLine as RefreshCw, RiSearchLine as Search, RiMagicLine as Sparkles, RiArrowDownSLine as ChevronDown, RiArrowLeftSLine, RiArrowRightSLine, RiCloseLine, RiMoreLine, RiSettings3Line, RiListCheck } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { pickFolder, openPath, revealInExplorer, openUrl, inTauri } from "@/lib/tauri";
import { bindVault, scanNotes, searchNotes, listCaptures, readNote, openCaptureWindow } from "./api";
import { useKnowledge } from "./store";
import { useKnowledgeCopy } from "./copy";
import { CaptureForm } from "./capture";
import { NoteReader } from "./note-reader";
import type { OrganizeMaterial } from "./organize";
import { OrganizationWorkspace } from "./organization-workspace";
import { OrganizationLauncher } from "./organization-launcher";
import { startOrganization, setOrganizationBlockedPath } from './background-organization';
import { useOrganizationJobs } from './organization-jobs';
import { organizationWritesNote } from './background-organization-core';
import { TagBrowser, UNTAGGED, noteTags } from "./tag-browser";
import { NoteTags } from "./note-tags";
import type { CaptureRecord, KnowledgeNote, NoteKind, ReadNote } from "./types";
import "./knowledge-workspace.css";

const categories = ["all", "inbox", "experience", "recipe", "resource"] as const;
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
  const { t, i18n } = useTranslation();
  const name = useKnowledge((s) => s.vaultName);
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [category, setCategory] = useState<typeof categories[number]>("all");
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
  const [submitting, setSubmitting] = useState(false);
  const job = useOrganizationJobs(state=>state.job);
  const [noteInfoOpen, setNoteInfoOpen] = useState(false);
  const [materials, setMaterials] = useState<OrganizeMaterial[] | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const noteItems = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const initiallySelected = useRef(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const organizing = job?.status === 'running' || job?.status === 'stopping';
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
        setNotes(nextNotes); setCaptures(nextCaptures);
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
  async function organizeInBackground(){
    if(!root||submitting)return;
    setSubmitting(true);setError('');setNotice('');
    try{await startOrganization({root,blockedPaths:noteDirty&&active?[active.path]:[],trigger:'manual'});}
    catch(failure){setError(failure instanceof Error?failure.message:String(failure));}
    finally{if(mounted.current)setSubmitting(false);}
  }
  function noteSaved(saved: ReadNote) { readRequest.current++; setReading(false); setDetail(saved); void refresh(); }
  function chooseTag(value: string | null) { setTag(value); }
  function chooseNote(note: KnowledgeNote) {
    initiallySelected.current = true;
    if (active?.path !== note.path) setNoteDirty(true);
    setNoteInfoOpen(false);
    setActive(note);
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
  const categoryName = (kind: NoteKind | "all") => c[kind];
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
        <span className="knowledge-vault-name"><span>Obsidian</span><strong>{name || c.bind}</strong></span>
        <span className="knowledge-vault-change">{c.changeVault}<ChevronDown /></span>
      </button>
      <div className="knowledge-header-actions">
      {root && <><Button variant="ghost" size="icon" title={c.refresh} aria-label={c.refresh} onClick={() => void refresh()} disabled={loading || binding}><RefreshCw className={loading ? "animate-spin" : ""} /></Button><div className="knowledge-organization-actions"><Button className="knowledge-organize-button" variant="outline" size="sm" disabled={binding||submitting||organizing} onClick={() => void organizeInBackground()}><Sparkles /><span>{organizing ? c.organizingNow : c.autoOrganize}</span></Button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={c.organizationOptions} title={c.organizationOptions}><RiMoreLine /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="workbench-ui knowledge-note-menu"><DropdownMenuItem disabled={binding||organizing} onSelect={() => setLauncherOpen(true)}><RiListCheck />{c.manual}</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/settings?tab=knowledge")}><RiSettings3Line />{c.organizationSettings}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><Button size="sm" onClick={() => { if (inTauri) void openCaptureWindow().catch((e) => setError(String(e))); else setCaptureOpen(true); }}><Plus />{c.capture}</Button></>}
    </div></header>
    {error && !materials && <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!root ? <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-8"><BookOpen className="size-10 text-muted-foreground" /><p className="text-sm">{c.unbound}</p><p className="text-xs text-muted-foreground">{c.bindHint}</p><Button onClick={() => void bind()}>{c.bind}</Button></div> : <>
      <div className="knowledge-controls">
        <div className="knowledge-filter-bar">
          <nav aria-label={c.title} className="knowledge-categories">{categories.map((kind) => <button key={kind} type="button" aria-pressed={category === kind} onClick={() => setCategory(kind)}>{categoryName(kind)}<span>{notes.filter((note) => (kind === "all" || note.kind === kind) && (kind !== "inbox" || captureForPath.get(note.path)?.status !== "archived")).length}</span></button>)}</nav>
          <div className="knowledge-search-field knowledge-main-search"><Search aria-hidden="true" /><input ref={searchInput} type="search" aria-label={c.search} placeholder={c.search} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} /><span className="knowledge-search-suffix">{query ? <button type="button" aria-label={c.clearSearch} title={c.clearSearch} onClick={() => { setQuery(""); searchInput.current?.focus(); }}><RiCloseLine /></button> : <kbd aria-hidden="true" title="Ctrl+F">/</kbd>}</span></div>
        </div>
        <TagBrowser notes={categoryNotes} selected={tag} onSelect={chooseTag} />
      </div>
      <div className="knowledge-reading-layout">
        <aside className="knowledge-note-list" aria-label={c.notesLabel}>
          <div className="knowledge-list-heading"><h2>{categoryName(category)}</h2><span aria-live="polite">{loading && <RefreshCw className="animate-spin" aria-label={c.loading} />}{filtered.length} {c.noteCount}</span></div>
          <div ref={noteItems} className="knowledge-note-items" onKeyDown={navigateNotes} aria-busy={loading}>{loading && !pageNotes.length && <p role="status" className="knowledge-list-message">{c.loading}</p>}{!loading && filtered.length === 0 && <div className="knowledge-list-message"><p>{needle || tag ? c.noMatching : c.empty}</p>{(needle || tag || category !== "all") && <button onClick={clearFilters}>{c.resetFilters}</button>}</div>}{pageNotes.map((note) => {
          return <div key={note.path} className="knowledge-note-item" data-active={active?.path === note.path}>
            <button className="knowledge-note-open" title={note.title} aria-current={active?.path === note.path ? "true" : undefined} onClick={() => chooseNote(note)}><h3>{note.title}</h3><span className="knowledge-note-category">{categoryName(note.kind)}</span></button>
          </div>;
        })}</div><nav className="knowledge-pagination" aria-label={c.notePagination}><Button variant="ghost" size="icon" aria-label={c.previousPage} disabled={currentPage === 0} onClick={() => setPageIndex(currentPage - 1)}><RiArrowLeftSLine /></Button><span aria-live="polite">{currentPage + 1} / {totalPages}</span><Button variant="ghost" size="icon" aria-label={c.nextPage} disabled={currentPage >= totalPages - 1} onClick={() => setPageIndex(currentPage + 1)}><RiArrowRightSLine /></Button></nav></aside>
        <article className="knowledge-reader-pane" aria-label={c.readingMode}>{!active ? <div className="knowledge-reader-empty"><span className="knowledge-reader-empty-icon"><BookOpen /></span><h2>{c.readingMode}</h2><p>{c.readerHint}</p></div> : <div className="knowledge-note-document">
          {!loading && !filtered.some((note) => note.path === active.path) && <div className="knowledge-outside-filter" role="status"><span>{c.readingOutsideFilter}</span><button onClick={clearFilters}>{c.resetFilters}</button></div>}
          {detail?.path === active.path ? <NoteReader key={detail.path} root={root} note={detail} title={active.title} onOpen={handleOpen} onInfo={() => setNoteInfoOpen(true)} recipe={active.kind === "recipe"} onSaved={noteSaved} onDirtyChange={setNoteDirty} /> : reading && <p role="status" className="p-5 text-sm text-muted-foreground">{c.loading}</p>}
        </div>}</article>
        {/* 第三列：文档信息常驻。弹窗只留「采集来源」那几项（原始项目/来源/目标），
            两处不重复：这里放当前文档本身的事实，以及可以直接改的标签。 */}
        {active && <aside className="knowledge-info-rail" aria-label={c.noteInfo}>
          <h2>{c.noteInfo}</h2>
          <div className="knowledge-rail-row"><span>{c.originalPath}</span><b title={active.path}>{active.path}</b></div>
          <div className="knowledge-rail-row"><span>{c.kind}</span><b>{categoryName(active.kind)}</b></div>
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
        </aside>}
      </div>
    </>}
    <Dialog open={captureOpen} onOpenChange={setCaptureOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{c.capture}</DialogTitle><DialogDescription>{c.collectionHint}</DialogDescription></DialogHeader><CaptureForm onSaved={() => void refresh()} /></DialogContent></Dialog>
    {root && active && <Dialog open={noteInfoOpen} onOpenChange={setNoteInfoOpen}><DialogContent className="workbench-ui knowledge-note-info"><DialogHeader><DialogTitle>{c.noteInfo}</DialogTitle><DialogDescription>{active.title}</DialogDescription></DialogHeader><dl className="knowledge-info-fields"><div><dt>{c.originalPath}</dt><dd>{active.path}</dd></div><div><dt>{c.kind}</dt><dd>{categoryName(active.kind)}</dd></div>{currentCapture?.project && <div><dt>{c.originalProject}</dt><dd>{currentCapture.project}</dd></div>}{currentCapture?.source && <div><dt>{c.originalSource}</dt><dd>{currentCapture.source}</dd></div>}{currentCapture?.archivedPath && <div><dt>{c.target}</dt><dd>{currentCapture.archivedPath}</dd></div>}</dl></DialogContent></Dialog>}
    {root && launcherOpen && <OrganizationLauncher root={root} blockedPath={noteDirty ? active?.path : undefined} onClose={() => setLauncherOpen(false)} onSelected={(next) => { setLauncherOpen(false); setNotice(""); setMaterials(next); }} />}
    {root && materials && <OrganizationWorkspace root={root} materials={materials} onClose={() => setMaterials(null)} onArchived={(result) => { setMaterials(null); setNotice(c.archiveSuccess); setActive(result); setCategory(result.kind === "note" ? "all" : result.kind); setTag(null); queryRef.current = ""; setQuery(""); void refresh(); }} />}

  </div>;
}
