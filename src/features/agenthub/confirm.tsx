import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/motion/button/base";

/**
 * 全应用统一的确认弹窗（工具箱内复用）。
 *
 * 不用 `window.confirm`：它是浏览器原生框，与玻璃材质完全割裂，也会被
 * WebView 的"是否阻止此页面创建更多对话框"拦掉。破坏性动作（删除技能、
 * 丢弃未保存的编辑）走这里。
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t("toolbox.cancel")}
          </Button>
          <Button
            size="sm"
            className={danger ? "bg-destructive text-destructive-foreground" : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
