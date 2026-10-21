import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowDownToLine, Minus, Plus, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { tbHarnessCollect, tbHarnessPush, tbHarnessRemove, tbHarnessScan, tbMcpList, tbSkillList, type TbHarnessReport, type TbMcpServer, type TbSkillMeta, type TbTransferItem, type TbTransferResult } from "./api";
import "./toolbox.css";

/**
 * 本机工具：看这台机器上各 AI 工具现在有什么，并把两个方向搬起来。
 *
 * 收集（别家 → 工具箱）是只读对方的；分发（工具箱 → 别家）会写别人家的配置，
 * 因此后端在写入前必备份，这里必须把备份路径显示出来 —— 用户需要知道
 * 「出事了去哪儿找回原来的文件」。
 */
export function HarnessView() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<TbHarnessReport[]>([]);
  const [servers, setServers] = useState<TbMcpServer[]>([]);
  const [skills, setSkills] = useState<TbSkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<Record<string, TbTransferResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scanned, mcp, own] = await Promise.all([tbHarnessScan(), tbMcpList(), tbSkillList()]);
      setReports(scanned);
      setServers(mcp);
      setSkills(own);
      setFailure("");
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(key: string, action: () => Promise<TbTransferResult>) {
    setBusy(key);
    try {
      const result = await action();
      setResults((current) => ({ ...current, [key]: result }));
      if (result.errors.length > 0) toast.error(t("toolbox.distribute.failed"));
      else if (result.applied.length > 0) toast.success(t("toolbox.distribute.done", { count: result.applied.length }));
      else toast.info(t("toolbox.distribute.nothing"));
      await load();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy("");
    }
  }

  const reason = (entry: TbTransferItem) => {
    const code = t(`toolbox.reason.${entry.code}`);
    return entry.detail ? `${entry.name}: ${code} — ${entry.detail}` : `${entry.name}: ${code}`;
  };

  if (loading && reports.length === 0) return <div className="toolbox-empty">{t("toolbox.loading")}</div>;

  return (
    <div className="toolbox-column" style={{ gap: 12 }}>
      <div className="toolbox-actions">
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
          {t("toolbox.harness.rescan")}
        </Button>
        <span className="toolbox-hint">{t("toolbox.harness.hint")}</span>
      </div>
      {failure && <div className="toolbox-error">{failure}</div>}

      <div className="toolbox-tools">
        {[...reports].sort((a, b) => Number(b.exists) - Number(a.exists)).map((report) => {
          const key = report.id;
          const mcpIn = new Set(report.mcpServers.map((s) => s.name));
          const skillsIn = new Set(report.skills.map((s) => s.name));
          const result = results[key];
          return (
            <section className="toolbox-tool-card" key={key}>
              <div className="toolbox-tool-head">
                <Terminal />
                <strong>{report.name}</strong>
                <span>{report.exists ? t("toolbox.harness.detected") : t("toolbox.harness.missing")}</span>
              </div>
              {report.configPath && <div className="toolbox-tool-path">{report.configPath}</div>}
              {report.skillsDirs.length > 0 && <div className="toolbox-tool-path">{report.skillsDirs.join(" · ")}</div>}

              {report.notes.length > 0 && (
                <div className="toolbox-notes">
                  {report.notes.map((entry, index) => (
                    <span key={`${entry.code}-${index}`}>{t(`toolbox.note.${entry.code}`)}{entry.path ? ` — ${entry.path}` : ""}</span>
                  ))}
                </div>
              )}

              {report.mcpServers.length > 0 && (
                <div>
                  <div className="workbench-eyebrow">{t("toolbox.harness.collectMcp")}</div>
                  <div className="toolbox-detected">
                    {report.mcpServers.map((server) => (
                      <button
                        key={server.name}
                        type="button"
                        disabled={busy !== ""}
                        title={t("toolbox.harness.collectOne", { name: server.name })}
                        onClick={() => void run(key, () => tbHarnessCollect(report.id, "mcp", [server.name]))}
                      >
                        <ArrowDownToLine />
                        {server.name}
                        {servers.some((own) => own.name === server.name) && <em>{t("toolbox.harness.have")}</em>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {report.skills.length > 0 && (
                <div>
                  <div className="workbench-eyebrow">{t("toolbox.harness.collectSkills")}</div>
                  <div className="toolbox-detected">
                    {report.skills.map((skill) => (
                      <button
                        key={skill.path}
                        type="button"
                        disabled={busy !== ""}
                        title={t("toolbox.harness.collectOne", { name: skill.name })}
                        onClick={() => void run(key, () => tbHarnessCollect(report.id, "skills", [skill.name]))}
                      >
                        <ArrowDownToLine />
                        {skill.name}
                        {skills.some((own) => own.dirName === skill.name) && <em>{t("toolbox.harness.have")}</em>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {report.supportsMcp && report.exists && servers.length > 0 && (
                <div>
                  <div className="workbench-eyebrow">{t("toolbox.harness.sendMcp")}</div>
                  <div className="toolbox-detected">
                    {servers.map((server) =>
                      mcpIn.has(server.name) ? (
                        <button
                          key={server.id}
                          type="button"
                          disabled={busy !== ""}
                          title={t("toolbox.harness.removeOne", { name: server.name })}
                          onClick={() => void run(key, () => tbHarnessRemove(report.id, "mcp", [server.name]))}
                        >
                          <Minus />
                          {server.name}
                        </button>
                      ) : (
                        <button
                          key={server.id}
                          type="button"
                          disabled={busy !== ""}
                          title={t("toolbox.harness.sendOne", { name: server.name })}
                          onClick={() => void run(key, () => tbHarnessPush(report.id, "mcp", [server.name]))}
                        >
                          <Plus />
                          {server.name}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}

              {report.supportsSkills && skills.length > 0 && (
                <div>
                  <div className="workbench-eyebrow">{t("toolbox.harness.sendSkills")}</div>
                  <div className="toolbox-detected">
                    {skills.map((skill) =>
                      skillsIn.has(skill.name) ? (
                        <button
                          key={skill.dirName}
                          type="button"
                          disabled={busy !== ""}
                          title={t("toolbox.harness.removeOne", { name: skill.name })}
                          onClick={() => void run(key, () => tbHarnessRemove(report.id, "skills", [skill.dirName]))}
                        >
                          <Minus />
                          {skill.name}
                        </button>
                      ) : (
                        <button
                          key={skill.dirName}
                          type="button"
                          disabled={busy !== ""}
                          title={t("toolbox.harness.sendOne", { name: skill.name })}
                          onClick={() => void run(key, () => tbHarnessPush(report.id, "skills", [skill.dirName]))}
                        >
                          <Plus />
                          {skill.name}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}

              {result && (
                <div className="toolbox-notice">
                  <div className="toolbox-notice-head">
                    {t("toolbox.distribute.applied", { count: result.applied.length, names: result.applied.join(", ") || "—" })}
                  </div>
                  {[...result.skipped, ...result.errors].map((entry, index) => (
                    <div key={`${entry.code}-${entry.name}-${index}`}>{reason(entry)}</div>
                  ))}
                  {result.backups.length > 0 && (
                    <div className="toolbox-notice-backup">
                      <ShieldCheck className="size-3.5" />
                      {t("toolbox.distribute.backup", { path: result.backups[0] })}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
