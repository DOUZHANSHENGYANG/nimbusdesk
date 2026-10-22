import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import { useSettings } from "@/stores/settings";

/**
 * 保存的筛选视图：把「迭代 + 状态 + 搜索词」存成一个命名快照，一键切回。
 * 借鉴 Huly 的 saved views——纯前端状态，不碰数据模型。
 */
export function ProjectViewsBar(props: {
  iteration: string;
  status: string;
  search: string;
  onApply: (view: { iteration: string; status: string; search: string }) => void;
}) {
  const { t } = useTranslation();
  const views = useSettings((s) => s.projectViews);
  const setViews = useSettings((s) => s.setProjectViews);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setViews([
      ...views,
      { id: `v${Date.now()}`, name: trimmed, iteration: props.iteration, status: props.status, search: props.search },
    ]);
    setName("");
    setNaming(false);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
      <Bookmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {views.length === 0 && !naming && (
        <span className="text-[11.5px] text-muted-foreground">{t("projects.views.empty")}</span>
      )}
      {views.map((view) => (
        <span key={view.id} className="group inline-flex items-center gap-0.5 rounded-full bg-muted pl-2 pr-1 py-0.5">
          <button
            type="button"
            title={`${view.iteration} · ${view.status}${view.search ? ` · ${view.search}` : ""}`}
            onClick={() => props.onApply(view)}
            className="text-[11.5px] text-foreground/85 hover:text-foreground"
          >
            {view.name}
          </button>
          <button
            type="button"
            aria-label={t("projects.views.remove")}
            onClick={() => setViews(views.filter((v) => v.id !== view.id))}
            className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setName(""); setNaming(false); }
            }}
            placeholder={t("projects.views.name")}
            className="h-5 w-28 rounded border border-border bg-background px-1.5 text-[11.5px] outline-none focus:border-brand/60"
          />
          <button type="button" onClick={save} className="text-[11.5px] text-brand hover:underline">
            {t("projects.views.save")}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden />
          {t("projects.views.saveCurrent")}
        </button>
      )}
    </div>
  );
}
