# 启动与内存：分包是怎么切的

这个应用在 Windows 上**每个窗口都是一个独立 WebView2 进程**：主窗口、Dock、每块文件栅栏、
每张待办纸片、右键菜单浮窗、采集窗、搜索窗、快捷工具…它们加载的是同一份 `index.html`。
所以「入口要解析多少 JS」不是一次性开销，而是乘以窗口数量、并且每次都发生在冷启动时。

## 改前 / 改后（实测）

| | 改前 | 改后 |
|---|---|---|
| 入口静态闭包（任一窗口首屏必然解析） | 2977 KB（单包） | **868 KB**（27 块） |
| 其中 AI SDK（`ai` + `@ai-sdk/*` + zod） | 打在包里，人人有份 | 416 KB 只在 `/agent` 那一片 |
| 首屏请求数 | 1 | 57（图标合并成一块后） |
| 打开 `/agent` | 无额外开销 | 按需 491 KB |
| 打开 `/plans` | 无额外开销 | 按需 6 块 |
| CSS | 326 KB 单文件 | 215 KB + 各页按需 |

测量口径：`npm run build && npm run check:bundle` —— 它按 `index.html` 的 entry 出发，沿着
静态 import 走完整个闭包，把每块体积列出来；超过 900 KB 或闭包里出现 AI SDK 痕迹就判失败。

## 具体做了什么

1. **窗口级按需加载**（`src/main.tsx`）：`App`、Dock、栅栏、待办纸片、右键菜单、采集、搜索、
   快捷工具、边缘坞全部改成 `lazy`，入口只留 label 分流那一小段。以前一个几十行的右键菜单
   也要把主应用、工具箱、AI SDK 一起解析一遍。
2. **路由级按需加载**（`src/app/App.tsx`）：首页保持静态（它是落点，懒加载只会把首屏往后推），
   其余页面各自一片。工具箱四页带着 ahub 全套，文件页带拖放与栅栏，设置页带备份/导入 ——
   现在打开应用不必先解析这些。
3. **主窗口后台任务单独成片**（`src/app/main-runtimes.tsx`）：提醒、项目、禅道、知识、搜索、
   资讯、桌面、目录映射、边缘坞、纸片恢复从 `providers.tsx` 拆出来走 `lazy`。栅栏/便签/
   菜单这些独立小窗口也挂 `Providers`，以前会连带背上整套后台逻辑。
4. **图标合并**（`vite.config.ts` 的 `codeSplitting.groups`）：rolldown 默认把每个图标切成
   独立 chunk，首屏五十多个请求都是几 KB 的图标；压成一块后首屏请求从 72 降到 57。

### 两条踩过的坑（别再试一遍）

- **别用 `manualChunks` 强制把 react / radix / motion / ai-sdk 分组**：分组后
  `vendor-motion`、`vendor-radix` 会反向 import `vendor-ai` 里的公共 helper，
  于是 AI SDK 那 416 KB 又被拖回「每个窗口都要加载」的闭包，比不分组还差（实测 1336 KB）。
- **别把 `Providers` 也懒加载掉**：主窗口的 `windowReady()`（`visible:false` 的窗口什么时候显示）
  就在它里面。`Providers` 静态保留，`App` 懒加载 —— 窗口仍然等 App 就绪后才显示，
  和拆分前一致，不会白屏闪现。

## 怎么验

```powershell
npm run build                 # 出产物
npm run check:bundle          # 入口闭包体积 + AI SDK 是否漏进首屏
npx vite preview --port 4179 --strictPort
npm run check:split           # 在产物上验：首页不背对话页、/agent 与 /plans 各自按需到达
```

`check:split` 在普通浏览器里跑，桩了一个最小 `__TAURI_INTERNALS__`（IPC 一律返回空），
所以它只回答「chunk 该不该来、页面该不该渲染」；业务行为仍由 `src/features/*/fixtures` 那套
夹具负责。桩自身造成的报错（事件解绑、命令返回 null 后读属性）在脚本里显式豁免。

## 还没做的（下一步）

- **i18n 185 KB 常驻**：`src/lib/i18n.ts` 把 zh 与 en 两份词表内联在同一个模块里，且每个窗口都加载。
  按语言拆成两个 chunk、切换时再拉另一份，能再省一半。
- **入口那 324 KB**：现在是 `main.tsx` + `Providers` + 各 store 的同步逻辑。store 的 action 与
  初始状态可以再分一层，让「只显示一个便签」的窗口只加载它要的 store。
- **页面内部的重量**：文件页（1228 行 + 拖放 + 栅栏）、知识库页本身还没做内部懒加载；
  长列表也没有虚拟化（全仓库没有 `useVirtualizer`），几千条会掉帧。
