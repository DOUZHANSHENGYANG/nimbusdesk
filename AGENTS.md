# AGENTS.md — 在这个仓库里干活的约定

云台 / NimbusDesk：Tauri 2 + React 19 + Vite + Tailwind v4 的本机工作台。先读 `architecture.md`（技术栈与已定的设计决策）和 `goal-and-requirements.md`（为什么这么做），再动手。

## 五条硬约束

1. **一次改动一次 commit**，提交信息说清「为什么」而不只是「改了什么」。
2. **结束前 `npm run verify` 必须退出 0**，工作区干净（`git status --short` 为空）。它串起：i18n 对齐 → 对比度 → 预览同步 → `tsc --noEmit` → 各功能单测 → `cargo test`。
   **提交前/发版前再跑 `npm run verify:dist`**：构建 + 入口闭包体积 + 四个浏览器回归（分包边界、轮询门控、长列表分片与深链、搜索窗批加载与跨批滚动）。这些只有把真产物/真夹具跑起来才验得到，`verify` 那道快闸不覆盖。
3. **i18n 双语同时加**：应用词表在 `src/lib/i18n.ts`，ahub 的单独在 `src/ahub/i18n/index.ts`；项目页文案在 `src/features/projects/copy.ts`（缺 en key 直接编译报错）。`npm run check:i18n` 会拦住 key 对不齐或占位符不一致。
4. **改了行为就改文档**：`docs/` 下按功能分篇，写清用法 + 怎么验证，并附 `docs/screenshots/` 里的截图名。
5. **视觉只消费 token**：组件里不许写死颜色，新颜色先进 `src/styles/tokens.css` 的 primitive 层；对比度由 `npm run check:contrast` 兜底。

## 浏览器回归

`src/features/*/fixtures/page.html` 是「真组件 + mock 原生 IPC」的夹具，`scripts/check-*-browser.mjs` 用 Playwright 跑它们：

```powershell
npm run dev                                  # Vite，端口 17800
$env:PLAYWRIGHT_MODULE="…/playwright/index.mjs"   # Playwright 不是项目依赖
node scripts/check-home-overview-browser.mjs
```

断言要落在「用户能看见的东西」上（文本、`aria-pressed`、跳转落点），不要断言内部 state。

`npm run verify:dist` 会自己起服务跑那五条（产物：`check:split` / `check:visibility`；
夹具：`check:files-list` / `check:search-window` / `check:modal`），手边有 dev server 时也可以单跑。

## 上下文卫生（省内存，也省钱）

本机 16 GB，一个 OpenChamber 会话栈常态就 3–4 GB。实测过一轮派子代理的代价（`node scripts/measure-agent-memory.mjs`）：

- 子代理**不新开**会话标签（renderer 数量不动），小任务的常驻增量只有十几 MB；
- 真正的尖峰来自**工具子进程**：一次并行 5 个调用就拉起 5 个 PowerShell，每个 100–220 MB，瞬时 +0.5 GB，跑完释放；
- 真正压不下来的水位是**大输出留在会话里**：一次整文件读、一整份 `verify` 日志，都会常驻在 agent 进程里（长会话私有内存能到 1.5 GB）；
- agent 顺手起的 dev server 会一直挂着（本机实测两台 vite 就 2 GB）。

所以：

1. 命令输出落盘再筛，不要整份打进会话：`npm run verify *> $env:TEMP\verify.log`，随后只 `Select-String` 关键行。
2. `read` 一律带 `offset/limit`；找东西用 `grep`，别整文件读。
3. 派子代理：任务切窄，只要**结论 + 证据**，别让它回贴代码；别一次并行派一堆。
4. 长任务换新会话继续，别在一条会话里堆到最后（单个标签的 renderer 能涨到 900 MB）。
5. 用完的 dev server / 测试进程顺手关掉，别留给下一个人。
