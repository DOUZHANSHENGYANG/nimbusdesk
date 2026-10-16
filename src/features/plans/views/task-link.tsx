import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, FolderOpen, FileText, Globe, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { linkTitle, type TaskLink, type TaskLinkType } from "@/features/plans/types";
import {
  openPath,
  openUrl,
  pickFile,
  pickFolder,
  probePaths,
  inTauri,
} from "@/lib/tauri";
import { useModal } from "@/components/shell/modal-host";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 关联类型 → 图标（与文件管理页的图标语义保持一致） */
function LinkIcon({ type, className }: { type: TaskLinkType; className?: string }) {
  const Icon = type === "folder" ? FolderOpen : type === "url" ? Globe : FileText;
  return <Icon className={className} strokeWidth={2} />;
}

/**
 * 打开关联。
 *
 * 打开前先 probe 一次磁盘：任务可能在一周前关联了一个文件，
 * 之后用户把它删了或移走了。直接调 openPath 会抛出系统级错误对话框，
 * 而这里能给出「关联的路径已不存在」这句人能看懂的话。
 * URL 不做探测 —— 探测一个网址意味着发网络请求，与「纯本地」的定位冲突。
 */
function useOpenLink() {
  const { t } = useTranslation();
  return useCallback(
    async (link: TaskLink) => {
      try {
        if (link.type === "url") {
          await openUrl(link.path);
          return;
        }
        const [info] = await probePaths([link.path]);
        if (info?.kind === "missing") {
          toast.error(t("plans.linkMissing"));
          return;
        }
        await openPath(link.path);
      } catch {
        toast.error(t("plans.linkOpenErr"));
      }
    },
    [t],
  );
}

/** 行内关联徽标：点击直达，悬停出现移除按钮 */
export function TaskLinkBadge({
  link,
  onRemove,
}: {
  link: TaskLink;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const open = useOpenLink();
  const [busy, setBusy] = useState(false);

  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    await open(link);
    setBusy(false);
  };

  return (
    <span
      className={cn(
        "group/link ml-2 inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-full",
        "bg-muted px-1.5 py-px align-middle text-[10px] font-medium text-muted-foreground",
        "transition-colors hover:bg-brand/10 hover:text-brand",
      )}
      title={link.path}
    >
      <button
        type="button"
        onClick={go}
        className={cn("inline-flex min-w-0 items-center gap-1", busy && "opacity-60")}
      >
        <LinkIcon type={link.type} className="size-3 shrink-0" />
        <span className="truncate">{linkTitle(link)}</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title={t("plans.linkRemove")}
        aria-label={t("plans.linkRemove")}
        className="shrink-0 rounded-full p-px opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover/link:opacity-100"
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

/**
 * 关联选择器（编辑态用）。
 *
 * 三种来源三种入口：文件与文件夹走系统对话框（用户要的是「挑一个」），
 * URL 走输入框（系统没有「选一个网址」这回事）。不做一个下拉里混三种，
 * 因为那需要用户先想「我要的是哪一种」，而图标按钮让这个选择一目了然。
 */
export function TaskLinkPicker({
  link,
  onChange,
}: {
  link?: TaskLink;
  onChange: (link: TaskLink | undefined) => void;
}) {
  const { t } = useTranslation();
  const { prompt } = useModal();
  const [open, setOpen] = useState(false);

  const pick = useCallback(
    async (kind: "file" | "folder") => {
      if (!inTauri) {
        toast.error(t("files.err.unsupported"));
        return;
      }
      const picked = kind === "file" ? await pickFile() : await pickFolder();
      if (!picked) return;
      // 探测一次拿到真实类型：用户在 Windows 上「选择文件」时若选到文件夹，
      // 系统对话框在多数配置下会拒绝，但绕过对话框（拖拽、手输路径）时不会 ——
      // 所以以磁盘上的真实类型为准，而不是以用户点的按钮为准。
      const [info] = await probePaths([picked]);
      onChange({ type: info?.kind === "folder" ? "folder" : "file", path: picked });
      setOpen(false);
    },
    [onChange, t],
  );

  const enterUrl = useCallback(async () => {
    const entered = await prompt({ title: t("plans.linkEnterUrl"), initial: link?.path ?? "" });
    if (entered === null) return;
    const raw = entered.trim();
    if (!raw) return;
    // 容错：用户常忘写协议头。补 https 而不是报错 —— 报错回来还是得再输一遍。
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      new URL(withProto);
    } catch {
      toast.error(t("plans.linkUrlInvalid"));
      return;
    }
    onChange({ type: "url", path: withProto });
    setOpen(false);
  }, [link?.path, onChange, prompt, t]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("plans.linkAdd")}
          aria-label={t("plans.linkAdd")}
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md transition-colors",
            link
              ? "text-brand hover:bg-brand/10"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Link2 className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <MenuItem icon={<FileText className="size-3.5" />} onClick={() => void pick("file")}>
          {t("plans.linkPickFile")}
        </MenuItem>
        <MenuItem icon={<FolderOpen className="size-3.5" />} onClick={() => void pick("folder")}>
          {t("plans.linkPickFolder")}
        </MenuItem>
        <MenuItem icon={<Globe className="size-3.5" />} onClick={() => void enterUrl()}>
          {t("plans.linkEnterUrl")}
        </MenuItem>
        {link && (
          <MenuItem
            icon={<X className="size-3.5" />}
            danger
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            {t("plans.linkRemove")}
          </MenuItem>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : "hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** 关联的只读展示（不可交互场景，如纸片窗口） */
export function TaskLinkStatic({ link, className }: { link: TaskLink; className?: string }) {
  const open = useOpenLink();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void open(link);
      }}
      title={link.path}
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1 rounded-full bg-muted px-1.5 py-px",
        "align-middle text-[10px] font-medium text-muted-foreground transition-colors",
        "hover:bg-brand/10 hover:text-brand",
        className,
      )}
    >
      <ExternalLink className="size-2.5 shrink-0" />
      <span className="truncate">{linkTitle(link)}</span>
    </button>
  );
}
