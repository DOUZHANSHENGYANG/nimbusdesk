import type { ZenTask, ZenExecution, ZenTaskLink, ZenChange } from "./zentao-types";
export interface Entity { id: string; createdAt: number; updatedAt: number }
export interface Project extends Entity {
  name: string; note: string; status: "active" | "archived";
  folder: string | null;
  /** 置顶：始终排在未置顶的项目之前（同组内仍按数组顺序） */
  pinned?: boolean;
  /** 业务标签：自由文本，逗号输入 */
  tags?: string[];
  /** 计划起止：填了就按时间推算进度 */
  startDate?: string | null; endDate?: string | null;
  /** 人工覆盖的进度（0–100）；有值就不再按时间/工作项推算 */
  progressManual?: number | null;
  /** 图标名，取自项目图标白名单；空则用默认文件夹 */
  icon?: string | null;
  /** 图标色，1–5，映射到 --chart-N */
  color?: number | null;
}
export interface Iteration extends Entity { name: string; start: string; end: string }
export type WorkItemStatus = "todo" | "doing" | "done" | "cancelled";
export interface WorkItem extends Entity {
  title: string; projectId: string | null; note: string;
  status: WorkItemStatus; deadline: string | null; activeIterationId: string | null;
  /** 子计划：指向同项目的另一条工作项 */
  parentId?: string | null;
  /** 同层权重，默认 1；只在兄弟之间有意义 */
  weight?: number;
  /** 人工完成度 0–100；有值就不再只看 status */
  percent?: number | null;
  /** 甘特用；都可空，缺省回退到迭代区间 */
  startDate?: string | null; endDate?: string | null;
  mergedIntoId?: string | null;
  mergedSnapshot?: { item: Omit<WorkItem, "mergedSnapshot">; source: ZenTaskLink; change?: ZenChange; mergedAt: number };
}
export interface IterationMembership {
  id: string; itemId: string; iterationId: string; joinedAt: number; leftAt: number | null;
  carriedFrom: string | null; snapshot?: { title: string; status: WorkItemStatus; deadline: string | null } | null;
  updatedAt: number;
}
/** 每天每项目一行，用于燃尽 / 累积流 / 速率；没有历史就没有图，所以从装上那天起累积。 */
export interface ProgressSnapshot {
  date: string; projectId: string;
  todo: number; doing: number; done: number; cancelled: number;
  /** 权重合计（点数）与其中已完成的部分 */
  points: number; donePoints: number;
}
export interface ProjectData {
  projects: Project[]; iterations: Iteration[]; items: WorkItem[];
  memberships: IterationMembership[];
  snapshots: ProgressSnapshot[];
  remoteTasks: ZenTask[]; remoteExecutions: ZenExecution[]; remoteLinks: ZenTaskLink[];
  remoteChanges: ZenChange[];
}
export type NewItem = Pick<WorkItem, "title"> & Partial<Pick<WorkItem, "projectId" | "note" | "deadline" | "activeIterationId" | "parentId" | "weight" | "percent" | "startDate" | "endDate">>;
export type NewProject = Pick<Project, "name"> & Partial<Pick<Project, "note" | "tags">>;
export function emptyProjectData(): ProjectData {
  return { projects: [], iterations: [], items: [], memberships: [], snapshots: [], remoteTasks: [], remoteExecutions: [], remoteLinks: [], remoteChanges: [] };
}
