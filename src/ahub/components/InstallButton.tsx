import { listen } from "@tauri-apps/api/event";
import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";

/**
 * 未安装工具的官方 zip 直链（版本固定）。
 * shortcut: URL 写死具体版本，过时需手动更新此表；需要新工具时在这里加一行。
 * dir = 解压后放在环境根目录下的目录名。
 */
export const INSTALL_SOURCES: Record<string, { url: string; dir: string }> = {
  mvn: { url: "https://dlcdn.apache.org/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip", dir: "maven" },
  gradle: { url: "https://services.gradle.org/distributions/gradle-8.10.2-bin.zip", dir: "gradle" },
  go: { url: "https://go.dev/dl/go1.23.4.windows-amd64.zip", dir: "go" },
  node: { url: "https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip", dir: "nodejs" },
  rg: { url: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip", dir: "ripgrep" },
  terraform: { url: "https://releases.hashicorp.com/terraform/1.10.3/terraform_1.10.3_windows_amd64.zip", dir: "terraform" },
};

type Stage = "download" | "extract" | "path" | "done";

/** 未安装工具的「安装」按钮：下载 → 解压 → PATH 全程显示进度，完成后 toast。 */
export function InstallButton({ toolId, onInstalled }: { toolId: string; onInstalled?: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>("download");
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void listen<{ tool: string; stage: Stage; percent: number }>("install-progress", (e) => {
      if (e.payload.tool !== toolId) return;
      setStage(e.payload.stage);
      setPercent(e.payload.percent);
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [toolId]);

  if (!INSTALL_SOURCES[toolId]) return null;

  const run = async () => {
    // 未设置环境根目录时先引导设置，绝不发起下载
    const root = await api.getEnvRoot().catch(() => "");
    if (!root) {
      toast.error(t("envSetup.needRoot"));
      return;
    }
    const src = INSTALL_SOURCES[toolId];
    setBusy(true);
    setStage("download");
    setPercent(0);
    try {
      const r = await api.installTool(toolId, src.url, src.dir);
      toast.success(t("envSetup.installDone", { tool: r.tool }));
      onInstalled?.();
    } catch (e) {
      toast.error(`${t("envSetup.installFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const label = !busy
    ? t("envSetup.install")
    : stage === "download"
      ? `${t("envSetup.stageDownload")} ${percent}%`
      : stage === "extract"
        ? t("envSetup.stageExtract")
        : t("envSetup.stagePath");

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void run();
      }}
      className="h-6 shrink-0 gap-1 rounded-md px-2 text-[10px]"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
      <span className="whitespace-nowrap tabular-nums">{label}</span>
    </Button>
  );
}
