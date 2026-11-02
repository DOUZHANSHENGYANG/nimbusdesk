import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Bell,
  BookOpen,
  Bot,
  CalendarClock,
  CheckCheck,
  FolderOpen,
  HardDrive,
  Info,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/motion/switch";
import { requestNotificationPermission } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  useNotifications,
  type AppNotification,
  type NotificationSource,
} from "@/stores/notifications";

const SOURCE_ICON: Record<NotificationSource, typeof Bell> = {
  skill: Sparkles,
  schedule: CalendarClock,
  storage: HardDrive,
  files: FolderOpen,
  ai: Bot,
  knowledge: BookOpen,
  system: Info,
};

const SOURCE_KEY: Record<NotificationSource, string> = {
  skill: "notifications.source.skill",
  schedule: "notifications.source.schedule",
  storage: "notifications.source.storage",
  files: "notifications.source.files",
  ai: "notifications.source.ai",
  knowledge: "notifications.source.knowledge",
  system: "notifications.source.system",
};

function timeAgo(ts: number, en: boolean): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return en ? "just now" : "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return en ? `${minutes}m ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return en ? `${hours}h ago` : `${hours} 小时前`;
  return new Date(ts).toLocaleDateString(en ? "en-US" : "zh-CN");
}

function levelClass(level: AppNotification["level"]): string {
  if (level === "error") return "text-danger";
  if (level === "warning") return "text-warning";
  if (level === "success") return "text-success";
  return "text-brand";
}

/**
 * 标题栏通知铃铛：应用内收件箱 + 未读计数 + 系统通知开关。
 * 这里只负责展示与读取；通知的产生通过 `@/lib/notifications` 的 `notify()`。
 */
export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const en = i18n.language?.startsWith("en");
  const items = useNotifications((state) => state.items);
  const systemEnabled = useNotifications((state) => state.systemEnabled);
  const markRead = useNotifications((state) => state.markRead);
  const markAllRead = useNotifications((state) => state.markAllRead);
  const clearRead = useNotifications((state) => state.clearRead);
  const setSystemEnabled = useNotifications((state) => state.setSystemEnabled);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const unread = items.filter((item) => !item.read).length;
  const visible = filter === "unread" ? items.filter((item) => !item.read) : items;
  const readCount = items.length - unread;

  const openItem = (item: AppNotification) => {
    markRead(item.id);
    if (item.route) {
      navigate(item.route);
      setOpen(false);
    }
  };

  const toggleSystem = async (next: boolean) => {
    if (!next) {
      setSystemEnabled(false);
      return;
    }
    const state = await requestNotificationPermission();
    if (state !== "granted") {
      toast.error(t("notifications.permissionDenied"));
      return;
    }
    setSystemEnabled(true);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("notifications.open")}
          title={t("notifications.open")}
          className={cn(
            "relative grid size-8 place-items-center rounded-lg transition-colors duration-150",
            open
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:opacity-70",
          )}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <span className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[9px] font-semibold leading-4 text-primary-foreground tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={8} className="w-[380px] max-w-[92vw] gap-0 p-0">
        <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
          <Bell className="size-4 text-brand" />
          <span className="text-[13px] font-semibold">{t("notifications.title")}</span>
          {unread > 0 ? (
            <span className="rounded-full bg-brand/10 px-1.5 text-[10px] leading-4 text-brand tabular-nums">
              {t("notifications.unread", { n: unread })}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!unread}
            onClick={markAllRead}
            title={t("notifications.markAllRead")}
            aria-label={t("notifications.markAllRead")}
            className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <CheckCheck className="size-3.5" />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] transition-colors",
                filter === value ? "bg-brand/10 text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {value === "all" ? t("notifications.all") : t("notifications.unreadFilter")}
            </button>
          ))}
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {t("notifications.total", { n: items.length })}
          </span>
        </div>

        <div className="max-h-[min(58vh,460px)] overflow-y-auto">
          {visible.length === 0 ? (
            <div className="grid place-items-center px-4 py-10 text-center">
              <Bell className="size-5 text-muted-foreground/50" />
              <p className="mt-2 text-[11px] text-muted-foreground">
                {filter === "unread" ? t("notifications.emptyUnread") : t("notifications.empty")}
              </p>
            </div>
          ) : (
            visible.map((item) => {
              const Icon = SOURCE_ICON[item.source] ?? Info;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openItem(item)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b border-border/50 px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-muted/55",
                    !item.read && "bg-brand/[0.04]",
                  )}
                >
                  <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted", levelClass(item.level))}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{item.title}</span>
                      {item.count > 1 ? (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[9px] leading-4 text-muted-foreground tabular-nums">
                          ×{item.count}
                        </span>
                      ) : null}
                      {!item.read ? <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-brand" /> : null}
                    </span>
                    {item.body ? (
                      <span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{item.body}</span>
                    ) : null}
                    <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                      <span>{t(SOURCE_KEY[item.source])}</span>
                      <span>·</span>
                      <span>{timeAgo(item.updatedAt, en)}</span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <footer className="border-t border-border/70 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-foreground">{t("notifications.system")}</span>
            <Switch
              checked={systemEnabled}
              onCheckedChange={(next) => void toggleSystem(next)}
              ariaLabel={t("notifications.system")}
              className="scale-90"
            />
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{t("notifications.systemHint")}</p>
          {readCount > 0 ? (
            <button
              type="button"
              onClick={clearRead}
              className="mt-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("notifications.clearRead", { n: readCount })}
            </button>
          ) : null}
        </footer>
      </PopoverContent>
    </Popover>
  );
}
