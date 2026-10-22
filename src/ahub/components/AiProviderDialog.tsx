import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { Field, Input } from "@/ahub/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ahub/components/ui/select";
import { api } from "@/ahub/lib/api";
import { testResultText } from "@/ahub/lib/aiProviderTest";
import type { AiProvider, AiProviderDraft, AiProviderPreset, AiProviderTestResult } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/**
 * 添加 / 编辑 AI 提供商的对话框。
 * 选厂商预设会自动填协议、Base URL 与起始模型，之后都可手改；
 * 编辑模式下 API key 留空表示不改动已保存的凭据。
 */
export function AiProviderDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入则为编辑模式 */
  provider?: AiProvider | null;
  onSaved: (p: AiProvider) => void;
}) {
  const { t } = useTranslation();
  const editing = !!provider;
  const [presets, setPresets] = useState<AiProviderPreset[]>([]);
  const [presetId, setPresetId] = useState("custom");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    void api.aiProviderPresets().then(setPresets).catch(() => setPresets([]));
  }, [open]);

  // 每次打开都回到传入的初值（切换编辑对象时不能残留上一次的内容）
  useEffect(() => {
    if (!open) return;
    setError("");
    setTestResult(null);
    setApiKey("");
    if (provider) {
      setPresetId("custom");
      setName(provider.name);
      setKind(provider.kind);
      setBaseUrl(provider.baseUrl);
      setModel(provider.model);
    } else {
      const custom = presets.find((p) => p.id === "custom");
      setPresetId("custom");
      setName("");
      setKind(custom?.kind ?? "openai");
      setBaseUrl("");
      setModel("");
    }
    // presets 到位后不重置表单：用户可能已经开始填了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider]);

  /** 选中预设 → 自动填充协议 / Base URL / 起始模型（之后都可覆盖） */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
    setModel(p.defaultModel);
    setTestResult(null);
    if (!name.trim()) {
      // 名称留空时给个建议值，用户可改
      setName(t(`aiProvider.preset_${p.id}`));
    }
  };

  const draft = (): AiProviderDraft => ({ kind, baseUrl, model, apiKey });

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 编辑模式用已保存的 id + 表单草稿；新增模式传空 id（后端只看草稿）
      const r = await api.aiProviderTest(provider?.id ?? "", draft());
      setTestResult(r);
    } catch (e) {
      setTestResult({
        ok: false,
        message: String(e),
        elapsedMs: 0,
        model: "",
        status: 0,
        reason: "network",
      });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setError("");
    if (!model.trim()) {
      setError(t("aiProvider.modelRequired"));
      return;
    }
    setBusy(true);
    try {
      const saved = editing
        ? await api.aiProviderUpdate(provider!.id, {
            name: name.trim() || provider!.name,
            kind,
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            apiKey: apiKey.trim() || undefined,
          })
        : await api.aiProviderCreate(
            name.trim() || t(`aiProvider.preset_${presetId}`),
            kind,
            baseUrl.trim(),
            model.trim(),
            apiKey.trim(),
          );
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("aiProvider.edit") : t("aiProvider.add")}</DialogTitle>
          <DialogDescription>{t("aiProvider.desc")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {!editing ? (
            <Field label={t("aiProvider.preset")}>
              <Select value={presetId} onValueChange={applyPreset}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t("aiProvider.presetPh")} />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {t(`aiProvider.preset_${p.id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          <Field label={t("aiProvider.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("aiProvider.namePh")} />
          </Field>

          <Field label={t("aiProvider.kind")}>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v);
                setTestResult(null);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">{t("aiProvider.kind_openai")}</SelectItem>
                <SelectItem value="anthropic">{t("aiProvider.kind_anthropic")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("aiProvider.baseUrl")} hint={t("aiProvider.baseUrlHint")}>
            <Input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTestResult(null);
              }}
              placeholder={t("aiProvider.baseUrlPh")}
              className="font-mono text-xs"
              dir="ltr"
            />
          </Field>

          <Field label={t("aiProvider.model")}>
            <Input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setTestResult(null);
              }}
              placeholder={t("aiProvider.modelPh")}
              className="font-mono text-xs"
              dir="ltr"
            />
          </Field>

          <Field
            label={t("aiProvider.apiKey")}
            hint={editing ? t("aiProvider.apiKeyKeepHint") : t("aiProvider.apiKeyNewHint")}
          >
            <Input
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestResult(null);
              }}
              type="password"
              placeholder={editing ? "••••••••" : t("aiProvider.apiKeyPh")}
              className="font-mono text-xs"
              autoComplete="off"
              dir="ltr"
            />
          </Field>

          {testResult ? (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed",
                testResult.ok ? "bg-success/12 text-success" : "bg-danger/12 text-danger",
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 break-words">{testResultText(testResult, t)}</span>
            </div>
          ) : null}

          {error ? <p className="text-[11px] leading-relaxed text-danger">{error}</p> : null}
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={testing || busy}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {testing ? t("aiProvider.testing") : t("aiProvider.test")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={busy || testing}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
