import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useAgent } from "../store";
import { GOAL_LIMIT } from "../composer-core";

/**
 * 本次目标：一句话说清这一轮要达成什么。非空时**追加到 instructions** 末尾
 * （`\n\n本次目标：<text>`），并持久化到当前会话，会话顶部再显示一条小条。
 *
 * 为什么不是「系统提示词编辑器」：那是一个需要策展、需要版本管理的东西；
 * 这里只是给这一轮对话多一句约束，所以它属于会话而不是全局设置。
 */
export function GoalPopover() {
  const { t } = useTranslation();
  const goal = useAgent((state) => state.goal);
  const setGoal = useAgent((state) => state.setGoal);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    setGoal(draft);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 打开时把当前目标带进输入框：改一个已有的目标比从零写第二个更常见
        if (next) setDraft(goal ?? "");
      }}
    >
      <PopoverTrigger
        className="agent-tool-btn"
        data-active={goal ? true : undefined}
        title={goal ? `${t("agent.goal.title")}：${goal}` : t("agent.goal.action")}
        aria-label={t("agent.goal.action")}
      >
        <Target />
        {goal ? <span className="agent-tool-dot" aria-hidden="true" /> : null}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="agent-goal-pop w-80">
        <PopoverTitle className="agent-menu-name">{t("agent.goal.title")}</PopoverTitle>
        <PopoverDescription className="agent-menu-note">{t("agent.goal.hint")}</PopoverDescription>
        <input
          className="agent-goal-input"
          value={draft}
          maxLength={GOAL_LIMIT}
          placeholder={t("agent.goal.placeholder")}
          aria-label={t("agent.goal.title")}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commit();
            }
          }}
        />
        <div className="agent-goal-actions">
          <span className="agent-goal-count">{`${draft.length}/${GOAL_LIMIT}`}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={!goal && !draft}
            onClick={() => {
              setDraft("");
              setGoal(null);
              setOpen(false);
            }}
          >
            {t("agent.goal.clear")}
          </Button>
          <Button size="xs" onClick={commit}>{t("agent.goal.save")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
