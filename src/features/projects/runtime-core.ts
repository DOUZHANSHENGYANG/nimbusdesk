import { dueProjectReminders, type DueProjectReminder } from "./core";
import type { ProjectData, ReminderDelivery } from "./types";

export function createProjectReminderRunner(deps: {
  getData: () => ProjectData;
  notify: (due: DueProjectReminder[]) => Promise<boolean>;
  save: (rows: ReminderDelivery[]) => Promise<void>;
  now?: () => Date;
}) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const now = (deps.now ?? (() => new Date()))();
      const due = dueProjectReminders(deps.getData(), now);
      if (due.length && await deps.notify(due)) await deps.save(due.map(({ id, itemId, date, slots }) => ({ id, itemId, date, slots, notifiedAt: +now })));
    } finally { running = false; }
  };
}
