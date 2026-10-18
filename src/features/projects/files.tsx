import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, Folder, FolderOpen, MoreHorizontal, Plus, RefreshCw, Upload, X } from "lucide-react";
import { useModal } from "@/components/shell/modal-host";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { pickFile, pickFolder, openUrl, inTauri } from "@/lib/tauri";
import { flushAllStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { createProjectEntry, createProjectRoot, importProjectFile, listProjectFiles, moveProjectFile, openProjectFile, readProjectFile, trashProjectFile, writeProjectText, type ProjectDocument, type ProjectFile } from "./api";

const copy = {
  zh: { title: "项目资料", choose: "选择已有目录", createRoot: "创建项目目录", unbound: "尚未绑定资料目录", empty: "此目录为空", refresh: "刷新", new: "新建", folder: "文件夹", markdown: "Markdown 文件", text: "文本文件", import: "导入副本", importFolder: "导入文件夹副本", importMove: "移动文件到项目", moveConfirm: "将从原位置移走文件", source: "来源", target: "目标", name: "名称", rename: "重命名", move: "移动", moveHint: "输入相对于项目根目录的完整目标路径，含文件名；目标目录须已存在。", trash: "移到回收站", trashConfirm: "将此条目移到系统回收站？", open: "系统打开", root: "根目录", save: "保存", preview: "预览", edit: "编辑", saved: "已保存", dirty: "未保存", select: "选择文件查看内容", unsupported: "此格式请用系统程序打开", conflict: "磁盘文件已由其他程序更改，本地草稿已保留。", local: "本地草稿", disk: "磁盘当前内容", reload: "采用磁盘内容", reloadConfirm: "丢弃当前草稿并载入磁盘内容？", saveCopy: "另存副本", unbind: "解除绑定", unbindConfirm: "解除绑定仅移除项目关联，磁盘文件将保留。", native: "请在桌面应用中管理项目资料", close: "关闭预览", pending: "处理中…", failed: "文件操作失败", conflictKeep: "可先复制本地草稿，或另存为新文件。", importHint: "默认复制并保留来源；同名文件不会被覆盖。" },
  en: { title: "Project files", choose: "Choose existing folder", createRoot: "Create project folder", unbound: "No folder bound", empty: "This folder is empty", refresh: "Refresh", new: "New", folder: "Folder", markdown: "Markdown file", text: "Text file", import: "Import file copy", importFolder: "Import folder copy", importMove: "Move file into project", moveConfirm: "Move this file from its original location", source: "Source", target: "Destination", name: "Name", rename: "Rename", move: "Move", moveHint: "Enter the complete destination relative to the project root, including the name. The target folder must exist.", trash: "Move to Recycle Bin", trashConfirm: "Move this item to the system Recycle Bin?", open: "Open in system app", root: "Root", save: "Save", preview: "Preview", edit: "Edit", saved: "Saved", dirty: "Unsaved", select: "Select a file to preview", unsupported: "Open this format in its system app", conflict: "Another program changed this file. Your local draft is retained.", local: "Local draft", disk: "Current disk content", reload: "Use disk content", reloadConfirm: "Discard your draft and load the disk content?", saveCopy: "Save a copy", unbind: "Unbind folder", unbindConfirm: "Unbinding removes only the project association. Files remain on disk.", native: "Manage project files in the desktop application", close: "Close preview", pending: "Working…", failed: "File operation failed", conflictKeep: "Copy your draft or save it to a new file.", importHint: "Imports copy and preserve the source by default. Existing names are never overwritten." },
};
// Retain unsaved drafts when navigating to another project or leaving this page.
const drafts = new Map<string, { original: string; content: string }>();
const inFlightSaves = new Map<string, Promise<void>>();
const toolClass = "h-7 gap-1 px-2 text-xs";
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

export function ProjectFiles({ projectId, folder, onFolderChange }: { projectId: string; folder: string | null; onFolderChange: (folder: string | null) => void | Promise<void> }) {
  return <FileWorkspace key={`${projectId}:${folder ?? "unbound"}`} projectId={projectId} folder={folder} onFolderChange={onFolderChange} />;
}

function FileWorkspace({ projectId, folder, onFolderChange }: { projectId: string; folder: string | null; onFolderChange: (folder: string | null) => void | Promise<void> }) {
  const { i18n } = useTranslation();
  const c = copy[i18n.language.startsWith("zh") ? "zh" : "en"];
  const { prompt, confirm } = useModal();
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selected, setSelected] = useState<ProjectFile | null>(null);
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [original, setOriginal] = useState("");
  const [content, setContent] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const listing = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; listing.current++; }; }, []);
  const keyFor = (file: ProjectFile) => `${projectId}:${folder}:${file.path}`;
  const fail = (e: unknown) => setError(`${c.failed}: ${String(e)}`);
  const refresh = useCallback(async () => {
    if (!folder || !inTauri) return;
    const ticket = ++listing.current;
    await flushAllStorage();
    const entries = await listProjectFiles(projectId, path);
    if (mounted.current && ticket === listing.current) setFiles(entries);
  }, [folder, path, projectId]);
  useEffect(() => { void refresh().catch(e => { if (mounted.current) setError(String(e)); }); }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await flushAllStorage(); await action(); } catch (e) { if (mounted.current) fail(e); }
    finally { if (mounted.current) setBusy(false); }
  };
  const show = async (file: ProjectFile) => {
    const ticket = ++request.current;
    setSelected(file); setDocument(null); setConflict(null); setError(""); setReading(true);
    try {
      // Reopening this file in another workspace waits for its earlier save,
      // so the editor reads the new disk baseline and the retained newer draft.
      await inFlightSaves.get(keyFor(file));
      const loaded = await readProjectFile(projectId, file.path);
      if (!mounted.current || ticket !== request.current) return;
      const draft = drafts.get(keyFor(file));
      setDocument(loaded); setOriginal(draft?.original ?? loaded.content ?? ""); setContent(draft?.content ?? loaded.content ?? "");
      setConflict(draft && loaded.content !== draft.original ? loaded.content : null); setPreview(loaded.kind === "markdown" && !draft);
    } catch (e) { if (mounted.current && ticket === request.current) fail(e); }
    finally { if (mounted.current && ticket === request.current) setReading(false); }
  };
  const edit = (value: string) => {
    setContent(value); setNotice("");
    if (selected) { if (value === original && !inFlightSaves.has(keyFor(selected))) drafts.delete(keyFor(selected)); else drafts.set(keyFor(selected), { original, content: value }); }
  };
  const save = () => {
    if (!selected || busy) return;
    const file = selected, key = keyFor(file), expected = original, submitted = content;
    const ticket = request.current;
    if (inFlightSaves.has(key)) return;
    // Keep an explicit draft while saving, including edits that revert to the
    // previous baseline: they become unsaved again once submitted reaches disk.
    drafts.set(key, { original: expected, content: submitted });
    const saving = run(async () => {
      try {
        await writeProjectText(projectId, file.path, expected, submitted);
        const latest = drafts.get(key)?.content ?? submitted;
        if (latest === submitted) drafts.delete(key);
        else drafts.set(key, { original: submitted, content: latest });
        if (mounted.current && ticket === request.current) {
          setOriginal(submitted); setConflict(null); setNotice(latest === submitted ? c.saved : "");
        }
        if (mounted.current) await refresh();
      } catch (e) {
        if (String(e).includes("file-conflict")) {
          const current = await readProjectFile(projectId, file.path);
          if (mounted.current && ticket === request.current) { setConflict(current.content ?? ""); setError(c.conflict); }
        } else throw e;
      }
    });
    inFlightSaves.set(key, saving);
    void saving.finally(() => {
      if (inFlightSaves.get(key) === saving) inFlightSaves.delete(key);
      const latest = drafts.get(key);
      if (latest?.content === latest?.original) drafts.delete(key);
    });
    return saving;
  };
  const make = async (kind: "folder" | "text" | "markdown") => {
    const name = await prompt({ title: `${c.new} · ${kind === "folder" ? c.folder : kind === "text" ? c.text : c.markdown}`, placeholder: c.name });
    if (!name) return;
    await run(async () => { await createProjectEntry(projectId, path, name, kind); await refresh(); });
  };
  const importFrom = async (directory = false, move = false) => {
    let source: string | null;
    try { source = await (directory ? pickFolder() : pickFile()); } catch (error) { fail(error); return; }
    if (!source) return;
    if (move && !await confirm({ title: c.moveConfirm, description: <div className="break-all text-xs">{c.source}: {source}<br />{c.target}: {folder}/{path}</div>, confirmText: c.move })) return;
    await run(async () => { await importProjectFile(projectId, source, path, move); await refresh(); });
  };
  const relocate = async (file: ProjectFile, rename: boolean) => {
    const entered = await prompt({ title: rename ? c.rename : c.move, initial: rename ? file.name : file.path, description: rename ? undefined : c.moveHint });
    if (!entered) return;
    const destination = rename ? [parentOf(file.path), entered].filter(Boolean).join("/") : entered;
    await run(async () => {
      const moved = await moveProjectFile(projectId, file.path, destination);
      const prefix = `${projectId}:${folder}:`;
      for (const [key, draft] of [...drafts]) {
        if (key === keyFor(file) || key.startsWith(`${keyFor(file)}/`)) {
          drafts.set(`${prefix}${moved}${key.slice(keyFor(file).length)}`, draft); drafts.delete(key);
        }
      }
      if (selected && (selected.path === file.path || selected.path.startsWith(`${file.path}/`))) {
        const next = `${moved}${selected.path.slice(file.path.length)}`;
        setSelected({ ...selected, path: next, name: next.split("/").slice(-1)[0] ?? selected.name });
      }
      await refresh();
    });
  };
  const remove = async (file: ProjectFile) => {
    if (!await confirm({ title: c.trashConfirm, description: <span className="break-all text-xs">{folder}/{file.path}</span>, confirmText: c.trash, danger: true })) return;
    await run(async () => { await trashProjectFile(projectId, file.path); if (selected?.path === file.path) { setSelected(null); setDocument(null); request.current++; } await refresh(); });
  };
  const saveCopy = async () => {
    if (!selected) return;
    const name = await prompt({ title: c.saveCopy, initial: `copy-${selected.name}` });
    if (!name) return;
    await run(async () => {
      const created = await createProjectEntry(projectId, parentOf(selected.path), name, document?.kind === "markdown" ? "markdown" : "text");
      await writeProjectText(projectId, created, "", content); await refresh(); setNotice(c.saved);
    });
  };
  if (!inTauri) return <p className="p-3 text-xs text-muted-foreground">{c.native}</p>;
  if (!folder) return <section aria-label={c.title} className="space-y-2 py-3"><p className="text-xs text-muted-foreground">{c.unbound}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" className={toolClass} disabled={busy} onClick={() => void run(async () => { const picked = await pickFolder(); if (picked) await onFolderChange(picked); })}>{c.choose}</Button><Button size="sm" variant="outline" className={toolClass} disabled={busy} onClick={() => void run(async () => { const root = await createProjectRoot(projectId); await onFolderChange(root); })}>{c.createRoot}</Button></div>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</section>;
  const editable = document?.kind === "text" || document?.kind === "markdown";
  return <section aria-label={c.title} aria-busy={busy || reading} className="flex min-h-64 flex-col text-xs">
    <div className="flex flex-wrap items-center gap-1 border-b py-2">
      <nav aria-label={c.title} className="mr-auto flex min-w-0 flex-wrap items-center gap-1"><button className="rounded px-1 py-1 text-muted-foreground hover:bg-muted" onClick={() => setPath("")} title={folder}>{c.root}</button>{path.split("/").filter(Boolean).map((part, index, parts) => <span key={index} className="flex items-center gap-1"><span className="text-muted-foreground">/</span><button className="max-w-32 truncate rounded px-1 py-1 hover:bg-muted" onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav>
      <Button size="sm" variant="ghost" className={toolClass} disabled={busy} title={c.refresh} aria-label={c.refresh} onClick={() => void run(async () => { await refresh(); if (selected) await show(selected); })}><RefreshCw className="size-3.5" /></Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={toolClass} disabled={busy}><Plus className="size-3.5" />{c.new}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => void make("markdown")}>{c.markdown}</DropdownMenuItem><DropdownMenuItem onSelect={() => void make("text")}>{c.text}</DropdownMenuItem><DropdownMenuItem onSelect={() => void make("folder")}>{c.folder}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={toolClass} disabled={busy} title={c.importHint}><Upload className="size-3.5" />{c.import}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => void importFrom()}>{c.import}</DropdownMenuItem><DropdownMenuItem onSelect={() => void importFrom(true)}>{c.importFolder}</DropdownMenuItem><DropdownMenuItem onSelect={() => void importFrom(false, true)}>{c.importMove}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className={toolClass} aria-label={c.title}><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => void run(() => openProjectFile(projectId))}>{c.open}</DropdownMenuItem><DropdownMenuItem onSelect={() => void (async () => { if (await confirm({ title: c.unbind, description: c.unbindConfirm })) await onFolderChange(null); })()}>{c.unbind}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div>
    {error && <p role="alert" className="break-all py-2 text-destructive">{error}</p>}
    <div className={cn("grid min-h-0 flex-1", selected ? "grid-cols-1 gap-3 lg:grid-cols-[minmax(150px,0.8fr)_minmax(0,1.8fr)]" : "grid-cols-1")}>
      <div className="min-h-0 overflow-auto py-1">{files.length === 0 && <p className="py-5 text-muted-foreground">{c.empty}</p>}{files.map(file => <div key={file.path} className={cn("group flex items-center rounded hover:bg-muted", selected?.path === file.path && "bg-muted")}>
        <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left" disabled={busy} onClick={() => file.directory ? setPath(file.path) : void show(file)} title={file.name}>{file.directory ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}<span className="truncate">{file.name}</span></button>
        <DropdownMenu><DropdownMenuTrigger asChild><button disabled={busy} className="rounded p-1.5 text-muted-foreground hover:bg-accent" aria-label={`${file.name} · ${c.title}`}><MoreHorizontal className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => void run(() => openProjectFile(projectId, file.path))}>{c.open}</DropdownMenuItem><DropdownMenuItem onSelect={() => void relocate(file, true)}>{c.rename}</DropdownMenuItem><DropdownMenuItem onSelect={() => void relocate(file, false)}>{c.move}</DropdownMenuItem><DropdownMenuItem className="text-destructive" onSelect={() => void remove(file)}>{c.trash}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>)}</div>
      {selected && <div className="min-w-0 border-t py-2 lg:border-l lg:border-t-0 lg:pl-3"><div className="mb-2 flex items-center gap-1"><span className="mr-auto truncate font-medium" title={selected.path}>{selected.name}</span>{editable && <><span role="status" className="shrink-0 text-[10px] text-muted-foreground">{content !== original ? c.dirty : notice}</span>{document.kind === "markdown" && <Button size="sm" variant="ghost" className={toolClass} onClick={() => setPreview(!preview)}>{preview ? c.edit : c.preview}</Button>}<Button size="sm" variant="outline" className={toolClass} disabled={busy || content === original || conflict !== null} onClick={() => void save()}>{c.save}</Button></>}<Button size="sm" variant="ghost" className={toolClass} title={c.open} aria-label={c.open} disabled={busy} onClick={() => void run(() => openProjectFile(projectId, selected.path))}><FolderOpen className="size-3.5" /></Button><button className="rounded p-1 hover:bg-muted" aria-label={c.close} onClick={() => { request.current++; setSelected(null); setDocument(null); }}><X className="size-3.5" /></button></div>
        {reading && <p role="status" className="py-5 text-muted-foreground">{c.pending}</p>}
        {conflict !== null && <div className="mb-3 space-y-2 border-l-2 border-amber-500 pl-3"><p>{c.conflict}</p><p className="text-muted-foreground">{c.conflictKeep}</p><div className="grid grid-cols-1 gap-2 xl:grid-cols-2"><div><p className="mb-1 font-medium">{c.local}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{content}</pre></div><div><p className="mb-1 font-medium">{c.disk}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{conflict}</pre></div></div><div className="flex gap-2"><Button variant="outline" size="sm" className={toolClass} onClick={() => void (async () => { if (await confirm({ title: c.reloadConfirm })) { setOriginal(conflict); setContent(conflict); setConflict(null); setError(""); drafts.delete(keyFor(selected)); } })()}>{c.reload}</Button><Button variant="outline" size="sm" className={toolClass} disabled={busy} onClick={() => void saveCopy()}>{c.saveCopy}</Button></div></div>}
        {editable && (preview ? <div className="knowledge-markdown max-h-[60vh] overflow-auto break-words leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^https?:\/\//i.test(url) || url.startsWith("#") ? url : ""} components={{ img: ({ alt }) => <span className="text-muted-foreground">[{alt}]</span>, a: ({ href, children }) => <a href={href} className="text-primary underline underline-offset-2" onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void openUrl(href).catch(fail); }}>{children}</a> }}>{content}</ReactMarkdown></div> : <textarea aria-label={`${selected.name} · ${c.edit}`} className="min-h-64 w-full resize-y rounded border bg-transparent p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={content} onChange={e => edit(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (!busy && conflict === null) void save(); } }} />)}
        {document?.kind === "image" && document.dataUrl && <img src={document.dataUrl} alt={selected.name} className="max-h-[60vh] max-w-full object-contain" />}
        {document?.kind === "external" && <p className="py-8 text-center text-muted-foreground">{c.unsupported}</p>}
      </div>}
    </div>
  </section>;
}
