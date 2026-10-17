import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inTauri } from "@/lib/tauri";
import { refreshSearchApps, searchAppsStatus } from "./api";
import type { SearchAppsStatus } from "./types";

export function SearchAppsSettings({ en }: { en: boolean }) {
  const [status, setStatus] = useState<SearchAppsStatus | null>(null), [error, setError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const update = () => { void searchAppsStatus().then(value => { if (active.current) { setStatus(value); setError(""); } }).catch(error => { if (active.current) setError(String(error)); }); };
    update(); const timer = setInterval(update, 3000);
    const subscription = inTauri ? listen<SearchAppsStatus>("search://apps-status", event => setStatus(event.payload)) : null;
    return () => { active.current = false; clearInterval(timer); void subscription?.then(stop => stop()).catch(() => undefined); };
  }, []);
  async function refresh() {
    setRefreshing(true); setError("");
    try { await refreshSearchApps(); const value = await searchAppsStatus(); if (active.current) setStatus(value); }
    catch (error) { if (active.current) setError(String(error)); }
    finally { if (active.current) setRefreshing(false); }
  }
  return <section className="search-settings-section" aria-label={en ? "Applications" : "应用目录"}>
    <div className="search-settings-section-heading"><h3><AppWindow />{en ? "Applications" : "应用目录"}</h3><Button size="sm" variant="outline" disabled={refreshing || status?.indexing} onClick={() => void refresh()}><RefreshCw className={status?.indexing ? "animate-spin" : ""} />{en ? "Refresh apps" : "刷新应用目录"}</Button></div>
    <p className="search-settings-hint">{en ? "Find Start menu apps by name, pinyin or common aliases." : "按名称、拼音或常见别名查找开始菜单中的应用。"}</p>
    <p role="status" className="search-settings-hint">{status?.indexing ? en ? "Updating applications…" : "正在更新应用目录…" : status ? en ? `${status.count} applications` : `${status.count} 个应用` : en ? "Loading applications…" : "正在读取应用目录…"}</p>
    {(error || status?.error) && <p role="alert" className="search-settings-error">{error || status?.error}</p>}
  </section>;
}
