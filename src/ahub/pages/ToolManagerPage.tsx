import { useTranslation } from "react-i18next";
import { HarnessToolsSection } from "@/ahub/components/HarnessToolsSection";
import { PageShell } from "@/ahub/components/PageShell";

/**
 * Harness 页：**只有工具卡**，一个工具一张卡，一张卡就是它的全部。
 *
 * 卡上：CLI 版本 / 缺失 / 可更新 + 「更新 · 修复 · 安装」、配置文件（编辑 · 快照）、
 * 技能目录、配置版本（监视 · 版本列表 · 恢复 · 清空）、打开与复制路径、单卡刷新、迁移入口。
 *
 * 原来这里还有两段（CLI 批量表 / 配置版本库），但它们的内容都已经落到卡上：
 * 批量更新收进页头那颗按钮、每日自动快照与「全部快照」搬去设置页
 * （`SettingsView`，和「工具顺序」放一起）—— 那两件事天生跨工具，不属于任何一张卡。
 *
 * 工具的**展示顺序**在「设置 → 工具顺序」里拖；默认把常用的几个排前面
 * （opencode / dsh / codex / claude code / codebuddy / pi，见 `harness.rs` 的 `DEFAULT_ORDER`）。
 */
export function ToolManagerPage() {
  const { t } = useTranslation();

  return (
    <PageShell title={t("nav.harness")}>
      <HarnessToolsSection />
    </PageShell>
  );
}
