import { Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAiJobs } from "@/ahub/stores/ai-jobs";

/** AI 任务悬浮条：标签 / 摘要的后台任务，切到哪个页面都看得见。 */
export function AiJobsDock() {
  const { t } = useTranslation();
  const { jobs, clearFinished } = useAiJobs();
  const active = jobs.filter((job) => job.stage === "queued" || job.stage === "running").length;
  const failed = jobs.filter((job) => job.stage === "failed").length;
  if (!jobs.length) return null;

  return (
    <div className="fixed right-4 bottom-20 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-[11px] text-foreground shadow-lg">
      {active > 0 ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <Sparkles className="size-3.5 text-primary" />}
      <span>{t("skills.aiJobs", { n: active })}</span>
      {failed > 0 ? <span className="text-danger">· {failed}</span> : null}
      {active === 0 ? (
        <button type="button" className="rounded-full p-0.5 text-ink-3 hover:text-foreground" onClick={clearFinished} title={t("skills.aiJobsClear")}>
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
