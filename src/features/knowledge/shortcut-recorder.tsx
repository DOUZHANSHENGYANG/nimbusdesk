import { useEffect, useId, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { recordShortcut } from "./shortcut-keys";

export function ShortcutRecorder({ value, onChange, en, disabled, onRecordingChange, placeholder = "Ctrl+Alt+Space" }: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  en: boolean;
  disabled: boolean;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  function finish() {
    setRecording(false);
    onRecordingChange(false);
  }

  useEffect(() => {
    if (!recording) return;
    function cancel() {
      setHint(en ? "Recording cancelled. Your previous draft is unchanged." : "已取消录制，保留原来的快捷键草稿。");
      finish();
    }
    function keydown(event: KeyboardEvent) {
      // Own keyboard input only during explicit recording, including browser commands.
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = recordShortcut(event);
      if (result.type === "cancel") {
        cancel();
        recordButton.current?.focus();
      } else if (result.type === "recorded") {
        onChange(result.shortcut);
        setHint(en ? "Recorded. Save to activate this shortcut." : "录制完成，点击保存后生效。");
        finish();
      } else if (result.reason === "typing" || result.reason === "unsupported" || result.reason === "composition") {
        setHint(en ? "Use Ctrl, Alt or the system key with a supported key." : "请使用 Ctrl、Alt 或系统键加一个常用按键。");
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
  }, [recording, en, onChange, onRecordingChange]);

  return <div ref={group} className="space-y-2.5">
    <label htmlFor={id} className="block text-[13px] font-medium">{en ? "Global shortcut" : "全局快捷键"}</label>
    <div className="flex flex-wrap items-center gap-2">
      <Input ref={input} id={id} value={recording ? "" : value} disabled={disabled} readOnly={recording}
        aria-describedby={`${id}-hint`} className={`min-w-48 flex-1 font-medium ${recording ? "border-primary bg-primary/5 ring-2 ring-primary/20" : ""}`}
        placeholder={recording ? (en ? "Press a key combination…" : "请按下快捷键组合…") : placeholder}
        onChange={(event) => { onChange(event.target.value); setHint(""); }} spellCheck={false} autoComplete="off" />
      <Button ref={recordButton} type="button" variant={recording ? "outline" : "secondary"} size="sm" disabled={disabled}
        aria-pressed={recording} onClick={() => {
          if (recording) { finish(); setHint(en ? "Recording cancelled. Your previous draft is unchanged." : "已取消录制，保留原来的快捷键草稿。"); }
          else { setHint(""); setRecording(true); onRecordingChange(true); input.current?.focus(); }
        }}>
        {recording ? <X className="size-3.5" /> : <Keyboard className="size-3.5" />}
        {recording ? (en ? "Cancel recording" : "取消录制") : (en ? "Record shortcut" : "录制快捷键")}
      </Button>
    </div>
    <p id={`${id}-hint`} role="status" className="min-h-5 text-xs leading-5 text-muted-foreground">
      {hint || (recording ? (en ? "Listening… Esc or Tab cancels. Click outside to stop." : "正在录制… 按 Esc / Tab 或点击其他位置取消。")
        : (en ? "Record a combination or type it manually. Save to activate." : "支持按键录制，也可手动输入；保存后生效。"))}
    </p>
  </div>;
}
