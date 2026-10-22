import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface KvRow {
  key: string;
  value: string;
}

export function rowsFromRecord(record: Record<string, string>): KvRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export function recordFromRows(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

/** 键值对行编辑器：环境变量 / 请求头这类「键 → 值」，逐行填写、可增删。 */
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

  const update = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
            placeholder={keyPlaceholder ?? t("toolbox.kv.key")}
            className="h-8 flex-1 font-mono text-xs"
            dir="ltr"
          />
          <span className="shrink-0 text-ink-3">=</span>
          <Input
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder={valuePlaceholder ?? t("toolbox.kv.value")}
            className="h-8 flex-[1.4] font-mono text-xs"
            dir="ltr"
          />
          <button
            type="button"
            title={t("toolbox.delete")}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
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
        {t("toolbox.kv.add")}
      </Button>
    </div>
  );
}
