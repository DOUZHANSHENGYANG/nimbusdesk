import { Package, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfigVaultSection } from "@/ahub/components/ConfigVaultSection";
import { HarnessSkillsSection } from "@/ahub/components/HarnessSkillsSection";
import { HarnessToolsSection } from "@/ahub/components/HarnessToolsSection";
import { ToolManagerSection } from "@/ahub/components/ToolManagerSection";
import { PageShell } from "@/ahub/components/PageShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ahub/components/motion/tabs";

/**
 * Harness 页：四个页签，按「日常最常用 → 偶尔维护」排序。
 *
 * - Harness 工具：每个工具的配置、技能目录、迁移与单卡刷新
 * - 本机技能：各工具目录里实际有什么
 * - CLI 版本：批量检查/更新 npm 全局 CLI
 * - 配置备份：配置文件版本历史
 *
 * 原来的「跨类型总览」已去掉：每张 Harness 卡已经给出同样的信息，
 * 再放一张表只是重复。
 */
export function ToolManagerPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("tools");

  return (
    <PageShell title={t("nav.harness")}>
      <Tabs value={tab} onValueChange={setTab} variant="segment" className="flex w-full flex-col gap-4">
        <TabsList className="w-fit">
          <TabsTrigger value="tools">
            <Terminal className="mr-1.5 size-3.5" />
            {t("harnessTools.title")}
          </TabsTrigger>
          <TabsTrigger value="skills">
            <Sparkles className="mr-1.5 size-3.5" />
            {t("harnessSkills.title")}
          </TabsTrigger>
          <TabsTrigger value="cli">
            <Package className="mr-1.5 size-3.5" />
            {t("tools.sectionTitle")}
          </TabsTrigger>
          <TabsTrigger value="vault">
            <ShieldCheck className="mr-1.5 size-3.5" />
            {t("settings.vault")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tools">
          <HarnessToolsSection />
        </TabsContent>
        <TabsContent value="skills">
          <HarnessSkillsSection />
        </TabsContent>
        <TabsContent value="cli">
          <ToolManagerSection />
        </TabsContent>
        <TabsContent value="vault">
          <ConfigVaultSection />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
