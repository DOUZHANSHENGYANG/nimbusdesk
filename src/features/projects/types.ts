export interface Entity { id: string; createdAt: number; updatedAt: number }
export interface BusinessArea extends Entity { name: string }
export interface ReminderRule {
  enabled: boolean; times: string[]; advanceDays: number; weekdays: number[];
  nonWorkingDay: "same" | "previous"; timezone: string;
}
export interface Project extends Entity {
  name: string; areaId: string | null; note: string; status: "active" | "archived";
  folder: string | null; reminder?: ReminderRule | null;
}
export interface Iteration extends Entity { name: string; start: string; end: string }
export type WorkItemStatus = "todo" | "doing" | "done" | "cancelled";
export interface WorkItem extends Entity {
  title: string; projectId: string | null; areaId: string | null; note: string;
  status: WorkItemStatus; deadline: string | null; activeIterationId: string | null;
  reminder?: ReminderRule | null;
}
export interface IterationMembership {
  id: string; itemId: string; iterationId: string; joinedAt: number; leftAt: number | null;
  carriedFrom: string | null; snapshot?: { title: string; status: WorkItemStatus; deadline: string | null } | null;
  updatedAt: number;
}
export interface ReminderDelivery { id: string; itemId: string; date: string; slots: string[]; notifiedAt: number }
export interface ProjectData {
  areas: BusinessArea[]; projects: Project[]; iterations: Iteration[]; items: WorkItem[];
  memberships: IterationMembership[]; reminderRule: ReminderRule; deliveries: ReminderDelivery[];
}
export type NewItem = Pick<WorkItem, "title"> & Partial<Pick<WorkItem, "projectId" | "areaId" | "note" | "deadline" | "activeIterationId">>;
export type NewProject = Pick<Project, "name"> & Partial<Pick<Project, "areaId" | "note">>;
export const DEFAULT_REMINDER_RULE: ReminderRule = {
  enabled: true, times: ["09:00", "16:50"], advanceDays: 0,
  weekdays: [0, 1, 2, 3, 4, 5, 6], nonWorkingDay: "same", timezone: "Asia/Shanghai",
};
export function emptyProjectData(): ProjectData {
  return { areas: [], projects: [], iterations: [], items: [], memberships: [], reminderRule: structuredClone(DEFAULT_REMINDER_RULE), deliveries: [] };
}
