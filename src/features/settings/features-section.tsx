import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/motion/switch";
import { NAV_GROUPS, sectionsOf } from "@/components/shell/navigation";
import { useSettings } from "@/stores/settings";

/**
 * 功能开关。
 *
 * 一份状态（`settings.navDisabled`）同时决定**主侧栏**和**设置导航**里那一项是否出现：
 * 关掉「资讯」，侧栏里的资讯项消失、设置里对应的分节也一起隐藏。
 * 一级分组本身不可关闭（关掉整组＝逐个关掉它的子项），但一组里全关掉时整组连标题一起消失。
 *
 * 拖拽排序与换图标是下一段，这里只做「显隐」。
 */
export function FeaturesSection() {
  const { t } = useTranslation();
  const navDisabled = useSettings((s) => s.navDisabled);
  const setNavEnabled = useSettings((s) => s.setNavEnabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.features.title")}</CardTitle>
        <CardDescription>{t("settings.features.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.key} className="space-y-1">
            <div className="flex items-center gap-2 px-1 pb-1 text-[12px] font-medium text-muted-foreground">
              <group.icon className="size-4 shrink-0 opacity-70" aria-hidden strokeWidth={1.7} />
              <span>{t(group.key)}</span>
            </div>
            {sectionsOf(group).map((section) => (
              <div key={section.key} className="space-y-1">
                {group.sections.length > 1 && (
                  <p className="px-1 pt-1 text-[11px] text-muted-foreground/60">{t(section.key)}</p>
                )}
                <ul className="space-y-0.5">
                  {section.items.map((entry) => {
                    const on = !navDisabled.includes(entry.to);
                    return (
                      <li
                        key={entry.to}
                        className="flex h-10 items-center gap-3 rounded-[var(--pr-radius-md)] px-2 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]"
                      >
                        <entry.icon className="size-4 shrink-0 opacity-70" aria-hidden strokeWidth={1.7} />
                        <span className="min-w-0 flex-1 truncate text-[13.5px]">{t(entry.key)}</span>
                        <Switch checked={on} onCheckedChange={(next) => setNavEnabled(entry.to, next)} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
