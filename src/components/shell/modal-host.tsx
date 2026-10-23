import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { ModalDialogRequest } from "./modal-dialog";

/**
 * 确认/提示/输入对话框，走自建 Modal（禁用原生 confirm/alert/prompt）。
 *
 * 对话框的**界面**拆到 `./modal-dialog` 并在这里 `lazy` 拉取：那块是 motion 驱动的
 * （`motion-dom` + `framer-motion` 上百 KB），而 `ModalProvider` 挂在**每个窗口**最外层 ——
 * 以前它关着也一直挂在树上，于是「只显示一张便签」的小窗口也要解析整套动画运行时。
 * 现在只有真的要弹时才加载；provider 自身只留状态与 Promise 结算。
 *
 * 时序上仍然是对的：打开时挂载（入场动画从 `initial` 播起），关闭后内容保留 500ms 再卸载
 * （覆盖 `AnimatePresence` 的退场动画）。
 */

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

interface ModalRequest extends ModalDialogRequest {
  inputInitial?: string;
  resolve: (value: unknown) => void;
}

interface ModalContextValue {
  confirm: (options?: ConfirmOptions) => Promise<boolean>;
  alert: (options?: AlertOptions) => Promise<void>;
  prompt: (options?: PromptOptions) => Promise<string | null>;
}

const ModalDialog = lazy(() => import("./modal-dialog"));

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useModal must be used within <ModalProvider>");
  return ctx;
}

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
    // 等退场动画结束后再清内容（也从这里卸载对话框分片），避免内容瞬间消失
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
      {data && (
        <Suspense fallback={null}>
          <ModalDialog
            request={data}
            open={open}
            input={input}
            onInputChange={setInput}
            inputRef={inputRef}
            onConfirm={(value) => close(value)}
            onCancel={() => close(isPrompt ? null : false)}
          />
        </Suspense>
      )}
    </ModalContext.Provider>
  );
}
