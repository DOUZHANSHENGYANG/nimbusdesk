import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bot, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAgent } from "./store";
import { Composer } from "./ui/composer";
import { Status } from "./ui/status";
import { Thread } from "./ui/thread";
import "./agent.css";

/** 空会话的建议 prompt：写完就发，省一次「不知道能问什么」。 */
const SUGGESTIONS = ["agent.suggestions.skills", "agent.suggestions.prompts", "agent.suggestions.search"];

/**
 * AI 面板：对话 + 本机只读能力。
 *
 * 与「工具」页（每次输入都要过一次模型的小工具）和「工具箱」（本地文件管理，
 * 不联网）都是两件事：这里跑的是一个带工具循环的 agent。
 */
export function AgentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const init = useAgent((state) => state.init);
  const guide = useAgent((state) => state.guide);
  const count = useAgent((state) => state.messages.length);
  const model = useAgent((state) => state.model);
  const send = useAgent((state) => state.send);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="agent workbench-ui">
      <Status />
      <div className="agent-body">
        {guide ? (
          <div className="agent-guide">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Bot />
                </EmptyMedia>
                <EmptyTitle>{t("agent.guide.title")}</EmptyTitle>
                <EmptyDescription>{t("agent.guide.body")}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => navigate("/settings")}>{t("agent.guide.action")}</Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : count === 0 ? (
          <div className="agent-empty">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Sparkles />
                </EmptyMedia>
                <EmptyTitle>{t("agent.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("agent.emptyBody")}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="agent-empty-suggestions">
                {SUGGESTIONS.map((key) => (
                  <Button key={key} variant="outline" size="sm" onClick={() => void send(t(key))}>
                    {t(key)}
                  </Button>
                ))}
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <Thread model={model} />
        )}
      </div>
      <Composer />
    </div>
  );
}
