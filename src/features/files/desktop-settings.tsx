import { useState } from "react";
import { FolderInput, Monitor } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/motion/button/base";
import { toggleDesktopFences } from "./desktop-runtime";

export function DesktopFenceSettings() {
    const fenceReveal = useSettings(state => state.fenceReveal);
    const setFenceReveal = useSettings(state => state.setFenceReveal);
    const en = useSettings(state => state.lang) === 'en';
    const [error, setError] = useState('');
    return <Card><CardHeader>
      <CardTitle className="flex items-center gap-2 text-[15px]"><Monitor className="size-4 text-brand"/>{en ? 'Desktop fences' : '桌面栅格'}</CardTitle>
      <CardDescription>{en ? 'Show or hide all enabled fences. Dropped files move into the fence’s folder.' : '一键显示或隐藏已启用的栅格；拖入文件会移动到对应栅格目录。'}</CardDescription>
    </CardHeader><CardContent className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-foreground/90">{en ? 'Visibility' : '显示方式'}</span>
        <div role="group" aria-label={en ? 'Fence visibility' : '栅格显示方式'} className="flex gap-1">
          {([
            { mode: "hover" as const, label: en ? 'On hover' : '悬停显示' },
            { mode: "always" as const, label: en ? 'Always visible' : '始终显示' },
          ]).map((option) => (
            <button
              key={option.mode}
              type="button"
              aria-pressed={fenceReveal === option.mode}
              onClick={() => setFenceReveal(option.mode)}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${fenceReveal === option.mode ? 'border-brand bg-brand/10 text-brand' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">{en ? 'On hover: the fence fades out when the pointer leaves.' : '悬停显示：指针离开后栅格淡出，移上去再显形。'}</p>
      </div>
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void toggleDesktopFences().catch(cause => setError(String(cause)))}>{en ? 'Show / hide fences' : '显示 / 隐藏栅格'}</Button>
      </div>
    </CardContent></Card>;
}

/** 收纳规则：拖进来是移动，大件先问一句 */
export function CollectSettings() {
    const limit = useSettings(state => state.collectConfirmMb);
    const setLimit = useSettings(state => state.setCollectConfirmMb);
    const en = useSettings(state => state.lang) === 'en';
    return <Card><CardHeader>
      <CardTitle className="flex items-center gap-2 text-[15px]"><FolderInput className="size-4 text-brand"/>{en ? 'Collecting' : '收纳'}</CardTitle>
      <CardDescription>{en
        ? 'Dropping into a box moves the files into it. Folders always ask first; files ask when the total passes the limit below.'
        : '拖进盒子 = 把文件移动到盒子里。文件夹一定先问；文件合计超过下面的体积也先问。'}</CardDescription>
    </CardHeader><CardContent>
      <label className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
        <span>{en ? 'Ask above' : '超过'}</span>
        <input
          type="number"
          min={0}
          max={10240}
          step={50}
          value={limit}
          onChange={event => setLimit(Number(event.target.value))}
          className="h-8 w-24 rounded-lg border border-border bg-card px-2 text-[13px] tabular-nums outline-none focus:border-brand/50"
        />
        <span>MB</span>
      </label>
      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{en ? '0 = only folders ask.' : '0 = 只有文件夹会问。'}</p>
    </CardContent></Card>;
}
