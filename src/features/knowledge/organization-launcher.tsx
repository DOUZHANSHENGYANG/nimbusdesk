import { useEffect, useRef, useState } from "react";
import { RiCloseLine, RiSearchLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { listCaptures, readNote, scanNotes } from "./api";
import { useKnowledgeCopy } from "./copy";
import { loadOrganizationMaterials } from "./organization-materials";
import type { OrganizeMaterial } from "./organize";
import type { CaptureRecord, KnowledgeNote } from "./types";
import "./organization-launcher.css";

export function OrganizationLauncher({ root, blockedPath, onClose, onSelected }: {
  root: string;
  blockedPath?: string;
  onClose: () => void;
  onSelected: (materials: OrganizeMaterial[]) => void;
}) {
  const c = useKnowledgeCopy();
  const en = c.all === "All";
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "inbox">("all");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const running = useRef(false);
  const latestBlockedPath = useRef(blockedPath);
  latestBlockedPath.current = blockedPath;
  useEffect(() => {
    const token = ++generation.current;
    setLoading(true); setError(""); setNotes([]); setCaptures([]); setSelected(new Set());
    void Promise.all([scanNotes(root), listCaptures(root)]).then(([nextNotes, nextCaptures]) => {
      if (generation.current !== token) return;
      setNotes(nextNotes); setCaptures(nextCaptures);
    }).catch((failure) => { if (generation.current === token) setError(String(failure)); })
      .finally(() => { if (generation.current === token) setLoading(false); });
    return () => { generation.current++; };
  }, [root, reload]);
  useEffect(() => {
    if (blockedPath) setSelected((old) => new Set([...old].filter((path) => path !== blockedPath)));
  }, [blockedPath]);

  const needle = query.trim().toLocaleLowerCase();
  const archivedPaths = new Set(captures.filter((capture) => capture.status === "archived").map((capture) => capture.notePath));
  const inboxNotes = notes.filter((note) => note.kind === "inbox" && !archivedPaths.has(note.path));
  const visible = (scope === "inbox" ? inboxNotes : notes).filter((note) => !needle || `${note.title} ${note.path}`.toLocaleLowerCase().includes(needle));
  function toggle(path: string, checked: boolean) {
    setSelected(checked ? new Set([path]) : new Set());
  }
  function close() { generation.current++; onClose(); }
  async function enter() {
    if (running.current || loading || selected.size === 0) return;
    const token = generation.current;
    running.current = true; setReading(true); setError("");
    try {
      const materials = await loadOrganizationMaterials(notes, captures, [...selected], (path) => readNote(root, path), blockedPath);
      if (materials.some((material) => material.note.path === latestBlockedPath.current)) throw new Error(c.saveBeforeAI);
      if (generation.current === token) onSelected(materials);
    } catch (failure) { if (generation.current === token) setError(String(failure)); }
    finally { running.current = false; if (generation.current === token) setReading(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent showCloseButton={false} className="organization-launcher workbench-ui" aria-busy={loading || reading}>
      <DialogHeader className="organization-launcher-header">
        <div><DialogTitle>{c.manual}</DialogTitle><DialogDescription>{en ? "Choose a note to edit, classify and archive." : "选择一篇笔记，手动编辑、分类并归档。"}</DialogDescription></div>
        <Button variant="ghost" size="icon-sm" aria-label={c.cancelled} onClick={close}><RiCloseLine /></Button>
      </DialogHeader>
      <div className="organization-launcher-controls">
        <label className="organization-launcher-search"><RiSearchLine /><Input aria-label={en ? "Search material" : "搜索整理材料"} placeholder={en ? "Search title or path" : "搜索标题或路径"} value={query} disabled={reading} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="organization-launcher-selection">
          <div className="organization-launcher-scopes" role="group" aria-label={en ? "Material scope" : "材料范围"}>
            <button type="button" aria-pressed={scope === "all"} disabled={reading} onClick={() => setScope("all")}>{en ? "All material" : "全部材料"}<span>{notes.length}</span></button>
            <button type="button" aria-pressed={scope === "inbox"} disabled={reading} onClick={() => setScope("inbox")}>{c.inbox}<span>{inboxNotes.length}</span></button>
          </div>
          <div className="organization-launcher-bulk"><Button variant="ghost" size="sm" disabled={reading || selected.size === 0} onClick={() => setSelected(new Set())}>{en ? "Clear" : "清除"}</Button></div>
        </div>
      </div>
      {blockedPath && <p className="organization-launcher-notice">{en ? "The note with unsaved edits is unavailable. Save it to include it, or select other notes." : "当前未保存的笔记暂不可选；可先保存，或选择其他材料。"}</p>}
      {error && <div className="organization-launcher-error" role="alert"><p>{error}</p>{!reading && <Button variant="outline" size="sm" onClick={() => { if (selected.size > 0) void enter(); else setReload((old) => old + 1); }}>{c.retry}</Button>}</div>}
      <div className="organization-launcher-list" aria-label={en ? "Available material" : "可选整理材料"}>
        {loading ? <p className="organization-launcher-empty" role="status">{c.loading}</p> : visible.length === 0 ? <p className="organization-launcher-empty">{notes.length === 0 ? c.empty : c.noMatching}</p> : visible.map((note) => <label key={note.path} className="organization-launcher-row" data-disabled={note.path === blockedPath || undefined}>
          <Checkbox checked={selected.has(note.path)} disabled={reading || note.path === blockedPath} onCheckedChange={(checked) => toggle(note.path, checked === true)} aria-label={`${en ? "Select" : "选择"} ${note.title}`} />
          <span className="organization-launcher-note"><strong title={note.title}>{note.title}</strong><small title={note.path}>{note.path === blockedPath ? (en ? "Unsaved edits" : "尚未保存") : note.path}</small></span>
          <span className="organization-launcher-kind">{c[note.kind]}</span>
        </label>)}
      </div>
      <div className="organization-launcher-footer">
        <div><strong aria-live="polite">{en ? `${selected.size} selected` : `已选 ${selected.size} 条材料`}</strong><p>{en ? "Only selected sources are loaded. Nothing is sent to AI or written in this step." : "此步骤仅载入所选原文，不会发送 AI 或写入文件。"}</p></div>
        <div><Button variant="outline" onClick={close}>{c.cancelled}</Button><Button disabled={loading || reading || selected.size === 0} onClick={() => void enter()}>{reading ? c.loading : (en ? "Continue to organize" : "进入整理")}</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}
