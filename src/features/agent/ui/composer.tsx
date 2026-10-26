import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Maximize2, Mic, Plus, SendHorizontal, Square, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openExternal } from "@/lib/open";
import { MAX_ATTACHMENTS, readAttachment, type Pending } from "../attachments";
import { COMPOSER_MAX_HEIGHT, draftAfterExpand, draftForExpand } from "../composer-core";
import { useAgent } from "../store";
import { ExpandDialog } from "./expand-dialog";
import { GoalPopover } from "./goal-popover";
import { ModelPicker } from "./model-picker";
import { PermissionPicker } from "./permission-picker";
import { PresetPicker } from "./preset-picker";
import { ThinkingPicker } from "./thinking-picker";
import { ToolButton } from "./tool-button";

/** 快捷键：新会话。Ctrl/⌘+Shift+O（O 是我们这边「打开新的」的约定）。 */
const NEW_SESSION_KEY = "o";

const describeAttachment = (error: unknown) => {
  const code = error instanceof Error ? error.message : "";
  return ["AI_ATTACH_TOO_LARGE", "AI_ATTACH_NO_VISION", "AI_ATTACH_UNSUPPORTED", "AI_ATTACH_UNREADABLE"].includes(code)
    ? code
    : "AI_ATTACH_UNREADABLE";
};

/**
 * 输入区：**两行** —— 上面是 textarea（自适应，最多 8 行后框内滚动），下面是工具行。
 *
 * 工具行左侧是「往里加东西」的（＋ 附件、⤢ 放大、盾 权限、◎ 目标），右侧是
 * 「这一轮怎么跑」的状态型控件（思考等级、模型、智能体、语音、发送）：
 * 右边三个都显示当前值的短名，点一下就是选择器 —— 用户不用进设置页就能确认
 * 「现在到底用什么在跑」。
 *
 * 窄宽度（<520px，见 agent.css 的容器查询）只留图标：这一行有 9 个控件，
 * 挤到手机宽度时文字先让位。
 *
 * 快捷键：回车发送、Shift+回车换行、Esc 停止；生成中同一个位置变成「停止」。
 * 附件：图片走服务商 vision（当前模型不支持就在加进来的时候挡掉），文本文件
 * 作为上下文内联进这一轮的消息文本。
 */
export function Composer() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedText, setExpandedText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const send = useAgent((state) => state.send);
  const stop = useAgent((state) => state.stop);
  const text = useAgent((state) => state.draft);
  const setText = useAgent((state) => state.setDraft);
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

  // 内容变了就把框长到内容高度（上限 8 行，再多就在框内滚动）。只在文字变化时跑，
  // 按键时不必自己算一次 —— 两处算必然有一处先漂。
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text]);

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

  /** `value` 是给放大面板用的：那条路径上 state 还没落地，不能读 `text`。 */
  const submit = (value: string = text) => {
    const trimmed = value.trim();
    if ((!trimmed && pending.length === 0) || busy || guide) return false;
    setText("");
    setPending([]);
    setNotice(null);
    void send(trimmed, pending);
    return true;
  };

  /** 放大面板关闭：内容写回输入框（Esc 关掉不丢字，只裁掉结尾空行）。 */
  const closeExpanded = () => {
    setText(draftAfterExpand(expandedText));
    setExpanded(false);
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
      {/* 输入框上方的小动作条：这里放「跳出去看」这类不属于本轮对话的动作，
          有图标也有文字，不跟下面那排对话控件混在一起 */}
      <div className="agent-composer-bar">
        <ToolButton
          icon={<ExternalLink />}
          label={t("agent.leaderboard")}
          title={t("agent.leaderboard")}
          aria-label={t("agent.leaderboard")}
          onClick={() => void openExternal("https://modelsage.cn/leaderboards").catch(() => undefined)}
        />
      </div>
      <div className="agent-composer-box" data-disabled={guide || undefined} title={t("agent.hint")}>
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={guide}
          placeholder={guide ? t("agent.guide.placeholder") : t("agent.placeholder")}
          onChange={(event) => setText(event.target.value)}
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
        <div className="agent-composer-tools">
          <div className="agent-tools-group">
            <ToolButton
              icon={<Plus />}
              title={t("agent.attach.action")}
              aria-label={t("agent.attach.action")}
              disabled={guide}
              onClick={() => filePicker.current?.click()}
            />
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              accept="image/*,text/*,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.log,.ts,.tsx,.js,.jsx,.css,.html,.xml,.rs,.py,.go,.java,.sql,.sh"
              onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }}
            />
            <ToolButton
              icon={<Maximize2 />}
              title={t("agent.expand.action")}
              aria-label={t("agent.expand.action")}
              disabled={guide}
              onClick={() => {
                setExpandedText(draftForExpand(text).value);
                setExpanded(true);
              }}
            />
            <PermissionPicker />
            <GoalPopover />
          </div>
          <div className="agent-tools-group agent-tools-end">
            <ThinkingPicker />
            <ModelPicker variant="composer" />
            <PresetPicker />
            {/* 语音：按钮先在这里，但**没有接任何东西** —— 见 tooltip 与交付说明。
                刻意不接 Web Speech API：WebView2 里它依赖外部服务，本机网络下不可用。 */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="agent-tool-wrap">
                  <ToolButton
                    icon={<Mic />}
                    disabled
                    aria-disabled="true"
                    aria-label={t("agent.voice.pending")}
                    title={t("agent.voice.pending")}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{t("agent.voice.pending")}</TooltipContent>
            </Tooltip>
            {busy ? (
              <ToolButton
                className="agent-send"
                data-busy="true"
                icon={<Square />}
                title={t("agent.stopHint")}
                aria-label={t("agent.stop")}
                onClick={() => void stop()}
              />
            ) : (
              <ToolButton
                className="agent-send"
                icon={<SendHorizontal />}
                title={`${t("agent.send")}\n${t("agent.hint")}`}
                aria-label={t("agent.send")}
                disabled={guide || starting || (!text.trim() && pending.length === 0)}
                onClick={() => submit()}
              />
            )}
          </div>
        </div>
      </div>
      <ExpandDialog
        open={expanded}
        value={expandedText}
        busy={busy}
        disabled={guide}
        onChange={setExpandedText}
        onClose={closeExpanded}
        onSend={() => {
          if (submit(draftAfterExpand(expandedText))) setExpanded(false);
        }}
      />
    </div>
  );
}
