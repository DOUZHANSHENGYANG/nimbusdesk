import { useState } from "react";
import { isToolUIPart } from "ai";
import { useTranslation } from "react-i18next";
import {
  Check,
  ArrowDown,
  CircleAlert,
  CircleCheck,
  Copy,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  StepForward,
  Undo2,
  X,
} from "lucide-react";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Markdown } from "@/ahub/components/Markdown";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { metaOf, messageText, type AgentAttachmentMeta } from "../sessions";
import { useAgent, type AgentError } from "../store";
import type { AgentMessage } from "../model";

/** 工具名的中文说法；未登记的（不该出现）退回工具名本身。 */
const TOOL_LABELS: Record<string, string> = {
  search_workspace: "agent.tool.names.search_workspace",
  list_skills: "agent.tool.names.list_skills",
  list_prompts: "agent.tool.names.list_prompts",
  save_skill: "agent.tool.names.save_skill",
};

const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

const Spinner = () => (
  <TraceIcon>
    <LoaderCircle className="animate-spin" />
  </TraceIcon>
);

type Part = AgentMessage["parts"][number];
type Extra = "copy" | "regenerate" | "continue" | "edit" | "revert";

/** `file` part 在联合类型里不带可选 url，这里统一收窄一次。 */
interface FileLike { type: "file"; mediaType: string; url?: string; filename?: string }
const filesOf = (parts: readonly Part[]) => parts.filter((part): part is Part & FileLike => part.type === "file");

/** 气泡下方的悬停操作条：复制 / 重新生成 / 继续 / 编辑。 */
function Actions({ message, items, onEdit }: { message: AgentMessage; items: Extra[]; onEdit?: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const regenerate = useAgent((state) => state.regenerate);
  const continueLast = useAgent((state) => state.continueLast);
  const revertTo = useAgent((state) => state.revertTo);
  // 复制的是用户自己写的那段（文本附件内联的包装不带给用户）
  const text = messageText(message);

  const icon: Record<Extra, typeof Copy> = {
    copy: Copy,
    regenerate: RefreshCw,
    continue: StepForward,
    edit: Pencil,
    revert: Undo2,
  };

  return (
    <div className="agent-actions">
      {items.map((item) => {
        const Icon = item === "copy" && copied ? Check : icon[item];
        const label =
          item === "copy" ? t("agent.action.copy")
            : item === "regenerate" ? t("agent.regenerate")
              : item === "continue" ? t("agent.action.continue")
                : item === "revert" ? t("agent.action.revert")
                  : t("agent.action.edit");
        return (
          <Button
            key={item}
            size="icon"
            variant="ghost"
            aria-label={label}
            title={label}
            onClick={() => {
              if (item === "copy") {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }, () => undefined);
                return;
              }
              if (item === "regenerate") void regenerate(message.id);
              if (item === "continue") void continueLast();
              if (item === "revert") void revertTo(message.id);
              if (item === "edit") onEdit?.();
            }}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}

/** 用户消息：附件缩略图 + 气泡 + 时间 + 悬停操作；编辑时就地换成输入框。 */
function UserMessage({ message }: { message: AgentMessage }) {
  const [editing, setEditing] = useState(false);
  const meta = metaOf(message);
  const time = meta.createdAt ? new Date(meta.createdAt).toLocaleTimeString() : null;
  const attachments = meta.attachments ?? [];
  const images = filesOf(message.parts).filter((part) => part.url);
  const text = messageText(message);

  if (editing) {
    return (
      <Message align="end">
        <MessageContent>
          <MessageEditor message={message} onDone={() => setEditing(false)} />
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message align="end">
      <MessageContent>
        {images.map((part, index) => (
          <img key={index} className="agent-image" src={part.url} alt={part.filename ?? ""} />
        ))}        <Bubble align="end">
          <BubbleContent>{text}</BubbleContent>
        </Bubble>
        {attachments.length > 0 && <Attachments items={attachments} />}
        <MessageFooter className="agent-meta">{time && <span>{time}</span>}</MessageFooter>
        <Actions message={message} items={["copy", "edit", "revert"]} onEdit={() => setEditing(true)} />
      </MessageContent>
    </Message>
  );
}

/** 编辑用户消息并重发：就地替换，后面那一段分支会被丢掉（AI SDK 的语义）。 */
function MessageEditor({ message, onDone }: { message: AgentMessage; onDone: () => void }) {
  const { t } = useTranslation();
  const editMessage = useAgent((state) => state.editMessage);
  const [text, setText] = useState(messageText(message));
  return (
    <div className="agent-edit">
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDone();
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void editMessage(message.id, text);
            onDone();
          }
        }}
      />
      <div className="agent-edit-actions">
        <Button size="sm" onClick={() => { void editMessage(message.id, text); onDone(); }}>
          {t("agent.action.resend")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{t("agent.cancel")}</Button>
      </div>
    </div>
  );
}

function Attachments({ items }: { items: AgentAttachmentMeta[] }) {
  const { t } = useTranslation();
  return (
    <div className="agent-attachments">
      {items.map((item) => (
        <span key={`${item.name}-${item.size}`} className="agent-attachment" data-kind={item.kind}>
          {item.name}
          {!item.kept && <em>{t("agent.attach.dropped")}</em>}
        </span>
      ))}
    </div>
  );
}

/** 一条工具调用：人是看的「动词 + 宾语」一行，参数与结果藏在展开层里。 */
function ToolCall({ part, message }: { part: Part; message: AgentMessage }) {
  const { t } = useTranslation();
  const approve = useAgent((state) => state.approve);
  const reapprove = useAgent((state) => state.reapprove);
  const regenerate = useAgent((state) => state.regenerate);
  const [open, setOpen] = useState(false);
  if (!isToolUIPart(part)) return null;
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
  const label = t(TOOL_LABELS[name] ?? name);

  if (part.state === "input-streaming") {
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status="running">
            <Spinner />
            <TraceTitle>{t("agent.tool.preparing", { name: label })}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {/* 参数还在逐字补齐：直接把半截 JSON 显示出来，别等它长完 */}
          <CodeBlock size="sm">
            <CodeBlockContent wrap>{asText(part.input)}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  // 需要审批：就地展开成确认卡，不弹全局弹窗。
  if (part.state === "approval-requested") {
    return (
      <div className="agent-approval">
        <TraceLine>
          <TraceIcon>
            <ShieldAlert />
          </TraceIcon>
          <TraceTitle>{t("agent.tool.approvalTitle", { name: label })}</TraceTitle>
        </TraceLine>
        <p className="agent-note">{t("agent.tool.approvalNote")}</p>
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{asText(part.input)}</CodeBlockContent>
        </CodeBlock>
        <div className="agent-approval-actions">
          <Button size="sm" onClick={() => void approve(part.approval.id, true)}>
            {t("agent.tool.approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void approve(part.approval.id, false)}>
            {t("agent.tool.reject")}
          </Button>
        </div>
      </div>
    );
  }

  if (part.state === "approval-responded") {
    return (
      <TraceLine status="pending">
        <Spinner />
        <TraceTitle>
          {part.approval.approved
            ? t("agent.tool.approved", { name: label })
            : t("agent.tool.deniedWaiting", { name: label })}
        </TraceTitle>
      </TraceLine>
    );
  }

  if (part.state === "output-denied") {
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status="pending">
            <TraceIcon>
              <ShieldAlert />
            </TraceIcon>
            <TraceTitle>{t("agent.tool.denied", { name: label })}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap>{asText(part.input)}</CodeBlockContent>
          </CodeBlock>
          <Button size="sm" variant="outline" onClick={() => void reapprove(part.approval.id)}>
            <ShieldCheck />
            {t("agent.tool.reapprove")}
          </Button>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="agent-tool-error">
        <TraceLine status="error">
          <TraceIcon>
            <CircleAlert />
          </TraceIcon>
          <TraceTitle>{t("agent.tool.failed", { name: label })}</TraceTitle>
          <TraceDescription className="agent-error-text">{part.errorText}</TraceDescription>
        </TraceLine>
        {/* 单个工具没法单独重跑，就地重跑一轮（模型会再决定调不调这个工具） */}
        <Button size="sm" variant="outline" onClick={() => void regenerate(message.id)}>
          <RefreshCw />
          {t("agent.retry")}
        </Button>
      </div>
    );
  }

  const running = part.state !== "output-available";
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            {running ? <LoaderCircle className="animate-spin" /> : <CircleCheck className="text-success" />}
          </TraceIcon>
          <TraceTitle>
            {running ? t("agent.tool.running", { name: label }) : t("agent.tool.done", { name: label })}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{asText(running ? part.input : part.output)}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function Reasoning({ text, streaming, seconds }: { text: string; streaming: boolean; seconds?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  // 流式时自动展开，结束后自动折叠；用户手动开过就听用户的。
  const expanded = open ?? streaming;
  return (
    <TraceCollapsible open={expanded} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={streaming ? "running" : undefined}>
          <TraceIcon>
            <Sparkles />
          </TraceIcon>
          <TraceTitle>
            {streaming ? t("agent.thinking") : seconds ? t("agent.meta.thought", { seconds }) : t("agent.thought")}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function AssistantParts({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  const meta = metaOf(message);
  const seconds = meta.elapsedMs === undefined ? undefined : (meta.elapsedMs / 1000).toFixed(1);
  return (
    <Trace>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? (
            <Markdown key={index} source={part.text} className="agent-text agent-markdown" />
          ) : null;
        }
        if (part.type === "reasoning") {
          return <Reasoning key={index} text={part.text} streaming={streaming && part.state === "streaming"} seconds={seconds} />;
        }
        if (part.type === "file") {
          const file = part as { mediaType: string; url?: string; filename?: string };
          return file.mediaType.startsWith("image/") && file.url
            ? <img key={index} className="agent-image" src={file.url} alt={file.filename ?? ""} />
            : null;
        }
        if (part.type === "dynamic-tool" || isToolUIPart(part)) {
          return <ToolCall key={index} part={part} message={message} />;
        }
        return null;
      })}
    </Trace>
  );
}

/** 出错就地一条，不去顶部报错；原始报文折在下面。 */
function ErrorBar({ error, onRetry }: { error: AgentError; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="agent-error" role="alert">
      <TraceLine status="error">
        <TraceIcon>
          <CircleAlert />
        </TraceIcon>
        <TraceTitle>{t(`agent.error.${error.kind}`)}</TraceTitle>
      </TraceLine>
      <div className="agent-error-actions">
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          {t("agent.retry")}
        </Button>
      </div>
      {error.detail && <code className="agent-error-detail">{error.detail}</code>}
    </div>
  );
}

/** 「已停止 / 上次未完成」之后的两个出口：接着写，或者重来。 */
function ResumeRow({ kind, messageId }: { kind: "stopped" | "incomplete"; messageId?: string }) {
  const { t } = useTranslation();
  const retry = useAgent((state) => state.retry);
  const regenerate = useAgent((state) => state.regenerate);
  const continueLast = useAgent((state) => state.continueLast);
  return (
    <MessageFooter className="agent-stopped">
      {kind === "stopped" ? t("agent.stopped") : t("agent.incomplete")}
      <Button size="sm" variant="ghost" onClick={() => void continueLast()}>
        <StepForward />
        {t("agent.action.continue")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => (messageId ? void regenerate(messageId) : void retry())}
      >
        <RefreshCw />
        {t("agent.regenerate")}
      </Button>
    </MessageFooter>
  );
}

/** 有没有可显示的内容：只有出错、没吐出任何东西的那一轮不该占一段空白。 */
function hasContent(message: AgentMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === "text") return Boolean(part.text.trim());
    if (part.type === "file") return true;
    if (part.type === "reasoning") return Boolean(part.text.trim());
    return part.type === "dynamic-tool" || isToolUIPart(part);
  });
}

export function Thread({ model }: { model: string }) {
  const { t } = useTranslation();
  const messages = useAgent((state) => state.messages);
  const status = useAgent((state) => state.status);
  const stopped = useAgent((state) => state.stopped);
  const incomplete = useAgent((state) => state.incomplete);
  const droppedContext = useAgent((state) => state.droppedContext);
  const error = useAgent((state) => state.error);
  const elapsedMs = useAgent((state) => state.elapsedMs);
  const usage = useAgent((state) => state.usage);
  const retry = useAgent((state) => state.retry);
  const newSession = useAgent((state) => state.newSession);
  const busy = status === "submitted" || status === "streaming";
  const last = messages[messages.length - 1];
  const partial = error !== null && last?.role === "assistant"
    && last.parts.some((part) => part.type === "text" && part.text);
  /** 每条助手消息都把「模型 · 耗时 · token」摆在下面；只有最后一条缺数据时用运行态兜底。 */
  const metaLine = (message: AgentMessage): string[] => {
    const meta = metaOf(message);
    const live = message === last;
    const elapsed = meta.elapsedMs ?? (live ? elapsedMs : undefined);
    const used = meta.usage ?? (live ? usage : undefined);
    return [
      meta.model ?? model,
      elapsed === null || elapsed === undefined
        ? null
        : t("agent.meta.elapsed", { seconds: (elapsed / 1000).toFixed(1) }),
      used?.totalTokens == null ? null : t("agent.meta.tokens", { count: used.totalTokens }),
    ].filter(Boolean) as string[];
  };

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="agent-thread">
            {droppedContext > 0 && (
              <MessageScrollerItem>
                <div className="agent-notice" role="status">
                  <CircleAlert />
                  <span>{t("agent.context.trimmed", { count: droppedContext })}</span>
                  <Button size="sm" variant="outline" onClick={() => void newSession()}>
                    {t("agent.newChat")}
                  </Button>
                </div>
              </MessageScrollerItem>
            )}
            {messages.map((message) => {
              if (metaOf(message).hidden) return null;
              if (message.role === "assistant" && !hasContent(message)) return null;
              const meta = metaLine(message);
              return (
                <MessageScrollerItem key={message.id} messageId={message.id}>
                  {message.role === "user" ? (
                    <UserMessage message={message} />
                  ) : (
                    <Message align="start">
                      <MessageContent>
                        <AssistantParts message={message} streaming={busy && message === last} />
                        {/* 次要素级元信息：模型 · 耗时 · token，不抢正文 */}
                        {!(busy && message === last) && meta.length > 0 && (
                          <MessageFooter className="agent-meta">{meta.join(" · ")}</MessageFooter>
                        )}
                        <Actions message={message} items={["copy", "regenerate", "continue"]} />
                      </MessageContent>
                    </Message>
                  )}
                </MessageScrollerItem>
              );
            })}
            {/* 已提交、还没等到首字节：助手位置先立一行「思考中…」 */}
            {status === "submitted" && (
              <MessageScrollerItem>
                <Message align="start">
                  <MessageContent>
                    <TraceLine status="running">
                      <Spinner />
                      <TraceTitle>{t("agent.thinking")}</TraceTitle>
                    </TraceLine>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            )}
            {error && (
              <MessageScrollerItem>
                <ErrorBar error={error} onRetry={() => void retry()} />
              </MessageScrollerItem>
            )}
            {stopped && !busy && !error && (
              <MessageScrollerItem>
                <ResumeRow kind="stopped" />
              </MessageScrollerItem>
            )}
            {incomplete && !busy && !error && !stopped && (
              <MessageScrollerItem>
                <ResumeRow kind="incomplete" messageId={last?.role === "assistant" ? last.id : undefined} />
              </MessageScrollerItem>
            )}
            {partial && (
              <MessageScrollerItem>
                <MessageFooter className="agent-stopped">
                  <X />
                  {t("agent.incomplete")}
                </MessageFooter>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="agent-scroll-button">
          <ArrowDown aria-hidden="true" />
          <span>{t("agent.scrollToEnd")}</span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
