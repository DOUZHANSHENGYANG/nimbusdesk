# 启动与内存：分包是怎么切的

这个应用在 Windows 上**每个窗口都是一个独立 WebView2 进程**：主窗口、Dock、每块文件栅栏、
右键菜单浮窗、采集窗、搜索窗、快捷工具…它们加载的是同一份 `index.html`。
所以「入口要解析多少 JS」不是一次性开销，而是乘以窗口数量、并且每次都发生在冷启动时。

## 改前 / 改后（实测）

| | 改前 | 改后 |
|---|---|---|
| 入口静态闭包（任一窗口首屏必然解析） | 2977 KB（单包） | **529 KB**（26 块） |
| 其中 AI SDK（`ai` + `@ai-sdk/*` + zod） | 打在包里，人人有份 | 416 KB 只在 `/agent` 那一片 |
| 其中 gsap（主题兜底动画用） | 69 KB，每个窗口都解析 | 只在走 GSAP 兜底时按需加载 |
| 其中 i18n 词表 | 185 KB（云台 + 工具箱两份，含双语） | 75 KB（工具箱 79 KB 随页面走、英文 32 KB 按需） |
| 其中动画运行时（motion + gsap） | 每次都解析（对话框关着也挂着） | 只在第一次弹窗时按需 127 KB |
| 首屏请求数 | 1 | 57（图标合并成一块后） |
| 打开 `/agent` | 无额外开销 | 按需 488 KB |
| 打开 `/plans` | 无额外开销 | 按需 6 块 |
| CSS | 326 KB 单文件 | 215 KB + 各页按需 |

测量口径：`npm run build && npm run check:bundle` —— 它按 `index.html` 的 entry 出发，沿着
静态 import 走完整个闭包，把每块体积列出来；超过 900 KB 或闭包里出现 AI SDK 痕迹就判失败。

## 具体做了什么

1. **窗口级按需加载**（`src/main.tsx`）：`App`、Dock、栅栏、右键菜单、采集、搜索、
   快捷工具、边缘坞全部改成 `lazy`，入口只留 label 分流那一小段。以前一个几十行的右键菜单
   也要把主应用、工具箱、AI SDK 一起解析一遍。
2. **路由级按需加载**（`src/app/App.tsx`）：首页保持静态（它是落点，懒加载只会把首屏往后推），
   其余页面各自一片。工具箱四页带着 ahub 全套，文件页带拖放与栅栏，设置页带备份/导入 ——
   现在打开应用不必先解析这些。
3. **主窗口后台任务单独成片**（`src/app/main-runtimes.tsx`）：提醒、项目、禅道、知识、搜索、
   资讯、桌面、目录映射、边缘坞从 `providers.tsx` 拆出来走 `lazy`。栅栏/便签/
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
- **批加载不能滚回选中项，但跨批导航必须滚到**。搜索结果的滚动由 `pendingReveal` 标记驱动：
  只有「选中项变化」时才置位；纯批加载（哨兵放下一批）时标记为空，一次都不滚，否则用户拖
  滚动条翻页时每放一批就被拽回第 0 条。**而标记只在节点真的渲染出来之后才消费** ——
  跨批跳转（如第 0 条按 ↑ 回绕到最后一条）时 `ensureVisible` 先扩容、节点下一次渲染才出现，
  提前清标记就会「补出了但停在视口外」。

回归：`npm run check:files-list`（需要 `npm run dev`）—— 塞 800 条，断言首屏远小于总数、
反复滚到底能铺满、深链能定位到首批之外（含「当前有搜索词把目标筛掉」的情形）、全程无报错。
`npm run check:search-window`（同样需要 dev server）—— 造 200 条命中，断言批加载不把列表
拽回选中项、且「回绕跳转」那一下会把选中项滚进可视区。它用的夹具是已提交的
`src/features/search/fixtures/page.html`（此前只在 gitignore 的 `/Temp/` 下有副本，
搜索窗的回归因此进不了仓库，是这一轮的教训）。

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
- `plans` 与 `plans-archive` 成对事务只在两侧都真的变了时开；只改计划时就是一次单键写。

### 存储：大文档拉长批处理窗口，隐藏即落盘

先量了一下「一份大文档写一次有多贵」（真实形状的合成数据）：`files` 2000 条 ≈ 0.6 MB（序列化 3.3 ms /
解析 2.2 ms）、8000 条 ≈ 2.5 MB（12.2 / 12.5 ms）；`plans` 3 年 ≈ 1.45 MB（8.7 / 6.8 ms）。
而写一次 = 整份序列化 + 一次 IPC + SQLite 重写整行。

所以：**超过 512 KB 的载荷把防抖窗口从 250 ms 拉到 1.2 s**（期间所有改动合并成一次写），
并在 `visibilitychange → hidden` 与 `pagehide` 时立即把队列排空 —— 窗口切走/关闭不会把改动留在内存里。
两条都有单测（`delays()` 断言窗口长度、`hide()` 断言立刻落盘）。

这一条只降**频次**，不降**单次代价**。结构性改造已经落地：`files` 改成 SQLite **行级表**
（一条条目一行），前端只推增量 —— 改一条就只写一条 `UPDATE`，不再整份重写。
细节与效果见 `docs/plan-storage-sharding.md`。

### 对话框：打开那一刻才把动画运行时拉进来

`ModalProvider` 挂在**每个窗口**最外层，而对话框界面（`center-morph-modal`）是 motion 驱动的
（`motion-dom` + `framer-motion`）。以前对话框即使关着也一直挂在树上 —— 于是「只显示一张便签」
的小窗口也要解析整套动画运行时，这一笔有 161 KB。

现在界面拆到 `src/components/shell/modal-dialog.tsx`，provider 里 `lazy` 拉取，只在
`data !== null`（真要弹）时才挂载。时序没有变：

- **入场**：`CenterMorphModalContent` 是「挂载 → `mounted=true` → 播 `initial → animate`」，
  延迟挂载只是把这段动画挪到打开那一刻；
- **退场**：`AnimatePresence` + `open=false`，而 provider 保留内容 500ms 再卸载，正好盖住这段。

回归：`npm run check:modal`（夹具 `src/components/shell/fixtures/page.html`）—— 断言「没弹之前
DOM 里没有 `[role="dialog"]`」，以及确认/输入/提示三种都能弹、能把 Promise 结算成
`false / true / 回填后的字符串`，退场后节点再次消失。

### 词表：默认语言内联，另一门语言按需

中文（默认）留在入口里同步可用，英文拆成 `src/lib/locales/en.ts` 的独立分片（32 KB），
由 `ensureLanguage("en")` 动态 import。省的是「每个窗口都为一个可能用不到的语言付解析费」。

不闪的写法：语言真源在设置里，但它要等 persist 水合（一次 IPC）才知道，而窗口挂载后立刻要显示。
所以 `changeLang` 顺手把语言记进 **localStorage**（同步可读），`main.tsx` 在渲染前先
`await ensureLanguage(提示语言)` —— 中文是个已 resolve 的 Promise（只让出一个微任务），
英文才会真的去拉那 32 KB。窗口在 `windowReady()` 之前是隐藏的，所以英文用户不会先看到一闪中文。

配套的两条断言：

- `check:bundle` —— 英文词表必须不在入口闭包里，且 `en-*.js` 分片存在（防有人把它静态 import 回去）；
- `check:split` —— 用 settings `lang=en` 启动一次，断言真的拉到 `en-*` 分片、正文是英文、无缺键。

### gsap：只有走兜底动画时才加载

主题切换首选 View Transitions（WebView2 支持），GSAP 羽化幕布只是**无 VT 运行时**的兜底。
但 `lib/theme.ts` 以前顶部静态 import gsap，于是每个窗口都为一段可能永远不播的兜底动画解析 69 KB。
现在改成在兜底分支里 `await import("@/lib/gsap")`，主题切换的对外签名保持同步。

`check:split` 里补了一条针对性断言：用 init script 删掉 `Document.prototype.startViewTransition`
模拟无 VT 的运行时，点「切换到亮色」，断言主题类翻转、兜底幕布（z-index 2147483000）在动画结束后
被移除（说明 gsap 分片到位、`switching` 状态也收尾了）、无报错。

注意范围：这条省的是**小窗口**（栅栏/便签/菜单/Dock/采集/搜索）—— 主窗口的 `App` 里
`PageTransition` 还会加载 gsap（路由过渡要用），但那是主窗口自己那一片，不影响入口闭包。

## 怎么验

**一条命令的闸门**（CI / 发版前跑它）：

```powershell
npm run verify:dist
```

它依次做：构建 → `check:bundle`（闭包体积 + AI SDK 是否漏进首屏）→ 起 `vite preview`（4179）
跑 `check:split` / `check:visibility` → 起 `vite`（17800）跑 `check:files-list` /
`check:search-window` / `check:modal`。已经开着的服务会**复用而不是杀掉**，只清理自己起的；
任一环节失败即非零退出并打印该环节输出。`VERIFY_SKIP_DEV=1` 可只验产物阶段。

单跑某一条（手边已有服务时最方便）：

```powershell
npm run check:bundle          # 只体检已有 dist
npx vite preview --port 4179 --strictPort && npm run check:split
npm run dev                   # 17800，夹具检查需要它
npm run check:files-list      # 800 条分片 + 深链（含过滤态）
npm run check:search-window   # 搜索窗批加载与跨批跳转
npm run check:modal           # 对话框按需挂载 + 三种弹窗的结算
```

为什么这些不在 `npm run verify` 里：`verify` 是本地快闸（单测 + 类型 + i18n，不构建、不起服务），
塞进生产构建和两个服务会让它慢好几倍。分工是「`verify` 每次改动都跑；`verify:dist` 提交前/发版前跑」。

`check:split` / `check:visibility` 在普通浏览器里跑，桩了一个最小 `__TAURI_INTERNALS__`
（IPC 一律返回空），所以它们只回答「chunk 该不该来、页面该不该渲染、轮询该不该跑」；
业务行为仍由 `src/features/*/fixtures` 那套夹具负责。桩自身造成的报错（事件解绑、
命令返回 null 后读属性）在脚本里显式豁免。

## 还没做的（下一步）

- **入口那 262 KB**：现在是 `main.tsx` + `Providers` + 各 store 的同步逻辑。store 的 action 与
  初始状态可以再分一层，让「只显示一个便签」的窗口只加载它要的 store。
- **页面内部的重量**：文件页（1228 行 + 拖放 + 栅栏）、知识库页本身还没做内部懒加载。
  长列表已分片（见上），但知识库以外的深列表（比如设置里的技能/提示词长表）还没接。
- **存储层：整份重写这件事只解掉了一半**。已做内容去重（见上），剩下的是**结构**问题：
  `plans`、`files` 这类 store 是「一个 key = 一份大 JSON」，改一个字段就要重新序列化整份并
  让 SQLite 重写一次。真要解决得把大文档拆成按条目的表（或在 Rust 侧做增量合并），
  属于数据模型变更 —— 会影响备份、跨窗口回灌、SQLite 快照合并，得单独一轮做，不能顺手改。
