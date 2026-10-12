import { useState } from "react";
import { ArchiveRestore, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { dayProgress, parseDate } from "@/features/plans/types";
import { restoreDay, usePlansArchive } from "@/features/plans/store";
import { ReadOnlyTree } from "@/features/plans/views/shared";
import { useModal } from "@/components/shell/modal-host";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** 归档浏览视图：按日期倒序，展开只读树，可恢复 */
export function ArchiveView({ onRestore }: { onRestore: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const archiveDays = usePlansArchive((s) => s.days);
  const { confirm } = useModal();
  const [openDate, setOpenDate] = useState<string | null>(null);

  const entries = Object.entries(archiveDays).sort((a, b) => b[0].localeCompare(a[0]));
  const dateFmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });

  const onRestoreClick = async (date: string) => {
    const ok = await confirm({
      title: t("plans.restoreConfirm", { date }),
    });
    if (!ok) return;
    if (restoreDay(date)) {
      toast.success(t("plans.restored", { date }));
      onRestore(date);
    }
  };

  if (entries.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">
        {t("plans.archiveEmpty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([date, entry]) => {
        const { done, total } = dayProgress(entry.tasks);
        const open = openDate === date;
        return (
          <div key={date} className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 px-3.5 py-2.5">
              <button
                type="button"
                onClick={() => setOpenDate(open ? null : date)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <ChevronRight
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                    open && "rotate-90",
                  )}
                />
                <span className="text-[13px] font-semibold">{dateFmt.format(parseDate(date))}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {done}/{total}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void onRestoreClick(date)}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-brand/10 hover:text-brand"
              >
                <ArchiveRestore className="size-3.5" />
                {t("plans.restore")}
              </button>
            </div>

            {open && (
              <div className="border-t border-border/60 px-3 py-2">
                <ReadOnlyTree tasks={entry.tasks} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
