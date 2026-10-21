import { useTranslation } from "react-i18next";
import { childrenOf, dayProgress, linkTitle, minutesOf, rangeLabel, type PlanTask } from "@/features/plans/types";
import type { FileItem } from "@/stores/files";
import "./today-list.css";

/**
 * 今天：按时间的行式清单 + 玻璃右栏。
 *
 * 为什么先是清单而不是星图：主页是「今天要做什么」，一屏之内看得清、点得动
 * 比看得爽重要。星图保留（右上角切到「脉络」），但不再是默认落点。
 *
 * 分组是按开始时间推出来的（上午 / 下午 / 晚上 / 未定时），不是存下来的字段 ——
 * 时间一改，分组自动跟着变，不需要任何迁移。
 */
type Slot = "morning" | "afternoon" | "evening" | "unscheduled";
const SLOTS: Slot[] = ["morning", "afternoon", "evening", "unscheduled"];

function slotOf(start?: string): Slot {
  const m = minutesOf(start);
  if (m == null) return "unscheduled";
  if (m < 12 * 60) return "morning";
  if (m < 18 * 60) return "afternoon";
  return "evening";
}

export function TodayList({
  tasks,
  focusedId,
  onFocus,
  onToggle,
  latest,
}: {
  tasks: PlanTask[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onToggle: (id: string) => void;
  latest: FileItem[];
}) {
  const { t } = useTranslation();
  const roots = tasks.filter((task) => task.parentId === null);
  const focused = focusedId ? tasks.find((task) => task.id === focusedId) ?? null : null;
  const subtasks = focused ? childrenOf(tasks, focused.id) : [];
  const parent = focused?.parentId ? tasks.find((task) => task.id === focused.parentId) ?? null : null;
  const progress = dayProgress(tasks);
  const groups = SLOTS.map((slot) => ({ slot, rows: roots.filter((task) => slotOf(task.start) === slot) })).filter(
    (group) => group.rows.length > 0,
  );

  return (
    <div className="tl-layout">
      <div className="tl-main">
        {groups.length === 0 && <p className="tl-empty">{t("home.emptyToday")}</p>}
        {groups.map(({ slot, rows }) => (
          <section key={slot} className="tl-group">
            <div className="tl-label">{t(`home.slot_${slot}`)}</div>
            {rows.map((task) => {
              const range = rangeLabel(task);
              return (
                <div key={task.id} className="tl-block">
                  <div className={`tl-row${task.done ? " is-done" : ""}${focused?.id === task.id ? " is-focus" : ""}`}>
                    <button
                      type="button"
                      className="tl-dot"
                      role="checkbox"
                      aria-checked={task.done}
                      aria-label={t("home.toggleDone")}
                      onClick={() => onToggle(task.id)}
                    />
                    <button
                      type="button"
                      className="tl-title"
                      onClick={() => onFocus(focused?.id === task.id ? null : task.id)}
                    >
                      {task.title}
                    </button>
                    {range && <span className="tl-time">{range}</span>}
                  </div>
                  {focused?.id === task.id && subtasks.length > 0 && (
                    <div className="tl-subs">
                      {subtasks.map((sub) => (
                        <button
                          key={sub.id}
                          type="button"
                          className={`tl-sub${sub.done ? " is-done" : ""}`}
                          onClick={() => onToggle(sub.id)}
                        >
                          <i aria-hidden />
                          {sub.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <aside className="tl-rail">
        <div className="tl-panel mat-glass">
          {focused ? (
            <>
              <h2 className="tl-panel-h">{focused.title}</h2>
              <p className="tl-panel-m">{rangeLabel(focused) ?? focused.start ?? t("home.slot_unscheduled")}</p>
              <Prop label={t("home.propTime")} value={rangeLabel(focused) ?? focused.start ?? "—"} />
              {parent && <Prop label={t("home.propParent")} value={parent.title} />}
              {subtasks.length > 0 && (
                <Prop
                  label={t("home.propSubtasks")}
                  value={`${subtasks.filter((sub) => sub.done).length} / ${subtasks.length}`}
                />
              )}
              {focused.note && <Prop label={t("home.propNote")} value={focused.note} />}
              {focused.link && <Prop label={t("home.propLink")} value={linkTitle(focused.link)} />}
              {focused.attachments && focused.attachments.length > 0 && (
                <Prop label={t("home.propAttachments")} value={focused.attachments.map((file) => file.name).join("、")} />
              )}
            </>
          ) : (
            <>
              <h2 className="tl-panel-h">{t("home.progressLabel", { done: progress.done, total: progress.total })}</h2>
              <p className="tl-panel-m">{t("home.listHint")}</p>
            </>
          )}

          <div className="tl-label tl-rail-label">{t("home.latestItems")}</div>
          {latest.map((item) => (
            <div key={item.id} className="tl-note">
              <div className="tl-note-t">{item.title}</div>
              <div className="tl-note-m">{new Date(item.createdAt).toLocaleDateString()}</div>
            </div>
          ))}
          {latest.length === 0 && <p className="tl-note-m">{t("home.noItems")}</p>}
        </div>
      </aside>
    </div>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div className="tl-prop">
      <span>{label}</span>
      <b title={value}>{value}</b>
    </div>
  );
}
