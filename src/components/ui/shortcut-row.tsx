import { useEffect, useId, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { recordShortcut } from "@/features/knowledge/shortcut-keys";

/**
 * 一行一条全局快捷键：`[名称] [输入框] [录制] [清除] [保存]`，一行放下。
 *
 * 录制逻辑本来在 `shortcut-recorder.tsx` 里；它的调用方现在只剩这一处，
 * 而「一行显示」要求输入框与录制按钮是同一行里的并列格子，所以并回来了 ——
 * 少一层 prop 转手，也少一个文件。
 *
 * 说明文字不常驻（一行放不下，而且读的人只想知道在哪按）：名称上的 `title`
 * 给鼠标，录制中 / 出错这类**当下要紧的**信息才占第二行。
 */
export interface ShortcutRowProps {
  label: string;
  /** 这条快捷键在哪生效；只在 title 里出现 */
  hint?: string;
  /** 当前已保存的值 */
  value: string;
  placeholder?: string;
  /** 注册 + 落盘。存到哪由调用方决定（热键注册、JSON 落盘、失败回滚都留在各自功能里） */
  save: (value: string) => void | Promise<void>;
  /** 允许留空停用（大多数全局快捷键都允许） */
  clearable?: boolean;
  en: boolean;
}

export function ShortcutRow({ label, hint, value, placeholder, save, clearable = true, en }: ShortcutRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState("");
  const group = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const current = draft ?? value;
  const dirty = current !== value;

  function finish() {
    setRecording(false);
  }

  useEffect(() => {
    if (!recording) return;
    function cancel() {
      setStatus(en ? "Recording cancelled. Your previous draft is unchanged." : "已取消录制，保留原来的草稿。");
      finish();
    }
    function keydown(event: KeyboardEvent) {
      // 只有明确进入录制时才抢键盘，包括浏览器自己的组合键
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = recordShortcut(event);
      if (result.type === "cancel") {
        cancel();
      } else if (result.type === "recorded") {
        setDraft(result.shortcut);
        setError("");
        setStatus(en ? "Recorded. Save to activate." : "录制完成，点保存后生效。");
        finish();
      } else if (result.reason === "typing" || result.reason === "unsupported" || result.reason === "composition") {
        setStatus(en ? "Use Ctrl, Alt or the system key with a supported key." : "请用 Ctrl、Alt 或系统键加一个常用按键。");
      }
    }
    function pointerdown(event: PointerEvent) {
      if (!group.current?.contains(event.target as Node)) cancel();
    }
    function focusout(event: FocusEvent) {
      if (!group.current?.contains(event.relatedTarget as Node | null)) cancel();
    }
    const element = group.current;
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("pointerdown", pointerdown, true);
    element?.addEventListener("focusout", focusout);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("pointerdown", pointerdown, true);
      element?.removeEventListener("focusout", focusout);
    };
  }, [recording, en]);

  const commit = async (next: string) => {
    setBusy(true);
    setError("");
    try {
      await save(next);
      setDraft(null);
      setStatus("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    /*
     * 固定列宽（每行各自是一个 grid，用 auto 列宽会因为各行按钮多少不同而错位）：
     * 名称 | 输入框 | 录制 | 清除 | 保存 —— 六行的保存按钮落在同一条竖线上。
     */
    <div ref={group} className="grid grid-cols-[6.5rem_minmax(0,1fr)_5.5rem_4rem_5rem] items-center gap-x-2 gap-y-1">
      <label htmlFor={inputId} title={hint} className="truncate text-[13px] font-medium text-foreground/90">{label}</label>
      <Input
        id={inputId}
        value={recording ? "" : current}
        disabled={busy}
        readOnly={recording}
        aria-describedby={statusId}
        className={`min-w-0 font-medium ${recording ? "border-primary bg-primary/5 ring-2 ring-primary/20" : ""}`}
        placeholder={recording ? (en ? "Press a key combination…" : "请按下快捷键组合…") : placeholder}
        onChange={(event) => { setDraft(event.target.value); setStatus(""); setError(""); }}
        spellCheck={false}
        autoComplete="off"
      />
      <Button
        type="button"
        variant={recording ? "outline" : "secondary"}
        size="sm"
        disabled={busy}
        aria-pressed={recording}
        aria-label={`${en ? "Record shortcut" : "录制快捷键"} · ${label}`}
        className="w-full"
        onClick={() => {
          if (recording) {
            finish();
            setStatus(en ? "Recording cancelled. Your previous draft is unchanged." : "已取消录制，保留原来的草稿。");
          } else {
            setStatus("");
            setRecording(true);
            document.getElementById(inputId)?.focus();
          }
        }}
      >
        {recording ? <X className="size-3.5" /> : <Keyboard className="size-3.5" />}
        {recording ? (en ? "Cancel" : "取消") : (en ? "Record" : "录制")}
      </Button>
      {/* 主操作靠右：清除是次要的，放在保存左边；没有值时占位留空，保证列不塌 */}
      {clearable && value ? (
        <Button size="sm" variant="ghost" disabled={busy || recording} className="w-full" onClick={() => void commit("")}>
          {en ? "Clear" : "清除"}
        </Button>
      ) : <span />}
      <Button size="sm" disabled={busy || recording || !dirty} className="w-full" onClick={() => void commit(current)}>
        {en ? "Save" : "保存"}
      </Button>
      {(error || recording || status) ? (
        <p id={statusId} role={error ? "alert" : "status"} className={`col-start-2 text-[11px] leading-4 ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error || (recording
            ? (en ? "Listening… Esc or Tab, or click outside, cancels." : "正在录制… 按 Esc / Tab 或点其他位置取消。")
            : status)}
        </p>
      ) : (
        <span id={statusId} className="sr-only" />
      )}
    </div>
  );
}
