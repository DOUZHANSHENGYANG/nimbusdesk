import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { inTauri } from "@/lib/tauri";

export interface FileDropPoint {
  x: number;
  y: number;
}

interface FileDropOptions {
  enabled: boolean;
  /** 原生拖放的指针位置（物理像素），用于判断落在哪个收纳盒上。 */
  onOver?: (point: FileDropPoint | null) => void;
  onDrop: (paths: string[], point?: FileDropPoint) => Promise<unknown>;
  onError: (error: unknown) => void;
}

/** Native paths are supplied by Tauri, scoped to this mounted page's WebView. */
export function useFileDrop(options: FileDropOptions): { dragging: boolean; busy: boolean } {
  const latest = useRef(options);
  latest.current = options;
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!options.enabled) setDragging(false);
  }, [options.enabled]);

  useEffect(() => {
    if (!inTauri) return;
    let mounted = true;
    let pending = 0;
    let unlisten: (() => void) | undefined;
    const pointOf = (event: { position?: { x: number; y: number } }): FileDropPoint | undefined =>
      event.position ? { x: event.position.x, y: event.position.y } : undefined;
    void getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
      if (!mounted || !latest.current.enabled) return;
      if (payload.type === "enter" || payload.type === "over") {
        setDragging(true);
        latest.current.onOver?.(pointOf(payload) ?? null);
        return;
      }
      if (payload.type === "leave") {
        setDragging(false);
        latest.current.onOver?.(null);
        return;
      }
      setDragging(false);
      if (payload.type !== "drop" || !payload.paths.length) return;

      // Capture accepted callbacks before navigation or dialog state changes.
      const accepted = latest.current;
      pending++;
      setBusy(true);
      void (async () => {
        try {
          await accepted.onDrop([...payload.paths], pointOf(payload));
        }
        catch (error) { accepted.onError(error); }
        finally {
          pending--;
          if (mounted) setBusy(pending > 0);
        }
      })();
    }).then(stop => {
      if (mounted) unlisten = stop;
      else stop();
    }).catch(error => {
      if (mounted) latest.current.onError(error);
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  return { dragging: options.enabled && dragging, busy };
}
