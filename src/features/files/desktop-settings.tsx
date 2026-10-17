import { useState } from "react";
import { Monitor } from "lucide-react";
import { toast } from "sonner";
import { useSettings } from "@/stores/settings";
import { ShortcutRecorder } from "@/features/knowledge/shortcut-recorder";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/motion/button/base";
import { setDesktopShortcut, toggleDesktopFences } from "./desktop-runtime";

export function DesktopFenceSettings() {
    const saved = useSettings(state => state.fenceShortcut);
    const en = useSettings(state => state.lang) === 'en';
    const [draft, setDraft] = useState<string | null>(null);
    const [recording, setRecording] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    async function save(value: string) {
        setBusy(true); setError('');
        try { await setDesktopShortcut(value.trim()); useSettings.getState().setFenceShortcut(value.trim()); setDraft(null); toast.success(en ? 'Fence shortcut saved' : '栅格快捷键已保存'); }
        catch (cause) { setError(String(cause)); }
        finally { setBusy(false); }
    }
    return <Card><CardHeader>
      <CardTitle className="flex items-center gap-2 text-[15px]"><Monitor className="size-4 text-brand"/>{en ? 'Desktop fences' : '桌面栅格'}</CardTitle>
      <CardDescription>{en ? 'Show or hide all enabled fences. Dropped files move into the fence’s folder.' : '一键显示或隐藏已启用的栅格；拖入文件会移动到对应栅格目录。'}</CardDescription>
    </CardHeader><CardContent className="space-y-3">
      <ShortcutRecorder placeholder="Ctrl+Alt+F" value={draft ?? saved} onChange={value => { setDraft(value); setError(''); }} en={en} disabled={busy} onRecordingChange={setRecording}/>
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || recording || !(draft ?? saved).trim()} onClick={() => void save(draft ?? saved)}>{en ? 'Save shortcut' : '保存快捷键'}</Button>
      <Button size="sm" variant="secondary" disabled={busy || recording} onClick={() => void toggleDesktopFences().catch(cause => setError(String(cause)))}>{en ? 'Show / hide fences' : '显示 / 隐藏栅格'}</Button>
      {!!saved && <Button size="sm" variant="ghost" disabled={busy || recording} onClick={() => void save('')}>{en ? 'Clear shortcut' : '清除快捷键'}</Button>}</div>
    </CardContent></Card>;
}
