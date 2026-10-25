import { AlertTriangle, CheckCircle2, CloudDownload, HelpCircle, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";

export type UpstreamStatus = "changed" | "current" | "untracked" | "error";

export interface UpstreamRow {
  dirName: string;
  name: string;
  status: UpstreamStatus;
  /** 远端地址；未开启跟踪时为空 */
  remote: string;
  /** 跟踪模式（git-scan / manual），更新后写回 */
  mode: string;
  /** 后端给的说明（git 不可用 / 未开 watch / ls-remote 失败原因） */
  note: string;
}

const ORDER: Record<UpstreamStatus, number> = { changed: 0, error: 1, untracked: 2, current: 3 };

/**
 * 批量「检查更新」结果。
 *
 * 单个技能的检查原本埋在详情页的「来源与更新」里，要逐个点开才知道有没有新版本；
 * 这里一次跑完，按「有新版本 → 出错 → 未跟踪 → 已最新」排序，点一行直接跳到那个技能。
 */
export function UpstreamCheckDialog({
  open,
  onOpenChange,
  rows,
  onOpenSkill,
  onUpdate,
  updating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: UpstreamRow[];
  onOpenSkill: (dirName: string) => void;
  /** 拉取上游并覆盖同名技能；一次可以传多行 */
  onUpdate?: (rows: UpstreamRow[]) => void | Promise<void>;
  updating?: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const sorted = [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
  const changed = rows.filter((row) => row.status === "changed").length;
  const icon = (status: UpstreamStatus) =>
    status === "changed" ? (
      <CloudDownload className="size-3.5 text-warning" />
    ) : status === "current" ? (
      <CheckCircle2 className="size-3.5 text-success" />
    ) : status === "error" ? (
      <AlertTriangle className="size-3.5 text-danger" />
    ) : (
      <HelpCircle className="size-3.5 text-ink-3" />
    );
  const tone = (status: UpstreamStatus) =>
    status === "changed" ? "warning" : status === "current" ? "success" : status === "error" ? "danger" : "muted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("skills.upBatchTitle")}</DialogTitle>
          <DialogDescription>
            {changed > 0 ? t("skills.upBatchFound", { n: changed }) : t("skills.upBatchNone")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-3">{t("skills.upBatchEmpty")}</p>
          ) : (
            <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-border">
              {sorted.map((row) => (
                <div
                  key={row.dirName}
                  className="flex items-center gap-2 border-b border-border/60 last:border-0"
                >
                  <button
                    type="button"
                    onClick={() => onOpenSkill(row.dirName)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  >
                    {icon(row.status)}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-foreground">{row.name}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-3">
                        {row.remote || row.note || t("skills.upNoRemote")}
                      </span>
                    </span>
                    <Badge variant={tone(row.status)}>
                      {t(
                        row.status === "changed"
                          ? "skills.upStateChanged"
                          : row.status === "current"
                            ? "skills.upStateCurrent"
                            : row.status === "error"
                              ? "skills.upStateError"
                              : "skills.upStateUntracked",
                      )}
                    </Badge>
                  </button>
                  {row.status === "changed" && onUpdate ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mr-2 h-7 shrink-0 text-[11px]"
                      disabled={updating?.has(row.dirName)}
                      onClick={() => void onUpdate([row])}
                    >
                      {updating?.has(row.dirName) ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <CloudDownload className="size-3.5" />
                      )}
                      {t(updating?.has(row.dirName) ? "skills.upUpdating" : "skills.upUpdate")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          {changed > 0 && onUpdate ? (
            <Button
              disabled={Boolean(updating?.size)}
              onClick={() => void onUpdate(sorted.filter((row) => row.status === "changed"))}
            >
              <CloudDownload className="size-3.5" />
              {t("skills.upUpdateAll", { n: changed })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 工具条按钮的忙碌态图标（检查可能要跑很多次 git ls-remote） */
export function UpstreamCheckIcon({ busy }: { busy: boolean }) {
  return <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />;
}
