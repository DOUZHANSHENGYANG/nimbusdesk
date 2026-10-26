import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { VersionList } from "@/ahub/components/VersionList";
import type { VersionEntry } from "@/ahub/lib/types";

/**
 * 「查看版本记录」弹框：技能与提示词共用。
 *
 * 版本时间轴占地方、又不是每次都要看（尤其是技能，右栏留给 AI 摘要更值），
 * 所以两页都把它收进弹框，主界面只留一个入口按钮 —— 有意思的是，
 * 两页的「右栏」于是都只剩「这一份自己的东西」：技能是摘要，提示词是变量。
 */
export function VersionHistoryDialog({
  open,
  onOpenChange,
  label,
  versions,
  current,
  onSeed,
  onClear,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 副标题：技能目录名 / 提示词标题 */
  label?: string;
  versions: VersionEntry[];
  current: string;
  onSeed?: () => void;
  onClear?: () => void;
  onRestore: (content: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            {t("common.versionHistory")}
          </DialogTitle>
          {label ? (
            <DialogDescription className="font-mono" dir="ltr">
              {label}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogBody className="min-h-0">
          <div className="h-[58vh]">
            <VersionList
              fill
              versions={versions}
              current={current}
              onSeed={onSeed}
              onClear={onClear}
              onRestore={onRestore}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
