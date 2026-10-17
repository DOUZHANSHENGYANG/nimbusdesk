import type { ReactNode } from "react";
import { RiArrowRightUpLine, RiBookOpenLine, RiCalendarCheckLine, RiComputerLine, RiFolderLine, RiImageLine, RiRefreshLine, RiAddLine } from "@remixicon/react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from '@/components/ui/button';
import { ItemIcon } from "@/features/files/icons";
import { rangeLabel, statusOf, type PlanTask } from "@/features/plans/types";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import type { CaptureRecord } from "@/features/knowledge/types";
import type { FileCategory, FileItem } from "@/stores/files";
import { openPath, openUrl } from "@/lib/tauri";
import type { HomeModule } from "./workspace-orbit";

export interface InboxSummary {
  status: "unbound" | "loading" | "ready" | "error";
  records: CaptureRecord[];
  error?: string;
}

export function HomeInspector({ selected, tasks, latest, categories, openCategories, items, inbox, vaultName, today, now, onToggle, onRetry, onCapture, captureBusy }: {
  selected: HomeModule;
  tasks: PlanTask[];
  latest: FileItem[];
  categories: FileCategory[];
  openCategories: FileCategory[];
  items: FileItem[];
  inbox: InboxSummary;
  vaultName: string;
  today: string;
  now: Date;
  onToggle: (id: string) => void;
  onRetry: () => void;
  onCapture: () => void;
  captureBusy: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const heading = { plans: t("home.plansToday"), files: t("home.latestItems"), knowledge: t("home.knowledgeInbox"), fences: t("home.desktopFences") }[selected];
  const destination = selected === "plans" ? "/plans" : selected === "knowledge" ? "/knowledge" : "/files";
  const action = selected === "plans" ? t("home.goToPlans") : selected === "knowledge" ? t("home.goKnowledge") : t("home.goFiles");
  const ModuleIcon = { plans: RiCalendarCheckLine, files: RiFolderLine, knowledge: RiBookOpenLine, fences: RiComputerLine }[selected];

  return (
    <aside className="home-inspector" id="home-inspector" aria-label={t("home.moduleContents")}>
      <div key={selected} className="home-inspector-body">
        <header className="home-inspector-heading">
          <span className="home-inspector-icon" aria-hidden="true"><ModuleIcon className="size-5" /></span>
          <div className="min-w-0"><p className="home-inspector-eyebrow">{t("home.selectedModule")}</p><h2>{heading}</h2></div>
        </header>
        {selected !== 'knowledge' && <p className="home-inspector-scope">{t(`home.${selected}Scope`)}</p>}
        {selected === 'knowledge' && <div className="home-knowledge-actions"><Button size="sm" disabled={captureBusy} onClick={onCapture}><RiAddLine className="size-4"/>{t('home.quickCapture')}</Button><button type="button" onClick={()=>navigate('/knowledge')} className="home-knowledge-vault" title={vaultName || t('home.connectVault')}><RiBookOpenLine className="size-4 shrink-0" aria-hidden="true"/><span>{vaultName || t('home.connectVault')}</span><RiArrowRightUpLine className="size-3.5 shrink-0" aria-hidden="true"/></button></div>}

        {selected === "plans" && (tasks.length ? (
          <div className="home-task-list">
            {tasks.slice(0, 6).map((task) => (
              <div className="home-task-row" key={task.id} role="group" aria-label={task.title}>
                <StatusButton status={statusOf(task, today, now)} onToggle={() => onToggle(task.id)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13px] leading-6" style={doneTitleStyle(task.done)}>{task.title}</p>
                  {(rangeLabel(task) || task.link) && <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="font-mono">{rangeLabel(task)}</span>{task.link && <span className="truncate">{task.link.title || task.link.path.split(/[\\/]/).filter(Boolean).pop()}</span>}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>{t("home.noPlansToday")}</Empty>)}

        {selected === "files" && (latest.length ? latest.map((item) => (
          <button className="home-resource-row" key={item.id} type="button" onClick={() => {
            void (item.type === "url" ? openUrl(item.path) : openPath(item.path)).catch((error) => toast.error(String(error)));
          }}>
            <span className="home-resource-icon"><ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} className="size-5 shrink-0" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{item.title}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{categories.find((category) => category.id === item.categoryId)?.name || t("home.uncategorized")}</span></span>
            <RiArrowRightUpLine className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )) : <Empty>{t("home.noItems")}</Empty>)}

        {selected === "knowledge" && (
          inbox.status === "loading" ? <p role="status" className="py-8 text-xs text-muted-foreground">{t("home.loadingInbox")}</p>
          : inbox.status === "error" ? <div role="alert" className="py-4"><p className="break-words text-xs text-destructive">{inbox.error}</p><button className="home-inspector-retry" type="button" onClick={onRetry}><RiRefreshLine className="size-4" />{t("home.retry")}</button></div>
          : inbox.status === "unbound" ? <Empty>{t("home.bindVaultHint")}</Empty>
          : inbox.records.length ? inbox.records.slice(0, 5).map((record) => (
            <div className="home-resource-row" key={record.id}>
              <span className="home-resource-icon"><RiBookOpenLine className="size-5" /></span>
              <div className="min-w-0 flex-1"><p className="truncate text-[13px]">{record.title}</p><p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(record.createdAt)}</span>{record.attachments.length > 0 && <span className="inline-flex items-center gap-1"><RiImageLine className="size-3" aria-hidden="true" />{record.attachments.length}</span>}</p></div>
            </div>
          )) : <Empty>{t("home.emptyInbox")}</Empty>
        )}

        {selected === "fences" && (openCategories.length ? openCategories.slice(0, 6).map((category) => (
          <div className="home-resource-row" key={category.id}>
            <span className="home-resource-icon"><RiFolderLine className="size-5" /></span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{category.name}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{t("home.itemCount", { count: items.filter((item) => item.categoryId === category.id).length })}</span>
          </div>
        )) : <Empty>{t("home.noFences")}</Empty>)}

        {selected !== 'knowledge' && <button type="button" onClick={() => navigate(destination)} className="home-inspector-action">{action}<RiArrowRightUpLine className="size-4" /></button>}
      </div>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="home-inspector-empty">{children}</p>;
}
