import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openUrl, pickFiles } from "@/lib/tauri";
import { useManagerCopy } from "./manager-copy";
import { importNoteFile, moveNote, readNote, scanNotes, updateNote } from "./api";
import { inferType, normalizeStatus } from "./batch";
import { withField } from "./metadata";
import * as tools from "./vault-tools";
import type { HealthReport, LoopStatus, TriageStatus } from "./vault-tools";
import type { KnowledgeNote } from "./types";
import "./vault-manager.css";

/**
 * 管理面：一张表 + 上方筛选。
 *
 * 待审 → 点「审核」开对话框（左边输入、右边输出、下面定归档路径）；
 * 待归档 → 一行一个「归档」，实际搬运仍交给 archive.py；
 * 经验 → 只读表格。
 */
type Face = "inbox" | "review" | "archive" | "loop" | "cold";
type Filter = "all" | "agent" | "human";

const TYPES = ["技术知识", "项目经验", "项目研究", "业务知识", "学习笔记", "个人成长", "日记", "资源收藏", "会议记录", "会话记录", "MOC", "模板"];
/** 与 archive.py 的 DEFAULT_DEST 保持一致；config 的 dest_map 可以覆盖，界面上只做建议。 */
const TYPE_DEST: Record<string, string> = {
  "技术知识": "02-IT",
  "项目经验": "02-IT/07-项目经验",
  "项目研究": "02-IT/06-项目研究",
  "业务知识": "01-工作",
  "学习笔记": "03-生活/01-学习",
  "个人成长": "03-生活/02-计划",
  "日记": "03-生活/03-草稿",
  "资源收藏": "04-资源",
  "会议记录": "01-工作/04-项目管理",
  "会话记录": "00-Agent工作区/wiki",
};
const REVIEWED = { human: "00-Human工作区/已审核", agent: "00-Agent工作区/已审核" };
const TRASH = { human: "00-Human工作区/Trash", agent: "00-Agent工作区/Trash" };

export function VaultManager({ root }: { root: string }) {
  const c = useManagerCopy();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [triage, setTriage] = useState<TriageStatus | null>(null);
  const [loop, setLoop] = useState<LoopStatus | null>(null);
  const [inbox, setInbox] = useState<KnowledgeNote[]>([]);
  const [face, setFace] = useState<Face>("review");
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewing, setReviewing] = useState<KnowledgeNote | null>(null);
  const [preview, setPreview] = useState("");
  const [type, setType] = useState("技术知识");
  const [dest, setDest] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(""); setLoading(true);
    const [h, t, l, notes] = await Promise.allSettled([
      tools.healthReport(root),
      tools.triageStatus(root),
      tools.loopStatus(root),
      scanNotes(root),
    ]);
    if (h.status === "fulfilled") setHealth(h.value);
    else setError(asMessage(h.reason));
    if (t.status === "fulfilled") setTriage(t.value);
    if (l.status === "fulfilled") setLoop(l.value);
    if (notes.status === "fulfilled") setInbox(notes.value);
    setLoading(false);
  }, [root]);

  useEffect(() => { void load(); }, [load]);

  const pending = useMemo(() => inbox.filter((note) =>
    (note.path.startsWith("00-Agent工作区/Inbox/") || note.path.startsWith("00-Human工作区/Inbox/"))
    && !note.path.includes("/_raw/") && !note.path.includes("/工作台/")), [inbox]);

  const pendingPaths = useMemo(() => new Set(pending.map((note) => note.path)), [pending]);

  const mechanical = useMemo(() => {
    const groups = health?.groups ?? [];
    const pick = (id: string) => (groups.find((group) => group.id === id)?.items ?? []).filter((item) => pendingPaths.has(item.path));
    return { status: pick("bad_status"), bom: pick("bom_md"), ps1: pick("nobom_ps1") };
  }, [health, pendingPaths]);
  const mechanicalCount = mechanical.status.length + mechanical.bom.length + mechanical.ps1.length;

  const reminders = (health?.groups ?? []).filter((group) => group.id === "draft_old" || group.id === "unclosed");

  const who = (path: string): "human" | "agent" => path.startsWith("00-Human工作区/") ? "human" : "agent";
  const match = (value: "human" | "agent") => filter === "all" || filter === value;

  const inboxRows = pending.filter((note) => note.path.startsWith("00-Human工作区/") && match("human"));
  const reviewRows = pending.filter((note) => note.path.startsWith("00-Agent工作区/") && match("agent"));
  const coldRows = loop?.coldItems ?? [];
  const archiveRows = (triage?.ready ?? []).filter((item) => match(item.who === "human" ? "human" : "agent"));
  const problemRows = (triage?.problems ?? []).filter((item) => match(item.who === "human" ? "human" : "agent"));
  const loopRows = loop?.concepts ?? [];

  const archiveCount = (triage?.ready.length ?? 0) + (health?.groups.find((group) => group.id === "inbox")?.items.length ?? 0);

  async function openReview(note: KnowledgeNote) {
    setReviewing(note); setError(""); setPreview("");
    const guess = inferType(note.path);
    setType(guess); setDest(TYPE_DEST[guess] ?? "");
    try { setPreview((await readNote(root, note.path)).content.slice(0, 4000)); }
    catch (e) { setError(asMessage(e)); }
  }

  /** 一键修：Inbox 里的状态写法 + 全库隐藏字符（库内脚本干）。 */
  async function fixStatic() {
    setBusy(true); setError(""); setMessage("");
    let fixed = 0;
    for (const item of mechanical.status) {
      try {
        const note = await readNote(root, item.path);
        await updateNote(root, { path: item.path, content: withField(note.content, "status", normalizeStatus(item.detail ?? "")), fingerprint: note.fingerprint });
        fixed += 1;
      } catch (e) { setError(asMessage(e)); }
    }
    try { await tools.fixBom(root); } catch (e) { setError(asMessage(e)); }
    await load();
    setMessage(c.fixedStatic.replace("{status}", String(fixed)).replace("{files}", String(mechanical.bom.length + mechanical.ps1.length)));
    setBusy(false);
  }

  /** 通过：写 type / archive_to → 进同区「已审核」。 */
  async function approve(note: KnowledgeNote) {
    const zone = who(note.path);
    setBusy(true); setError("");
    try {
      const read = await readNote(root, note.path);
      let content = withField(read.content, "type", type);
      content = withField(content, "archive_to", dest || (TYPE_DEST[type] ?? ""));
      await updateNote(root, { path: note.path, content, fingerprint: read.fingerprint });
      const path = await moveNote(root, note.path, REVIEWED[zone]);
      setReviewing(null);
      await load();
      setMessage(c.reviewApproved.replace("{path}", path));
    } catch (e) { setError(asMessage(e)); }
    finally { setBusy(false); }
  }

  async function reject(note: KnowledgeNote) {
    setBusy(true); setError("");
    try {
      const path = await moveNote(root, note.path, TRASH[who(note.path)]);
      setReviewing(null);
      await load();
      setMessage(c.reviewRejected.replace("{path}", path));
    } catch (e) { setError(asMessage(e)); }
    finally { setBusy(false); }
  }

  async function upload() {
    const sources = await pickFiles().catch(() => [] as string[]);
    if (!sources.length) return;
    let ok = 0;
    for (const source of sources) {
      try { await importNoteFile(root, source, "00-Human工作区/Inbox"); ok += 1; }
      catch (e) { setError(asMessage(e)); }
    }
    await load();
    setMessage(c.uploaded.replace("{n}", String(ok)));
  }

  async function archiveNow() {
    setBusy(true); setError(""); setMessage("");
    try { await tools.triageRun(root); await load(); setMessage(c.doneArchive); }
    catch (e) { setError(asMessage(e)); }
    finally { setBusy(false); }
  }

  const faces: { id: Face; label: string }[] = [
    { id: "inbox", label: `${c.tabsInbox} ${inboxRows.length}` },
    { id: "review", label: `${c.tabsReview} ${reviewRows.length}` },
    { id: "archive", label: `${c.tabsArchive} ${archiveCount}` },
    { id: "loop", label: `${c.tabsLoop} ${loopRows.length}` },
    { id: "cold", label: `${c.tabsCold} ${coldRows.length}` },
  ];
  const sourceFiltered = face === "inbox" || face === "review" || face === "archive";

  return <div className="vm-plain">
    <div className="vm-toolbar">
      <nav className="vm-tabs" aria-label={c.centerTitle}>
        {faces.map((item) => <button key={item.id} type="button" aria-pressed={face === item.id}
          onClick={() => { setFace(item.id); setMessage(""); }}>{item.label}</button>)}
      </nav>
      {sourceFiltered && <div className="vm-filter-select"><span>{c.filterLabel}</span>
        <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <SelectTrigger size="sm" aria-label={c.filterLabel}><SelectValue /></SelectTrigger>
          <SelectContent className="workbench-ui">
            <SelectItem value="all">{c.filterAll}</SelectItem>
            <SelectItem value="agent">{c.filterAgent}</SelectItem>
            <SelectItem value="human">{c.filterHuman}</SelectItem>
          </SelectContent>
        </Select>
      </div>}
      {face === "review" && reminders.map((group) => <details key={group.id} className="vm-reminder-badge">
        <summary title={group.items.slice(0, 5).map((item) => item.path).join("\n")}>{c.reminderBadge[group.id] ?? group.label}<span>{group.items.length}</span></summary>
        <p>{c.reminders[group.id]?.replace("{n}", String(group.items.length)) ?? group.label}</p>
      </details>)}
      <div className="vm-toolbar-actions">
        {face === "inbox" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void upload()}>{c.uploadToInbox}</Button>}
        {face === "archive" && archiveRows.length > 0 && <Button size="sm" disabled={busy} onClick={() => void archiveNow()}>{c.runArchive}</Button>}
      </div>
    </div>

    {face === "loop" && <p className="vm-reminder">{c.loopDefine}</p>}
    {message && <p role="status" className="vm-message">{message}</p>}
    {error && <p role="alert" className="vm-error">{error}</p>}

    {face === "inbox" && <Table
      head={[c.colName, c.colSource, c.colAction]}
      empty={loading ? c.common.loading : c.inboxEmpty}
      rows={inboxRows.map((note) => ({
        key: note.path,
        cells: [
          <span className="vm-cell-name">{note.title}</span>,
          <Badge value={who(note.path)} label={who(note.path) === "human" ? c.filterHuman : c.filterAgent} />,
          <Button size="sm" variant="outline" onClick={() => openNote(root, note.path)}>{c.colOpen}</Button>,
        ],
      }))}
    />}

    {face === "review" && <>
      {mechanicalCount > 0 && <div className="vm-strip">
        <span>{c.needFix.replace("{n}", String(mechanicalCount))}</span>
        <button type="button" className="vm-strip-action" disabled={busy} onClick={() => void fixStatic()}>{c.fixAll}</button>
      </div>}
      <Table
        head={[c.colName, c.colSource, c.colAction]}
        empty={loading ? c.common.loading : c.reviewEmpty}
        rows={reviewRows.map((note) => ({
          key: note.path,
          cells: [
            <button type="button" className="vm-link" onClick={() => void openReview(note)}>{note.title}</button>,
            <Badge value={who(note.path)} label={who(note.path) === "human" ? c.filterHuman : c.filterAgent} />,
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void openReview(note)}>{c.reviewAction}</Button>,
          ],
        }))}
      />
    </>}

    {face === "archive" && <Table
      head={[c.colName, c.colSource, c.colAction]}
      empty={loading ? c.common.loading : c.archiveEmpty}
      rows={[...archiveRows.map((item) => ({
        key: item.path,
        cells: [
          <span className="vm-cell-name">{item.path.split("/").pop()}</span>,
          <Badge value={item.who === "human" ? "human" : "agent"} label={item.who === "human" ? c.filterHuman : c.filterAgent} />,
          <span className="vm-cell-dest">{item.dest}</span>,
        ],
      })), ...problemRows.map((item) => ({
        key: item.path,
        cells: [
          <span className="vm-cell-name">{item.path.split("/").pop()}</span>,
          <Badge value={item.who === "human" ? "human" : "agent"} label={item.who === "human" ? c.filterHuman : c.filterAgent} />,
          <span className="vm-cell-problem">{item.problems.join(" / ")}</span>,
        ],
      }))]}
    />}

    {face === "loop" && <Table
      head={[c.colConcept, c.colState, c.colCases, c.colAction]}
      empty={loading ? c.common.loading : c.loopEmpty}
      rows={loopRows.map((concept) => ({
        key: concept.concept,
        cells: [
          <span className="vm-cell-name">{concept.concept}</span>,
          <span>{c.states[concept.state] ?? concept.state}</span>,
          <span>{c.loopProgress.replace("{n}", String(concept.support)).replace("{total}", String(loop?.threshold ?? 3))}</span>,
          <Button size="sm" variant="outline" disabled={!concept.path} onClick={() => concept.path && openNote(root, concept.path)}>{c.openConcept}</Button>,
        ],
      }))}
    />}

    {face === "cold" && <Table
      head={[c.colName, c.colAction]}
      empty={loading ? c.common.loading : c.coldEmpty}
      rows={coldRows.map((item) => ({
        key: item.path,
        cells: [
          <span className="vm-cell-name">{item.title}</span>,
          <Button size="sm" variant="outline" onClick={() => openNote(root, item.path)}>{c.colOpen}</Button>,
        ],
      }))}
    />}
    <Dialog open={!!reviewing} onOpenChange={(open) => { if (!open) setReviewing(null); }}>
      <DialogContent className="workbench-ui vm-review-dialog sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{reviewing?.title}</DialogTitle>
          <DialogDescription>{reviewing?.path}</DialogDescription>
        </DialogHeader>
        {reviewing && <>
          <div className="vm-review-grid">
            <section><h3>{c.reviewInput}</h3><pre>{c.reviewInputText.replace("{zone}", who(reviewing.path) === "human" ? c.filterHuman : c.filterAgent).replace("{path}", reviewing.path)}</pre></section>
            <section><h3>{c.reviewOutput}</h3><pre>{preview || c.common.loading}</pre></section>
          </div>
          <div className="vm-review-path">
            <label className="vm-field"><span>{c.typeLabel}</span>
              <select value={type} disabled={busy} onChange={(event) => { const next = event.target.value; setType(next); setDest(TYPE_DEST[next] ?? ""); }}>
                {TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="vm-field"><span>{c.suggestPath}</span>
              <input value={TYPE_DEST[type] ?? ""} readOnly />
            </label>
            <label className="vm-field"><span>{c.finalPath}</span>
              <input value={dest} disabled={busy} onChange={(event) => setDest(event.target.value)} placeholder="02-IT/06-项目研究" />
            </label>
          </div>
          <div className="vm-actions vm-actions-end">
            <Button size="sm" disabled={busy || !dest.trim()} onClick={() => void approve(reviewing)}>{c.approve}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject(reviewing)}>{c.reject}</Button>
            <Button size="sm" variant="outline" onClick={() => openNote(root, reviewing.path)}>{c.openInObsidian}</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}

function Table({ head, rows, empty }: { head: string[]; rows: { key: string; cells: React.ReactNode[] }[]; empty: string }) {
  return <div className="vm-table-wrap">
    <table className="vm-table">
      <thead><tr>{head.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={head.length} className="vm-table-empty">{empty}</td></tr>}
        {rows.map((row) => <tr key={row.key}>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}
      </tbody>
    </table>
  </div>;
}

function Badge({ value, label }: { value: "human" | "agent"; label: string }) {
  return <span className="vm-badge-cell" data-who={value}>{label}</span>;
}

function asMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

function openNote(root: string, path: string) {
  const absolute = `${root.replace(/[\\/]$/, "")}/${path}`;
  void openUrl(`obsidian://open?path=${encodeURIComponent(absolute)}`).catch(() => undefined);
}
