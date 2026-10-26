import { GripVertical, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { loadHarnessReports } from "@/ahub/lib/harnessScan";
import type { HarnessReport } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 工具展示顺序：拖动调整各 AI 工具的显示顺序。
 * 顺序保存在设置里（harnessOrder），应用到 MCP / Skills 的所有列表。
 */
export function HarnessOrderSection() {
  const { t } = useTranslation();
  const info = useSettings((s) => s.info);
  const setHarnessOrder = useSettings((s) => s.setHarnessOrder);
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => {
    void loadHarnessReports().then(setReports).catch(() => setReports([]));
  }, []);

  const savedOrder = info?.settings.harnessOrder ?? [];
  const detected = (reports ?? []).filter((r) => r.supportsMcp || r.supportsSkills || r.mcpServers.length || r.skills.length);

  // 合并保存顺序 + 新探测到的：保存顺序优先，其余按探测顺序追加
  const merged: HarnessReport[] = (() => {
    if (!reports) return [];
    const byId = new Map(detected.map((r) => [r.id, r]));
    const out: HarnessReport[] = [];
    for (const id of savedOrder) {
      const r = byId.get(id);
      if (r) {
        out.push(r);
        byId.delete(id);
      }
    }
    for (const r of detected) if (byId.has(r.id)) out.push(r);
    return out;
  })();

  const persist = (list: HarnessReport[]) => {
    void setHarnessOrder(list.map((r) => r.id));
  };

  const move = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const list = [...merged];
    const from = list.findIndex((r) => r.id === fromId);
    const to = list.findIndex((r) => r.id === toId);
    if (from === -1 || to === -1) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    persist(list);
  };

  const reset = () => void setHarnessOrder([]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-2">{t("settings.harnessOrder")}</span>
        <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={reset} disabled={!savedOrder.length}>
          <RotateCcw className="size-3.5" />
          {t("settings.harnessOrderReset")}
        </Button>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-ink-3">{t("settings.harnessOrderHint")}</p>

      {reports === null ? (
        <p className="text-[11px] text-ink-3">{t("harness.scanning")}</p>
      ) : merged.length === 0 ? (
        <p className="text-[11px] text-ink-3">{t("settings.harnessOrderEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {merged.map((r) => (
            <div
              key={r.id}
              draggable
              onDragStart={() => setDragId(r.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverId(r.id);
              }}
              onDrop={() => {
                if (dragId) move(dragId, r.id);
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border bg-bg-subtle px-3 py-2 transition-colors",
                dragId === r.id ? "border-primary opacity-60" : "border-border",
                overId === r.id && dragId !== r.id ? "border-primary/60 bg-primary-soft" : "",
              )}
            >
              <GripVertical className="size-4 shrink-0 cursor-grab text-ink-3" />
              <HarnessIcon id={r.id} className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{r.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-3">
                {r.mcpServers.length ? t("harness.mcpCount", { count: r.mcpServers.length }) : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
