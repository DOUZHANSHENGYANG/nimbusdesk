# 启动与内存：分包是怎么切的

这个应用在 Windows 上**每个窗口都是一个独立 WebView2 进程**：主窗口、Dock、每块文件栅栏、
每张待办纸片、右键菜单浮窗、采集窗、搜索窗、快捷工具…它们加载的是同一份 `index.html`。
所以「入口要解析多少 JS」不是一次性开销，而是乘以窗口数量、并且每次都发生在冷启动时。

## 改前 / 改后（实测）

| | 改前 | 改后 |
|---|---|---|
| 入口静态闭包（任一窗口首屏必然解析） | 2977 KB（单包） | **789 KB**（27 块） |
| 其中 AI SDK（`ai` + `@ai-sdk/*` + zod） | 打在包里，人人有份 | 416 KB 只在 `/agent` 那一片 |
| 其中 i18n 词表 | 185 KB（云台 + 工具箱两份，含双语） | 106 KB（工具箱那 79 KB 随页面走） |
| 首屏请求数 | 1 | 57（图标合并成一块后） |
| 打开 `/agent` | 无额外开销 | 按需 488 KB |
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
5. **词表按需加载**：`src/ahub/i18n/index.ts` 的两张表（工具箱的键，79 KB）不再被
   `src/lib/i18n.ts` 静态 import，改成 `import "@/ahub/i18n"` 时才注册到同一个实例上。
   工具箱四页带着它一起走，其它窗口不再为它付费。合并语义没变（`deep=true`、
   `overwrite=false`，同名键以云台为准）。

### 缺键不能静默：`missingI18nKeys`

react-i18next 缺键**不报错**，只把 key 原样画在界面上 —— 词表按需加载最容易踩这个坑
（类型检查、构建、单测全绿，界面冒出 `skills.searchPlaceholder`）。所以：

- `src/lib/i18n.ts` 开了 `saveMissing` + `missingKeyHandler`，缺键收进 `missingI18nKeys`
  并挂到 `window.__i18nMissing`；
- `npm run check:split` 走遍 14 个路由，逐页断言它为空，顺带断言页面文本里没有 `a.b.c` 式的键痕迹。

**这条校验做过证伪**：把 `ahub-host-skills.tsx` 里的 `import "@/ahub/i18n"` 去掉重新构建，
`/toolbox/skills` 立刻报出 70 个缺键，其余页面干净 —— 说明它抓得住漏页，也不会乱叫。
（顺带发现：hash 导航不会重载文档，模块状态会跨路由串味，所以脚本用「换查询串 + reload」
强制整页重载，否则前面的页面会把词表「借」给后面的页面，测出假绿。）

### 两条踩过的坑（别再试一遍）

- **别用 `manualChunks` 强制把 react / radix / motion / ai-sdk 分组**：分组后
  `vendor-motion`、`vendor-radix` 会反向 import `vendor-ai` 里的公共 helper，
  于是 AI SDK 那 416 KB 又被拖回「每个窗口都要加载」的闭包，比不分组还差（实测 1336 KB）。
- **别把 `Providers` 也懒加载掉**：主窗口的 `windowReady()`（`visible:false` 的窗口什么时候显示）
  就在它里面。`Providers` 静态保留，`App` 懒加载 —— 窗口仍然等 App 就绪后才显示，
  和拆分前一致，不会白屏闪现。

### 长列表：分片渲染，而不是虚拟滚动

文件页条目网格与搜索结果可能上千条（整目录映射、Everything 文件检索）。以前整批铺进 DOM：
筛选一变就重排整张网格，键盘连按时每一帧都在动。

做法在 `src/lib/incremental.ts`（纯逻辑，`npm run check:incremental` 覆盖）+ 
`src/components/ui/incremental-list.tsx`（`useIncrementalCount` + `ListSentinel`）：

- 先渲染前 120（搜索窗 80）条，列表末尾放一个哨兵，滚到它就再放一批；
- 换筛选/搜索词 → 回到第一批；总数变小 → 自动收窄，不会越界；
- 搜索窗用键盘导航时，`ensureVisible(选中项)` 会把那一批补出来 ——
  `aria-activedescendant` 指向的节点始终存在，方向键能一路走到最后一条。

为什么不直接上虚拟滚动：文件页是 `auto-fill` 的自适应网格、搜索窗是带键盘导航的 listbox，
两者都要按「行高 × 列数」或「变高行」算绝对位置，改一次样式就容易错位。分片渲染把布局
完全留给浏览器，代价只是「Ctrl+F 只能搜到已渲染的部分」—— 这两个界面本来就靠过滤和搜索定位。

分片带来的两个连带约定（都写了注释，别改回去）：

- **深链定位要先等过滤条件落定**。`/files?item=<id>` 会同时切分类、清空搜索与标签，
  这些改到下一次渲染才生效；effect 在那次 commit 里拿到的 `filtered` 还是旧条件的结果，
  此时 `findIndex` 找不到目标**不代表目标不存在**。所以要等 `selected/search/activeTags`
  追上目标状态，再用 `ensureVisible` 把那一批补出来，补完才滚。
- **批加载不能滚回选中项**。搜索结果的滚动只在「选中项变化」时发生（`pendingReveal` 标记），
  否则用户拖滚动条翻页时，每放一批就被拽回第 0 条。

回归：`npm run check:files-list`（需要 `npm run dev`）—— 塞 800 条，断言首屏远小于总数、
反复滚到底能铺满、全程无报错。

### 轮询只在窗口可见时跑

`src/lib/visibility.ts` 提供一个受前台门控的轮询 `startForegroundInterval(run, ms, opts)`：
定时器照常按节奏走，但 `document.visibilityState === "hidden"`（最小化 / 被完全遮住）时
**跳过干活**，回到前台立刻补一拍。

口径要注意：`hidden` 是「这个窗口看不见」，不是「失焦」。切到别的应用但窗口还在屏幕上时
仍是 `visible` —— 暂停的只是用户根本看不见的那种。

已接入的 7 处（都是纯刷新，不可见时问了也没人看）：搜索状态 ×2、应用索引状态、Everything 探测、
目录映射的 5 秒目录扫描、项目 tick、禅道同步检查。

「回到前台补一拍」只有一个 owner：`startForegroundInterval` 的 `catchUp`（默认开）。目录映射、
项目、禅道这三个运行时原本各自挂 `focus` 监听（只有项目同时挂了 `visibilitychange`），
既重复又漏了「变可见但没拿到焦点」那一拍 —— 现在这些自挂监听已删掉，统一交给 `catchUp`。
搜索窗的 DOM `focus` 处理器也去掉了 `update()`（catchUp 已经补过），只有原生 `search://focus`
事件还会额外刷新一次（那条不经过 DOM 焦点）。

**刻意没接的三类**（写进代码注释了，别顺手改）：

- 边缘坞 / 显示器的 2.5 秒轮询：它就是靠轮询感知鼠标贴边的，窗口不可见时最需要它；
- 桌面便签的提醒调度：不可见也必须按时触发；
- GitHub 设备码登录轮询：用户正是要切到浏览器去授权，此时本窗口不可见。

回归：`npm run check:visibility`（需要构建产物 + preview）—— 把文档标成 hidden，断言
`search_status` 在 4.2 秒内一次都不再出现；恢复 visible 后 600 毫秒内补上一拍。

### 存储：内容没变就不重写

`src/lib/storage.ts` 的 `tauriJsonStorage` 里有一张 `sent` 表：每个 key 最后一次**确认已在磁盘上**的
序列化文本。`setItem` 进来的内容与之逐字相同时直接返回 —— 不排队、不走 IPC、不落盘、不广播。

为什么有用：zustand persist 每次 `set()` 都会调 `setItem`，它不看内容有没有变。而这个应用里
不少 `set` 只动了不持久化的字段，或者原样回写（例如启动时把数据目录再设一遍、轮询把同一份
状态再铺一遍），于是整份文档被重新序列化、过一趟 IPC、再让 SQLite 写一次。

只记**确定和磁盘一致**的文本，三个时机才更新，其余一律删掉记录（宁可多写一次，不能漏写）：

- `getItem` 读到内容 → 记下这份文本；
- `writeJson` 成功且原生没返回不同版本 → 保留；原生合并返回了不同内容（别的窗口改过）→ 删掉；
- 写入失败、读失败、`removeItem` → 删掉。

两个连带的行为变化（都在 `src/lib/storage.test.mjs` 里钉住了）：

- 「陈旧窗口原样回写」不再触发一次原生合并，所以 tombstone 要靠跨窗口事件传回来 ——
  那条路径本来就有（`storage://changed`），不依赖这种空写；
- `plans` 与 `plans-archive` 成对事务只在两侧都真的变了时才开；只改计划时就是一次单键写。

## 怎么验

```powershell
npm run verify:dist           # build + 入口闭包体检（CI/发版前跑这个）
npm run check:bundle          # 只体检已有 dist：闭包体积 + AI SDK 是否漏进首屏
npx vite preview --port 4179 --strictPort
npm run check:split           # 在产物上验：首页不背对话页、/agent 与 /plans 各自按需到达、全路由无缺键
npm run check:visibility      # 在产物上验：不可见时轮询停手、回前台补一拍
```

`check:bundle` 没进 `npm run verify`：`verify` 是本地快闸（不构建），每次往里塞一次生产构建
会让它慢一倍。体积闸门用 `verify:dist`，CI 与发版前跑它。

另外两个要 dev server 的：`npm run check:files-list`（800 条分片渲染）、
以及既有的 `scripts/check-*-browser.mjs`（业务夹具）。

`check:split` / `check:visibility` 在普通浏览器里跑，桩了一个最小 `__TAURI_INTERNALS__`
（IPC 一律返回空），所以它们只回答「chunk 该不该来、页面该不该渲染、轮询该不该跑」；
业务行为仍由 `src/features/*/fixtures` 那套夹具负责。桩自身造成的报错（事件解绑、
命令返回 null 后读属性）在脚本里显式豁免。

## 还没做的（下一步）

- **i18n 剩下的 106 KB**：云台自己的 zh 与 en 两份词表仍内联在同一个模块里、每个窗口都加载。
  按语言拆成两片（默认语言同步、另一种切换时再拉），能再省一半。
- **入口那 324 KB**：现在是 `main.tsx` + `Providers` + 各 store 的同步逻辑。store 的 action 与
  初始状态可以再分一层，让「只显示一个便签」的窗口只加载它要的 store。
- **页面内部的重量**：文件页（1228 行 + 拖放 + 栅栏）、知识库页本身还没做内部懒加载。
  长列表已分片（见上），但知识库以外的深列表（比如设置里的技能/提示词长表）还没接。
- **存储层：整份重写这件事只解掉了一半**。已做内容去重（见上），剩下的是**结构**问题：
  `plans`、`files` 这类 store 是「一个 key = 一份大 JSON」，改一个字段就要重新序列化整份并
  让 SQLite 重写一次。真要解决得把大文档拆成按条目的表（或在 Rust 侧做增量合并），
  属于数据模型变更 —— 会影响备份、跨窗口回灌、SQLite 快照合并，得单独一轮做，不能顺手改。
