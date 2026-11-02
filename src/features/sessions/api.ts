import { invoke } from "@tauri-apps/api/core";

export interface RuntimeInfo {
  id: string;
  label: string;
  available: boolean;
  home: string | null;
  note: string;
}

export interface SessionSummary {
  id: string;
  runtime: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number | null;
  messageCount: number;
  sizeBytes: number;
}

export interface SessionEvent {
  kind: string;
  text: string | null;
  timestamp: string | null;
  tool: string | null;
  paths: string[];
}

export interface SessionDetail {
  id: string;
  runtime: string;
  cwd: string | null;
  title: string | null;
  updatedAt: number | null;
  events: SessionEvent[];
}

export interface SessionCounts {
  prompts: number;
  interjections: number;
  replies: number;
  tools: number;
  outputs: number;
  edits: number;
  compactions: number;
}

export interface MigrationReport {
  source: string;
  sourceId: string;
  target: string;
  targetId: string;
  cwd: string;
  counts: SessionCounts;
  dropped: string[];
  resumeCommand: string | null;
  path: string | null;
  skipped: boolean;
}

export async function sessionRuntimes(): Promise<RuntimeInfo[]> {
  return invoke<RuntimeInfo[]>("sessions_runtimes");
}

export async function sessionList(runtimes?: string[]): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("sessions_list", { runtimes: runtimes?.length ? runtimes : null });
}

export async function sessionRead(runtime: string, id: string): Promise<SessionDetail> {
  return invoke<SessionDetail>("sessions_read", { runtime, id });
}

export interface ThoughtGraph {
  version: number;
  sourceSessionId: string;
  title: string;
  nodes: Array<{
    id: string;
    type: "thought";
    position: { x: number; y: number };
    data: {
      question: string;
      response: string;
      responses: string[];
      responseIndex: number;
      isCollapsed: boolean;
      isEditing: boolean;
      isEditingResponse: boolean;
      isLoading: boolean;
    };
  }>;
  edges: Array<{ id: string; source: string; target: string; type: "thought" }>;
}

export async function sessionThoughtGraph(runtime: string, id: string): Promise<ThoughtGraph> {
  return invoke<ThoughtGraph>("sessions_thought_graph", { runtime, id });
}

export async function importThoughtGraph(graph: ThoughtGraph, cwd?: string | null): Promise<SessionDetail> {
  return invoke<SessionDetail>("sessions_import_thought_graph", { graph, cwd: cwd ?? null });
}

export interface CanvasWriteResult {
  id: string;
  resumeCommand: string | null;
  path: string | null;
  dropped: string[];
}

export async function commitThoughtGraph(
  graph: ThoughtGraph,
  target: string,
  cwd?: string | null,
  title?: string | null,
): Promise<CanvasWriteResult> {
  return invoke<CanvasWriteResult>("sessions_commit_thought_graph", {
    graph,
    target,
    cwd: cwd ?? null,
    title: title ?? null,
  });
}

export async function sessionMigrate(input: {
  source: string;
  sessionId: string;
  target: string;
  cwd?: string | null;
}): Promise<MigrationReport> {
  return invoke<MigrationReport>("sessions_migrate", {
    req: {
      source: input.source,
      sessionId: input.sessionId,
      target: input.target,
      cwd: input.cwd ?? null,
    },
  });
}
