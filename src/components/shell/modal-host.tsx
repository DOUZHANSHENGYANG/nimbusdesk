import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CenterMorphModal, CenterMorphModalContent } from "@/components/motion/center-morph-modal";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

/* ── 类型 ─────────────────────────────────────────────── */

export interface ConfirmOptions {
  title?: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface AlertOptions {
  title?: string;
  description?: ReactNode;
  okText?: string;
}

export interface PromptOptions {
  title?: string;
  description?: ReactNode;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  cancelText?: string;
}

interface ModalRequest {
  title: string;
  description?: ReactNode;
  confirmText: string;
  cancelText?: string;
  danger?: boolean;
  showInput?: boolean;
  inputPlaceholder?: string;
  inputInitial?: string;
  resolve: (value: unknown) => void;
  kind: "confirm" | "alert" | "prompt";
}

interface ModalContextValue {
  confirm: (options?: ConfirmOptions) => Promise<boolean>;
  alert: (options?: AlertOptions) => Promise<void>;
  prompt: (options?: PromptOptions) => Promise<string | null>;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useModal must be used within <ModalProvider>");
  return ctx;
}

/* ── Provider ─────────────────────────────────────────── */

export function ModalProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModalRequest | null>(null);
  const dataRef = useRef<ModalRequest | null>(null);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => {
        show({
          kind: "confirm",
          title: options.title ?? t("modal.confirmTitle"),
          description: options.description,
          confirmText: options.confirmText ?? t("common.confirm"),
          cancelText: options.cancelText ?? t("common.cancel"),
          danger: options.danger,
          resolve: resolve as (v: unknown) => void,
        });
      }),
    [t],
  );

  const alert = useCallback(
    (options: AlertOptions = {}) =>
      new Promise<void>((resolve) => {
        show({
          kind: "alert",
          title: options.title ?? t("modal.alertTitle"),
          description: options.description,
          confirmText: options.okText ?? t("common.ok"),
          resolve: resolve as (v: unknown) => void,
        });
      }),
    [t],
  );

  const prompt = useCallback(
    (options: PromptOptions = {}) =>
      new Promise<string | null>((resolve) => {
        show({
          kind: "prompt",
          title: options.title ?? t("modal.inputTitle"),
          description: options.description,
          confirmText: options.confirmText ?? t("common.confirm"),
          cancelText: options.cancelText ?? t("common.cancel"),
          showInput: true,
          inputPlaceholder: options.placeholder,
          inputInitial: options.initial ?? "",
          resolve: resolve as (v: unknown) => void,
        });
      }),
    [t],
  );

  function show(r: ModalRequest) {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    // A replacement resolves the old request rather than leaving its caller waiting.
    dataRef.current?.resolve(dataRef.current.kind === "prompt" ? null : false);
    setInput(r.inputInitial ?? "");
    dataRef.current = r;
    setData(r);
    setOpen(true);
  }

  function close(value: unknown) {
    const request = dataRef.current;
    if (!request) return;
    dataRef.current = null;
    setOpen(false);
    // 等退场动画结束后再清内容，避免内容瞬间消失
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setData(current => current === request ? null : current);
    }, 500);
    request.resolve(value);
  }

  // 输入初值在 show 中一次设置；打开时只选择文本，避免迟到的 effect 覆盖输入。
  useEffect(() => {
    if (open && data?.showInput) {
      const frame = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(frame);
    }
  }, [open, data]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    dataRef.current?.resolve(dataRef.current.kind === "prompt" ? null : false);
    dataRef.current = null;
  }, []);

  // 全局禁用原生弹框：统一走自建 Modal
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.confirm = (msg?: unknown) => {
      console.warn("[modal] window.confirm blocked:", msg);
      return false;
    };
    w.alert = (msg?: unknown) => {
      console.warn("[modal] window.alert blocked:", msg);
    };
    w.prompt = (msg?: unknown) => {
      console.warn("[modal] window.prompt blocked:", msg);
      return null;
    };
  }, []);

  const isPrompt = data?.kind === "prompt";

  return (
    <ModalContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      <CenterMorphModal
        open={open}
        onOpenChange={(o) => {
          if (!o) close(isPrompt ? null : false);
        }}
      >
        <CenterMorphModalContent
          ariaLabel={data?.title ?? "Dialog"}
          initialFocusRef={isPrompt ? inputRef : undefined}
          className="max-w-[24rem] bg-popover text-popover-foreground"
        >
          {data && (
            <div className="flex flex-col gap-4 px-6 pt-6 pb-5">
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[15px] font-semibold leading-tight">{data.title}</h2>
                {data.description != null && (
                  <div className="text-muted-foreground text-[13px] leading-relaxed">
                    {data.description}
                  </div>
                )}
              </div>

              {data.showInput && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="modal-input" className="sr-only">
                    {data.title}
                  </Label>
                  <Input
                    id="modal-input"
                    ref={inputRef}
                    value={input}
                    placeholder={data.inputPlaceholder}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat) {
                        e.preventDefault();
                        return;
                      }
                      e.preventDefault();
                      close(input);
                    }}
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                {data.kind !== "alert" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => close(isPrompt ? null : false)}
                  >
                    {data.cancelText}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  className={
                    data.danger
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : ""
                  }
                  onClick={() => close(isPrompt ? input : true)}
                >
                  {data.confirmText}
                </Button>
              </div>
            </div>
          )}
        </CenterMorphModalContent>
      </CenterMorphModal>
    </ModalContext.Provider>
  );
}
