import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ahub/components/ui/button";
import { Input } from "@/ahub/components/ui/input";
import { cn } from "@/ahub/lib/utils";

export interface KvRow {
  key: string;
  value: string;
}

export function rowsFromRecord(rec: Record<string, string>): KvRow[] {
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

export function recordFromRows(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return out;
}

/**
 * 键值对行编辑器：用于环境变量 / 请求头等，逐行填写「键 → 值」，可增删。
 */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useTranslation();

  const update = (i: number, patch: Partial<KvRow>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder ?? t("mcp.kvKey")}
            className="h-8 flex-1 font-mono text-xs"
            dir="ltr"
          />
          <span className="shrink-0 text-ink-3">=</span>
          <Input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder ?? t("mcp.kvValue")}
            className="h-8 flex-[1.4] font-mono text-xs"
            dir="ltr"
          />
          <button
            type="button"
            title={t("common.delete")}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={cn("h-8 w-fit gap-1.5 text-xs", rows.length === 0 && "mt-0.5")}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" />
        {t("mcp.kvAdd")}
      </Button>
    </div>
  );
}
