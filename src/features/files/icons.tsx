import { useState } from "react";
import {
  AppWindow,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { ItemType } from "@/stores/files";
import { cn } from "@/lib/utils";

/** 扩展名 → 专属图标 + 颜色（默认图标兜底） */
const EXT_MAP: Record<string, { Icon: LucideIcon; cls: string }> = {
  pdf: { Icon: FileText, cls: "text-red-500" },
  doc: { Icon: FileText, cls: "text-blue-500" },
  docx: { Icon: FileText, cls: "text-blue-500" },
  rtf: { Icon: FileText, cls: "text-blue-500" },
  odt: { Icon: FileText, cls: "text-blue-500" },
  txt: { Icon: FileText, cls: "text-blue-400" },
  md: { Icon: FileText, cls: "text-blue-400" },
  xls: { Icon: FileSpreadsheet, cls: "text-emerald-600" },
  xlsx: { Icon: FileSpreadsheet, cls: "text-emerald-600" },
  csv: { Icon: FileSpreadsheet, cls: "text-emerald-600" },
  ppt: { Icon: FileText, cls: "text-orange-500" },
  pptx: { Icon: FileText, cls: "text-orange-500" },
  png: { Icon: FileImage, cls: "text-violet-500" },
  jpg: { Icon: FileImage, cls: "text-violet-500" },
  jpeg: { Icon: FileImage, cls: "text-violet-500" },
  gif: { Icon: FileImage, cls: "text-violet-500" },
  webp: { Icon: FileImage, cls: "text-violet-500" },
  bmp: { Icon: FileImage, cls: "text-violet-500" },
  svg: { Icon: FileImage, cls: "text-violet-500" },
  ico: { Icon: FileImage, cls: "text-violet-500" },
  mp3: { Icon: FileAudio, cls: "text-purple-500" },
  wav: { Icon: FileAudio, cls: "text-purple-500" },
  flac: { Icon: FileAudio, cls: "text-purple-500" },
  ogg: { Icon: FileAudio, cls: "text-purple-500" },
  m4a: { Icon: FileAudio, cls: "text-purple-500" },
  mp4: { Icon: FileVideo, cls: "text-pink-500" },
  mkv: { Icon: FileVideo, cls: "text-pink-500" },
  avi: { Icon: FileVideo, cls: "text-pink-500" },
  mov: { Icon: FileVideo, cls: "text-pink-500" },
  zip: { Icon: FileArchive, cls: "text-amber-600" },
  rar: { Icon: FileArchive, cls: "text-amber-600" },
  "7z": { Icon: FileArchive, cls: "text-amber-600" },
  tar: { Icon: FileArchive, cls: "text-amber-600" },
  gz: { Icon: FileArchive, cls: "text-amber-600" },
  html: { Icon: FileCode, cls: "text-sky-500" },
  htm: { Icon: FileCode, cls: "text-sky-500" },
  js: { Icon: FileCode, cls: "text-sky-500" },
  ts: { Icon: FileCode, cls: "text-sky-500" },
  tsx: { Icon: FileCode, cls: "text-sky-500" },
  jsx: { Icon: FileCode, cls: "text-sky-500" },
  json: { Icon: FileCode, cls: "text-sky-500" },
  py: { Icon: FileCode, cls: "text-sky-500" },
  rs: { Icon: FileCode, cls: "text-sky-500" },
  go: { Icon: FileCode, cls: "text-sky-500" },
  java: { Icon: FileCode, cls: "text-sky-500" },
  c: { Icon: FileCode, cls: "text-sky-500" },
  cpp: { Icon: FileCode, cls: "text-sky-500" },
  css: { Icon: FileCode, cls: "text-sky-500" },
  exe: { Icon: AppWindow, cls: "text-slate-400" },
  msi: { Icon: AppWindow, cls: "text-slate-400" },
  bat: { Icon: FileCode, cls: "text-sky-500" },
};

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 条目图标：网站 favicon（可加载则用图）→ 文件按扩展名映射 → 兜底图标。
 * 加载失败自动回退兜底图标。
 */
export function ItemIcon({
  type,
  path,
  iconUrl,
  className,
}: {
  type: ItemType;
  path: string;
  iconUrl?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);

  if (type === "url") {
    if (iconUrl && !broken) {
      return (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className={cn("shrink-0 rounded object-contain", className)}
        />
      );
    }
    return <Globe className={cn("shrink-0 text-info", className)} strokeWidth={1.8} />;
  }

  if (type === "folder") {
    return <Folder className={cn("shrink-0 text-brand", className)} strokeWidth={1.8} />;
  }

  const ext = extOf(path);
  const hit = EXT_MAP[ext] ?? { Icon: FileIcon, cls: "text-muted-foreground" };
  const { Icon, cls } = hit;
  return <Icon className={cn("shrink-0", cls, className)} strokeWidth={1.8} />;
}
