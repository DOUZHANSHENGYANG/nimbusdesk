import type { ZenFields, ZenTask } from "./zentao-types";

export const ZEN_FIELD_KEYS = ["title", "note", "deadline", "status"] as const;
export const ZEN_WRITE_FIELDS = ["title", "note", "deadline"] as const;
export const zenEpoch = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const encoder = new TextEncoder();
export const zenBounded = (v: unknown, max: number, empty = true) => typeof v === "string" && !v.includes("\0") && (empty || Boolean(v.trim())) && encoder.encode(v).length <= max;
export const zenDate = (v: unknown) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !v.startsWith("0000") && Number.isFinite(+new Date(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v);
export const zenTimestamp = (v: unknown) => v === null || (typeof v === "string" && v.length <= 100 && zenDate(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(v));
export function validZenFields(v: ZenFields): boolean {
  return Boolean(v && Object.keys(v).length === 4 && Object.keys(v).every(k => ZEN_FIELD_KEYS.includes(k as typeof ZEN_FIELD_KEYS[number])) && zenBounded(v.title, 10_000, false) && zenBounded(v.note, 1_000_000) && zenDate(v.deadline) && ["todo", "doing", "done", "cancelled"].includes(v.status));
}
export function remoteFields(task: ZenTask): ZenFields {
  return { title: task.title, note: task.note, deadline: task.deadline, status: task.status === "doing" ? "doing" : ["done", "closed"].includes(task.status) ? "done" : task.status === "cancel" ? "cancelled" : "todo" };
}
export function mergeZenFields(local: ZenFields, base: ZenFields, remote: ZenFields) {
  const baseline = { ...base }, patch: Partial<ZenFields> = {}, divergedFields: string[] = [];
  for (const key of ZEN_FIELD_KEYS) {
    if (local[key] === baseline[key] || local[key] === remote[key]) {
      Object.assign(patch, { [key]: remote[key] }); Object.assign(baseline, { [key]: remote[key] });
    } else if (remote[key] !== baseline[key]) divergedFields.push(key);
  }
  return { baseline, patch, divergedFields };
}
