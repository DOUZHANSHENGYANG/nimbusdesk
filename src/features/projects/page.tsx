import { FolderKanban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/shell/empty-state";

export function ProjectsPage() {
  const { t } = useTranslation();

  return <EmptyState icon={<FolderKanban />} title={t("projects.empty")} />;
}
