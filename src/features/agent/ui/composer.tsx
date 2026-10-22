import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, SendHorizontal, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_ATTACHMENTS, readAttachment, type Pending } from "../attachments";
import { useAgent } from "../store";
import { ModelPicker } from "./model-picker";

/** 快捷键：新会话。Ctrl/⌘+Shift+O（O 是我们这边「打开新的」的约定）。 */
const NEW_SESSION_KEY = "o";

const describeAttachment = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return ["AI_ATTACH_TOO_LARGE", "AI_ATTACH_NO_VISION", "AI_ATTACH_UNSUPPORTED", "AI_ATTACH_UNREADABLE"].includes(code)
    ? code
    : "AI_ATTACH_UNREADABLE";
};

/**
 * 输入区：回车发送、Shift+回车换行、Esc 停止；生成中同一个位置变成「停止」。
 *
 * 附件：图片走服务商 vision（当前模型不支持就在加进来的时候挡掉），文本文件
 * 作为上下文内联进这一轮的消息文本。
 */
export function Composer() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const send = useAgent((state) => state.send);
  const stop = useAgent((state) => state.stop);
  const newSession = useAgent((state) => state.newSession);
  const starting = useAgent((state) => state.starting);
  const guide = useAgent((state) => state.guide);
  const status = useAgent((state) => state.status);
  const vision = useAgent((state) => state.vision);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === NEW_SESSION_KEY) {
        event.preventDefault();
        void newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession]);

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = MAX_ATTACHMENTS - pending.length;
    const next: Pending[] = [];
    let problem: string | null = null;
    for (const file of [...files].slice(0, Math.max(0, room))) {
      try {
        next.push(await readAttachment(file, vision));
      } catch (error) {
        problem = describeAttachment(error);
      }
    }
    if (files.length > room) problem = "AI_ATTACH_TOO_MANY";
    setNotice(problem);
    if (next.length) setPending((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
  };

  const submit = () => {
    const value = text.trim();
    if ((!value && pending.length === 0) || busy || guide) return;
    setText("");
    setPending([]);
    setNotice(null);
    const node = area.current;
    if (node) node.style.height = "auto";
    void send(value, pending);
  };

  return (
    <div
      className="agent-composer"
      data-dragging={dragging || undefined}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      {pending.length > 0 && (
        <div className="agent-attachments agent-attachments-input">
          {pending.map((item) => (
            <span key={item.id} className="agent-attachment" data-kind={item.kind}>
              {item.kind === "image" && <img src={item.body} alt="" />}
              {item.name}
              <button
                type="button"
                aria-label={t("agent.attach.remove")}
                onClick={() => setPending((current) => current.filter((entry) => entry.id !== item.id))}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      {notice && (
        <p className="agent-composer-notice" role="alert">
          {t(`agent.attach.error.${notice}`, { count: MAX_ATTACHMENTS })}
          <button type="button" onClick={() => setNotice(null)}>{t("agent.cancel")}</button>
        </p>
      )}
      <div className="agent-composer-box" data-disabled={guide || undefined}>
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={guide}
          placeholder={guide ? t("agent.guide.placeholder") : t("agent.placeholder")}
          onChange={(event) => {
            setText(event.target.value);
            const node = area.current;
            if (node) {
              node.style.height = "auto";
              node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (busy) void stop();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <Button size="icon" variant="outline" aria-label={t("agent.stop")} title={t("agent.stopHint")} onClick={() => void stop()}>
            <Square />
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label={t("agent.send")}
            disabled={guide || starting || (!text.trim() && pending.length === 0)}
            onClick={submit}
          >
            <SendHorizontal />
          </Button>
        )}
      </div>
      <div className="agent-composer-hint">
        <span className="agent-composer-left">
          {/* 当前模型就在输入框左下角，点一下就是换模型（和顶栏同一个选择器） */}
          <ModelPicker variant="composer" />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("agent.attach.action")}
            title={t("agent.attach.action")}
            disabled={guide}
            onClick={() => filePicker.current?.click()}
          >
            <Paperclip />
          </Button>
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            accept="image/*,text/*,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.log,.ts,.tsx,.js,.jsx,.css,.html,.xml,.rs,.py,.go,.java,.sql,.sh"
            onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }}
          />
        </span>
        <span>{t("agent.hint")}</span>
      </div>
    </div>
  );
}
