import { useEffect, useState } from "react";
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
import { inTauri, nativeIcon } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/* ── 原生图标缓存（按「路径 + 目标尺寸」，模块级；栅栏与文件页共享） ── */

const nativeCache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

/** 目标位图边长（物理像素）。取到 16 的整数倍，让缩小落在整数比例上 */
function targetSize(cssSize: number): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const raw = cssSize * dpr;
  return Math.max(16, Math.min(256, Math.ceil(raw / 16) * 16));
}

/**
 * 取 Windows 原生图标（资源管理器同款）。
 *
 * 为什么要把目标尺寸传给 Rust、而不是拿 256px 让浏览器缩：
 * 图标在界面上只有 20–34 CSS 像素，浏览器从 256 缩到 ~40 物理像素
 * 是 6 倍以上的降采样，会丢掉细节显得发糊。Rust 侧做盒式滤波
 * （预乘 alpha 平均）质量更好，也顺带把 data URL 从 ~200KB 降到几 KB。
 *
 * 同一「路径 + 尺寸」只请求一次，结果模块级缓存；
 * 取不到返回 null → 调用方回退 lucide 图标。
 */
export function useNativeIcon(
  path: string | undefined,
  enabled: boolean,
  cssSize = 20,
): string | null {
  const size = targetSize(cssSize);
  const key = path ? `${path}\u{1}${size}` : "";

  const [icon, setIcon] = useState<string | null>(() =>
    key ? (nativeCache.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key) {
      setIcon(null);
      return;
    }
    if (nativeCache.has(key)) {
      setIcon(nativeCache.get(key) ?? null);
      return;
    }
    let alive = true;
    const sub = () => {
      if (alive) setIcon(nativeCache.get(key) ?? null);
    };
    subscribers.add(sub);

    const task =
      pending.get(key) ??
      nativeIcon(path as string, size)
        .catch(() => null)
        .then((v) => {
          nativeCache.set(key, v);
          pending.delete(key);
          notify();
          return v;
        });
    pending.set(key, task);
    void task.then(() => sub());

    return () => {
      alive = false;
      subscribers.delete(sub);
    };
  }, [key, path, size, enabled]);

  // enabled=false（非 Tauri 环境或调用方显式关闭）时不使用原生图标
  return enabled ? icon : null;
}
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
  native = true,
  size = 20,
}: {
  type: ItemType;
  path: string;
  iconUrl?: string;
  className?: string;
  /** 本地条目是否优先用 Windows 原生图标（默认是） */
  native?: boolean;
  /** 显示尺寸（CSS 像素），用于按 DPR 取合适分辨率的原生图标 */
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const nativeUrl = useNativeIcon(type === "url" ? undefined : path, native && inTauri, size);
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

  // 本地条目：优先原生图标（与资源管理器/桌面一致），取不到再回退
  if (nativeUrl) {
    return (
      <img
        src={nativeUrl}
        alt=""
        draggable={false}
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }

  if (type === "folder") {
    return <Folder className={cn("shrink-0 text-brand", className)} strokeWidth={1.8} />;
  }

  const ext = extOf(path);
  const hit = EXT_MAP[ext] ?? { Icon: FileIcon, cls: "text-muted-foreground" };
  const { Icon, cls } = hit;
  return <Icon className={cn("shrink-0", cls, className)} strokeWidth={1.8} />;
}
