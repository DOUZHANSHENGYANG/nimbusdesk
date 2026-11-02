import { useMemo, useState } from "react";
import { CheckSquare, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
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

/**
 * 标签管理：列出当前全部标签（带出现次数），可选择性地删。
 *
 * 去掉分组之后，标签就是一组自由字符串，管理动作只剩两件有意义的事：
 * **删掉选中的**、**全清**。改名/合并这类语义操作必须有引用计数兜底，
 * 现在不做 —— 光靠「删」就能把脏标签收敛干净。
 */
export function TagManagerDialog({
  open,
  onOpenChange,
  tags,
  onRemove,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 全部标签 + 各自被多少条引用 */
  tags: { tag: string; count: number }[];
  /** 从所有条目上摘掉这些标签 */
  onRemove: (tags: string[]) => Promise<void> | void;
  /** 摘掉全部标签（需要二次确认） */
  onClear: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = tags.filter((row) => !q || row.tag.toLowerCase().includes(q));
    return rows.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [tags, query]);

  const allPicked = visible.length > 0 && visible.every((row) => picked.has(row.tag));

  const toggle = (tag: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  const run = async (action: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setPicked(new Set()); setConfirming(false); } onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("tagManager.title")}</DialogTitle>
          <DialogDescription>{t("tagManager.hint")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!visible.length} onClick={() => setPicked(allPicked ? new Set() : new Set(visible.map((row) => row.tag)))}>
              {allPicked ? <CheckSquare /> : <Square />}
              {allPicked ? t("tagManager.deselectAll") : t("tagManager.selectAll")}
            </Button>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("prompts.tagSearch")}
              aria-label={t("tagManager.search")}
              className="h-8 min-w-40 flex-1 rounded-md border border-input bg-surface px-2 text-xs outline-none focus:border-primary"
            />
            <span className="text-xs text-muted-foreground">{t("tagManager.selected", { n: picked.size })}</span>
          </div>

          <div className="max-h-72 min-h-24 overflow-y-auto rounded-lg border border-border">
            {!visible.length ? (
              <p className="p-4 text-center text-xs text-muted-foreground">{t("tagManager.empty")}</p>
            ) : (
              visible.map((row) => {
                const on = picked.has(row.tag);
                return (
                  <button
                    key={row.tag}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(row.tag)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-[12px] last:border-0 transition-colors",
                      on ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-muted",
                    )}
                  >
                    {on ? <CheckSquare className="size-3.5 shrink-0" /> : <Square className="size-3.5 shrink-0 text-ink-3" />}
                    <span className="min-w-0 flex-1 truncate">{row.tag}</span>
                    <span className="shrink-0 tabular-nums text-[10.5px] text-ink-3">{row.count}</span>
                  </button>
                );
              })
            )}
          </div>

          {confirming ? (
            <p className="rounded-lg bg-warning/10 p-2 text-[11px] leading-relaxed text-warning">
              {t("tagManager.clearConfirm", { n: tags.length })}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            className="mr-auto text-destructive"
            disabled={busy || !tags.length}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              void run(async () => {
                await onClear();
                setPicked(new Set());
              });
            }}
          >
            <Trash2 />
            {confirming ? t("tagManager.clearConfirmBtn") : t("tagManager.clearAll")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || picked.size === 0}
            onClick={() =>
              void run(async () => {
                await onRemove([...picked]);
                setPicked(new Set());
              })
            }
          >
            {t("tagManager.removeSelected", { n: picked.size })}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
