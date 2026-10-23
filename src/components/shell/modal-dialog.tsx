import type { ReactNode, RefObject } from "react";
import { CenterMorphModal, CenterMorphModalContent } from "@/components/motion/center-morph-modal";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 确认/提示/输入对话框的**界面**部分。
 *
 * 单独成文件的唯一理由是分包：`center-morph-modal` 是 motion 驱动的（`motion-dom` +
 * `framer-motion` 上百 KB），而 `ModalProvider` 挂在每个窗口的最外层 —— 以前对话框即使
 * 关着也一直挂在树上，于是「只显示一张便签」的窗口也要为它解析整套动画运行时。
 * 现在由 `modal-host` 在**真的要弹**的时候才 `lazy` 拉这块（见那边的说明）。
 *
 * 入场动画不受影响：`CenterMorphModalContent` 是「挂载后 mounted=true」再播
 * `initial → animate`（未展开 → 全展开），所以延迟挂载只是把这段动画挪到打开那一刻。
 * 退场动画靠 `AnimatePresence` + `open=false`，而 provider 会保留内容 500ms 再卸载，
 * 正好覆盖这段时长。
 */
export interface ModalDialogRequest {
  kind: "confirm" | "alert" | "prompt";
  title: string;
  description?: ReactNode;
  confirmText: string;
  cancelText?: string;
  danger?: boolean;
  showInput?: boolean;
  inputPlaceholder?: string;
}

export interface ModalDialogProps {
  request: ModalDialogRequest;
  open: boolean;
  input: string;
  onInputChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** 用户确认（带输入值时用于 prompt） */
  onConfirm: (value: string | boolean) => void;
  /** 用户取消 / 点击遮罩 / 按 Esc */
  onCancel: () => void;
}

export default function ModalDialog({
  request,
  open,
  input,
  onInputChange,
  inputRef,
  onConfirm,
  onCancel,
}: ModalDialogProps) {
  const isPrompt = request.kind === "prompt";

  return (
    <CenterMorphModal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <CenterMorphModalContent
        ariaLabel={request.title}
        initialFocusRef={isPrompt ? inputRef : undefined}
        className="max-w-[24rem] bg-popover text-popover-foreground"
      >
        <div className="flex flex-col gap-4 px-6 pt-6 pb-5">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-[15px] font-semibold leading-tight">{request.title}</h2>
            {request.description != null && (
              <div className="text-muted-foreground text-[13px] leading-relaxed">
                {request.description}
              </div>
            )}
          </div>

          {request.showInput && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="modal-input" className="sr-only">
                {request.title}
              </Label>
              <Input
                id="modal-input"
                ref={inputRef}
                value={input}
                placeholder={request.inputPlaceholder}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat) {
                    e.preventDefault();
                    return;
                  }
                  e.preventDefault();
                  onConfirm(input);
                }}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {request.kind !== "alert" && (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {request.cancelText}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              className={request.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              onClick={() => onConfirm(isPrompt ? input : true)}
            >
              {request.confirmText}
            </Button>
          </div>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  );
}
