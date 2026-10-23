import i18next from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import { zh } from "./locales/zh";

export type Lang = "zh" | "en";

/** 词表形状：`en` 用它约束自己（漏一个键就编译报错，比运行时缺键可靠得多）。 */
export type AppMessages = typeof zh;

/**
 * 缺键采样。
 *
 * react-i18next 缺键**不报错**：它把 key 原样画到界面上。分包、懒加载词表这类改动
 * 最容易踩的就是这个坑 —— 类型检查、构建、单测全绿，界面上却冒出 `toolbox.xxx.yyy`。
 * 所以这里把缺键收进一个数组（同时挂到 window 上），由浏览器回归逐页断言它为空：
 * `scripts/check-split-browser.mjs` 会走一遍所有路由。
 */
export const missingI18nKeys: string[] = [];

declare global {
  interface Window {
    __i18nMissing?: string[];
  }
}

/**
 * 语言提示（localStorage，**同步可读**）。
 *
 * 设置里的 `lang` 是真源，但它要等 persist 水合（一次 IPC）才知道；而窗口在挂载后
 * 立刻就要显示，等不了。所以切换语言时顺手把它记在 localStorage 里，启动时先按这个
 * 提示把对应词表拉好再渲染首帧 —— 英文用户不会先看到一闪中文。
 * 词表分片换来的是「每个窗口少解析约 50 KB」，代价只有这一行同步读取。
 */
const LANG_HINT_KEY = "nimbusdesk.lang";

export function readLanguageHint(): Lang {
  try {
    return window.localStorage.getItem(LANG_HINT_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

/**
 * 确保某门语言的词表已可用。
 *
 * 中文（默认语言）内联在入口，同步可用；英文是独立分片，第一次用到时才加载。
 * 重复调用共享同一个 Promise，切换语言与启动预取不会重复拉取。
 */
let englishPack: Promise<void> | null = null;

export function ensureLanguage(lang: Lang): Promise<void> {
  if (lang === "zh") return Promise.resolve();
  englishPack ??= import("./locales/en").then(({ en }) => {
    i18n.addResourceBundle("en", "translation", en, true, false);
  });
  return englishPack;
}

export const i18n = i18next.createInstance();
void i18n.init({
  lng: "zh",
  // 兜底用中文（内联、必定可用）；不能指回 en —— 那门语言此刻可能还没加载
  fallbackLng: "zh",
  defaultNS: "translation",
  resources: {
    zh: { translation: zh },
  },
  interpolation: { escapeValue: false },
  saveMissing: true,
  missingKeyHandler: (_lngs, _ns, key) => {
    if (!missingI18nKeys.includes(key)) {
      missingI18nKeys.push(key);
      if (typeof window !== "undefined") window.__i18nMissing = missingI18nKeys;
    }
  },
});

export function changeLang(lang: Lang) {
  try {
    window.localStorage.setItem(LANG_HINT_KEY, lang);
  } catch {
    // 存不了就算了：只影响下次启动的预取，不影响本次切换
  }
  if (i18n.language === lang) return;
  // 非默认语言要先等分片到位再切，否则切换瞬间会把 key 画到界面上
  void ensureLanguage(lang).then(() => i18n.changeLanguage(lang));
}

/*
 * 桥②（语言）：AgentHub（源侧工具箱）的键表合并进**同一个**实例 —— 合并动作在
 * `src/ahub/i18n/index.ts`，那边 import 时才注册（那两张表 79 KB，只有工具箱四页、
 * 设置里的 AI 部分真正用得到，不该由每个窗口的入口静态背上）。
 *
 * 这里只留一条约定：合并语义是 deep=true、overwrite=false（云台已有的键一律不被覆盖，
 * 两张表有 19 个同名键，以云台为准）；语言切换因此天然同时作用于两边。
 * 哪片页面忘了 import 词表，上面的缺键采样会记下来，浏览器回归逐页断言为空。
 */

export { I18nextProvider, useTranslation };
