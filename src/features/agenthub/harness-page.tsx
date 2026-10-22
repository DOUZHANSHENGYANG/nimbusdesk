import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowDownToLine, Minus, Plus, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { cn } from "@/lib/utils";
import { tbHarnessCollect, tbHarnessPush, tbHarnessRemove, tbHarnessScan, tbMcpList, tbSkillList, type TbHarnessReport, type TbMcpServer, type TbSkillMeta, type TbTransferItem, type TbTransferResult } from "./api";
import { matchQuery } from "./core";
import { ToolboxPage } from "./page";
import { EmptyState } from "./shared/empty-state";
import { FilterBar, SearchBar } from "./shared/search-bar";
import "./toolbox.css";

/**
 * 本机工具页：看这台机器上各 AI 工具现在有什么，并把条目在两个方向搬起来。
 *
 * 收集（别家 → 工具箱）只读对方的；分发（工具箱 → 别家）会写别人家的配置，
 * 因此后端在写入前必备份，这里必须把备份路径显示出来 —— 用户需要知道
 * 「出事了去哪儿找回原来的文件」。
 *
 * 与源侧的关系：源侧这块是「探测对话框（HarnessDialog）+ 工具页签
 * （ToolManagerSection）」，805 行里大半是**整份配置文本编辑器**与**导入前的
 * 冲突对照表**。前者云台明确不做（需要 JSONC 保真解析），后者云台改成
 * 「冲突直接跳过并在结果里列出」（一次 collect 就能看到漏了哪些）。所以这里
 * 保留的是源侧那张**逐工具的卡片**：名字、检测状态、配置路径、技能目录、
 * 警告、两个方向的条目；上方补一条搜索与「只看已检测到的」筛选。
 */
export function HarnessPage() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<TbHarnessReport[]>([]);
  const [servers, setServers] = useState<TbMcpServer[]>([]);
  const [skills, setSkills] = useState<TbSkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<Record<string, TbTransferResult>>({});
  const [query, setQuery] = useState("");
  const [detectedOnly, setDetectedOnly] = useState(false);

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

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      reports
        .filter((report) => !detectedOnly || report.exists)
        .filter((report) => matchQuery(query, [report.name, report.id, report.configPath, ...report.skillsDirs]))
        .sort((a, b) => Number(b.exists) - Number(a.exists)),
    [reports, query, detectedOnly],
  );

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

  return (
    <ToolboxPage
      section="harness"
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("toolbox.harness.searchPlaceholder")} className="w-56" />
          <Button
            size="sm"
            variant={detectedOnly ? "primary" : "secondary"}
            className="h-8"
            onClick={() => setDetectedOnly((value) => !value)}
          >
            {t("toolbox.harness.detectedOnly")}
          </Button>
          <Button size="sm" variant="secondary" className="h-8" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            {t("toolbox.harness.rescan")}
          </Button>
        </>
      }
    >
      <FilterBar>
        <span className="toolbox-hint">{t("toolbox.harness.hint")}</span>
      </FilterBar>

      {failure ? <div className="toolbox-error">{failure}</div> : null}

      {loading && reports.length === 0 ? (
        <div className="toolbox-empty">{t("toolbox.loading")}</div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Terminal} title={t("toolbox.noMatch")} />
      ) : (
        <div className="toolbox-tools pb-2">
          {visible.map((report) => {
            const key = report.id;
            const mcpIn = new Set(report.mcpServers.map((server) => server.name));
            const skillsIn = new Set(report.skills.map((skill) => skill.name));
            const result = results[key];
            const detectedMcp = report.mcpServers.filter((server) => !servers.some((own) => own.name === server.name));
            const detectedSkills = report.skills.filter((skill) => !skills.some((own) => own.dirName === skill.name));
            return (
              <section className={cn("toolbox-tool-card", !report.exists && "opacity-60")} key={key}>
                <div className="toolbox-tool-head">
                  <Terminal />
                  <strong>{report.name}</strong>
                  <span>{report.exists ? t("toolbox.harness.detected") : t("toolbox.harness.missing")}</span>
                </div>
                {report.configPath ? <div className="toolbox-tool-path">{report.configPath}</div> : null}
                {report.skillsDirs.length > 0 ? <div className="toolbox-tool-path">{report.skillsDirs.join(" · ")}</div> : null}

                {report.notes.length > 0 ? (
                  <div className="toolbox-notes">
                    {report.notes.map((entry, index) => (
                      <span key={`${entry.code}-${index}`}>
                        {t(`toolbox.note.${entry.code}`)}
                        {entry.path ? ` — ${entry.path}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/* 收集：从它这里拿。已经有的标「已有」，一键全部收集跳过这些。 */}
                {report.mcpServers.length > 0 || report.skills.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {report.mcpServers.length > 0 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={busy !== "" || detectedMcp.length === 0}
                        onClick={() => void run(key, () => tbHarnessCollect(report.id, "mcp", detectedMcp.map((server) => server.name)))}
                      >
                        <ArrowDownToLine className="size-3.5" />
                        {t("toolbox.harness.collectAllMcp", { n: detectedMcp.length })}
                      </Button>
                    ) : null}
                    {report.skills.length > 0 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={busy !== "" || detectedSkills.length === 0}
                        onClick={() => void run(key, () => tbHarnessCollect(report.id, "skills", detectedSkills.map((skill) => skill.name)))}
                      >
                        <Sparkles className="size-3.5" />
                        {t("toolbox.harness.collectAllSkills", { n: detectedSkills.length })}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {report.mcpServers.length > 0 ? (
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
                          {mcpIn.has(server.name) && servers.some((own) => own.name === server.name) ? <em>{t("toolbox.harness.have")}</em> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {report.skills.length > 0 ? (
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
                          {skills.some((own) => own.dirName === skill.name) ? <em>{t("toolbox.harness.have")}</em> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {report.supportsMcp && report.exists && servers.length > 0 ? (
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
                ) : null}

                {report.supportsSkills && report.exists && skills.length > 0 ? (
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
                ) : null}

                {result ? (
                  <div className="toolbox-notice">
                    <div className="toolbox-notice-head">
                      {t("toolbox.distribute.applied", { count: result.applied.length, names: result.applied.join(", ") || "—" })}
                    </div>
                    {[...result.skipped, ...result.errors].map((entry, index) => (
                      <div key={`${entry.code}-${entry.name}-${index}`}>{reason(entry)}</div>
                    ))}
                    {result.backups.length > 0 ? (
                      <div className="toolbox-notice-backup">
                        <ShieldCheck className="size-3.5" />
                        {t("toolbox.distribute.backup", { path: result.backups[0] })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </ToolboxPage>
  );
}
