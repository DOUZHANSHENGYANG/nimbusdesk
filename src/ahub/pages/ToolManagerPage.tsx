import { useTranslation } from "react-i18next";
import { ConfigVaultSection } from "@/ahub/components/ConfigVaultSection";
import { HarnessToolsSection } from "@/ahub/components/HarnessToolsSection";
import { ToolManagerSection } from "@/ahub/components/ToolManagerSection";
import { PageShell } from "@/ahub/components/PageShell";

/**
 * Harness 页：**一页到底**，不再切页签。
 *
 * 原来是四个页签（Harness 工具 / 本机技能 / CLI 版本 / 配置备份）：
 * 「本机技能」只是技能页的只读副本（功能重复，已删）；另外三个说的其实是同一批工具的
 * 不同侧面 —— 每张工具卡本来就把配置文件、技能目录、备份与迁移收在一起了，
 * 再按页签切开只是让人多切几次。现在从上到下：工具卡片（含 CLI 版本与更新状态）
 * → CLI 批量更新 → 配置文件的版本历史。
 *
 * 工具的**展示顺序**在「设置 → 工具顺序」里拖；默认把常用的几个排前面
 * （opencode / dsh / codex / claude code / codebuddy / pi，见 `harness.rs` 的 `DEFAULT_ORDER`）。
 */
export function ToolManagerPage() {
  const { t } = useTranslation();

  return (
    <PageShell title={t("nav.harness")}>
      <div className="flex w-full flex-col gap-6">
        <HarnessToolsSection />
        <ToolManagerSection />
        <ConfigVaultSection />
      </div>
    </PageShell>
  );
}
