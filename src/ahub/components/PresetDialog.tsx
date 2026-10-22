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
import { Field, Input, Textarea } from "@/ahub/components/ui/input";

/**
 * 新建 / 重命名预设的对话框（两者共用）。
 * 名称必填；重复名称由后端判重，这里只负责把错误码翻成人话后展示。
 */
export function PresetDialog({
  open,
  onOpenChange,
  title,
  hint,
  initialName = "",
  initialDescription = "",
  /** 返回 reject 的错误串会显示在对话框内，对话框保持打开 */
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 副标题（如「把当前选中的 3 个技能存成一个预设」） */
  hint?: string;
  initialName?: string;
  initialDescription?: string;
  onSubmit: (name: string, description: string) => Promise<void>;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开都回到传入的初值（重命名不同预设时不能残留上一次的内容）
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription);
    setError("");
  }, [open, initialName, initialDescription]);

  const submit = async () => {
    if (!name.trim()) {
      setError(t("preset.nameRequired"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSubmit(name.trim(), description.trim());
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const disabled = saving || !!busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint ?? t("preset.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label={t("preset.name")}>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("preset.namePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !disabled) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </Field>
          <Field label={t("preset.description")}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("preset.descriptionPlaceholder")}
              className="min-h-16"
            />
          </Field>
          {error ? <p className="text-[11px] leading-relaxed text-danger">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={disabled}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={disabled}>
            {disabled ? t("preset.saving") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
