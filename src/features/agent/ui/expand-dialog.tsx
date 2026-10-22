import { useTranslation } from "react-i18next";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ExpandDialogProps {
  open: boolean;
  value: string;
  busy: boolean;
  /** 被禁用（没有可用服务商）时只读。 */
  disabled: boolean;
  onChange: (value: string) => void;
  /** Esc / 关闭按钮 / 点遮罩：内容带回输入框。 */
  onClose: () => void;
  /** 回车或「发送」：带回输入框并立刻发送。 */
  onSend: () => void;
}

/**
 * 放大输入框：一个居中的大编辑面板，专门给「要写很长的一段」用。
 *
 * 它**不是**第二个输入框：草稿始终只有一份 —— 打开时从输入框取，关闭时写回
 * 输入框（`draftForExpand` / `draftAfterExpand`），中间不落任何别的状态。
 * 所以 Esc 关掉不会丢字，面板开着的时候按回车和在外面按回车是同一个动作。
 */
export function ExpandDialog({ open, value, busy, disabled, onChange, onClose, onSend }: ExpandDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-[min(920px,92vw)] gap-3 sm:max-w-[min(920px,92vw)]">
        <DialogHeader>
          <DialogTitle className="agent-expand-title">
            <Maximize2 />
            {t("agent.expand.title")}
          </DialogTitle>
          <DialogDescription>{t("agent.expand.hint")}</DialogDescription>
        </DialogHeader>
        <textarea
          className="min-h-[52vh] w-full resize-none rounded-lg border border-border bg-background p-3 text-sm leading-relaxed text-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/30"
          value={value}
          disabled={disabled}
          placeholder={t("agent.placeholder")}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <DialogFooter className="agent-expand-foot">
          <Button variant="outline" size="sm" onClick={onClose}>{t("agent.expand.close")}</Button>
          <Button size="sm" disabled={disabled || busy} onClick={onSend}>{t("agent.expand.send")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
