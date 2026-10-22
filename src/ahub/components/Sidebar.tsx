import { useEffect, useState } from "react";
import { FolderOpen, FileText, ShieldCheck, Sparkles, Server, Globe } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { api } from "@/ahub/lib/api";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";
import { useUi, type Page } from "@/ahub/stores/ui";

const items: { id: Page; icon: typeof FileText; key: string }[] = [
  { id: "prompts", icon: FileText, key: "nav.prompts" },
  { id: "mcp", icon: Server, key: "nav.mcp" },
  { id: "skills", icon: Sparkles, key: "nav.skills" },
  { id: "vault", icon: ShieldCheck, key: "nav.vault" },
  { id: "env", icon: Globe, key: "nav.env" },
];

export function Sidebar() {
  const { t } = useTranslation();
  const page = useUi((s) => s.page);
  const setPage = useUi((s) => s.setPage);
  const prompts = useData((s) => s.prompts.length);
  const mcp = useData((s) => s.mcp.length);
  const skills = useData((s) => s.skills.length);
  const dataDirs = useSettings((s) => s.info?.dataDirs.root ?? "");
  const [harnessCount, setHarnessCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    void api
      .vaultInstalledCount()
      .then(setHarnessCount)
      .catch(() => setHarnessCount(undefined));
  }, []);

  const counts: Partial<Record<Page, number>> = { prompts, mcp, skills, vault: harnessCount };

  return (
    <aside className="ah-material flex w-[168px] shrink-0 flex-col border-r border-border xl:w-[200px]">
      <nav className="flex flex-col gap-1 p-3">
        {items.map(({ id, icon: Icon, key }) => {
          const active = page === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setPage(id)}
              className={cn(
                "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] outline-none transition-colors duration-150",
                active ? "text-foreground" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-lg bg-primary-soft"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
              <Icon className={cn("relative z-10 size-4 shrink-0", active && "text-primary")} />
              <span className={cn("relative z-10 font-medium", active && "text-primary")}>{t(key)}</span>
              {counts[id] !== undefined ? (
                <span
                  className={cn(
                    "relative z-10 ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-surface-2 text-ink-3",
                  )}
                >
                  {counts[id]}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto p-3">
        <button
          type="button"
          title={t("common.reveal")}
          onClick={() => dataDirs && void api.revealPath(dataDirs)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[11px] text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink-2"
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate" dir="ltr">
            {dataDirs || "…"}
          </span>
        </button>
        <div className="px-3 pb-1 pt-1 text-[10px] text-ink-3">{t("app.name")} v0.1.0</div>
      </div>
    </aside>
  );
}
