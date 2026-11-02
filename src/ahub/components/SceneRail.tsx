import { useState } from "react";
import { Check, Download, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { useActiveScene, useScenes, type SceneKind } from "@/ahub/stores/scenes";

/**
 * 场景栏（左侧最上面一格）：把一批技能 / MCP / 提示词存成一个组合，点一下只看这些。
 *
 * 语义只有两件事：**过滤视图** 和 **导出 zip**。不部署、不写宿主配置——
 * 用户自己拿到 zip 手动装，比在这层引入"环境/项目"概念干净得多。
 * 高度上限 45%，超出自己滚，免得场景一多就把底下的标签栏挤没。
 */
export function SceneRail({
  kind,
  selected,
  onExport,
  className,
}: {
  kind: SceneKind;
  /** 当前勾选的 id（技能是 dirName、MCP/提示词是各自 id），用来新建 / 更新场景 */
  selected: string[];
  /** 导出这些成员；不传就不显示导出按钮 */
  onExport?: (ids: string[]) => void | Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  const scenes = useScenes((s) => s.scenes[kind]);
  const create = useScenes((s) => s.create);
  const rename = useScenes((s) => s.rename);
  const setMembers = useScenes((s) => s.setMembers);
  const remove = useScenes((s) => s.remove);
  const setActive = useScenes((s) => s.setActive);
  const active = useActiveScene(kind);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const submit = () => {
    const name = draft.trim();
    setCreating(false);
    setDraft("");
    if (!name) return;
    const id = create(kind, name, selected);
    setActive(kind, id);
  };

  return (
    <div className={cn("flex max-h-[45%] min-h-0 flex-col", className)}>
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-1.5">
        <span className="truncate text-[10.5px] font-medium text-ink-3">{t("scene.title")}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-ink-3">{scenes.length}</span>
        <button
          type="button"
          aria-label={t("scene.new")}
          title={selected.length ? t("scene.newFromSelection", { n: selected.length }) : t("scene.newHint")}
          onClick={() => { setDraft(""); setCreating(true); }}
          className="ml-auto shrink-0 rounded p-0.5 text-ink-3 outline-none transition-colors hover:text-foreground"
        >
          <Plus className="size-3" />
        </button>
        {active ? (
          <button
            type="button"
            aria-label={t("scene.clearFilter")}
            title={t("scene.clearFilter")}
            onClick={() => setActive(kind, null)}
            className="shrink-0 rounded p-0.5 text-primary outline-none hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {creating ? (
          <div className="mb-0.5 flex items-center gap-1 rounded-md border border-primary/40 px-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={submit}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
                if (event.key === "Escape") { setCreating(false); setDraft(""); }
              }}
              placeholder={t("scene.namePlaceholder")}
              className="h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-ink-3"
            />
          </div>
        ) : null}

        {scenes.map((scene) => {
          const on = active?.id === scene.id;
          const count = scene.members.length;
          return (
            <div
              key={scene.id}
              className={cn(
                "group/scene flex h-7 items-center gap-1 rounded-md px-1.5 transition-colors",
                on ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-muted",
              )}
            >
              {editing?.id === scene.id ? (
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ id: scene.id, name: event.target.value })}
                  onBlur={() => { rename(kind, scene.id, editing.name); setEditing(null); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { rename(kind, scene.id, editing.name); setEditing(null); }
                    if (event.key === "Escape") setEditing(null);
                  }}
                  className="h-5 min-w-0 flex-1 rounded border border-primary bg-surface px-1 text-[11px] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setActive(kind, scene.id)}
                  title={t("scene.applyHint")}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] outline-none"
                >
                  {on ? <Check className="size-3 shrink-0" /> : <span className="size-3 shrink-0" />}
                  <span className="truncate">{scene.name}</span>
                  <span className="shrink-0 tabular-nums text-[10.5px] text-ink-3">{count}</span>
                </button>
              )}
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/scene:opacity-100">
                <button
                  type="button"
                  aria-label={t("scene.update")}
                  title={t("scene.updateHint", { n: selected.length })}
                  disabled={selected.length === 0}
                  onClick={() => setMembers(kind, scene.id, selected)}
                  className="rounded p-0.5 text-ink-3 hover:text-foreground disabled:opacity-30"
                >
                  <Plus className="size-2.5" />
                </button>
                {onExport ? (
                  <button
                    type="button"
                    aria-label={t("scene.export")}
                    title={count ? t("scene.exportHint", { n: count }) : t("scene.exportEmpty")}
                    disabled={count === 0}
                    onClick={() => void onExport(scene.members)}
                    className="rounded p-0.5 text-ink-3 hover:text-foreground disabled:opacity-30"
                  >
                    <Download className="size-2.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={t("scene.rename")}
                  onClick={() => setEditing({ id: scene.id, name: scene.name })}
                  className="rounded p-0.5 text-ink-3 hover:text-foreground"
                >
                  <Pencil className="size-2.5" />
                </button>
                <button
                  type="button"
                  aria-label={t("scene.delete")}
                  onClick={() => remove(kind, scene.id)}
                  className="rounded p-0.5 text-ink-3 hover:text-danger"
                >
                  <Trash2 className="size-2.5" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
