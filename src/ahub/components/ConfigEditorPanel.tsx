import { AlertTriangle, FileCode, FolderOpen, Loader2, Save, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Textarea } from "@/ahub/components/ui/input";
import { api } from "@/ahub/lib/api";

/** 简单的行级差异统计（新增 / 删除 行数） */
function diffStat(a: string, b: string): { added: number; removed: number } {
  const la = a.split("\n");
  const lb = b.split("\n");
  const setA = new Map<string, number>();
  for (const l of la) setA.set(l, (setA.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lb) {
    const n = setA.get(l) ?? 0;
    if (n > 0) setA.set(l, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of setA.values()) removed += n;
  return { added, removed };
}

/**
 * 配置编辑器：从右侧滑出，实时编辑某工具的配置文件。
 * - 实时比对内容差异，显示「未保存改动」徽标与增删行数
 * - 保存前自动打快照（走 vault，受管工具），并做语法校验
 */
export function ConfigEditorPanel({
  open,
  harness,
  name,
  onClose,
  onSaved,
}: {
  open: boolean;
  harness: string;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !harness) return;
    setLoading(true);
    setError("");
    setText("");
    setOriginal("");
    api
      .readHarnessConfig(harness)
      .then((r) => {
        setText(r.text);
        setOriginal(r.text);
        setPath(r.path);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, harness]);

  const dirty = text !== original;
  const stat = useMemo(() => (dirty ? diffStat(original, text) : { added: 0, removed: 0 }), [original, text, dirty]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await api.writeHarnessConfig(harness, text);
      const bak = res.backup?.split(/[\\/]/).pop();
      toast.success(t("mcp.cfgSaved", { name }) + (bak ? ` · ${t("mcp.backupMade")}: ${bak}` : ""));
      setOriginal(text);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 420, damping: 40 }}
          className="fixed inset-0 z-50 flex flex-col bg-card"
        >
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <FileCode className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{t("mcp.editCfgTitle", { name })}</span>
                {dirty ? (
                  <Badge variant="warning">
                    {t("settings.vaultDirty", { added: stat.added, removed: stat.removed })}
                  </Badge>
                ) : (
                  <Badge variant="muted">{t("settings.vaultClean")}</Badge>
                )}
              </div>
              <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                {path || "—"}
              </div>
            </div>
            <button
              type="button"
              title={t("mcp.revealCfg")}
              onClick={() => path && void api.revealPath(path)}
              className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <FolderOpen className="size-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-ink-3">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-xs">{t("mcp.cfgLoading")}</span>
              </div>
            ) : (
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                className="h-full min-h-full resize-none font-mono text-xs leading-relaxed whitespace-pre"
                dir="ltr"
              />
            )}
          </div>

          {error ? (
            <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-all">{error}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-subtle px-5 py-3.5">
            <span className="mr-auto text-[11px] text-ink-3">
              {dirty ? t("settings.vaultSaveWillSnapshot") : t("mcp.cfgEditHint")}
            </span>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={loading || saving || !dirty}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {t("common.save")}
            </Button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
