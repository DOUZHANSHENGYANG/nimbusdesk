import { useState } from "react";
import { FolderOpen, Keyboard, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { openPath, pickFolder } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { bindVault, openCaptureWindow } from "./api";
import { useKnowledge } from "./store";
import { flushAllStorage } from "@/lib/storage";

import { normalizeOrganizationPreferences } from './auto-organize';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

export function KnowledgeSettings() {
  const en = useSettings((s) => s.lang) === "en";
  const { vaultRoot, vaultName, setVault } = useKnowledge();
  const [rootDraft, setRootDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async (root = rootDraft ?? vaultRoot ?? "") => {
    if (!root.trim()) return;
    setBusy(true);
    try {
      const vault = await bindVault(root.trim());
      setVault(vault.root, vault.name);
      setRootDraft(null);
      toast.success(en ? "Vault connected" : "知识库已绑定");
    } catch (e) { toast.error(String(e)); }
    finally { setBusy(false); }
  };
  const choose = async () => {
    try {
      const root = await pickFolder();
      if (root) { setRootDraft(root); await connect(root); }
    } catch (e) { toast.error(String(e)); }
  };
  return <>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]"><BookOpen className="size-4" />{en ? "Obsidian vault" : "Obsidian 知识库"}</CardTitle>
        <CardDescription>{en ? "Use your existing Markdown files. Connecting never moves or changes your notes." : "直接使用已有 Markdown 文件。绑定或换绑不会移动、复制或修改原有笔记。"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-2 text-sm"><span>{en ? "Vault folder" : "知识库文件夹"}</span>
          <Input value={rootDraft ?? vaultRoot ?? ""} onChange={(e) => setRootDraft(e.target.value)} placeholder={en ? "Folder containing .obsidian" : "选择包含 .obsidian 的知识库文件夹"} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void choose()} disabled={busy}><FolderOpen className="size-4" />{en ? "Choose folder" : "选择文件夹"}</Button>
          <Button size="sm" onClick={() => void connect()} disabled={busy || !(rootDraft ?? vaultRoot)?.trim()}>{en ? "Connect" : "绑定知识库"}</Button>
        </div>
        {vaultRoot && <p className="break-all text-xs text-muted-foreground">{en ? "Connected" : "已绑定"}：{vaultName} · {vaultRoot}</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">{en ? "App backups do not include vault notes or images. Commit or back up vault changes through your existing vault workflow." : "工作台备份不包含知识库正文与图片。知识库文件继续按你现有的 Git 和备份流程管理。"}</p>
      </CardContent>
    </Card>
    {vaultRoot && <VaultLayoutSettings key={vaultRoot} root={vaultRoot} en={en} />}
    <OrganizationPreferenceSettings en={en}/>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]"><Keyboard className="size-4" />{en ? "Quick capture" : "快捷收集"}</CardTitle>
        <CardDescription>{en ? "Show a pinned panel from any application. Clipboard access only happens when you paste." : "在任意应用中呼出置顶面板。只有主动粘贴时才读取剪贴板。"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => void openCaptureWindow().catch((e) => toast.error(String(e)))}>{en ? "Open panel" : "打开面板"}</Button></div>
      </CardContent>
    </Card>
  </>;
}

function OrganizationPreferenceSettings({en}:{en:boolean}) {
  const saved=useKnowledge(s=>s.organization);
  const [draft,setDraft]=useState(()=>normalizeOrganizationPreferences(saved));
  const [busy,setBusy]=useState(false);
  async function save(){
    if(draft.schedule.enabled&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.schedule.time)){
      toast.error(en?'Choose a valid daily organization time':'请选择有效的每天整理时间');
      return;
    }
    setBusy(true);
    try{useKnowledge.getState().setOrganization(draft);await flushAllStorage();toast.success(en?'Organization preferences saved':'整理偏好已保存');}
    catch(error){toast.error(String(error));}finally{setBusy(false);}
  }
  return <Card><CardHeader><CardTitle className="text-[15px]">{en?'AI automatic organization':'AI 自动整理'}</CardTitle><CardDescription>{en?'Reads the inbox, drafts, tags and classifies. The result waits in the inbox for your review.':'读取收件箱里的材料，生成正文、打标签、定类型；结果留在 Inbox 等你审。'}</CardDescription></CardHeader><CardContent className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="workbench-field"><span>{en?'Scope':'整理范围'}</span><select aria-label={en?'Organization scope':'整理范围'} value={draft.scope} disabled={busy} onChange={e=>setDraft({...draft,scope:e.target.value as typeof draft.scope})}><option value="inbox">{en?'Inbox only':'仅两个区的 Inbox'}</option></select></label>
      <label className="workbench-field"><span>{en?'Structure':'写作模板'}</span><select aria-label={en?'Automatic organization template':'自动整理模板'} value={draft.template} disabled={busy} onChange={e=>setDraft({...draft,template:e.target.value as typeof draft.template})}>{[['auto','自动判断类别与结构','Automatic'],['experience','开发经验','Experience'],['recipe','开发配方','Recipe'],['resource','资源收藏','Resource']].map(([value,zh,label])=><option key={value} value={value}>{en?label:zh}</option>)}</select></label>
    </div>
    <label className="workbench-field"><span>{en?'Writing preferences':'整理偏好'}</span><Textarea aria-label={en?'Organization instructions':'整理偏好'} value={draft.instructions} maxLength={8000} disabled={busy} onChange={e=>setDraft({...draft,instructions:e.target.value})} className="min-h-24 text-sm" placeholder={en?'For example: keep code complete, explain the cause first and use concise Chinese.':'例如：保留完整代码，优先说明问题原因，使用简洁中文，标签以技术和场景为主。'}/></label>
    <label className="flex items-start gap-3 text-sm leading-6"><Checkbox className="mt-1" checked={draft.sendImages} disabled={busy} onCheckedChange={value=>setDraft({...draft,sendImages:value===true})}/><span>{en?'Allow sending capture images to the default vision model':'允许将收集图片发送给默认图片模型'}<small className="block text-xs leading-5 text-muted-foreground">{en?'Off by default. Image names and links are always kept.':'默认关闭，仅传图片名称与引用；开启后会上传实际图片。'}</small></span></label>
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="flex items-center justify-between gap-6">
        <label htmlFor="organization-schedule-enabled" className="cursor-pointer text-sm font-medium">{en?'Organize daily':'每天定时整理'}</label>
        <Switch id="organization-schedule-enabled" aria-label={en?'Enable daily organization':'启用每天定时整理'} checked={draft.schedule.enabled} disabled={busy} onCheckedChange={enabled=>setDraft({...draft,schedule:{...draft.schedule,enabled}})}/>
      </div>
      <div className="flex items-center justify-between gap-6">
        <label htmlFor="organization-schedule-time" className="text-[13px] text-muted-foreground">{en?'Local time':'每天整理时间（本地时间）'}</label>
        <Input id="organization-schedule-time" type="time" required aria-label={en?'Daily organization time':'每天整理时间'} value={draft.schedule.time} disabled={busy||!draft.schedule.enabled} onChange={e=>setDraft({...draft,schedule:{...draft.schedule,time:e.target.value}})} className="h-9 w-32 shrink-0 text-sm"/>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{en?'Runs while the app is open or in the tray. If today’s time is missed, it catches up once after returning from sleep or reopening the app. Nothing runs after fully quitting. Saving enables the schedule; a missed time today may run immediately.':'应用运行或驻留托盘时，到点自动整理；休眠或错过当天时间，恢复后补跑一次。完全退出应用时不执行。保存后生效；若已过今天设定时间，可能立即补跑。'}</p>
    </div>
    <p className="text-xs leading-6 text-muted-foreground">{en?'Unchanged organized notes are skipped. Each note is handled separately; source recovery copies stay outside the list. Other Obsidian folders are excluded.':'跳过已整理且未修改的文章。逐篇处理，不自动合并无关材料；原文恢复副本不出现在列表中。其他 Obsidian 文件夹不参与整理。'}</p>
    <div className="flex justify-end"><Button size="sm" disabled={busy} onClick={()=>void save()}>{en?'Save preferences':'保存整理偏好'}</Button></div>
  </CardContent></Card>;
}

function VaultLayoutSettings({ root, en }: { root: string; en: boolean }) {
  const open = (relative: string) => void openPath(`${root.replace(/[\\/]$/, "")}/${relative}`).catch((error) => toast.error(String(error)));
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-[15px]"><FolderOpen className="size-4" />{en ? "Vault config" : "库配置"}</CardTitle>
      <CardDescription>{en ? "Read from the vault's own config file; the app probes it automatically." : "配置来自库内配置文件，工作台自动探查，不在应用里另存一份。"}</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => open("99-系统/config.yaml")}>{en ? "Open config.yaml" : "打开 config.yaml"}</Button>
        <Button variant="secondary" size="sm" onClick={() => open("99-系统/模板")}>{en ? "Open templates" : "打开模板目录"}</Button>
      </div>
    </CardContent>
  </Card>;
}