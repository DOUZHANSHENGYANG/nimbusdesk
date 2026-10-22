import { Bot, CheckCircle2, Loader2, Pencil, Plus, Sparkles, Star, Trash2, XCircle, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AiProviderDialog } from "@/ahub/components/AiProviderDialog";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { Switch } from "@/ahub/components/motion/switch";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";
import { testResultText } from "@/ahub/lib/aiProviderTest";
import type { AiProvider } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 单张卡片上的测试结果（成功后展示延迟与模型） */
type CardTest = { ok: boolean; text: string };

/**
 * 设置页「AI 提供商」tab：卡片列表 + 添加/编辑/测试/设默认/启停/删除。
 * 徽标：默认（isDefault）与状态并列。状态优先反映事实 ——
 * 已停用 > 已连接（本次会话测通）> 已配置（有 key 未测）> 未配置。
 */
export function AiProviderSettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<AiProvider[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [removing, setRemoving] = useState<AiProvider | null>(null);
  const [busyId, setBusyId] = useState("");
  const [tests, setTests] = useState<Record<string, CardTest>>({});

  const load = async () => {
    try {
      // 首次加载后端会把旧三字段迁移成「自定义」提供商（幂等）
      const list = await api.aiProviderList();
      setProviders(list);
    } catch (e) {
      toast.error(String(e));
      setProviders([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const runTest = async (p: AiProvider) => {
    setBusyId(p.id);
    setTests((m) => {
      const next = { ...m };
      delete next[p.id];
      return next;
    });
    try {
      const r = await api.aiProviderTest(p.id);
      const text = testResultText(r, t);
      setTests((m) => ({ ...m, [p.id]: { ok: r.ok, text } }));
      if (r.ok) toast.success(text);
      else toast.error(text);
    } catch (e) {
      setTests((m) => ({ ...m, [p.id]: { ok: false, text: String(e) } }));
      toast.error(String(e));
    } finally {
      setBusyId("");
    }
  };

  const setDefault = async (p: AiProvider) => {
    setBusyId(p.id);
    try {
      await api.aiProviderSetDefault(p.id);
      await load();
      toast.success(t("aiProvider.defaultToast", { name: p.name }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId("");
    }
  };

  const toggleEnabled = async (p: AiProvider, enabled: boolean) => {
    setBusyId(p.id);
    try {
      await api.aiProviderSetEnabled(p.id, enabled);
      await load();
      toast.success(t(enabled ? "aiProvider.enabledToast" : "aiProvider.disabledToast", { name: p.name }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId("");
    }
  };

  const doDelete = async (p: AiProvider) => {
    setBusyId(p.id);
    try {
      await api.aiProviderDelete(p.id);
      await load();
      toast.success(t("aiProvider.deleted"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId("");
    }
  };

  const onSaved = async (p: AiProvider) => {
    await load();
    toast.success(editing ? t("aiProvider.saved") : t("aiProvider.created"));
    setEditing(null);
    // 新增后立刻试一次，省去用户手动点「测试连接」
    if (!editing && p.id) void runTest(p);
  };

  if (providers === null) {
    return <p className="text-[11px] text-ink-3">{t("common.loading")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[11px] leading-relaxed text-ink-3">{t("aiProvider.desc")}</p>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 text-[11px]"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          {t("aiProvider.add")}
        </Button>
      </div>

      {providers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-bg-subtle px-6 py-10 text-center">
          <span className="grid size-10 place-items-center rounded-full bg-primary-soft text-primary">
            <Sparkles className="size-5" />
          </span>
          <div>
            <div className="text-sm font-medium text-foreground">{t("aiProvider.empty")}</div>
            <p className="mt-1 max-w-md text-[11px] leading-relaxed text-ink-3">{t("aiProvider.emptyHint")}</p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            {t("aiProvider.addFirst")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((p) => {
            const test = tests[p.id];
            const busy = busyId === p.id;
            return (
              <div key={p.id} className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg",
                      p.enabled ? "bg-primary-soft text-primary" : "bg-surface-2 text-ink-3",
                    )}
                  >
                    {p.kind === "anthropic" ? <Bot className="size-4" /> : <Sparkles className="size-4" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">{p.name}</span>
                      {p.isDefault ? (
                        <Badge variant="default">
                          <Star />
                          {t("aiProvider.isDefault")}
                        </Badge>
                      ) : null}
                      {!p.enabled ? (
                        <Badge variant="muted">{t("aiProvider.statusDisabled")}</Badge>
                      ) : test?.ok ? (
                        <Badge variant="success">{t("aiProvider.statusOk")}</Badge>
                      ) : p.keyHint ? (
                        <Badge variant="info">{t("aiProvider.statusConfigured")}</Badge>
                      ) : (
                        <Badge variant="warning">{t("aiProvider.statusMissing")}</Badge>
                      )}
                      <Badge variant="outline">
                        {p.kind === "anthropic" ? t("aiProvider.kind_anthropic") : t("aiProvider.kind_openai")}
                      </Badge>
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                      <span className="font-mono" dir="ltr">
                        {p.keyHint || "—"}
                      </span>
                      <span className="font-mono" dir="ltr">
                        {p.model || "—"}
                      </span>
                      {p.baseUrl ? (
                        <span className="min-w-0 truncate font-mono" dir="ltr">
                          {p.baseUrl}
                        </span>
                      ) : null}
                    </div>

                    {test ? (
                      <div
                        className={cn(
                          "mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed",
                          test.ok ? "text-success" : "text-danger",
                        )}
                      >
                        {test.ok ? (
                          <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
                        ) : (
                          <XCircle className="mt-0.5 size-3 shrink-0" />
                        )}
                        <span className="min-w-0 break-words">{test.text}</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(v) => void toggleEnabled(p, v)}
                      disabled={busy}
                      ariaLabel={p.enabled ? t("aiProvider.disable") : t("aiProvider.enable")}
                      className="mr-1 scale-90"
                    />
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("aiProvider.test")}
                      onClick={() => void runTest(p)}
                      disabled={busy}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                    </Button>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("aiProvider.edit")}
                      onClick={() => {
                        setEditing(p);
                        setDialogOpen(true);
                      }}
                      disabled={busy}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("aiProvider.setDefault")}
                      onClick={() => void setDefault(p)}
                      disabled={busy || p.isDefault}
                    >
                      <Star className="size-3.5" />
                    </Button>
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("common.delete")}
                      className="hover:text-danger"
                      onClick={() => setRemoving(p)}
                      disabled={busy}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-ink-3">{t("aiProvider.deleteCredentialNote")}</p>

      <AiProviderDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditing(null);
        }}
        provider={editing}
        onSaved={(p) => void onSaved(p)}
      />

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => {
          if (!v) setRemoving(null);
        }}
        title={t("aiProvider.deleteTitle")}
        message={t("aiProvider.deleteMessage", { name: removing?.name ?? "" })}
        danger
        onConfirm={() => {
          if (removing) void doDelete(removing);
          setRemoving(null);
        }}
      />
    </div>
  );
}
