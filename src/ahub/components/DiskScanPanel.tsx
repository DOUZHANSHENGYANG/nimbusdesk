import { HardDrive, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";
import type { DiscoveredCli } from "@/ahub/lib/types";

/** 全盘扫描面板：触发扫描 + 缓存结果列表 + PATH 备份恢复。 */
export function DiskScanPanel({ onScanned }: { onScanned: (tools: DiscoveredCli[]) => void }) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [tools, setTools] = useState<DiscoveredCli[]>([]);

  // 首次进入读缓存，不自动重扫（只有手动刷新才触发全盘遍历）
  useEffect(() => {
    let cancelled = false;
    void api
      .diskScanCached()
      .then((cached) => {
        if (!cancelled && cached?.length) {
          setTools(cached);
          onScanned(cached);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onScanned]);

  const run = async () => {
    setScanning(true);
    try {
      const next = await api.diskScan();
      setTools(next);
      onScanned(next);
      if (next.length === 0) toast.info(t("envSetup.diskEmpty"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setScanning(false);
    }
  };

  const restore = async () => {
    try {
      await api.restorePathBackup();
      toast.success(t("envSetup.restorePathDone"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" className="h-8 text-[11px]" disabled={scanning} onClick={() => void run()}>
          {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {scanning ? t("envSetup.diskScanning") : tools.length ? t("envSetup.diskRescan") : t("envSetup.diskScan")}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => void restore()}>
          <Undo2 className="size-3.5" />
          {t("envSetup.restorePath")}
        </Button>
        {tools.length > 0 ? (
          <span className="text-[11px] tabular-nums text-ink-3">{t("envSetup.diskCount", { n: tools.length })}</span>
        ) : null}
      </div>

      {tools.length > 0 ? (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {tools.map((cli) => (
            <div
              key={`${cli.name}-${cli.installPath}`}
              className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <HardDrive className="size-3 shrink-0 text-ink-3" />
              <span className="w-28 shrink-0 truncate text-[12px] font-medium text-foreground">{cli.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3" dir="ltr" title={cli.installPath}>
                {cli.installPath}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-ink-3">{t("envSetup.diskHint")}</p>
      )}
    </div>
  );
}
