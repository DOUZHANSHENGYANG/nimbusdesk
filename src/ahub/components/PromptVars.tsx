import { AlertTriangle, Check, ChevronDown, Copy, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { Input, Textarea } from "@/ahub/components/ui/input";
import { api, copyText } from "@/ahub/lib/api";
import type { Prompt, PromptVariable, PromptVarType } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

const TYPES: PromptVarType[] = ["text", "textarea", "select", "number", "boolean"];

/**
 * 变量定义面板：嵌在提示词编辑器里。
 *
 * 正文里的 `{{name}}` 是唯一事实来源 —— 这里展示的是"正文中出现的变量"，
 * 外加"定义了但正文已不引用"的残留项（单独分组，避免误以为还在生效）。
 * 改名/删除会同步改写正文，由后端精确处理（只动占位符，不动同名纯文本）。
 */
export function PromptVarsPanel({
  content,
  variables,
  onChangeContent,
  onChangeVariables,
}: {
  content: string;
  variables: PromptVariable[];
  onChangeContent: (next: string) => void;
  onChangeVariables: (next: PromptVariable[]) => void;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<PromptVariable[]>([]);
  const [unused, setUnused] = useState<PromptVariable[]>([]);
  const [open, setOpen] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.parsePromptVars(content, variables, true);
      setActive(r.active);
      setUnused(r.unused);
    } catch {
      /* 解析失败时保持上一帧，不打断编辑 */
    }
  }, [content, variables]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = (name: string, next: Partial<PromptVariable>) => {
    onChangeVariables(active.map((v) => (v.name === name ? { ...v, ...next } : v)));
  };

  const rename = async (from: string) => {
    const to = window.prompt(t("prompts.varRenamePrompt"), from);
    if (to === null || to.trim() === from) return;
    const err = await api.validatePromptVarName(to.trim(), active, from);
    if (err) {
      toast.error(t(`prompts.varErr_${err}`));
      return;
    }
    const nextContent = await api.renamePromptVar(content, from, to.trim());
    onChangeContent(nextContent);
    onChangeVariables(active.map((v) => (v.name === from ? { ...v, name: to.trim() } : v)));
  };

  const remove = async (name: string) => {
    const nextContent = await api.removePromptVar(content, name);
    onChangeContent(nextContent);
    onChangeVariables(active.filter((v) => v.name !== name));
  };

  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left outline-none"
      >
        <ChevronDown className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {t("prompts.varsTitle")}
        </span>
        <Badge variant="muted" className="ml-1">
          {active.length}
        </Badge>
        {unused.length > 0 ? (
          <Badge variant="warning" title={t("prompts.varsUnusedHint")}>
            {t("prompts.varsUnused", { n: unused.length })}
          </Badge>
        ) : null}
        <span className="ml-auto text-[11px] text-ink-3">{t("prompts.varsSyntax")}</span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {active.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-3">{t("prompts.varsEmpty")}</p>
          ) : (
            active.map((v) => (
              <div key={v.name} className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-subtle p-2">
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                    {"{{"}
                    {v.name}
                    {"}}"}
                  </code>
                  <button
                    type="button"
                    title={t("prompts.varRename")}
                    onClick={() => void rename(v.name)}
                    className="rounded p-1 text-ink-3 outline-none hover:bg-surface-2 hover:text-foreground"
                  >
                    <Wand2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t("prompts.varRemove")}
                    onClick={() => void remove(v.name)}
                    className="rounded p-1 text-ink-3 outline-none hover:bg-surface-2 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={v.type}
                    onChange={(e) => patch(v.name, { type: e.target.value as PromptVarType })}
                    className="h-7 rounded-md border border-border bg-surface px-1.5 text-[11px] outline-none"
                  >
                    {TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {t(`prompts.varType_${ty}`)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={v.defaultValue}
                    onChange={(e) => patch(v.name, { defaultValue: e.target.value })}
                    placeholder={t("prompts.varDefault")}
                    className="h-7 min-w-28 flex-1 text-[11px]"
                  />
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2">
                    <input
                      type="checkbox"
                      checked={v.required}
                      onChange={(e) => patch(v.name, { required: e.target.checked })}
                      className="accent-[var(--ah-primary)]"
                    />
                    {t("prompts.varRequired")}
                  </label>
                </div>
                {v.type === "select" ? (
                  <Input
                    value={v.options.join(", ")}
                    onChange={(e) =>
                      patch(v.name, {
                        options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    placeholder={t("prompts.varOptions")}
                    className="h-7 text-[11px]"
                  />
                ) : null}
              </div>
            ))
          )}

          {unused.length > 0 ? (
            <div className="rounded-lg border border-dashed border-warning/40 bg-warning/5 p-2">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-warning">
                <AlertTriangle className="size-3" />
                {t("prompts.varsUnusedTitle", { n: unused.length })}
              </div>
              <p className="mb-1.5 text-[10px] leading-relaxed text-ink-3">{t("prompts.varsUnusedHint")}</p>
              <div className="flex flex-wrap gap-1">
                {unused.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => onChangeVariables(active)}
                    title={t("prompts.varDropUnused")}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-ink-3 hover:border-danger/40 hover:text-danger"
                  >
                    {v.name} ✕
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 填充弹框：按变量定义生成表单 → 渲染 → 复制。
 *
 * 必填未填时禁用「复制」，但**不阻断预览** —— 用户能看到缺哪几项，
 * 而不是面对一个只会说"请填写"的空壳。
 */
export function PromptFillDialog({
  prompt,
  open,
  onOpenChange,
}: {
  prompt: Prompt | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [vars, setVars] = useState<PromptVariable[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rendered, setRendered] = useState("");
  const [missing, setMissing] = useState<string[]>([]);

  const defined = prompt?.variables ?? [];

  useEffect(() => {
    if (!open || !prompt) return;
    let alive = true;
    void (async () => {
      const r = await api.parsePromptVars(prompt.content, defined, false);
      if (!alive) return;
      setVars(r.active);
      const init: Record<string, string> = {};
      for (const v of r.active) init[v.name] = v.defaultValue ?? "";
      setValues(init);
    })();
    return () => {
      alive = false;
    };
  }, [open, prompt, defined]);

  useEffect(() => {
    if (!open || !prompt) return;
    let alive = true;
    void (async () => {
      const r = await api.renderPromptVars(prompt.content, defined, values);
      if (!alive) return;
      setRendered(r.content);
      setMissing(r.missing);
    })();
    return () => {
      alive = false;
    };
  }, [open, prompt, defined, values]);

  const canCopy = useMemo(() => missing.length === 0 && rendered.trim().length > 0, [missing, rendered]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t("prompts.fillTitle", { title: prompt?.title ?? "" })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
          {vars.length === 0 ? (
            <p className="text-xs text-ink-3">{t("prompts.fillNoVars")}</p>
          ) : (
            <div className="flex shrink-0 flex-col gap-2.5">
              {vars.map((v) => {
                const bad = missing.includes(v.name);
                return (
                  <div key={v.name} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[12px] text-foreground">
                        {"{{"}
                        {v.name}
                        {"}}"}
                      </code>
                      {v.required ? <span className="text-[10px] text-danger">*</span> : null}
                      {bad ? (
                        <span className="text-[10px] text-danger">{t("prompts.fillMissing")}</span>
                      ) : null}
                    </div>
                    {v.type === "textarea" ? (
                      <Textarea
                        value={values[v.name] ?? ""}
                        onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.value }))}
                        placeholder={v.placeholder || v.description}
                        className={cn("min-h-16 text-[12px]", bad && "border-danger/60")}
                      />
                    ) : v.type === "select" ? (
                      <select
                        value={values[v.name] ?? ""}
                        onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.value }))}
                        className={cn(
                          "h-[34px] rounded-md border border-input bg-surface px-2 text-[12px] outline-none",
                          bad && "border-danger/60",
                        )}
                      >
                        <option value="">{t("prompts.fillChoose")}</option>
                        {v.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : v.type === "boolean" ? (
                      <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                        <input
                          type="checkbox"
                          checked={values[v.name] === "true"}
                          onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.checked ? "true" : "" }))}
                          className="accent-[var(--ah-primary)]"
                        />
                        {v.description || t("prompts.fillYes")}
                      </label>
                    ) : (
                      <Input
                        type={v.type === "number" ? "number" : "text"}
                        value={values[v.name] ?? ""}
                        onChange={(e) => setValues((p) => ({ ...p, [v.name]: e.target.value }))}
                        placeholder={v.placeholder || v.description}
                        className={cn("h-[34px] text-[12px]", bad && "border-danger/60")}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
              {t("prompts.fillPreview")}
              {missing.length > 0 ? (
                <span className="text-danger">{t("prompts.fillStillMissing", { n: missing.length })}</span>
              ) : (
                <span className="flex items-center gap-0.5 text-success">
                  <Check className="size-3" strokeWidth={3} />
                  {t("prompts.fillReady")}
                </span>
              )}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-subtle p-3 font-mono text-[12px] leading-relaxed text-foreground">
              {rendered}
            </pre>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button
            disabled={!canCopy}
            onClick={() =>
              void copyText(rendered).then((ok) => ok && toast.success(t("common.copied")))
            }
          >
            <Copy />
            {t("prompts.fillCopy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
