import { useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { groupTags } from "@/ahub/lib/tag-groups";
import { useTagGroups } from "@/ahub/stores/tag-groups";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { Button } from "@/ahub/components/ui/button";

/**
 * 标签选择器：既能从已有标签里挑（按分组列出、可搜索），也能当场输入新标签。
 * 新建技能、编辑技能、批量打标签共用同一个控件 —— 避免三处各写一套，标签也更容易收敛。
 */
export function TagPicker({
  value,
  onChange,
  allTags,
  placeholder,
  id,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  allTags: string[];
  placeholder?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const groups = useTagGroups((s) => s.groups);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const view = useMemo(() => {
    const q = text.trim().toLowerCase();
    const pool = allTags.filter((tag) => !value.includes(tag));
    const visible = q ? pool.filter((tag) => tag.toLowerCase().includes(q)) : pool;
    return groupTags(visible, groups);
  }, [allTags, groups, text, value]);

  const add = (tag: string) => {
    const next = tag.trim();
    if (!next) return;
    if (!value.includes(next)) onChange([...value, next]);
    setText("");
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-surface px-2 py-1 transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--ah-primary-soft)]"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span key={tag} className="inline-flex max-w-40 items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
            <span className="truncate">{tag}</span>
            <button
              type="button"
              aria-label={`remove ${tag}`}
              className="rounded-full p-0.5 outline-none hover:bg-primary/15"
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((item) => item !== tag));
              }}
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(text);
            }
            if (event.key === "Backspace" && !text && value.length > 0) onChange(value.slice(0, -1));
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder={value.length === 0 ? (placeholder ?? t("tagPicker.placeholder")) : ""}
          className="h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-ink-3"
        />
      </div>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-1.5 shadow-xl">
          {text.trim() && !allTags.includes(text.trim()) ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(text)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11.5px] text-primary hover:bg-primary-soft"
            >
              <Plus className="size-3" />
              {t("tagPicker.create", { tag: text.trim() })}
            </button>
          ) : null}
          {view.groups.map((group) => (
            <div key={group.id}>
              {group.tags.length > 0 ? <p className="px-2 pt-1 text-[10px] text-ink-3">{group.name}</p> : null}
              {group.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(tag)}
                  className={cn("flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11.5px] text-ink-2 hover:bg-muted")}
                >
                  <Check className="size-3 opacity-0" />
                  {tag}
                </button>
              ))}
            </div>
          ))}
          {view.ungrouped.length > 0 ? (
            <div>
              <p className="px-2 pt-1 text-[10px] text-ink-3">{t("tagShelf.ungrouped")}</p>
              {view.ungrouped.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(tag)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11.5px] text-ink-2 hover:bg-muted"
                >
                  <Check className="size-3 opacity-0" />
                  {tag}
                </button>
              ))}
            </div>
          ) : null}
          {!text.trim() && view.groups.every((group) => group.tags.length === 0) && view.ungrouped.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-ink-3">{t("tagPicker.empty")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 批量打标签：追加 / 移除 / 清空，作用在当前勾选的技能上。 */
export function BatchTagDialog({
  open,
  onOpenChange,
  count,
  allTags,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  allTags: string[];
  onApply: (mode: "add" | "remove" | "clear", tags: string[]) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async (mode: "add" | "remove" | "clear") => {
    setBusy(true);
    try {
      await onApply(mode, tags);
      setTags([]);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tagPicker.batchTitle", { n: count })}</DialogTitle>
          <DialogDescription>{t("tagPicker.batchHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <TagPicker value={tags} onChange={setTags} allTags={allTags} />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => void run("clear")}>
            {t("tagPicker.clear")}
          </Button>
          <Button variant="secondary" disabled={busy || tags.length === 0} onClick={() => void run("remove")}>
            {t("tagPicker.remove")}
          </Button>
          <Button disabled={busy || tags.length === 0} onClick={() => void run("add")}>
            {t("tagPicker.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
