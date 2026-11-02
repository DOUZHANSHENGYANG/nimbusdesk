import { invoke } from "@tauri-apps/api/core";

export interface CanvasMessage {
  role: string;
  text: string;
}

export function exportSessionToCanvas(title: string, messages: CanvasMessage[]): Promise<string> {
  return invoke<string>("sessions_export_to_canvas", { title, messages });
}
