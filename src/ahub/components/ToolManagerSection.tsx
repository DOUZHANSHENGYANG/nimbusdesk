import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { api, copyText } from "@/ahub/lib/api";
import type { ToolList, ToolVersion } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 是否有更新（无更新时显示「已是最新」） */
function versionText(tool: ToolVersion): string {
  if (!tool.installed) return "";
  if (tool.current && tool.latest && tool.hasUpdate) return tool.current;
  return tool.current || "—";
}

/**
 * 未安装工具：给出可直接粘进终端的安装命令 + 复制按钮。
 * 命令与确认框里更新用的命令保持同一形式（`npm install -g <pkg>@latest`），便于对照。
 */
function InstallCommand({ pkg }: { pkg: string }) {
  const { t } = useTranslation();
  const cmd = `npm install -g ${pkg}@latest`;
  return (
    <div className="flex items-center gap-2 pl-[3.75rem]">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg-subtle px-2 py-1 font-mono text-[11px] text-ink-2">
        {cmd}
      </code>
      <button
        type="button"
        title={t("common.copy")}
        aria-label={t("common.copy")}
        onClick={() => void copyText(cmd).then((ok) => ok && toast.success(t("common.copied")))}
        className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * AI 工具管理：检查各 CLI 工具是否有新版本，并按需更新。
 *
 * 设计取舍：
 * - **只列 npm 全局安装的 CLI**。GUI 桌面应用（Cursor / Claude Desktop …）没有可编程的
 *   更新入口，不在此列，避免出现「能查不能更」的行。
 * - **不自动检查**。查询 registry 是网络请求，只在用户点「检查更新」时发起。
 * - **只检查已安装的工具**。未安装的查最新版没有意义，改为给出可直接复制的安装命令。
 * - **已安装的排在前面**（后端 `sort_installed_first`），常用的先看到。
 * - **逐个工具一行**（纵向单列），与项目其它区域保持一致的阅读动线。
 * - **批量更新需二次确认**，确认框列出将执行的完整命令。
 */
export function ToolManagerSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<ToolList | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.toolList());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    try {
      const next = await api.toolCheckLatest();
      setState(next);
      const n = next.tools.filter((x) => x.hasUpdate).length;
      if (n > 0) toast.success(t("tools.checkDone", { n }));
      else toast.info(t("tools.allUpToDate"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChecking(false);
    }
  };

  const doUpdate = async () => {
    setConfirmOpen(false);
    const ids = [...sel];
    if (!ids.length) return;
    setUpdating(true);
    try {
      const res = await api.toolUpdate(ids);
      const okN = res.filter((r) => r.ok).length;
      if (okN > 0) toast.success(t("tools.updateDone", { ok: okN, total: res.length }));
      // 失败的工具逐条报出原因，不掩盖
      for (const r of res.filter((x) => !x.ok)) {
        toast.error(`${r.name}: ${r.message}`);
      }
      setSel(new Set());
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUpdating(false);
    }
  };

  const tools = state?.tools ?? [];
  const updatable = tools.filter((x) => x.installed && x.hasUpdate);
  const allSelected = updatable.length > 0 && updatable.every((x) => sel.has(x.id));

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部操作条：位置恒常 —— 按钮始终在右侧，切换选中态不移动 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto min-w-0 text-[11px] text-ink-3">
          {state && !state.npmAvailable
            ? t("tools.npmMissing", { note: state.npmNote })
            : t("tools.hint")}
        </span>

        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-[11px]"
          disabled={checking || updating || loading}
          onClick={() => void check()}
        >
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t("tools.check")}
        </Button>

        <Button
          size="sm"
          className="h-8 text-[11px]"
          disabled={updating || sel.size === 0}
          onClick={() => setConfirmOpen(true)}
        >
          {updating ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("tools.update", { n: sel.size })}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-ink-3">
          <Loader2 className="size-3.5 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {tools.map((tool, i) => {
            const selectable = tool.installed && tool.hasUpdate && !updating;
            return (
              <div
                key={tool.id}
                className={cn("flex flex-col gap-1 px-3 py-2.5", i > 0 && "border-t border-border")}
              >
                {/* 第一行：勾选框 · 图标 · 名称/包名 · 版本状态 */}
                <div className="flex items-center gap-2.5">
                  {/* 勾选框：只有「已安装且有更新」才可勾选 */}
                  <button
                    type="button"
                    disabled={!selectable}
                    onClick={() => toggle(tool.id)}
                    aria-label={tool.name}
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                      !selectable
                        ? "cursor-default border-border/60"
                        : sel.has(tool.id)
                          ? "border-primary bg-primary text-white"
                          : "border-border-strong hover:border-primary",
                    )}
                  >
                    {sel.has(tool.id) ? <Check className="size-3" strokeWidth={3} /> : null}
                  </button>

                  <HarnessIcon id={tool.id} className="size-4 shrink-0" />

                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">{tool.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-3">{tool.pkg}</span>
                    </div>
                    {tool.broken ? (
                      <span className="flex items-start gap-1 text-[11px] text-warning">
                        <TriangleAlert className="mt-px size-3 shrink-0" />
                        <span className="min-w-0 break-all">{t("tools.broken", { note: tool.runnableNote })}</span>
                      </span>
                    ) : null}
                  </div>

                  {/* 版本状态：位置固定，宽度足够避免「已更新」时行高跳动 */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!tool.installed ? (
                      <span className="text-[11px] text-ink-3">{t("tools.notInstalled")}</span>
                    ) : (
                      <>
                        <span
                          className={cn(
                            "font-mono text-[11px]",
                            tool.hasUpdate ? "text-ink-3" : "text-ink-2",
                          )}
                        >
                          {versionText(tool)}
                        </span>
                        {tool.hasUpdate ? (
                          <>
                            <span className="text-[11px] text-ink-3">→</span>
                            <span className="font-mono text-[11px] font-medium text-primary">{tool.latest}</span>
                          </>
                        ) : tool.latest ? (
                          <span className="flex items-center gap-0.5 text-[11px] text-success">
                            <Check className="size-3" strokeWidth={3} />
                            {t("tools.upToDate")}
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-3">{t("tools.unchecked")}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* 第二行：安装命令（未安装）——缩进对齐到名称，提供复制粘贴 */}
                {!tool.installed ? (
                  <InstallCommand pkg={tool.pkg} />
                ) : null}
              </div>
            );
          })}

          {!tools.length ? (
            <div className="flex items-center gap-2 px-3 py-6 text-xs text-ink-3">
              <Terminal className="size-3.5" />
              {t("tools.empty")}
            </div>
          ) : null}
        </div>
      )}

      {/* 全选（仅在本次检查出可更新项后出现，避免空占位） */}
      {updatable.length > 0 ? (
        <button
          type="button"
          className="w-fit text-[11px] text-ink-3 underline-offset-2 hover:text-foreground hover:underline"
          onClick={() =>
            setSel(allSelected ? new Set() : new Set(updatable.map((x) => x.id)))
          }
        >
          {allSelected ? t("tools.unselectAll") : t("tools.selectAll", { n: updatable.length })}
        </button>
      ) : null}

      {/* 更新确认：必须列出将执行的确切命令 */}
      {confirmOpen ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]"
          role="presentation"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-lg"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="size-4 text-warning" />
              {t("tools.confirmTitle", { n: sel.size })}
            </h3>
            <p className="mb-3 text-[11px] leading-relaxed text-ink-3">{t("tools.confirmBody")}</p>

            <div className="mb-3 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
              {tools
                .filter((x) => sel.has(x.id))
                .map((x) => (
                  <div key={x.id} className="mb-2 last:mb-0">
                    <div className="text-[11px] font-medium text-foreground">
                      {x.name}
                      <span className="ml-2 font-mono text-ink-3">
                        {x.current} → {x.latest}
                      </span>
                    </div>
                    <code className="mt-0.5 block break-all font-mono text-[10px] text-ink-3">
                      npm install -g {x.pkg}@latest
                    </code>
                  </div>
                ))}
            </div>

            <p className="mb-4 text-[11px] text-warning">{t("tools.confirmNote")}</p>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" className="h-8 text-[11px]" onClick={() => setConfirmOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" className="h-8 text-[11px]" onClick={() => void doUpdate()}>
                {t("tools.confirmGo")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
