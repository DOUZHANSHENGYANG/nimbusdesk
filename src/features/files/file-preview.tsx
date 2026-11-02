import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { filePreview, inTauri, type FilePreview } from "@/lib/tauri";
import type { FileItem } from "@/stores/files";
import { ItemIcon } from "./icons";
import type { BoxAppearance } from "./box-appearance";

const TEXT_EXT = new Set([
  "md", "txt", "rs", "ts", "tsx", "js", "jsx", "json", "jsonc", "css", "html", "xml",
  "yaml", "yml", "toml", "py", "java", "cpp", "c", "h", "sql", "log", "csv", "ini",
  "conf", "sh", "ps1",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const cache = new Map<string, Promise<FilePreview | null>>();
function load(path: string): Promise<FilePreview | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const task = (inTauri ? filePreview(path) : Promise.resolve(null)).catch(() => null);
  cache.set(path, task);
  // Bounded: the fence only asks for the visible page; 256 is plenty.
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  return task;
}

function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/**
 * 图标位置的内容渲染：图片显示缩略图，文本显示前几行原文，其余回退
 * 系统原生图标 / Lucide 类型图标。与 Pogget 的 ShowTextPreview /
 * ShowMediaPreview 对应；失败永远静默回退，不阻塞栅栏。
 */
export function ItemVisual({
  item,
  size,
  appearance,
  className,
  iconClassName,
}: {
  item: FileItem;
  size: number;
  appearance: Pick<BoxAppearance, "showTextPreview" | "showMediaPreview">;
  className?: string;
  iconClassName?: string;
}) {
  const ext = item.type === "file" ? extOf(item.path) : "";
  const wantsText = appearance.showTextPreview && TEXT_EXT.has(ext);
  const wantsImage = appearance.showMediaPreview && IMAGE_EXT.has(ext);
  const [preview, setPreview] = useState<FilePreview | null>(null);

  useEffect(() => {
    setPreview(null);
    if (!wantsText && !wantsImage) return;
    let alive = true;
    void load(item.path).then((value) => {
      if (alive) setPreview(value);
    });
    return () => { alive = false; };
  }, [item.path, wantsText, wantsImage]);

  if (wantsImage && preview?.kind === "image" && preview.dataUrl) {
    return (
      <img
        src={preview.dataUrl}
        alt=""
        draggable={false}
        className={className ?? "rounded-md object-cover"}
        style={{ width: size, height: size }}
      />
    );
  }

  if (wantsText && preview?.kind === "text" && preview.text) {
    const lines = preview.text.replace(/\r/g, "").split("\n").filter((line) => line.trim()).slice(0, 4).join("\n");
    if (lines) {
      return (
        <span
          className={className ?? "block overflow-hidden rounded-md border border-border/70 bg-card px-1 py-0.5 text-left text-muted-foreground"}
          style={{ width: size, height: size, fontSize: Math.max(5, Math.round(size * 0.16)), lineHeight: 1.15 }}
          aria-hidden="true"
        >
          <span className="line-clamp-4 whitespace-pre-wrap break-all">{lines}</span>
        </span>
      );
    }
  }

  return (
    <ItemIcon
      type={item.type}
      path={item.path}
      iconUrl={item.iconUrl}
      size={size}
      className={iconClassName ?? "size-full"}
    />
  );
}

/** 纯文本预览的占位（供设置面板示意，不触发 IPC）。 */
export function TextPreviewGlyph({ size = 34 }: { size?: number }) {
  return (
    <span
      className="flex flex-col justify-center gap-0.5 overflow-hidden rounded-md border border-border/70 bg-card px-1"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <FileText className="size-2.5 text-muted-foreground" />
      <span className="h-px w-full bg-muted-foreground/30" />
      <span className="h-px w-2/3 bg-muted-foreground/25" />
    </span>
  );
}
