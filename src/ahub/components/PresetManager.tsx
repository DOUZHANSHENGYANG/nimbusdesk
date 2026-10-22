import { Check, Download, Loader2, Pencil, Trash2, Users } from "lucide-react";
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
import type { Preset, SkillMeta } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/**
 * 预设管理面板：重命名、编辑成员、删除、导出。
 *
 * 成员分两类：技能池里还存在的（可勾选）与已失效的（灰显 + 「已失效」标记，
 * 只能在编辑成员里手动移除 —— 不会自动清理）。
 */
export function PresetManager({
  open,
  onOpenChange,
  presets,
  skills,
  onChanged,
  /** 当前正在筛选的预设被删掉时，调用方需要清掉筛选 */
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: Preset[];
  skills: SkillMeta[];
  /** 任一写操作成功后刷新预设列表 */
  onChanged: () => Promise<void> | void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<Preset | null>(null);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  /** 技能池里真实存在的目录名 —— 用来判定失效成员 */
  const liveDirs = useMemo(() => new Set(skills.map((s) => s.dirName)), [skills]);

  const nameOf = (dirName: string) => skills.find((s) => s.dirName === dirName)?.name ?? dirName;

  const doExport = async (p: Preset) => {
    const picked = await openDialog({ directory: true, multiple: false, title: t("preset.exportPick") });
    if (typeof picked !== "string" || !picked) return;
    setExportingId(p.id);
    try {
      const r = await api.presetExport(p.id, picked);
      const reasonText = (code: string) =>
        code === "invalid" ? t("preset.reasonInvalid") : t("preset.reasonMissing");
      // 跳过原因逐个列出，不静默丢弃
      const skippedNames = r.skipped.map((s) => `${s.dirName} (${reasonText(s.reason)})`).join(", ");
      if (r.exported.length === 0) {
        toast.warning(t("preset.exportNone", { names: skippedNames || "—" }));
      } else {
        toast.success(t("preset.exportDone", { ok: r.exported.length, path: r.zipPath }));
        if (r.skipped.length) {
          toast.info(t("preset.exportSkipped", { n: r.skipped.length, names: skippedNames }));
        }
      }
    } catch (e) {
      toast.error(t("preset.exportFailed", { error: presetErrorText(e, t) }));
    } finally {
      setExportingId(null);
    }
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
            <DialogDescription>{t("preset.manageHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {presets.length === 0 ? (
              <p className="text-[11px] text-ink-3">{t("preset.emptyHint")}</p>
            ) : (
              presets.map((p) => {
                const stale = p.skillDirNames.filter((d) => !liveDirs.has(d));
                return (
                  <div key={p.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{p.name}</span>
                      <Badge variant={p.skillDirNames.length ? "muted" : "warning"}>
                        {p.skillDirNames.length
                          ? t("preset.membersCount", { n: p.skillDirNames.length })
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
                      {p.skillDirNames.length === 0 ? (
                        <span className="text-[11px] text-ink-3">{t("preset.noMembers")}</span>
                      ) : (
                        p.skillDirNames.map((d) => {
                          const gone = !liveDirs.has(d);
                          return (
                            <span
                              key={d}
                              title={gone ? t("preset.reasonMissing") : d}
                              className={cn(
                                "inline-flex max-w-[220px] items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                                gone ? "bg-surface-2 text-ink-3 line-through" : "bg-primary-soft text-primary",
                              )}
                            >
                              <span className="min-w-0 truncate">{gone ? d : nameOf(d)}</span>
                              {gone ? <span className="shrink-0 opacity-80">· {t("preset.stale")}</span> : null}
                            </span>
                          );
                        })
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px]"
                        onClick={() => setRenaming(p)}
                      >
                        <Pencil className="size-3.5" />
                        {t("preset.renameTitle")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px]"
                        onClick={() => setEditing(p)}
                      >
                        <Check className="size-3.5" />
                        {t("preset.editMembers")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px]"
                        disabled={exportingId === p.id}
                        onClick={() => void doExport(p)}
                      >
                        {exportingId === p.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Download className="size-3.5" />
                        )}
                        {t("preset.export")}
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

      {/* 重命名：名称 + 描述 */}
      <PresetDialog
        open={!!renaming}
        onOpenChange={(v) => !v && setRenaming(null)}
        title={t("preset.renameTitle")}
        initialName={renaming?.name ?? ""}
        initialDescription={renaming?.description ?? ""}
        onSubmit={async (name, description) => {
          if (!renaming) return;
          try {
            await api.presetUpdate(renaming.id, { name, description });
          } catch (e) {
            throw presetErrorText(e, t);
          }
          toast.success(t("preset.renamed"));
          await onChanged();
        }}
      />

      {/* 编辑成员 */}
      <PresetMembersDialog
        preset={editing}
        skills={skills}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={async () => {
          toast.success(t("preset.membersSaved"));
          await onChanged();
        }}
      />

      {/* 删除二次确认 */}
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
            .presetDelete(id)
            .then(async () => {
              toast.success(t("preset.deleted", { name }));
              onDeleted(id);
              await onChanged();
            })
            .catch((e) => toast.error(presetErrorText(e, t)));
        }}
      />
    </>
  );
}

/** 成员多选：技能池里勾选/取消，失效成员同样列出以便移除。 */
function PresetMembersDialog({
  preset,
  skills,
  onOpenChange,
  onSaved,
}: {
  preset: Preset | null;
  skills: SkillMeta[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!preset) return;
    setSel(new Set(preset.skillDirNames));
    setQ("");
  }, [preset]);

  const liveDirs = useMemo(() => new Set(skills.map((s) => s.dirName)), [skills]);
  /** 失效成员：仍在预设里但技能池已没有 */
  const staleMembers = useMemo(
    () => (preset ? preset.skillDirNames.filter((d) => !liveDirs.has(d)) : []),
    [preset, liveDirs],
  );

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return skills
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.dirName.toLowerCase().includes(needle))
      .slice(0, 500);
  }, [skills, q]);

  const toggle = (dirName: string) =>
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(dirName)) n.delete(dirName);
      else n.add(dirName);
      return n;
    });

  const save = async () => {
    if (!preset) return;
    setSaving(true);
    try {
      // 保持勾选顺序稳定：先按技能池顺序，再补上仍在选中的失效成员
      const ordered = [
        ...skills.map((s) => s.dirName).filter((d) => sel.has(d)),
        ...staleMembers.filter((d) => sel.has(d)),
      ];
      await api.presetUpdate(preset.id, { skillDirNames: ordered });
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
          <DialogDescription>{t("preset.editMembersHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} />
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border">
            {staleMembers.length ? (
              <div className="border-b border-border bg-surface-2/40 px-2.5 py-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-3">{t("preset.stale")}</div>
                {staleMembers.map((d) => (
                  <label
                    key={d}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] text-ink-3"
                  >
                    <input
                      type="checkbox"
                      checked={sel.has(d)}
                      onChange={() => toggle(d)}
                      className="size-3.5 accent-[var(--ah-primary)]"
                    />
                    <span className="min-w-0 flex-1 truncate line-through">{d}</span>
                    <span className="shrink-0 text-[10px]">{t("preset.reasonMissing")}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {list.length === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-ink-3">{t("common.empty")}</p>
            ) : (
              list.map((s) => (
                <label
                  key={s.dirName}
                  className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-2.5 py-1.5 text-xs text-ink-2 last:border-b-0 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={sel.has(s.dirName)}
                    onChange={() => toggle(s.dirName)}
                    className="size-3.5 accent-[var(--ah-primary)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-3">{s.dirName}</span>
                </label>
              ))
            )}
          </div>
          <p className="text-[11px] text-ink-3">{t("preset.membersCount", { n: sel.size })}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? t("preset.saving") : t("preset.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
