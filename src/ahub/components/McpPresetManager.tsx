import { Check, Pencil, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { PresetDialog } from "@/ahub/components/PresetDialog";
import { Badge } from "@/ahub/components/ui/badge";
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
import { Input } from "@/ahub/components/ui/input";
import { api } from "@/ahub/lib/api";
import { presetErrorText } from "@/ahub/lib/presetErrors";
import type { McpPreset, McpServer } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/**
 * MCP 预设管理：重命名、添加/移除成员、删除。
 *
 * 与 Skills 预设不同，这里不打包导出 —— MCP 的「带走」方式是复制 JSON，
 * 卡片和批量操作里已经有入口，预设只负责筛选与集合管理。
 *
 * 成员删除分两档：从预设移除（只动成员表）与彻底删除（删掉服务本身，
 * 后端会顺手把它从所有预设摘掉），彻底删除走二次确认。
 */
export function McpPresetManager({
  open,
  onOpenChange,
  presets,
  servers,
  onChanged,
  onItemsChanged,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: McpPreset[];
  servers: McpServer[];
  onChanged: () => Promise<void> | void;
  /** 彻底删除服务后刷新 MCP 列表 */
  onItemsChanged: () => Promise<void> | void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<McpPreset | null>(null);
  const [editing, setEditing] = useState<McpPreset | null>(null);
  const [deleting, setDeleting] = useState<McpPreset | null>(null);
  const [purging, setPurging] = useState<{ preset: McpPreset; server: McpServer } | null>(null);

  const liveNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);

  const removeMember = async (preset: McpPreset, name: string) => {
    try {
      await api.mcpPresetUpdate(preset.id, { serverNames: preset.serverNames.filter((n) => n !== name) });
    } catch (e) {
      toast.error(presetErrorText(e, t));
      return;
    }
    toast.success(t("preset.removedFromPreset"));
    await onChanged();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="size-4 text-primary" />
              {t("preset.manage")}
            </DialogTitle>
            <DialogDescription>{t("preset.mcpManageHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {presets.length === 0 ? (
              <p className="text-[11px] text-ink-3">{t("preset.mcpEmptyHint")}</p>
            ) : (
              presets.map((p) => {
                const stale = p.serverNames.filter((n) => !liveNames.has(n));
                return (
                  <div key={p.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{p.name}</span>
                      <Badge variant={p.serverNames.length ? "muted" : "warning"}>
                        {p.serverNames.length
                          ? t("preset.membersCount", { n: p.serverNames.length })
                          : t("preset.emptyBadge")}
                      </Badge>
                      {stale.length ? <Badge variant="danger">{t("preset.stale")} {stale.length}</Badge> : null}
                    </div>
                    {p.description ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{p.description}</p>
                    ) : (
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">—</p>
                    )}

                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.serverNames.length === 0 ? (
                        <span className="text-[11px] text-ink-3">{t("preset.noMembers")}</span>
                      ) : (
                        p.serverNames.map((n) => {
                          const gone = !liveNames.has(n);
                          const server = servers.find((s) => s.name === n);
                          return (
                            <span
                              key={n}
                              title={gone ? t("preset.reasonMissing") : n}
                              className={cn(
                                "group inline-flex max-w-[240px] items-center gap-0.5 rounded-full py-0.5 pl-2 pr-1 text-[11px]",
                                gone ? "bg-surface-2 text-ink-3 line-through" : "bg-primary-soft text-primary",
                              )}
                            >
                              <span className="min-w-0 truncate">{n}</span>
                              {gone ? <span className="shrink-0 opacity-80">· {t("preset.stale")}</span> : null}
                              {!gone ? (
                                <>
                                  <button
                                    type="button"
                                    title={t("preset.removeFromPreset")}
                                    onClick={() => void removeMember(p, n)}
                                    className="shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-primary/15 group-hover:opacity-100"
                                  >
                                    <X className="size-3" />
                                  </button>
                                  {server ? (
                                    <button
                                      type="button"
                                      title={t("preset.purgeMember")}
                                      onClick={() => setPurging({ preset: p, server })}
                                      className="shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-danger/15 group-hover:opacity-100"
                                    >
                                      <Trash2 className="size-3" />
                                    </button>
                                  ) : null}
                                </>
                              ) : null}
                            </span>
                          );
                        })
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => setRenaming(p)}>
                        <Pencil className="size-3.5" />
                        {t("preset.renameTitle")}
                      </Button>
                      <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => setEditing(p)}>
                        <Check className="size-3.5" />
                        {t("preset.editMembers")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="ml-auto h-7 text-[11px] text-danger hover:bg-danger/10 hover:text-danger"
                        onClick={() => setDeleting(p)}
                      >
                        <Trash2 className="size-3.5" />
                        {t("preset.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PresetDialog
        open={!!renaming}
        onOpenChange={(v) => !v && setRenaming(null)}
        title={t("preset.renameTitle")}
        initialName={renaming?.name ?? ""}
        initialDescription={renaming?.description ?? ""}
        onSubmit={async (name, description) => {
          if (!renaming) return;
          try {
            await api.mcpPresetUpdate(renaming.id, { name, description });
          } catch (e) {
            throw presetErrorText(e, t);
          }
          toast.success(t("preset.renamed"));
          await onChanged();
        }}
      />

      <McpPresetMembersDialog
        preset={editing}
        servers={servers}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={async () => {
          toast.success(t("preset.membersSaved"));
          await onChanged();
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("preset.deleteTitle")}
        message={t("preset.deleteMsg", { name: deleting?.name ?? "" })}
        danger
        onConfirm={() => {
          if (!deleting) return;
          const id = deleting.id;
          const name = deleting.name;
          void api
            .mcpPresetDelete(id)
            .then(async () => {
              toast.success(t("preset.deleted", { name }));
              onDeleted(id);
              await onChanged();
            })
            .catch((e) => toast.error(presetErrorText(e, t)));
        }}
      />

      {/* 彻底删除服务：服务没了，后端会把它从所有预设里摘掉 */}
      <ConfirmDialog
        open={!!purging}
        onOpenChange={(v) => !v && setPurging(null)}
        title={t("preset.purgeMemberTitle", { name: purging?.server.name ?? "" })}
        message={t("preset.purgeServerMsg")}
        danger
        onConfirm={() => {
          if (!purging) return;
          const id = purging.server.id;
          const name = purging.server.name;
          void api
            .deleteMcp(id)
            .then(async () => {
              toast.success(t("preset.purged", { name }));
              await onItemsChanged();
              await onChanged();
            })
            .catch((e) => toast.error(presetErrorText(e, t)));
        }}
      />
    </>
  );
}

function McpPresetMembersDialog({
  preset,
  servers,
  onOpenChange,
  onSaved,
}: {
  preset: McpPreset | null;
  servers: McpServer[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!preset) return;
    setSelected(new Set(preset.serverNames));
    setQ("");
  }, [preset]);

  const liveNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
  const missing = preset?.serverNames.filter((n) => !liveNames.has(n)) ?? [];

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return servers.filter(
      (s) => !needle || s.name.toLowerCase().includes(needle) || (s.description ?? "").toLowerCase().includes(needle),
    );
  }, [servers, q]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const save = async () => {
    if (!preset) return;
    setSaving(true);
    try {
      await api.mcpPresetUpdate(preset.id, { serverNames: [...selected] });
      onOpenChange(false);
      await onSaved();
    } catch (e) {
      toast.error(presetErrorText(e, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!preset} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("preset.editMembersTitle", { name: preset?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("preset.mcpEditMembersHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} />
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border">
            {list.length === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-ink-3">{t("common.empty")}</p>
            ) : (
              list.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-2.5 py-1.5 text-xs text-ink-2 last:border-b-0 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.name)}
                    onChange={() => toggle(s.name)}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-3">{s.transport}</span>
                </label>
              ))
            )}
          </div>
          {missing.length ? (
            <p className="text-[10.5px] text-ink-3">
              {t("preset.missingMembers", { names: missing.join(", ") })}
            </p>
          ) : null}
          <p className="text-[11px] text-ink-3">{t("preset.membersCount", { n: selected.size })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t("preset.saving") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
