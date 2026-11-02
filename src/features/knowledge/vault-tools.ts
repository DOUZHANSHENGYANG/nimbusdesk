/**
 * 知识库自己的 py 工具的调用层。
 *
 * 体检 / 分诊 / 闭环 / 检索的规则都在库里（99-系统/manage/tools），
 * 这里只把 `--json` 的结果搬回来 —— 不在前端再算一遍。
 */
import { invoke } from "@tauri-apps/api/core";

export type Severity = "error" | "warn" | "info";

export interface HealthItem { path: string; detail?: string }
export interface HealthGroup { id: string; label: string; severity: Severity; items: HealthItem[] }
export interface HealthReport {
  scanned: number;
  groups: HealthGroup[];
  total: number;
  skipped: { id: string; reason?: string }[];
}

export interface TriageReady { path: string; who: string; type: string; dest: string }
export interface TriageProblem { path: string; who: string; type: string; problems: string[] }
export interface TriageStatus {
  reviewed: { dir: string; exists: boolean; count: number }[];
  ready: TriageReady[];
  problems: TriageProblem[];
}
export interface TriageEntry { path: string; who: string; type: string; dest: string | null; problems: string[] }
export interface TriageResult { apply: boolean; moved: number; skipped: number; entries: TriageEntry[] }

export interface LoopConcept { concept: string; path: string; state: string; support: number; reasons: string[] }
export interface LoopStatus {
  cases: number;
  cold: number;
  coldItems?: { path: string; title: string }[];
  concepts: LoopConcept[];
  threshold: number;
  coldDays: number;
  distribution: { concept: string; count: number; hasConcept: boolean; ready: boolean }[];
  orphans: { path: string; reason: string }[];
}
export interface Backlog {
  exists: boolean;
  pending: { date: string; count: number; age: number }[];
  worst: number;
  threshold: number;
  overdue: boolean;
}

export interface SearchHit {
  path: string; title: string; type: string | null; status: string | null;
  tier: "formal" | "workspace"; lines: number[];
}
export interface SearchResult { keyword: string; total: number; hits: SearchHit[] }

async function run<T>(root: string, action: string, argument?: string): Promise<T> {
  const text = await invoke<string>("knowledge_vault_tool", { root, action, argument: argument ?? null });
  return JSON.parse(text) as T;
}

export const healthReport = (root: string) => run<HealthReport>(root, "report");
export const triageStatus = (root: string) => run<TriageStatus>(root, "triage_status");
export const triagePlan = (root: string) => run<TriageResult>(root, "triage_plan");
export const triageRun = (root: string) => run<TriageResult>(root, "triage_run");
export const loopStatus = (root: string) => run<LoopStatus>(root, "loop_status");
export const harvestBacklog = (root: string) => run<Backlog>(root, "backlog");
export const vaultSearch = (root: string, keyword: string) => run<SearchResult>(root, "search", keyword);

/** 只有「修 BOM」「重建索引」是文字输出：它们改文件，返回值只用来确认跑过了。 */
export const fixBom = (root: string) => invoke<string>("knowledge_vault_tool", { root, action: "fix_bom", argument: null });
export const rebuildIndex = (root: string) => invoke<string>("knowledge_vault_tool", { root, action: "index_build", argument: null });
