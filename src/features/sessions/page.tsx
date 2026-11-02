import { useCallback, useEffect, useMemo, useState } from "react";
import { ToolboxTabs } from "@/ahub/components/ToolboxTabs";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, CheckSquare, Copy, Loader2, RefreshCw, Square, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { inTauri } from "@/lib/tauri";
import { copyText, readText } from "@/lib/clipboard";
import {
  sessionList,
  sessionMigrate,
  sessionRead,
  sessionRuntimes,
  sessionThoughtGraph,
  commitThoughtGraph,
  importThoughtGraph,
  type MigrationReport,
  type RuntimeInfo,
  type SessionDetail,
  type SessionEvent,
  type SessionSummary,
} from "./api";

const RUNTIME_ORDER = ["opencode", "dsh", "workbuddy"] as const;

const KIND_LABEL: Record<string, string> = {
  user_prompt: "USER",
  user_interjection: "USER",
  assistant_reply: "ASSISTANT",
  tool_use: "TOOL",
  tool_result: "RESULT",
  file_edit: "EDIT",
  compact_summary: "COMPACT",
  compact_filtered: "COMPACT",
  turn_end: "TURN",
  other: "OTHER",
};

function runtimeLabel(runtimes: RuntimeInfo[], id: string): string {
  return runtimes.find((r) => r.id === id)?.label ?? id;
}

function stamp(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function EventRow({ event }: { event: SessionEvent }) {
  const text = event.text?.trim();
  if (!text) return null;
  const label = KIND_LABEL[event.kind] ?? event.kind.toUpperCase();
  const tone =
    event.kind === "user_prompt" || event.kind === "user_interjection"
      ? "text-primary"
      : event.kind === "assistant_reply"
        ? "text-foreground"
        : "text-muted-foreground";
  return (
    <div className="flex gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
      <span className={cn("w-20 shrink-0 pt-0.5 text-[0.65rem] font-semibold tracking-wide", tone)}>{label}</span>
      <div className="min-w-0 flex-1">
        {event.tool ? <div className="mb-1 text-xs font-medium text-muted-foreground">{event.tool}</div> : null}
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</div>
      </div>
    </div>
  );
}

export function SessionsPage() {
  const { t } = useTranslation();
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  /** 批量选择：key 是 `runtime:id`，可以跨客户端一起选 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!inTauri) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextRuntimes, nextSessions] = await Promise.all([sessionRuntimes(), sessionList()]);
      setRuntimes(nextRuntimes);
      setSessions(nextSessions);
      setSelected((current) => current ?? nextSessions[0] ?? null);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setReport(null);
    void sessionRead(selected.runtime, selected.id)
      .then((next) => {
        if (alive) setDetail(next);
      })
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const candidates = RUNTIME_ORDER.filter((id) => id !== selected.runtime && runtimes.some((r) => r.id === id && r.available));
    setTarget(candidates[0] ?? "");
  }, [selected, runtimes]);

  const filtered = useMemo(
    () => (filter === "all" ? sessions : sessions.filter((s) => s.runtime === filter)),
    [sessions, filter],
  );

  const copyGraph = async () => {
    if (!selected) return;
    try {
      const graph = await sessionThoughtGraph(selected.runtime, selected.id);
      await copyText(JSON.stringify(graph, null, 2));
      toast.success(t("sessions.graphCopied"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const previewGraph = async () => {
    if (!selected) return;
    try {
      const graph = JSON.parse(await readText());
      const session = await importThoughtGraph(graph, detail?.cwd ?? selected.cwd);
      toast.success(t("sessions.graphImported", { count: session.events.length }));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const pasteGraph = async () => {
    if (!selected || !target) return;
    setBusy(true);
    try {
      const graph = JSON.parse(await readText());
      await commitThoughtGraph(graph, target, detail?.cwd ?? selected.cwd, detail?.title ?? selected.title);
      toast.success(t("sessions.graphCommitted"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyResume = async () => {
    if (!report?.resumeCommand) return;
    await copyText(report.resumeCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const pickedSessions = () => sessions.filter((s) => picked.has(`${s.runtime}:${s.id}`));
  const allPicked = filtered.length > 0 && filtered.every((s) => picked.has(`${s.runtime}:${s.id}`));
  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(filtered.map((s) => `${s.runtime}:${s.id}`)));

  /** 批量迁移：选中的会话逐个搬到 target；失败只记在那一条上，不中断整批 */
  const migrateBatch = async () => {
    const items = pickedSessions();
    if (!items.length || !target) return;
    setBusy(true);
    setReport(null);
    let ok = 0;
    let failed = 0;
    for (const session of items) {
      try {
        await sessionMigrate({ source: session.runtime, sessionId: session.id, target, cwd: session.cwd });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed === 0) toast.success(t("sessions.batchDone", { n: ok }));
    else toast.error(t("sessions.batchFailed", { ok, failed }));
    setPicked(new Set());
    await load();
  };

  if (!inTauri) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("sessions.notInTauri")}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ToolboxTabs group="runtime" />
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("sessions.refresh")}
        </Button>
      </header>

      {/* 会话操作全搬到顶上：不用先点开某一条才能迁移 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <Button size="sm" variant="outline" onClick={toggleAll} disabled={filtered.length === 0}>
          {allPicked ? <CheckSquare /> : <Square />}
          {allPicked ? t("sessions.deselectAll") : t("sessions.selectAll")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("sessions.selectedCount", { n: picked.size })}</span>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden />

        {/* 可搜索的单选下拉：直接敲关键词筛 harness */}
        <input
          list="session-migrate-targets"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={t("sessions.pickTarget")}
          aria-label={t("sessions.migrateTo")}
          className="h-8 w-56 rounded-md border border-input bg-surface px-2 text-xs outline-none focus:border-primary"
        />
        <datalist id="session-migrate-targets">
          {RUNTIME_ORDER.map((id) => {
            const info = runtimes.find((r) => r.id === id);
            return (
              <option key={id} value={id}>
                {info?.label ?? id}
                {info?.available ? "" : " (off)"}
              </option>
            );
          })}
        </datalist>

        <Button size="sm" disabled={!picked.size || !target || busy} onClick={() => void migrateBatch()}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          {busy ? t("sessions.migrating") : t("sessions.batchMigrate")}
        </Button>

        <Button size="sm" variant="outline" disabled={!selected || busy} onClick={() => void previewGraph()}>
          <Waypoints />
          {t("sessions.importGraph")}
        </Button>
        <Button size="sm" variant="outline" disabled={!selected || !target || busy} onClick={() => void pasteGraph()}>
          <Waypoints />
          {t("sessions.pasteGraph")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {["all", ...RUNTIME_ORDER].map((id) => {
          const info = runtimes.find((r) => r.id === id);
          const disabled = id !== "all" && info && !info.available;
          return (
            <Button
              key={id}
              variant={filter === id ? "secondary" : "ghost"}
              size="sm"
              disabled={disabled}
              onClick={() => setFilter(id)}
            >
              {id === "all" ? t("sessions.all") : (info?.label ?? id)}
              {id !== "all" && info && !info.available ? " · off" : ""}
            </Button>
          );
        })}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>{t("sessions.preview")}</span>
            <span>{filtered.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("sessions.loading")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{filter === "all" ? t("sessions.empty") : t("sessions.filterEmpty")}</div>
            ) : (
              filtered.map((session) => (
                <div key={`${session.runtime}:${session.id}`} className="flex items-stretch border-b border-border/60">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={picked.has(`${session.runtime}:${session.id}`)}
                    aria-label={t("common.selectCard", { name: session.title || session.id })}
                    onClick={() => togglePick(`${session.runtime}:${session.id}`)}
                    className="grid w-9 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {picked.has(`${session.runtime}:${session.id}`) ? (
                      <CheckSquare className="size-4 text-primary" />
                    ) : (
                      <Square className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(session)}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-left transition-colors hover:bg-muted/50",
                      selected?.id === session.id && selected.runtime === session.runtime && "bg-muted/60",
                    )}
                  >
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.65rem] font-semibold text-primary">
                      {runtimeLabel(runtimes, session.runtime)}
                    </span>
                    <span className="truncate text-sm font-medium">{session.title || session.id}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground">
                    <span className="truncate">{session.cwd || "—"}</span>
                    <span className="shrink-0">{stamp(session.updatedAt)}</span>
                  </div>
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("sessions.pick")}</div>
          ) : (
            <>
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold">{detail?.title || selected.title || selected.id}</h2>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {runtimeLabel(runtimes, selected.runtime)} · {detail?.cwd || selected.cwd || "—"}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {detail ? `${detail.events.length} ${t("sessions.events")}` : <Loader2 className="size-4 animate-spin" />}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title={t("sessions.copyGraph")}
                    aria-label={t("sessions.copyGraph")}
                    disabled={!detail}
                    onClick={() => void copyGraph()}
                  >
                    <Waypoints />
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {!detail ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> {t("sessions.loading")}
                  </div>
                ) : detail.events.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">{t("sessions.empty")}</div>
                ) : (
                  detail.events.map((event, index) => <EventRow key={index} event={event} />)
                )}
              </div>

              {/* 迁移目标与批量动作都在顶部工具条上，这里只留迁移报告 */}
              {report ? (
                <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-3 text-xs">
                    <div className="flex items-center gap-2 font-medium text-success">
                      <Check className="size-4" />
                      {report.skipped ? t("sessions.skipped") : t("sessions.migrated")}
                      <span className="font-mono text-[0.7rem] text-muted-foreground">{report.targetId}</span>
                    </div>
                    {report.resumeCommand ? (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-muted-foreground">{t("sessions.resume")}</span>
                        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[0.7rem]">{report.resumeCommand}</code>
                        <Button size="icon-xs" variant="ghost" onClick={() => void copyResume()}>
                          {copied ? <Check /> : <Copy />}
                        </Button>
                      </div>
                    ) : null}
                    {report.dropped.length > 0 ? (
                      <div className="mt-2 text-muted-foreground">
                        {t("sessions.dropped")} {report.dropped.join("、")}
                      </div>
                    ) : null}
                  </div>
                ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
