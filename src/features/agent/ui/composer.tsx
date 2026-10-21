import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent } from "../store";

/** 输入区：回车发送、Shift+回车换行；生成中同一个位置变成「停止」。 */
export function Composer() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const send = useAgent((state) => state.send);
  const stop = useAgent((state) => state.stop);
  const starting = useAgent((state) => state.starting);
  const guide = useAgent((state) => state.guide);
  const status = useAgent((state) => state.status);
  const busy = status === "submitted" || status === "streaming";

  const submit = () => {
    const value = text.trim();
    if (!value || busy || guide) return;
    setText("");
    void send(value);
  };

  return (
    <div className="agent-composer">
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
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <Button size="icon" variant="outline" aria-label={t("agent.stop")} onClick={() => void stop()}>
            <Square />
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label={t("agent.send")}
            disabled={guide || starting || !text.trim()}
            onClick={submit}
          >
            <SendHorizontal />
          </Button>
        )}
      </div>
      <div className="agent-composer-hint">
        <span>{t("agent.hint")}</span>
      </div>
    </div>
  );
}
