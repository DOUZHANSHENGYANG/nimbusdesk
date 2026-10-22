import { Check, Download, FolderInput, Loader2, RefreshCw, ScanSearch, Search, ShieldAlert, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { api } from "@/ahub/lib/api";
import { Input } from "@/ahub/components/ui/input";
import type { HarnessReport, ImportSelection } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";
import { sortByOrder } from "@/ahub/lib/harnessOrder";
import { Switch } from "@/ahub/components/motion/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ahub/components/motion/tabs";

/** 冲突确认弹框：同名项目逐项选择保留中枢 / 用扫描源覆盖 */
function ConflictDialog({
  open,
  conflicts,
  choice,
  onChoice,
  onChoiceAll,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  conflicts: string[];
  choice: Record<string, boolean>;
  onChoice: (name: string, overwrite: boolean) => void;
  /** 批量设置：一次决定所有冲突项的去向 */
  onChoiceAll: (overwrite: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-warning" />
            {t("harness.conflictTitle")}
          </DialogTitle>
          <DialogDescription>{t("harness.conflictHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          {/* 批量操作：冲突项多时逐个点太累（画面里这类同名可以一次定完） */}
          {conflicts.length > 1 ? (
            <div className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <span className="shrink-0 text-[11px] text-ink-3">
                {t("harness.conflictAll", { n: conflicts.length })}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => onChoiceAll(false)}>
                  {t("harness.allKeepHub")}
                </Button>
                <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => onChoiceAll(true)}>
                  {t("harness.allUseSource")}
                </Button>
              </div>
            </div>
          ) : null}
          {conflicts.map((name) => (
            <div key={name} className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{name}</span>
              <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
                <button
                  type="button"
                  onClick={() => onChoice(name, false)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors",
                    !choice[name] ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                  )}
                >
                  {t("harness.keepHub")}
                </button>
                <button
                  type="button"
                  onClick={() => onChoice(name, true)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors",
                    choice[name] ? "bg-warning/15 text-warning" : "text-ink-3 hover:text-foreground",
                  )}
                >
                  {t("harness.useSource")}
                </button>
              </div>
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? t("common.saving") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 稳定的空数组引用：给 zustand selector 做兜底，避免每次返回新引用 */
const EMPTY_ORDER: string[] = [];

export function HarnessDialog({
  open,
  onOpenChange,
  kind,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kind: "mcp" | "skills";
}) {
  const { t } = useTranslation();
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [tab, setTab] = useState<string>("collect");
  // collect tab: harnessId -> Set(name); apply tab: shared selected names
  const [collectSel, setCollectSel] = useState<Record<string, Set<string>>>({});
  const [activeHarness, setActiveHarness] = useState<string>("");
  const [applyQuery, setApplyQuery] = useState("");
  const [applyTagFilter, setApplyTagFilter] = useState<Set<string>>(new Set());
  // 收集侧的搜索：只作用于「当前工具」的条目（每个工具的清单互相独立，
  // 全局搜索没有意义 —— 这里不是一张合并列表）
  const [collectQuery, setCollectQuery] = useState("");
  const [applySel, setApplySel] = useState<Set<string>>(new Set());

  // conflict confirmation state
  const [pending, setPending] = useState<{ harnessId: string; newItems: string[]; conflicts: string[] } | null>(null);
  const [conflictChoice, setConflictChoice] = useState<Record<string, boolean>>({});

  const mcp = useData((s) => s.mcp);
  const skills = useData((s) => s.skills);
  const loadMcp = useData((s) => s.loadMcp);
  const loadSkills = useData((s) => s.loadSkills);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const rs = await api.scanHarnesses();
      setReports(rs);
      if (kind === "mcp") {
        // 默认全选扫描到的全部 MCP
        const init: Record<string, Set<string>> = {};
        rs.forEach((r) => {
          if (r.mcpServers.length) init[r.id] = new Set(r.mcpServers.map((x) => x.name));
        });
        setCollectSel(init);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setScanning(false);
    }
  }, [kind]);

  useEffect(() => {
    if (open) {
      setTab("collect");
      setCollectSel({});
      setCollectQuery("");
      setApplySel(new Set());
      setPending(null);
      void scan();
    }
  }, [open, scan]);

  const toggleCollect = (harnessId: string, name: string) => {
    setCollectSel((prev) => {
      const next = { ...prev };
      const set = new Set(next[harnessId] ?? []);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      next[harnessId] = set;
      return next;
    });
  };

  /** 全选/取消全选。只作用于传入的清单（即过滤后的可见条目），
   *  这样搜索状态下不会把被筛掉的条目一并选中。 */
  const selectAllCollect = (r: HarnessReport, items: { name: string }[]) => {
    setCollectSel((prev) => {
      const set = new Set(prev[r.id] ?? []);
      const allSelected = items.length > 0 && items.every((x) => set.has(x.name));
      if (allSelected) items.forEach((x) => set.delete(x.name));
      else items.forEach((x) => set.add(x.name));
      return { ...prev, [r.id]: set };
    });
  };

  const totalCollect = Object.values(collectSel).reduce((acc, s) => acc + s.size, 0);

  /**
   * 排序：不在中枢的排前面，已在中枢的沉到末尾。
   * 同名项导入时必然走冲突流程，属于「先看清楚再决定」的一类，
   * 不该混在待收集项中间。同组内保持原顺序（稳定排序）。
   */
  const putExistingLast = (items: { name: string }[], hub: Set<string>) => {
    const fresh: { name: string }[] = [];
    const existing: { name: string }[] = [];
    for (const it of items) (hub.has(it.name) ? existing : fresh).push(it);
    return [...fresh, ...existing];
  };

  /** 按关键词过滤某个工具的条目。顺序：名称 → 描述/路径 → 传输方式/命令/URL */
  const filterCollectItems = (items: { name: string }[]) => {
    const q = collectQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const any = it as Record<string, unknown>;
      const hay = [
        it.name,
        any.description,
        any.path,
        any.transport,
        any.command,
        any.url,
      ]
        .filter((x): x is string => typeof x === "string")
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  };

  const runImport = useCallback(
    async (harnessId: string, selections: ImportSelection[]) => {
      setBusy(true);
      try {
        const res = await api.importFromHarness(harnessId, kind, selections);
        if (res.imported.length) {
          toast.success(
            t("harness.importDone", { imported: res.imported.length }) +
              (res.skipped.length ? t("harness.importSkipped", { count: res.skipped.length }) : ""),
          );
        }
        res.errors.forEach((e) => toast.error(e));
        setCollectSel((prev) => ({ ...prev, [harnessId]: new Set() }));
        if (kind === "mcp") void loadMcp();
        else void loadSkills();
      } catch (e) {
        toast.error(`${t("harness.importFailed")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [kind, loadMcp, loadSkills, t],
  );

  // 收集：先预收集（归档信息）→ 异步通知结果 → 无冲突直接执行；有冲突弹框逐项确认
  const doCollect = async (report: HarnessReport) => {
    const names = [...(collectSel[report.id] ?? [])];
    if (!names.length) {
      toast.warning(t("harness.nothingSelected"));
      return;
    }
    setBusy(true);
    try {
      const pre = await api.preImport(report.id, kind, names);
      if (!pre.newItems.length && !pre.conflicts.length) {
        toast.info(t("harness.collectEmpty"));
        return;
      }
      toast.success(t("harness.preDone", { newCount: pre.newItems.length, conflictCount: pre.conflicts.length }));
      if (pre.conflicts.length) {
        setConflictChoice({});
        setPending({ harnessId: report.id, newItems: pre.newItems, conflicts: pre.conflicts });
      } else {
        await runImport(report.id, pre.newItems.map((n) => ({ name: n, overwrite: false })));
      }
    } catch (e) {
      toast.error(`${t("harness.importFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmConflicts = async () => {
    if (!pending) return;
    const selections: ImportSelection[] = [
      ...pending.newItems.map((n) => ({ name: n, overwrite: false })),
      ...pending.conflicts.map((n) => ({ name: n, overwrite: conflictChoice[n] ?? false })),
    ];
    const id = pending.harnessId;
    setPending(null);
    await runImport(id, selections);
  };

  const hubItems = (kind === "mcp" ? mcp.map((s) => s.name) : skills.map((s) => s.dirName)).filter(Boolean);

  /** 应用列表（带标签元数据，用于按 tag 分组展示） */
  const applyEntries = useMemo(() => {
    const q = applyQuery.trim().toLowerCase();
    const list =
      kind === "mcp"
        ? mcp.map((m) => ({ key: m.name, label: m.name, tags: m.tags }))
        : skills.map((sk) => ({ key: sk.dirName, label: sk.name, tags: sk.tags }));
    return list.filter((e) => {
      if (applyTagFilter.size && !e.tags.some((tg) => applyTagFilter.has(tg))) return false;
      return !q || e.label.toLowerCase().includes(q) || e.tags.some((tg) => tg.toLowerCase().includes(q));
    });
  }, [kind, mcp, skills, applyQuery, applyTagFilter]);

  /** 当前上下文（不含标签筛选）下的标签池与计数 */
  const applyTags = useMemo(() => {
    const q = applyQuery.trim().toLowerCase();
    const m: Record<string, number> = {};
    for (const e of kind === "mcp" ? mcp.map((x) => ({ label: x.name, tags: x.tags })) : skills.map((x) => ({ label: x.name, tags: x.tags }))) {
      if (q && !e.label.toLowerCase().includes(q) && !e.tags.some((tg) => tg.toLowerCase().includes(q))) continue;
      for (const tg of e.tags) m[tg] = (m[tg] ?? 0) + 1;
    }
    const keys = new Set<string>(Object.keys(m));
    applyTagFilter.forEach((k) => keys.add(k));
    return [...keys].sort((a, b) => (m[b] ?? 0) - (m[a] ?? 0) || a.localeCompare(b)).map((k) => [k, m[k] ?? 0] as const);
  }, [kind, mcp, skills, applyQuery, applyTagFilter]);

  /** 按标签分组（未打标签归入「未分类」） */
  const applyGroups = useMemo(() => {
    const map = new Map<string, typeof applyEntries>();
    for (const e of applyEntries) {
      const keys = e.tags.length ? e.tags : [t("skills.untagged")];
      for (const k of keys) {
        const arr = map.get(k) ?? [];
        arr.push(e);
        map.set(k, arr);
      }
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [applyEntries, t]);

  // 一键收集：所有已勾选 harness 逐个导入；同名冲突默认保留中枢
  const collectAll = async () => {
    setBusy(true);
    let added = 0;
    let conflicts = 0;
    let errs = 0;
    try {
      for (const r of visible) {
        const items = kind === "mcp" ? r.mcpServers : r.skills;
        // 只提交过滤后仍可见的条目：否则搜索状态下点「全部收集」会连
        // 被筛掉的条目一起收走（用户看不到它们，属于误收集）
        const allowed = new Set(filterCollectItems(items).map((x) => x.name));
        const names = [...(collectSel[r.id] ?? [])].filter((n) => allowed.has(n));
        if (!names.length) continue;
        try {
          const pre = await api.preImport(r.id, kind, names);
          conflicts += pre.conflicts.length;
          if (pre.newItems.length) {
            const res = await api.importFromHarness(r.id, kind, pre.newItems.map((n) => ({ name: n, overwrite: false })));
            added += res.imported.length;
            errs += res.errors.length;
          }
        } catch {
          errs += 1;
        }
      }
      setCollectSel({});
      if (kind === "mcp") void loadMcp();
      else void loadSkills();
      toast.success(t("harness.collectAllDone", { added, conflicts, errs }));
    } finally {
      setBusy(false);
    }
  };

  const doApply = async (report: HarnessReport) => {
    const names = [...applySel];
    if (!names.length) {
      toast.warning(t("harness.nothingSelected"));
      return;
    }
    setBusy(true);
    try {
      const res = await api.applyToHarness(report.id, kind, names);
      if (res.applied.length && res.warnings.length) toast.success(t("harness.applyWithWarn", { applied: res.applied.length, warn: res.warnings.length }));
      else if (res.applied.length) toast.success(t("harness.applyDone", { applied: res.applied.length }));
      res.warnings.forEach((w) => toast.warning(w));
      res.errors.forEach((e) => toast.error(e));
    } catch (e) {
      toast.error(`${t("harness.applyFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // 必须用模块级常量做兜底：`?? []` 每次求值都是新引用，zustand 用 Object.is
  // 比较选择结果 → 永远判定"变了" → 无限重渲染（info 尚未加载时必现）
  const harnessOrder = useSettings((s) => s.info?.settings.harnessOrder ?? EMPTY_ORDER);
  const visible = sortByOrder(
    (reports ?? []).filter((r) => (kind === "mcp" ? r.supportsMcp || r.mcpServers.length : r.supportsSkills || r.skills.length)),
    harnessOrder,
  ) ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent wide className="h-[90vh] sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScanSearch className="size-4 text-primary" />
              {t("harness.title")}
            </DialogTitle>
          </DialogHeader>

          <div className="border-b border-border px-5 pt-3">
            <Tabs value={tab} onValueChange={setTab} variant="segment">
              <TabsList>
                <TabsTrigger value="collect">{t("harness.collectTab")}</TabsTrigger>
                {kind === "skills" ? <TabsTrigger value="apply">{t("harness.applyTab")}</TabsTrigger> : null}
              </TabsList>
            </Tabs>
          </div>

          <DialogBody>
            {reports === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-3">
                {scanning ? <Loader2 className="size-6 animate-spin" /> : null}
                <span className="text-xs">{t("harness.scanning")}</span>
              </div>
            ) : (
              <Tabs value={tab} onValueChange={setTab}>
                <TabsContent value="collect" className="flex min-h-0 flex-1 flex-col">
                  {visible.length === 0 ? (
                    <div className="py-16 text-center text-xs text-ink-3">{t("harness.noHarness")}</div>
                  ) : (
                    <div className="flex min-h-0 flex-1 gap-0">
                      {/* 左：工具列表 */}
                      <div className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border pr-3">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[11px] font-medium text-ink-3">{t("mcp.pickHarness")}</span>
                          <button
                            type="button"
                            title={t("common.rescan")}
                            onClick={() => void scan()}
                            disabled={scanning}
                            className="rounded p-1 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
                          >
                            <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} />
                          </button>
                        </div>
                        <Button
                          size="sm"
                          className="mb-1 h-8 w-full text-[11px]"
                          disabled={scanning || busy || totalCollect === 0}
                          onClick={() => void collectAll()}
                        >
                          <FolderInput className="size-3.5" />
                          {t("harness.collectAll")}
                        </Button>
                        {visible.map((r) => {
                          const items = kind === "mcp" ? r.mcpServers : r.skills;
                          const shown = filterCollectItems(items);
                          const selN = (collectSel[r.id] ?? new Set()).size;
                          return (
                            <button
                              key={r.id}
                              type="button"
                              onClick={() => setActiveHarness(r.id)}
                              className={cn(
                                "flex items-center gap-2 rounded-lg px-3 py-2 text-left outline-none transition-colors",
                                r.id === activeHarness ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
                              )}
                            >
                              <HarnessIcon id={r.id} className={cn("size-4 shrink-0", r.id === activeHarness ? "text-primary" : "text-ink-3")} />
                              <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.name}</span>
                              {selN ? (
                                <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-white">{selN}</span>
                              ) : (
                                <span className="shrink-0 text-[10px] text-ink-3">
                                  {collectQuery.trim() ? `${shown.length}/${items.length}` : items.length}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* 右：选中工具的配置项 */}
                      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pl-4">
                        {(() => {
                          const r = visible.find((x) => x.id === activeHarness) ?? visible[0];
                          const items = kind === "mcp" ? r.mcpServers : r.skills;
                          const hubSet = new Set(kind === "mcp" ? mcp.map((x) => x.name) : skills.map((x) => x.dirName));
                          const shown = putExistingLast(filterCollectItems(items), hubSet);
                          const existingN = shown.filter((x) => hubSet.has(x.name)).length;
                          const sel = collectSel[r.id] ?? new Set();
                          // 「全部选择」跟随过滤结果：搜索状态下只全选看得见的条目
                          const allSel = shown.length > 0 && shown.every((x) => sel.has(x.name));
                          return (
                            <>
                              <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-semibold text-foreground">{r.name}</div>
                                  <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                                    {kind === "mcp" ? r.configPath : r.skillsDirs.join(" · ") || "—"}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {existingN > 0 ? (
                                    <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                                      {t("harness.alreadyInHubN", { n: existingN })}
                                    </span>
                                  ) : null}
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-8 text-[11px]"
                                    disabled={shown.length === 0}
                                    onClick={() => selectAllCollect(r, shown)}
                                  >
                                    {allSel ? t("mcp.unselectAll") : t("common.selectAll")}
                                  </Button>
                                  <Button size="sm" disabled={busy || sel.size === 0} onClick={() => void doCollect(r)}>
                                    <FolderInput className="size-3.5" />
                                    {t("common.collect")}
                                  </Button>
                                </div>
                              </div>

                              {/* 收集侧筛选：只作用于当前工具的条目 */}
                              <div className="mb-2.5 flex items-center gap-2">
                                <div className="relative min-w-40 flex-1">
                                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
                                  <Input
                                    value={collectQuery}
                                    onChange={(e) => setCollectQuery(e.target.value)}
                                    placeholder={t("harness.collectSearchPh")}
                                    className="h-8 pl-8 text-xs"
                                  />
                                </div>
                                {collectQuery.trim() ? (
                                  <>
                                    <span className="shrink-0 text-[11px] text-ink-3">
                                      {t("harness.collectMatch", { n: shown.length, total: items.length })}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setCollectQuery("")}
                                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-ink-3 outline-none transition-colors hover:border-danger/40 hover:text-danger"
                                    >
                                      <X className="size-3" />
                                      {t("skills.clearFilters")}
                                    </button>
                                  </>
                                ) : null}
                              </div>

                              {items.length === 0 ? (
                                <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-ink-3">
                                  {t("harness.noItemsInHarness")}
                                </div>
                              ) : shown.length === 0 ? (
                                <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-ink-3">
                                  {t("harness.collectNoMatch", { q: collectQuery.trim() })}
                                </div>
                              ) : (
                                <div className="grid gap-1 sm:grid-cols-2">
                                  {shown.map((item) => {
                                    const checked = sel.has(item.name);
                                    const detail =
                                      kind === "mcp"
                                        ? (item as { transport?: string }).transport === "stdio"
                                          ? `${(item as { command?: string }).command ?? ""} ${(item as { args?: string[] }).args?.join(" ") ?? ""}`.trim()
                                          : (item as { url?: string }).url ?? ""
                                        : (item as { description?: string }).description || (item as { path?: string }).path;
                                    return (
                                      <button
                                        key={item.name}
                                        data-collect-item
                                        type="button"
                                        onClick={() => toggleCollect(r.id, item.name)}
                                        className={cn(
                                          "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors",
                                          checked ? "border-primary/40 bg-primary-soft" : "border-transparent hover:border-border hover:bg-surface-2",
                                        )}
                                      >
                                        <span
                                          className={cn(
                                            "mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors",
                                            checked ? "border-primary bg-primary text-white" : "border-border-strong bg-surface",
                                          )}
                                        >
                                          {checked ? <Check className="size-3" strokeWidth={3} /> : null}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                          <span className="flex min-w-0 items-center gap-1.5">
                                            <span className="truncate text-[13px] font-medium text-foreground">{item.name}</span>
                                            {hubSet.has(item.name) ? (
                                              <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1 py-px text-[10px] font-medium text-warning">
                                                {t("harness.alreadyInHub")}
                                              </span>
                                            ) : null}
                                          </span>
                                          {detail ? (
                                            <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-3" dir="ltr">
                                              {detail}
                                            </span>
                                          ) : null}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {r.notes.map((n) => (
                                <div key={n} className="mt-2 text-[11px] text-warning">
                                  {n}
                                </div>
                              ))}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="apply">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <p className="text-xs text-ink-3">{t("harness.hintApply")}</p>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-[11px] text-ink-3">{t("harness.overwriteLabel")}</span>
                      <Switch checked={overwrite} onCheckedChange={setOverwrite} />
                    </div>
                  </div>
                  {hubItems.length === 0 ? (
                    <div className="py-16 text-center text-xs text-ink-3">{t("harness.noHubItems")}</div>
                  ) : (
                    <>
                      {/* 搜索 + 全选 */}
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <div className="relative min-w-44 flex-1">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
                          <Input
                            value={applyQuery}
                            onChange={(e) => setApplyQuery(e.target.value)}
                            placeholder={t("harness.applySearchPh")}
                            className="h-8 pl-8 text-xs"
                          />
                        </div>
                        <span className="shrink-0 text-[11px] text-ink-3">
                          {t("harness.applySelCount", { n: applySel.size, total: hubItems.length })}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 text-[11px]"
                          onClick={() =>
                            setApplySel((prev) =>
                              prev.size === applyEntries.length && applyEntries.length > 0
                                ? new Set()
                                : new Set(applyEntries.map((e) => e.key)),
                            )
                          }
                        >
                          {applySel.size === applyEntries.length && applyEntries.length > 0
                            ? t("mcp.unselectAll")
                            : t("common.selectAll")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 text-[11px]"
                          disabled={applySel.size === 0}
                          onClick={() => setApplySel(new Set())}
                        >
                          {t("harness.applyClearSel")}
                        </Button>
                      </div>

                      {/* 标签快捷筛选 */}
                      {applyTags.length > 0 ? (
                        <div className="mb-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
                          <Tag className="size-3.5 shrink-0 text-ink-3" />
                          {applyTags.map(([tg, n]) => {
                            const on = applyTagFilter.has(tg);
                            return (
                              <button
                                key={tg}
                                type="button"
                                onClick={() =>
                                  setApplyTagFilter((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(tg)) next.delete(tg);
                                    else next.add(tg);
                                    return next;
                                  })
                                }
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                                  on
                                    ? "border-primary bg-primary text-white"
                                    : "border-border bg-surface text-ink-2 hover:border-primary/40 hover:text-primary",
                                )}
                              >
                                {tg}
                                <span className="tabular-nums opacity-60">{n}</span>
                              </button>
                            );
                          })}
                          {applyTagFilter.size > 0 ? (
                            <button
                              type="button"
                              onClick={() => setApplyTagFilter(new Set())}
                              className="ml-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-ink-3 outline-none transition-colors hover:border-danger/40 hover:text-danger"
                            >
                              <X className="size-3" />
                              {t("skills.clearFilters")}
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                      {/* 按标签分组的技能选择 */}
                      <div className="mb-4 flex flex-col gap-3">
                        {applyGroups.length === 0 ? (
                          <p className="px-3 py-4 text-center text-[11px] text-ink-3">{t("skills.gitFilterEmpty")}</p>
                        ) : (
                          applyGroups.map(([tag, items]) => (
                            <div key={tag}>
                              <div className="mb-1.5 flex items-center gap-1.5">
                                <Tag className="size-3 text-ink-3" />
                                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{tag}</span>
                                <span className="text-[10px] text-ink-3">· {items.length}</span>
                                <button
                                  type="button"
                                  className="ml-1 text-[10px] text-primary outline-none hover:underline"
                                  onClick={() =>
                                    setApplySel((prev) => {
                                      const n = new Set(prev);
                                      const allOn = items.every((x) => n.has(x.key));
                                      items.forEach((x) => (allOn ? n.delete(x.key) : n.add(x.key)));
                                      return n;
                                    })
                                  }
                                >
                                  {items.every((x) => applySel.has(x.key)) ? t("mcp.unselectAll") : t("common.selectAll")}
                                </button>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {items.map((e) => {
                                  const checked = applySel.has(e.key);
                                  return (
                                    <button
                                      key={e.key}
                                      type="button"
                                      onClick={() =>
                                        setApplySel((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(e.key)) next.delete(e.key);
                                          else next.add(e.key);
                                          return next;
                                        })
                                      }
                                      className={cn(
                                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                                        checked
                                          ? "border-primary bg-primary text-white"
                                          : "border-border bg-surface text-ink-2 hover:border-primary/40 hover:text-primary",
                                      )}
                                    >
                                      {checked ? <Check className="size-3" /> : null}
                                      {e.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="flex flex-col gap-3">
                        {visible.map((r) => (
                          <div key={r.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-foreground">{r.name}</div>
                              <div className="truncate font-mono text-[11px] text-ink-3" dir="ltr">
                                {kind === "mcp" ? r.configPath : r.skillsDirs.join(" · ")}
                              </div>
                            </div>
                            <Button size="sm" disabled={busy || applySel.size === 0} onClick={() => void doApply(r)}>
                              <Download className="size-3.5" />
                              {t("common.apply")}
                            </Button>
                          </div>
                        ))}
                      </div>
                      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">{t("harness.backupNote")}</p>
                    </>
                  )}
                </TabsContent>
              </Tabs>
            )}
          </DialogBody>

          <DialogFooter>
            <span className="mr-auto text-[11px] text-ink-3">
              {totalCollect > 0 ? `${t("common.selected")}: ${totalCollect}` : ""}
            </span>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 冲突确认弹框 */}
      <ConflictDialog
        open={!!pending}
        conflicts={pending?.conflicts ?? []}
        choice={conflictChoice}
        onChoice={(name, overwrite) => setConflictChoice((prev) => ({ ...prev, [name]: overwrite }))}
        onChoiceAll={(overwrite) =>
          setConflictChoice(Object.fromEntries((pending?.conflicts ?? []).map((n) => [n, overwrite])))
        }
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmConflicts()}
        busy={busy}
      />
    </>
  );
}
