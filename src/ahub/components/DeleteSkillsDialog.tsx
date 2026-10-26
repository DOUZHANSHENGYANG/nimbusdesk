import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";

export interface DeleteSkillTarget {
  dirName: string;
  name: string;
  /** 这份技能当前接入的工具（空 = 只在中枢里） */
  harnesses: { id: string; name: string }[];
}

/**
 * 删除技能（单个或批量）的统一确认框。
 *
 * 只删中枢会让 Claude Code / Codex 目录里的副本留下来，下次扫描又被当成
 * 「本机已有」出现在收集面板 —— 所以有副本时默认勾选「同时移出」，
 * 并把要动的工具名列清楚；用户不想动工具目录时可以取消。
 */
export function DeleteSkillsDialog({
  open,
  onOpenChange,
  title,
  message,
  targets,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  targets: DeleteSkillTarget[];
  /** removeHarnessCopies = 是否同时移出工具目录里的副本 */
  onConfirm: (removeHarnessCopies: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [remove, setRemove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tools = Array.from(
    new Map(
      targets.flatMap((target) =>
        target.harnesses.map((harness) => [harness.id, harness.name] as const),
      ),
    ).entries(),
  );
  const counts = new Map<string, number>();
  for (const target of targets) {
    for (const harness of target.harnesses) counts.set(harness.id, (counts.get(harness.id) ?? 0) + 1);
  }

  useEffect(() => {
    if (open) {
      setRemove(tools.length > 0);
      setError(null);
    }
    // tools 由 targets 派生；只关心「打开时有没有副本」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tools.length]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(tools.length > 0 && remove);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-danger" />
            {title}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {tools.length > 0 ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-bg-subtle p-3">
              <Checkbox
                checked={remove}
                disabled={busy}
                onCheckedChange={(next) => setRemove(next === true)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-foreground">
                  {t("skills.deleteHarnessTitle")}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-ink-3">
                  {t("skills.deleteHarnessHint")}
                </span>
                <span className="mt-1 block text-[11px] text-ink-3">
                  {tools
                    .map(([id, name]) => {
                      const n = counts.get(id) ?? 0;
                      return n > 1 ? `${name} ×${n}` : name;
                    })
                    .join("、")}
                </span>
              </span>
            </label>
          ) : (
            <p className="text-[11px] text-ink-3">{t("skills.deleteNoHarness")}</p>
          )}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
