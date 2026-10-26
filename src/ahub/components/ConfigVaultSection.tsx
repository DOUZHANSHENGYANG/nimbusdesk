import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/ahub/components/ui/button";
import { Switch } from "@/ahub/components/motion/switch";
import { api } from "@/ahub/lib/api";
import { useVault } from "@/ahub/stores/vault";

/**
 * 配置保险：为各 AI 工具的配置文件提供版本管理。
 *
 * **每个工具的版本现在跟着工具卡走**（卡上有：是否纳入监视、存了几版、展开看版本并恢复）——
 * 一个工具的东西放一起，不用为了回滚某个配置再去另一块地方找它。
 * 这里只剩**全局**那两件事：每日自动备份的开关，以及「给全部已纳入的配置打一份快照」。
 */
export function ConfigVaultSection() {
  const { t } = useTranslation();
  const status = useVault((s) => s.status);
  const index = useVault((s) => s.index);
  const busy = useVault((s) => s.busy);
  const load = useVault((s) => s.load);
  const snapshot = useVault((s) => s.snapshot);

  useEffect(() => {
    void load().catch((e) => toast.error(String(e)));
  }, [load]);

  const watched = index?.watched ?? [];
  const selectAll = async () => {
    try {
      await useVault.getState().setWatched((status ?? []).filter((item) => item.exists).map((item) => item.harness));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-relaxed text-ink-3">{t("settings.vaultHint")}</p>

      {/* 每日自动备份 */}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2.5">
        <Switch
          checked={index?.daily ?? false}
          onCheckedChange={(value) => {
            void api.vaultSetDaily(value).then(load).catch((e) => toast.error(String(e)));
          }}
        />
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-2">{t("settings.vaultDaily")}</div>
          <div className="text-[11px] text-ink-3">
            {index?.lastDaily ? t("settings.vaultLastDaily", { date: index.lastDaily }) : t("settings.vaultDailyHint")}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => void selectAll()}>
          {t("common.selectAll")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-[11px]"
          disabled={busy || watched.length === 0}
          onClick={() =>
            void snapshot(watched)
              .then((saved) => toast.success(t("settings.vaultSnapshotDone", { n: saved.length })))
              .catch((e) => toast.error(String(e)))
          }
        >
          <Save className="size-3.5" />
          {t("settings.vaultSnapshotNow")}
        </Button>
        <span className="text-[11px] text-ink-3">{t("settings.vaultSafety")}</span>
      </div>
    </div>
  );
}
