import { Check, ChevronDown, FileCode, FolderOpen, History, RotateCcw, Save, Shield, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfigEditorPanel } from "@/ahub/components/ConfigEditorPanel";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Switch } from "@/ahub/components/motion/switch";
import { api } from "@/ahub/lib/api";
import type { VaultIndex, VaultStatus, VaultVersion } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function kindLabel(kind: string, t: (k: string) => string): string {
  return t(`settings.vaultKind_${kind}`) || kind;
}

/**
 * 配置保险：为各 AI 工具的配置文件提供版本管理。
 * 初次可全选/勾选纳入管理；支持每日自动备份；可按版本恢复或清空记录。
 */
export function ConfigVaultSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VaultStatus[] | null>(null);
  const [idx, setIdx] = useState<VaultIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clearFor, setClearFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, ix] = await Promise.all([api.vaultStatus(), api.vaultIndex()]);
      setStatus(st);
      setIdx(ix);
    } catch (e) {
      toast.error(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const watched = new Set(idx?.watched ?? []);

  const toggleWatch = async (id: string) => {
    const next = new Set(watched);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      setIdx(await api.vaultSetWatched([...next]));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const selectAll = async () => {
    const all = (status ?? []).filter((s) => s.exists).map((s) => s.harness);
    try {
      setIdx(await api.vaultSetWatched(all));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const snapshotWatched = async () => {
    const ids = [...watched];
    if (!ids.length) {
      toast.warning(t("settings.vaultNoneWatched"));
      return;
    }
    setBusy(true);
    try {
      const res = await api.vaultSnapshot(ids, "manual");
      toast.success(t("settings.vaultSnapshotDone", { n: res.length }));
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (harness: string, v: number) => {
    setBusy(true);
    try {
      await api.vaultRestore(harness, v);
      toast.success(t("settings.vaultRestored", { v }));
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const versionsOf = (id: string): VaultVersion[] =>
    idx?.entries.find((e) => e.harness === id)?.versions ?? [];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-2">{t("settings.vault")}</span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => void selectAll()}>
            {t("common.selectAll")}
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busy} onClick={() => void snapshotWatched()}>
            <Save className="size-3.5" />
            {t("settings.vaultSnapshotNow")}
          </Button>
        </div>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-ink-3">{t("settings.vaultHint")}</p>

      {/* 每日自动备份 */}
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2.5">
        <Switch
          checked={idx?.daily ?? false}
          onCheckedChange={(v) => {
            void api.vaultSetDaily(v).then(setIdx).catch((e) => toast.error(String(e)));
          }}
        />
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-2">{t("settings.vaultDaily")}</div>
          <div className="text-[11px] text-ink-3">
            {idx?.lastDaily ? t("settings.vaultLastDaily", { date: idx.lastDaily }) : t("settings.vaultDailyHint")}
          </div>
        </div>
      </div>

      {status === null ? (
        <p className="text-[11px] text-ink-3">…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {status.map((s) => {
            const on = watched.has(s.harness);
            const versions = versionsOf(s.harness);
            const open = expanded === s.harness;
            return (
              <div key={s.harness} className="rounded-lg border border-border bg-bg-subtle">
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => void toggleWatch(s.harness)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
                  >
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                        on ? "border-primary bg-primary text-white" : "border-border-strong bg-surface",
                      )}
                    >
                      {on ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <HarnessIcon id={s.harness} className={cn("size-5 shrink-0", on ? "text-primary" : "text-ink-3")} />
                    <span className="min-w-0">
                      <span className={cn("block truncate text-xs font-medium", on ? "text-foreground" : "text-ink-2")}>
                        {s.name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-ink-3" dir="ltr">
                        {s.path || t("settings.vaultNoPath")}
                      </span>
                    </span>
                  </button>

                  {!s.exists ? <Badge variant="muted">{t("mcp.notInstalled")}</Badge> : null}
                  {s.exists && on && !s.upToDate ? <Badge variant="warning">{t("settings.vaultChanged")}</Badge> : null}
                  {s.exists && on && s.upToDate ? <Badge variant="success">{t("settings.vaultSynced")}</Badge> : null}
                  {versions.length ? <Badge variant="info">{versions.length}</Badge> : null}

                  <button
                    type="button"
                    title={t("mcp.revealCfg")}
                    onClick={() => s.path && void api.revealPath(s.path)}
                    disabled={!s.exists}
                    className="shrink-0 rounded p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
                  >
                    <FolderOpen className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t("mcp.btnEditCfg")}
                    onClick={() => setEditing({ id: s.harness, name: s.name })}
                    disabled={!s.exists}
                    className="shrink-0 rounded p-1.5 text-ink-3 outline-none transition-colors hover:bg-primary-soft hover:text-primary disabled:opacity-40"
                  >
                    <FileCode className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : s.harness)}
                    className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
                  >
                    <History className="size-3.5" />
                    <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
                  </button>
                </div>

                {open ? (
                  <div className="border-t border-border px-3 py-2">
                    {versions.length === 0 ? (
                      <p className="text-[11px] text-ink-3">{t("settings.vaultNoVersions")}</p>
                    ) : (
                      <>
                        <div className="mb-2 flex flex-col gap-1">
                          {[...versions].reverse().map((v) => (
                            <div key={v.v} className="flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5">
                              <Badge variant="outline">v{v.v}</Badge>
                              <span className="shrink-0 text-[10px] text-ink-3">{kindLabel(v.kind, t)}</span>
                              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2" dir="ltr">
                                {v.savedAt}
                              </span>
                              <span className="shrink-0 text-[10px] text-ink-3">{fmtSize(v.size)}</span>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                disabled={busy}
                                onClick={() => void restore(s.harness, v.v)}
                              >
                                <RotateCcw className="size-3" />
                                {t("settings.vaultRestore")}
                              </Button>
                            </div>
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px] text-danger hover:bg-danger/10"
                          onClick={() => setClearFor(s.harness)}
                        >
                          <Trash2 className="size-3.5" />
                          {t("settings.vaultClear")}
                        </Button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
        <Shield className="mt-0.5 size-3 shrink-0" />
        <span>{t("settings.vaultSafety")}</span>
      </p>

      <ConfigEditorPanel
        open={!!editing}
        harness={editing?.id ?? ""}
        name={editing?.name ?? ""}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />

      <ConfirmDialog
        open={!!clearFor}
        onOpenChange={(v) => !v && setClearFor(null)}
        title={t("settings.vaultClearTitle")}
        message={t("settings.vaultClearMsg")}
        danger
        onConfirm={() => {
          if (clearFor)
            void api
              .vaultClear([clearFor])
              .then(() => {
                toast.success(t("settings.vaultCleared"));
                void load();
              })
              .catch((e) => toast.error(String(e)));
        }}
      />
    </div>
  );
}
