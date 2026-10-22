import { Package, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CollapsibleCard } from "@/ahub/components/CollapsibleCard";
import { ConfigVaultSection } from "@/ahub/components/ConfigVaultSection";
import { ToolManagerSection } from "@/ahub/components/ToolManagerSection";
import { PageShell } from "@/ahub/components/PageShell";

/**
 * AI 工具管理：同一个对象（AI 工具）的两件事。
 * - 上方「工具与版本」：CLI 工具的版本检查与更新
 * - 下方「配置保险」：各工具配置文件的版本备份与恢复
 */
export function ToolManagerPage() {
  const { t } = useTranslation();
  return (
    <PageShell title={t("nav.vault")}>
      <div className="flex w-full flex-col gap-4">
        <CollapsibleCard icon={Package} title={t("tools.sectionTitle")}>
          <ToolManagerSection />
        </CollapsibleCard>

        <CollapsibleCard icon={ShieldCheck} title={t("settings.vault")}>
          <ConfigVaultSection />
        </CollapsibleCard>
      </div>
    </PageShell>
  );
}
