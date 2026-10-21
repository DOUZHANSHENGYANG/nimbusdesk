import { useState } from "react";
import { isToolUIPart } from "ai";
import { useTranslation } from "react-i18next";
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
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

/** 一条工具调用：人是看的「动词 + 宾语」一行，参数与结果藏在展开层里。 */
function ToolCall({ part }: { part: Part }) {
  const { t } = useTranslation();
  const approve = useAgent((state) => state.approve);
  const [open, setOpen] = useState(false);
  if (!isToolUIPart(part)) return null;
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
  const label = t(TOOL_LABELS[name] ?? name);

  if (part.state === "input-streaming") {
    return (
      <TraceLine status="running">
        <Spinner />
        <TraceTitle>{t("agent.tool.preparing", { name: label })}</TraceTitle>
      </TraceLine>
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
            : t("agent.tool.denied", { name: label })}
        </TraceTitle>
      </TraceLine>
    );
  }

  if (part.state === "output-denied") {
    return (
      <TraceLine status="pending">
        <TraceIcon>
          <ShieldAlert />
        </TraceIcon>
        <TraceTitle>{t("agent.tool.denied", { name: label })}</TraceTitle>
      </TraceLine>
    );
  }

  if (part.state === "output-error") {
    return (
      <TraceLine status="error">
        <TraceIcon>
          <CircleAlert />
        </TraceIcon>
        <TraceTitle>{t("agent.tool.failed", { name: label })}</TraceTitle>
        <TraceDescription className="agent-error-text">{part.errorText}</TraceDescription>
      </TraceLine>
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

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
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
          <TraceTitle>{streaming ? t("agent.thinking") : t("agent.thought")}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function AssistantParts({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  return (
    <Trace>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? (
            <p key={index} className="agent-text">
              {part.text}
            </p>
          ) : null;
        }
        if (part.type === "reasoning") {
          return <Reasoning key={index} text={part.text} streaming={streaming} />;
        }
        if (part.type === "dynamic-tool" || isToolUIPart(part)) {
          return <ToolCall key={index} part={part} />;
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

export function Thread({ model }: { model: string }) {
  const { t } = useTranslation();
  const messages = useAgent((state) => state.messages);
  const status = useAgent((state) => state.status);
  const stopped = useAgent((state) => state.stopped);
  const error = useAgent((state) => state.error);
  const elapsedMs = useAgent((state) => state.elapsedMs);
  const usage = useAgent((state) => state.usage);
  const retry = useAgent((state) => state.retry);
  const last = messages[messages.length - 1];
  const busy = status === "submitted" || status === "streaming";
  const meta = [
    model,
    elapsedMs === null ? null : t("agent.meta.elapsed", { seconds: (elapsedMs / 1000).toFixed(1) }),
    usage?.totalTokens == null ? null : t("agent.meta.tokens", { count: usage.totalTokens }),
  ].filter(Boolean);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="agent-thread">
            {messages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                {message.role === "user" ? (
                  <Message align="end">
                    <MessageContent>
                      <Bubble align="end">
                        <BubbleContent>
                          {message.parts
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("")}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                ) : (
                  <Message align="start">
                    <MessageContent>
                      <AssistantParts message={message} streaming={busy && message === last} />
                      {/* 耗时与用量放最次级位置，不抢正文 */}
                      {message === last && !busy && !error && meta.length > 0 && (
                        <MessageFooter className="agent-meta">{meta.join(" · ")}</MessageFooter>
                      )}
                    </MessageContent>
                  </Message>
                )}
              </MessageScrollerItem>
            ))}
            {error && (
              <MessageScrollerItem>
                <ErrorBar error={error} onRetry={() => void retry()} />
              </MessageScrollerItem>
            )}
            {stopped && !busy && !error && (
              <MessageScrollerItem>
                <MessageFooter className="agent-stopped">
                  {t("agent.stopped")}
                  <Button size="sm" variant="ghost" onClick={() => void retry()}>
                    <RefreshCw />
                    {t("agent.regenerate")}
                  </Button>
                </MessageFooter>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
