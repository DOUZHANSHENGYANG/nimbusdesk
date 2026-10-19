import type { Entity, WorkItemStatus } from "./types";

export type ZenApiVersion = "auto" | "v1" | "v2";
export type ZenWriteField = "title" | "note" | "deadline";
export interface ZenConnection extends Entity {
  name: string; baseUrl: string; account: string; apiVersion: ZenApiVersion;
  executionIds: number[]; autoSync: boolean; syncMinutes: number;
  writeFields?: ZenWriteField[];
}
export interface ZenSyncMeta {
  lastSyncAt: number | null; lastError: string | null; lastCount: number;
  resolvedVersion: "v1" | "v2" | null; authRequired: boolean;
}
export interface ZenConnectionData { connections: ZenConnection[]; syncStates: Record<string, ZenSyncMeta> }
export interface ZenTask {
  id: string; connectionId: string; remoteId: number; title: string; note: string; status: string;
  deadline: string | null; start: string | null; remoteProjectId: number | null;
  executionId: number | null; parentRemoteId: number | null; assignedTo: string; teamAccounts: string[];
  lastEditedDate: string | null; updatedAt: number;
}
export interface ZenExecution {
  id: string; connectionId: string; remoteId: number; name: string;
  start: string | null; end: string | null; status: string; updatedAt: number;
}
export interface ZenFields { title: string; note: string; deadline: string | null; status: WorkItemStatus }
export interface ZenTaskLink {
  id: string; connectionId: string; remoteId: number; itemId: string;
  baseline: ZenFields; divergedFields: string[]; updatedAt: number;
}
export interface ZenChange {
  id: string; connectionId: string; remoteId: number; itemId: string;
  status: "pending" | "conflict" | "sending" | "uncertain" | "failed";
  base: ZenFields; local: ZenFields; remote: ZenFields; expected: ZenFields;
  fields: ZenWriteField[]; lastError: string | null; updatedAt: number;
}
export interface ZenFetchResult {
  apiVersion: "v1" | "v2"; tasks: ZenTask[]; executions: ZenExecution[];
  unavailableIds: number[]; fetchedAt: number;
}
export interface ZenSecretStatus { hasPassword: boolean; hasToken: boolean; apiVersion?: "v1" | "v2" | null }
export interface ZenTestResult { apiVersion: "v1" | "v2"; account: string }
export const emptyZenSyncMeta = (): ZenSyncMeta => ({ lastSyncAt: null, lastError: null, lastCount: 0, resolvedVersion: null, authRequired: false });
