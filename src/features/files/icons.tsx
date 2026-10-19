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

const CACHE_LIMIT = 512;
const nativeCache = new Map<string, { value: string | null; expires: number }>();
const pending = new Map<string, Promise<string | null>>();

function cachedIcon(key: string) {
  const hit = nativeCache.get(key);
  if (hit && hit.expires <= Date.now()) {
    nativeCache.delete(key);
    return undefined;
  }
  return hit;
}

function rememberIcon(key: string, value: string | null) {
  nativeCache.delete(key);
  nativeCache.set(key, { value, expires: Date.now() + (value ? 300_000 : 2_000) });
  while (nativeCache.size > CACHE_LIMIT) nativeCache.delete(nativeCache.keys().next().value!);
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
 * 同一「路径 + 尺寸」合并并发请求，成功短期缓存，失败允许稍后重试；
 * 取不到返回 null → 调用方回退 lucide 图标。
 */
export function useNativeIcon(
  path: string | undefined,
  enabled: boolean,
  cssSize = 20,
): string | null {
  const size = targetSize(cssSize);
  const key = enabled && path ? `${path}\u{1}${size}` : "";

  const [icon, setIcon] = useState<{ key: string; value: string | null }>(() =>
    ({ key, value: key ? cachedIcon(key)?.value ?? null : null }),
  );

  useEffect(() => {
    if (!key) {
      setIcon({ key, value: null });
      return;
    }
    const cached = cachedIcon(key);
    if (cached) {
      setIcon({ key, value: cached.value });
      return;
    }
    let alive = true;

    const task =
      pending.get(key) ??
      nativeIcon(path as string, size)
        .catch(() => null)
        .then((v) => {
          rememberIcon(key, v);
          pending.delete(key);
          return v;
        });
    pending.set(key, task);
    void task.then((value) => {
      if (alive) setIcon({ key, value });
    });

    return () => {
      alive = false;
    };
  }, [key, path, size, enabled]);

  // enabled=false（非 Tauri 环境或调用方显式关闭）时不使用原生图标
  return enabled && icon.key === key ? icon.value : null;
}
/**
 * 扩展名 → 专属图标 + 颜色（默认图标兜底）。
 *
 * 颜色走 `--pr-file-*` token 而不是硬编码 tailwind class（原来的
 * `text-violet-500` 那一套）：同一 class 在两种主题下只能是一个明度，
 * 浅色模式压深过的颜色放到深色卡上就不够亮了。token 层按主题各取一档。
 *
 * 分类按「用户找文件时的心理归类」，不是按 MIME 精确划分：
 * PDF / 演示 / 压缩包 / 表格 / 视频 / 图片 / 文档 / 音频，两两色相 ≥30°，
 * 且整体避开 270–310° 紫族。
 */
const EXT_MAP: Record<string, { Icon: LucideIcon; cls: string }> = {
  pdf: { Icon: FileText, cls: "text-file-pdf" },
  doc: { Icon: FileText, cls: "text-file-doc" },
  docx: { Icon: FileText, cls: "text-file-doc" },
  rtf: { Icon: FileText, cls: "text-file-doc" },
  odt: { Icon: FileText, cls: "text-file-doc" },
  txt: { Icon: FileText, cls: "text-file-misc" },
  md: { Icon: FileText, cls: "text-file-misc" },
  xls: { Icon: FileSpreadsheet, cls: "text-file-sheet" },
  xlsx: { Icon: FileSpreadsheet, cls: "text-file-sheet" },
  csv: { Icon: FileSpreadsheet, cls: "text-file-sheet" },
  ppt: { Icon: FileText, cls: "text-file-slide" },
  pptx: { Icon: FileText, cls: "text-file-slide" },
  png: { Icon: FileImage, cls: "text-file-image" },
  jpg: { Icon: FileImage, cls: "text-file-image" },
  jpeg: { Icon: FileImage, cls: "text-file-image" },
  gif: { Icon: FileImage, cls: "text-file-image" },
  webp: { Icon: FileImage, cls: "text-file-image" },
  bmp: { Icon: FileImage, cls: "text-file-image" },
  svg: { Icon: FileImage, cls: "text-file-image" },
  ico: { Icon: FileImage, cls: "text-file-image" },
  mp3: { Icon: FileAudio, cls: "text-file-audio" },
  wav: { Icon: FileAudio, cls: "text-file-audio" },
  flac: { Icon: FileAudio, cls: "text-file-audio" },
  ogg: { Icon: FileAudio, cls: "text-file-audio" },
  m4a: { Icon: FileAudio, cls: "text-file-audio" },
  mp4: { Icon: FileVideo, cls: "text-file-video" },
  mkv: { Icon: FileVideo, cls: "text-file-video" },
  avi: { Icon: FileVideo, cls: "text-file-video" },
  mov: { Icon: FileVideo, cls: "text-file-video" },
  zip: { Icon: FileArchive, cls: "text-file-archive" },
  rar: { Icon: FileArchive, cls: "text-file-archive" },
  "7z": { Icon: FileArchive, cls: "text-file-archive" },
  tar: { Icon: FileArchive, cls: "text-file-archive" },
  gz: { Icon: FileArchive, cls: "text-file-archive" },
  // 代码统一用中性色：类型太多，逐一分色只会制造噪音
  html: { Icon: FileCode, cls: "text-file-misc" },
  htm: { Icon: FileCode, cls: "text-file-misc" },
  js: { Icon: FileCode, cls: "text-file-misc" },
  ts: { Icon: FileCode, cls: "text-file-misc" },
  tsx: { Icon: FileCode, cls: "text-file-misc" },
  jsx: { Icon: FileCode, cls: "text-file-misc" },
  json: { Icon: FileCode, cls: "text-file-misc" },
  py: { Icon: FileCode, cls: "text-file-misc" },
  rs: { Icon: FileCode, cls: "text-file-misc" },
  go: { Icon: FileCode, cls: "text-file-misc" },
  java: { Icon: FileCode, cls: "text-file-misc" },
  c: { Icon: FileCode, cls: "text-file-misc" },
  cpp: { Icon: FileCode, cls: "text-file-misc" },
  css: { Icon: FileCode, cls: "text-file-misc" },
  exe: { Icon: AppWindow, cls: "text-file-misc" },
  msi: { Icon: AppWindow, cls: "text-file-misc" },
  bat: { Icon: FileCode, cls: "text-file-misc" },
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
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const nativeUrl = useNativeIcon(type === "url" ? undefined : path, native && inTauri, size);
  if (type === "url") {
    if (iconUrl && iconUrl !== brokenUrl) {
      return (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          onError={() => setBrokenUrl(iconUrl)}
          className={cn("shrink-0 rounded object-contain", className)}
        />
      );
    }
    return <Globe className={cn("shrink-0 text-info", className)} strokeWidth={1.8} />;
  }

  // 本地条目：优先原生图标（与资源管理器/桌面一致），取不到再回退
  if (nativeUrl && nativeUrl !== brokenUrl) {
    return (
      <img
        src={nativeUrl}
        alt=""
        draggable={false}
        onError={() => {
          nativeCache.delete(`${path}\u{1}${targetSize(size)}`);
          setBrokenUrl(nativeUrl);
        }}
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
