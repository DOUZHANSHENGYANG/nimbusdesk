import { useState } from "react";
import { FolderOpen, Keyboard, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pickFolder } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { bindVault, openCaptureWindow, setCaptureShortcut, validateKnowledgeFolders } from "./api";
import { getKnowledgeFolders, useKnowledge } from "./store";
import { flushAllStorage } from "@/lib/storage";
import { DEFAULT_KNOWLEDGE_FOLDERS, KNOWLEDGE_FOLDER_KEYS, folderWithinVault, foldersForVault, normalizeFolders, type KnowledgeFolders } from "./folders";
import { ShortcutRecorder } from "./shortcut-recorder";
import { normalizeOrganizationPreferences } from './auto-organize';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

export function KnowledgeSettings() {
  const en = useSettings((s) => s.lang) === "en";
  const { vaultRoot, vaultName, shortcut, setVault, setShortcut } = useKnowledge();
  const [rootDraft, setRootDraft] = useState<string | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
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
  const saveShortcut = async () => {
    const next = (shortcutDraft ?? shortcut).trim();
    setBusy(true);
    setShortcutError("");
    try {
      await setCaptureShortcut(next);
      setShortcut(next);
      await flushAllStorage();
      setShortcutDraft(null);
      toast.success(en ? "Shortcut registered" : "快捷键已注册");
    } catch (e) { setShortcutError(String(e)); toast.error(String(e)); }
    finally { setBusy(false); }
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
    {vaultRoot && <KnowledgeFolderSettings key={vaultRoot} root={vaultRoot} en={en} />}
    <OrganizationPreferenceSettings en={en}/>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]"><Keyboard className="size-4" />{en ? "Quick capture" : "快捷收集"}</CardTitle>
        <CardDescription>{en ? "Show a pinned panel from any application. Clipboard access only happens when you paste." : "在任意应用中呼出置顶面板。只有主动粘贴时才读取剪贴板。"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ShortcutRecorder value={shortcutDraft ?? shortcut} onChange={(value) => { setShortcutDraft(value); setShortcutError(""); }} en={en} disabled={busy} onRecordingChange={setRecordingShortcut} />
        {shortcutError && <p role="alert" className="break-words text-xs text-destructive">{shortcutError}</p>}
        <div className="flex gap-2"><Button size="sm" disabled={busy || recordingShortcut} onClick={() => void saveShortcut()}>{en ? "Save shortcut" : "保存快捷键"}</Button><Button variant="secondary" size="sm" disabled={recordingShortcut} onClick={() => void openCaptureWindow().catch((e) => toast.error(String(e)))}>{en ? "Open panel" : "打开面板"}</Button></div>
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
  return <Card><CardHeader><CardTitle className="text-[15px]">{en?'AI automatic organization':'AI 自动整理'}</CardTitle><CardDescription>{en?'Click AI automatic organization in Knowledge or Quick capture to write, tag, classify and archive in one step.':'在开发知识或快捷收集中点击「AI 自动整理」，直接完成编写、标签、分类与归档。'}</CardDescription></CardHeader><CardContent className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="workbench-field"><span>{en?'Scope':'整理范围'}</span><select aria-label={en?'Organization scope':'整理范围'} value={draft.scope} disabled={busy} onChange={e=>setDraft({...draft,scope:e.target.value as typeof draft.scope})}><option value="inbox">{en?'Inbox only':'仅收件箱'}</option><option value="managed">{en?'All managed folders':'全部管理目录'}</option></select></label>
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

function KnowledgeFolderSettings({ root, en }: { root: string; en: boolean }) {
  const bindings = useKnowledge((state) => state.folderBindings);
  const [draft, setDraft] = useState<KnowledgeFolders | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folders = draft ?? foldersForVault(bindings, root);
  const names = en ? { experience: "Experience", recipe: "Recipes", resource: "Resources" } : { experience: "开发经验", recipe: "开发配方", resource: "资源收藏" };
  async function choose(key: keyof KnowledgeFolders) {
    setBusy(true); setError("");
    try {
      const path = await pickFolder();
      if (path) setDraft((old) => ({ ...(old ?? getKnowledgeFolders(root)), [key]: folderWithinVault(root, path) }));
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const validated = await validateKnowledgeFolders(root, normalizeFolders(folders));
      useKnowledge.getState().setFolders(root, validated);
      await flushAllStorage();
      setDraft(null);
      toast.success(en ? "Folder bindings saved" : "分类文件夹已保存");
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-[15px]"><FolderOpen className="size-4" />{en ? "Managed folders" : "知识分类文件夹"}</CardTitle>
      <CardDescription>{en ? "Search, tags and AI archiving use these folders plus your inbox. Other Obsidian notes stay outside the workbench." : "仅管理收件箱与以下文件夹，检索、标签和 AI 归档使用同一份绑定。其他笔记继续在 Obsidian 管理。"}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <p className="break-all text-xs leading-5 text-muted-foreground">{en ? "Paths relative to" : "路径相对于"} <span className="text-foreground/80">{root}</span></p>
      {KNOWLEDGE_FOLDER_KEYS.map((key) => <div key={key} className="space-y-2">
        <label htmlFor={`knowledge-folder-${key}`} className="text-[13px] font-medium">{names[key]}</label>
        <div className="flex items-center gap-2">
          <Input id={`knowledge-folder-${key}`} className="min-w-0 flex-1" aria-label={`${names[key]}${en ? " folder" : "文件夹"}`} value={folders[key]} disabled={busy}
            onChange={(event) => setDraft({ ...folders, [key]: event.target.value })} />
          <Button variant="secondary" size="sm" disabled={busy} aria-label={`${en ? "Choose " : "选择"}${names[key]}${en ? " folder" : "文件夹"}`} onClick={() => void choose(key)}><FolderOpen className="size-4" />{en ? "Choose" : "选择"}</Button>
        </div>
      </div>)}
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs leading-6 text-muted-foreground">
        <p>{en ? "Inbox" : "收件箱"} · 08-收件箱/ <span className="opacity-70">{en ? "New captures: 工作台/" : "新收集条目存入 工作台/"}</span></p>
        <p>{en ? "Images" : "图片"} · assets/images/工作台/ · WikiLink</p>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{en ? "Choose separate folders inside this vault. Changing bindings never moves notes. Missing target folders are created when archiving." : "可选择知识库内任意互不重叠的文件夹。更改绑定不移动原文件；不存在的目标文件夹在归档时创建。"}</p>
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_KNOWLEDGE_FOLDERS }); setError(""); }}>{en ? "Use defaults" : "恢复默认路径"}</Button>
        <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? (en ? "Saving…" : "正在保存…") : (en ? "Save folder bindings" : "保存文件夹绑定")}</Button>
      </div>
    </CardContent>
  </Card>;
}
