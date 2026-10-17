import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import { useStorageHealth } from "@/stores/storage-health";
import { useSettings } from "@/stores/settings";
import { revealInExplorer } from "@/lib/tauri";

/**
 * 落盘失败告警条。
 *
 * 只在「写不进去」这种用户必须立刻知道的情况下出现 —— 否则用户会以为
 * 自己的编辑已保存。点击可打开数据目录查看（磁盘满/目录被删/权限问题），
 * 右侧 ✕ 可暂时收起（下次再失败会重新出现）。
 */
export function StorageAlert() {
  const { t } = useTranslation();
  const problem = useStorageHealth((s) => s.problem);
  const key = useStorageHealth((s) => s.key);
  const detail = useStorageHealth((s) => s.detail);
  const at = useStorageHealth((s) => s.at);
  const dismiss = useStorageHealth((s) => s.dismiss);
  const dataDir = useSettings((s) => s.dataDir);

  // 失败瞬间弹一次 toast（告警条可能被用户收起过），同一时间戳只弹一次
  const toastedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!problem || at == null || toastedAt.current === at) return;
    toastedAt.current = at;
    toast.error(t("storage.failedToast"), { description: detail ?? undefined });
  }, [problem, at, detail, t]);

  if (!problem) return null;

  const kindLabel =
    problem === "write"
      ? t("storage.writeFailed")
      : problem === "remove"
        ? t("storage.removeFailed")
        : t("storage.readFailed");

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
    >
      <AlertTriangle className="mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{kindLabel}</span>
        {key && <span className="ml-1.5 font-mono opacity-80">{key}</span>}
        {detail && (
          <span className="ml-1.5 break-all opacity-90" title={detail}>
            {detail}
          </span>
        )}
        <p className="mt-0.5 opacity-80">{t("storage.hint")}</p>
      </div>
      {dataDir && (
        <button
          type="button"
          onClick={() => void revealInExplorer(dataDir).catch(() => undefined)}
          className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 hover:underline"
        >
          {t("storage.openDir")}
        </button>
      )}
      <button
        type="button"
        aria-label={t("storage.dismiss")}
        onClick={dismiss}
        className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-destructive/20"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
