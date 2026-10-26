import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfigVaultSection } from "@/ahub/components/ConfigVaultSection";
import { HarnessToolsSection } from "@/ahub/components/HarnessToolsSection";
import { ToolManagerSection } from "@/ahub/components/ToolManagerSection";
import { PageShell } from "@/ahub/components/PageShell";
import { cn } from "@/ahub/lib/utils";

/** 折起来的一段：只有标题行，点开才渲染内容。页面下部的「维护类」区块用它收起。 */
function Fold({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-1.5 text-left outline-none"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
        <span className="text-[12.5px] font-semibold text-foreground">{title}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

/**
 * Harness 页：**一页到底**，不再切页签。
 *
 * 原来是四个页签（Harness 工具 / 本机技能 / CLI 版本 / 配置备份）：
 * 「本机技能」只是技能页的只读副本（功能重复，已删）；另外三个说的其实是同一批工具的
 * 不同侧面 —— 每张工具卡本来就把 CLI 版本与更新、配置文件、技能目录、备份与迁移收在一起了
 * （CLI 的版本 / 缺失 / 可更新状态和「更新 / 修复 / 安装」按钮都在卡上），
 * 再按页签切开只是让人多切几次。
 *
 * 所以：上半是工具卡（日常看的），下半两段是**维护类**（CLI 批量更新 / 配置版本历史），
 * 默认折叠 —— 需要时才展开，平时不占屏。
 *
 * 工具的**展示顺序**在「设置 → 工具顺序」里拖；默认把常用的几个排前面
 * （opencode / dsh / codex / claude code / codebuddy / pi，见 `harness.rs` 的 `DEFAULT_ORDER`）。
 */
export function ToolManagerPage() {
  const { t } = useTranslation();

  return (
    <PageShell title={t("nav.harness")}>
      <div className="flex w-full flex-col gap-5">
        <HarnessToolsSection />
        <Fold title={t("tools.sectionTitle")}>
          <ToolManagerSection />
        </Fold>
        <Fold title={t("settings.vaultGlobal")}>
          <ConfigVaultSection />
        </Fold>
      </div>
    </PageShell>
  );
}
