import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import { api } from "@/ahub/lib/api";
import type { SettingsInfo } from "@/ahub/lib/types";
import { useSettings as useNdSettings } from "@/stores/settings";

/**
 * 桥②（语言）：唯一语言来源是云台的设置。
 *
 * 源侧语言存在 AgentHub 自己的 settings.json 与 localStorage["agenthub.lang"] 里，
 * 另外 init 了一套 i18next。云台这边两个实例已经合成一个（见 ahub/i18n/index.ts），
 * 所以只要读云台的值即可；否则会出现「设置页切了、工具箱没切」的一半一半状态。
 */
const ndLang = (): Lang => (useNdSettings.getState().lang === "en" ? "en" : "zh");

export type Theme = "light" | "dark";
export type Lang = "zh" | "en";
/** 主题色调。与明暗模式正交：任何色调都能配任何模式。 */
export type Accent = "blue" | "teal" | "rose" | "graphite";

export const ACCENTS: Accent[] = ["blue", "teal", "rose", "graphite"];

export function asAccent(v: unknown): Accent {
  return ACCENTS.includes(v as Accent) ? (v as Accent) : "blue";
}

export function applyThemeDom(theme: Theme, accent?: Accent) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  if (accent) root.dataset.accent = accent;
  try {
    localStorage.setItem("agenthub.theme", theme);
    if (accent) localStorage.setItem("agenthub.accent", accent);
  } catch {
    /* ignore */
  }
}

interface SettingsState {
  ready: boolean;
  theme: Theme;
  accent: Accent;
  language: Lang;
  info: SettingsInfo | null;
  boot: () => Promise<void>;
  refresh: () => Promise<void>;
  /** theme switch with radial expand (light→dark) / collapse (dark→light) */
  setTheme: (next: Theme, origin?: { x: number; y: number }) => Promise<void>;
  /** 切换主题色调（不影响明暗模式） */
  setAccent: (next: Accent) => Promise<void>;
  setLanguage: (lang: Lang) => Promise<void>;
  setDataDir: (path: string) => Promise<void>;
  setHarnessOrder: (order: string[]) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false,
  theme: "dark",
  accent: "blue",
  language: "zh",
  info: null,

  boot: async () => {
    try {
      const info = await api.getSettings();
      const theme = (info.settings.theme === "light" ? "light" : "dark") as Theme;
      // 主题色调用独立字段，不进 settings.theme（那个存明暗模式）
      let accent: Accent = "blue";
      try {
        accent = asAccent(localStorage.getItem("agenthub.accent"));
      } catch {
        /* ignore */
      }
      const lang = ndLang();
      applyThemeDom(theme, accent);
      set({ info, theme, accent, language: lang, ready: true });
    } catch {
      applyThemeDom("dark", "blue");
      set({ ready: true });
    }
  },

  refresh: async () => {
    try {
      const info = await api.getSettings();
      set({ info });
    } catch {
      /* ignore */
    }
  },

  setTheme: async (next, origin) => {
    const cur = get().theme;
    if (cur === next) return;
    set({ theme: next });
    api.setPrefs(undefined, next).catch(() => undefined);
    void emit("agenthub:theme", next).catch(() => undefined);

    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };

    const accent = get().accent;
    if (reduce || typeof doc.startViewTransition !== "function") {
      applyThemeDom(next, accent);
      return;
    }

    if (origin) {
      const radius = Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y),
      );
      root.style.setProperty("--vt-x", `${origin.x}px`);
      root.style.setProperty("--vt-y", `${origin.y}px`);
      root.style.setProperty("--vt-r", `${Math.ceil(radius)}px`);
    } else {
      root.style.setProperty("--vt-x", "50%");
      root.style.setProperty("--vt-y", "50%");
      root.style.setProperty("--vt-r", "150%");
    }

    // 明→暗：新（暗）从点击点扩散；暗→明：旧（暗）收拢回点击点
    root.dataset.vt = next === "dark" ? "expand" : "collapse";
    try {
      const vt = doc.startViewTransition(() => applyThemeDom(next, accent));
      await vt.finished;
    } catch {
      applyThemeDom(next, accent);
    } finally {
      delete root.dataset.vt;
    }
  },

  // 换色调不涉及明暗展开动画：只改 data-accent 即可，
  // 但用 CSS transition 让颜色平滑过渡（globals.css 里为关键 token 配了过渡）
  setAccent: async (next) => {
    if (get().accent === next) return;
    set({ accent: next });
    applyThemeDom(get().theme, next);
    void emit("agenthub:accent", next).catch(() => undefined);
  },

  setLanguage: async (lang) => {
    // 桥②：改成切云台的语言（i18n 是同一个实例，两边同时生效，不再自己 changeLanguage）
    useNdSettings.getState().setLang(lang);
    set({ language: lang });
    api.setPrefs(lang, undefined).catch(() => undefined);
    void emit("agenthub:lang", lang).catch(() => undefined);
  },

  setDataDir: async (path) => {
    const info = await api.setDataDir(path);
    set({ info });
    void emit("agenthub:data-changed").catch(() => undefined);
  },

  setHarnessOrder: async (order) => {
    const info = await api.setHarnessOrder(order);
    set({ info });
  },
}));
