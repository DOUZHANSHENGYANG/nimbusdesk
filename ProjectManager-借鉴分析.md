# ProjectManager 深度学习报告 · 对 NimbusDesk 的可借鉴清单

**参考项目**：<https://github.com/AlicDanclic/ProjectManager（MIT，本地克隆于> `$PI_SCRATCH_DIR/ref-pm`，v0.8.4）
**技术栈**：Tauri 2 + Svelte 5 (runes) + SvelteKit(adapter-static) + Vite 6 + Rust 2021 + Tailwind v4 + 纯 CSS 变量主题
**规模**：前端 125 文件 / 约 23k 行（含 Rust），i18n 中英各 680 行
**规模**：前端 125 文件，`src/` + `src-tauri/src/` 合计约 23.3k 行（其中两个 i18n 文件各 680 行）
**对比 NimbusDesk**：TS/TSX 约 16.2k 行 + Rust 1.9k 行 ≈ 18.1k 行 —— 两者体量相当

> 阅读建议：先看 **§0 结论速览** 决定保留/改造哪些，再看 **§1 全量清单** 逐条勾选。

***

## §0 结论速览

### 一句话判断

这个项目和 NimbusDesk **同代同栈**（都是 Tauri 2 自冷启动的本地优先桌面工具），但它把力气花在\*\*「任务领域模型的深度」和「数据安全的工程纪律」**上，而 NimbusDesk 花在**「窗口/桌面集成的深度」\*\*（自定义标题栏、径向主题切换、桌面栅栏、原生右键菜单、OLE 拖出）。

所以两者**互补性很强**，但有三个硬冲突必须记住：

| 冲突   | ref-pm 做法             | NimbusDesk 约束     | 结论                          |
| ---- | --------------------- | ----------------- | --------------------------- |
| 数据落盘 | localStorage 为权威源     | 自定义数据目录 JSON 文件为准 | 借「原子写+告警」机制，**不借存储分层**      |
| 联网   | 三后端云同步 + 服务器 PDF + AI | 纯本地、无网络           | **云同步/服务器导出整段跳过**           |
| 平台   | 桌面 + Android          | 仅 Win10/11 桌面     | **触摸/长按/WebView 兼容代码大半用不上** |

### 分级总览

| 级别  | 含义              | 条目数 |
| --- | --------------- | --- |
| ★★★ | 强烈建议做，收益明确、成本可控 | 14  |
| ★★  | 可考虑，视你的使用方式决定   | 13  |
| ★   | 增值但优先级低         | 9   |
| ✗   | 明确不建议抄（附理由）     | 8   |

**我认为最该抄的前 5 条**（按「性价比」排序，不是按重要性）：

1. **原子写补齐 + `.bak` 回退 + 写失败可见告警** —— 你现在 `data.rs:write_file` 缺 `fsync`，且写失败只 `console.error`，用户完全看不见。这是唯一会**永久丢数据**的风险点。
2. **一键全量备份/恢复** —— 你所有数据都在一个自定义目录里、没有云端，用户误删目录就全没了。
3. **i18n key 一致性校验脚本**（\~67 行）—— 你中英双语已经铺开，缺 key 时界面直接渲染 key 本身，是静默故障。
4. **任务提醒（到点通知）** —— 你的计划管理已经有 `start`/`end` 和 `useNow()` 分钟对齐的底座，加提醒只差一个 `tauri-plugin-notification` + 一个调度器。你现在**完全没有任何通知能力**。
5. **命令面板 + 全局搜索** —— 你已经装了 `cmdk` 但**一次都没用过**（`src/components/ui/command.tsx` 无人引用）。你的数据是「分类/标签/文件/任务」多维的，没有全局搜索会越来越难用。

**明确不要抄的**：云同步三后端、插件系统、自动更新、Android 分支、HTML5-DnD-替代方案的复杂度、无索引全量搜索。（理由见 §4）

***

## §1 全量功能清单（带依据与建议）

依据格式：`路径:行号`，均相对 `ref-pm/`。

### A. 数据安全与存储

| 功能               | ref-pm 实现                                                                             | 依据                                                                             | NimbusDesk 现状                                                                                                        | 建议                      |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **原子写**          | 写 `<path>.tmp` → `flush` → **`sync_all()`(fsync)** → 旧文件 `copy` 成 `.bak` → `rename`   | `src-tauri/src/atomic_file.rs:19-50`                                           | `data.rs:write_file` 有 tmp+rename，**无 fsync、无 .bak**                                                                 | ★★★ 补齐                  |
| **读回退 .bak**     | 主文件缺失/损坏时读 `.bak` 自愈                                                                  | `atomic_file.rs:58-70`                                                         | 无。解析失败直接 `Err` 冒泡                                                                                                    | ★★★                     |
| **原子写可独立单测**     | 模块**不依赖 tauri**，`rustc --test atomic_file.rs` 直接跑 5 个断言                               | `atomic_file.rs:1-10`、`84-140`；`package.json:test:rust`                        | 已有 Rust 测试习惯（`newfile.rs` 7 个）                                                                                       | ★★★ 照抄这个「解耦以便单测」的取向     |
| **写失败可见告警**      | `safeSetItem` catch → `storageHealth.error` + 10s Toast + 顶栏红条（`role="alert"`）        | `src/lib/stores/storage-health.ts:107-165`；`src/routes/+layout.svelte:180-188` | `storage.ts:flush()` 只 `console.error`                                                                               | ★★★                     |
| **配额预警**         | 已用 ≥ 4MB 预算 ×80% 时 Toast                                                              | `storage-health.ts:30,82,157-159`                                              | 无                                                                                                                    | ★ 不适用（不用 localStorage）  |
| **schema 版本迁移**  | `CURRENT_PM_SCHEMA = 3`，`STEPS = [v1_to_v2, v2_to_v3]` 逐版本函数链，只补缺失字段、**绝不纠正类型**       | `src/lib/utils/pm-schema.ts:26,250-303`                                        | `plans` 已有 `version:2 + migrate`（`store.ts:109-120`）；`plans-archive` 同；`files`/`fences` 是 `version:1` 但**无 migrate** | ★★ 给 files 补 migrate 骨架 |
| **导入校验（字段路径报错）** | 体积上限 32MB → JSON.parse → migrate → validate；错误带 `tasks[3].title` 路径；**任一段错误 → 整体不落地** | `pm-schema.ts:85-196,346-370`                                                  | 无导入功能                                                                                                                | ★★ 与「备份恢复」一起做           |
| **数组/字符串上限**     | tasks 20000、subtasks 2000…防 DoS                                                       | `pm-schema.ts:85-196`                                                          | 无                                                                                                                    | ★ 配合导入一起                |
| **一键全量备份**       | 导出 `{kind,schema_version,app_version,exported_at,projects[],settings,sync}`           | `src/lib/utils/backup.ts:88-102`                                               | 无                                                                                                                    | ★★★                     |
| **凭据不入备份**       | `SYNC_SAFE_KEYS` 白名单，token/密码另存 keyring                                               | `backup.ts:19-49`；`src-tauri/src/sync/credentials.rs`                          | 无凭据                                                                                                                  | ✗ 不涉及                   |
| **恢复 = 合并模式**    | 同 id 比 `updated_at` 新者胜，**本地独有永不删除**                                                  | `backup.ts:215-243`；`src/lib/stores/project.ts:502-533`                        | 无                                                                                                                    | ★★★ 这个语义很重要（恢复不该是覆盖）    |
| **删除前自动备份**      | `backupBeforeDelete` → 最近 20 条                                                        | `src/lib/sync/auto.ts:247-263`                                                 | 无（但你删除走回收站 `FOF_ALLOWUNDO`，间接可救）                                                                                     | ★★                      |
| **撤销/重做（50 步）**  | 每次 mutation 前 `JSON.parse(JSON.stringify(全部项目))` 深拷贝压栈，**内存数组、不落盘**                   | `src/lib/stores/history.ts:42-104`；`project.ts:58-80`                          | **完全没有 undo**                                                                                                        | ★★ 见 §2.4 的取舍分析         |
| **落盘时机**         | localStorage 订阅**逐次同步全量写**（无 debounce）；同步上行才 debounce 1200ms                          | `project.ts:58-80`；`sync/auto.ts:34,278-283`                                   | 已有 **250ms trailing debounce**（`storage.ts:17`），比它更好                                                                 | ✗ 你的更好，别改               |

### B. 任务领域模型（对「计划管理」）

| 功能                | ref-pm 实现                                                                                                                      | 依据                                                                                                   | 建议                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------- |
| **循环任务**          | `RecurrenceRule{freq,interval,byWeekday,end,count,until,sourceTaskId}`；完成一次→消费规则+生成下一实例+原任务 `recurrence=null`（同一 `update` 内原子） | `src/lib/types/task.ts:11-34`；`src/lib/utils/recurrence.ts:120-180`；`src/lib/stores/task.ts:237-269` | ★★★                       |
| **月末/闰日归位**       | `makeClampedDate()` = `min(day, daysInMonth)`；1/31 → 2/28；闰年 2/29 → 平年 2/28                                                    | `recurrence.ts:46-54,143-155`                                                                        | ★★★ 细节正确性                 |
| **weekly + 多选星期** | 先找本周内下一个选中日，无则跳下周日 + `interval*7`                                                                                              | `recurrence.ts:125-140`                                                                              | ★★★                       |
| **结束条件**          | `count`=剩余次数（消费递减）；`until` 双重判定（`isRuleExhausted` + `next > until`）                                                            | `recurrence.ts:96-102,174-180`                                                                       | ★★★                       |
| **规则归一化容错**       | 非法 freq→daily、interval<1→1、非法 end→never，保证存盘必合法                                                                                | `recurrence.ts:74-86`                                                                                | ★★★ 好习惯                   |
| **任务依赖**          | `Dependency{taskId, dayOffset}`；前置未完成时拒绝置 done                                                                                 | `task.ts:87-108,351-363`                                                                             | ★★                        |
| **循环依赖检测**        | 从被依赖任务 BFS 沿链找能否回到自身，能则放弃写入                                                                                                    | `task.ts:351-363`                                                                                    | ★★                        |
| **优先级**           | `high/medium/low` 三值枚举                                                                                                         | `types/task.ts:37-41`                                                                                | ★★★ 你现在没有优先级              |
| **标签**            | 项目级 `Tag{id,name,color}`，任务存 `tags: string[]`                                                                                  | `types/project.ts:36-48`                                                                             | ★★★ 你现在有标签系统（文件管理里），计划里没有 |
| **截止日期 + 时间**     | `due_date`(日期) + `due_time`(HH:mm)，`null` 时间视为当天 23:59                                                                         | `types/task.ts:101-107`；`src/lib/utils/reminder.ts:73-90`                                            | ★★ 你已有 `start`/`end`      |
| **子任务 checklist** | `Subtask{id,title,done}`，无独立状态/优先级/截止，只活在详情面板                                                                                  | `types/task.ts:43-54`                                                                                | ★★ 你的层级树已覆盖大部分            |
| **评论/留言**         | `{id,content,created_at}`，纯记录                                                                                                  | `types/task.ts:67-78`                                                                                | ★                         |
| **工时追踪**          | 单时间戳 `tracked_start`，**只能开始不能停**，工时 = `done?updated_at-...:now-...`                                                            | `task.ts:581-592`                                                                                    | ★★                        |
| **提醒**            | 前端 `setTimeout` 自调度，间隔可配 10–300s（默认 30s），提前量默认 1440min，去重键持久化                                                                  | `src/lib/utils/reminder.ts:92-149`；`src/routes/+layout.svelte:49-92`                                 | ★★★                       |
| **完整/简洁字段模式**     | `visibleFields` 只是 UI 谓词，数据不删（切回即复原），存**本机 localStorage**、不随项目同步                                                               | `src/lib/stores/task-fields.ts:36-124`                                                               | ★★                        |
| **里程碑**           | `Milestone{id,title,date,color,description}`，在概览页展示                                                                            | `types/project.ts:70-85`                                                                             | ★★                        |
| **变更日志（A.B.C）**   | A/B 位手动递增、C 位软件自动记录；`auto?:boolean` 区分展示权重                                                                                     | `types/project.ts:50-66`                                                                             | ★                         |
| **项目模板**          | 5 种（default/electron/hardware/web/todo），各带目录结构 + 文件内容生成器                                                                       | `types/project.ts:17`；`src/lib/templates.ts`                                                         | ★★ 可对应你的「项目」模块            |

### C. 视图与可视化

| 视图                 | 实现要点                                                                                                                      | 依据                                                                | 建议                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| **Timeline（甘特）**   | 横向；左侧 200px 任务名列 + 右侧百分比定位；**时间是百分比不是像素**；**依赖感知排期 = DFS+记忆化**（非显式拓扑排序）；今天线 2px 红；**只能画布平移，不能拖动条**；**无缩放、无吸附、无 SVG 依赖箭头** | `src/lib/components/views/Timeline.svelte:45-133,281,299,352-367` | ★★ 你的「时间轴」是**日内轴**，它的是**跨日轴**，可以互补成两个视图 |
| **TaskGraph（依赖图）** | 自研 SVG；**Kahn 最长路径分层**；节点固定 160×64；**三次贝塞尔**右中→左中；层内**无 barycenter 排序**（只按出现序）                                            | `TaskGraph.svelte:35-38,49-114,143-144,232-239`                   | ★                                       |
| **Kanban**         | 列**可配置**（`kanban_columns`，可增删/双击改名）；`resolveInsertIndex` + `skipHistory` 让「跨列+调序」只记一次撤销                                   | `Kanban.svelte:26-104`                                            | ★★ 「自定义列」你可能想要                          |
| **Calendar**       | 跨日线**无 lane 分配**，靠 `top: i*4px` 依次堆叠；每格独立渲染自己那段、靠同色同高拼成连续线；日号 `margin-top` 下移让位                                           | `Calendar.svelte:64-82,214-227,346-379`                           | ★★ 你的日历已有任务名，可加「跨日任务条」                  |
| **TaskList**       | 前端过滤（非索引）；拖拽时把「可见子集下标」换算回「全量下标」                                                                                           | `TaskList.svelte:72-85`；`src/lib/utils/reorder-target.ts:29-55`   | ★★ 这个换算你已经有类似实现                         |
| **Stats**          | 完成率/状态/优先级/标签分布/近 4 周趋势/工时；**纯 CSS 自绘**（`conic-gradient` 环形 + flex 柱），无图表库                                                | `src/lib/utils/stats.ts:86-209`；`Stats.svelte:13,54-78`           | ★★★ 便宜且好看                               |
| **GitLog**         | Rust `git2` revwalk（**无分页/数量上限**）；远程 GitHub API 单页 100                                                                    | `src-tauri/src/git/local.rs:5-45`；`git/remote.rs:25-28`           | ★                                       |
| **Flowchart**      | 画布用 `@xyflow/svelte`，节点形状自研；「自动布局」只是 `sqrt(n)` 网格                                                                         | `Flowchart.svelte:182-187,265-272`                                | ✗ 引入 xyflow 太重                          |
| **共享底座**           | `use:sortable`（423 行，Pointer Events 统一鼠标/触摸 + ghost + autoScroll + 兄弟让位 + 拖后抑制 click）被 Sidebar/Kanban/TaskList 三处复用       | `src/lib/actions/sortable.ts:107-423`                             | ★★★ 思想对；但你已有自己的实现                       |

### D. 应用层 UX

| 功能             | ref-pm 实现                                                                                                                          | 依据                                                       | NimbusDesk 现状                                       | 建议                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | --------------------- |
| **命令面板**       | 硬编码 28 条 builtin + 插件命令；`Ctrl+K`；**自研 substring 匹配、无打分、无模糊算法**                                                                     | `src/lib/components/shared/CommandPalette.svelte:41-125` | **装了 `cmdk` 但零引用**（`src/components/ui/command.tsx`） | ★★★                   |
| **全局搜索**       | **无索引**，每次按键全量线性扫项目/任务/子任务；分三桶拼接；**无相关度排序、无防抖**                                                                                    | `src/lib/stores/search.ts:98-167`                        | 无                                                   | ★★★                   |
| **快捷键**        | 单一 `<svelte:window onkeydown>`，`isEditing` 时让行；`Ctrl+K/N/F/Z/Shift+Z/,`、`1-9`、`Esc`、`?`；**不可配置**                                   | `src/routes/+page.svelte:97-142`                         | 无                                                   | ★★★                   |
| **快捷键帮助面板**    | **手写数组 8 条**，与真实逻辑双份维护 ⚠️                                                                                                          | `ShortcutHelp.svelte:18-27`                              | 无                                                   | ★★★ 但**要从注册表读**，别双份维护 |
| **Toast**      | 十几行 store：`toasts[]` + `toast(text,kind,ms=6000)`；有堆叠/超时，**无去重/无 Promise**                                                         | `src/lib/stores/toast.ts:19-35`                          | 已有 `sonner`，功能更强                                    | ✗ 你的更好                |
| **主题三态**       | `themeMode: light\|dark\|system`；`matchMedia('(prefers-color-scheme: dark)')` + `change` 实时生效                                      | `src/lib/stores/ui.ts:24-61`                             | **只有 `light\|dark`，无「跟随系统」**                        | ★★★                   |
| **颜色方案库**      | `stores/color.ts` 是「项目/标签调色板」的 CRUD（10 内置 + 自定义，最少保留 5），**不写 CSS 变量**                                                              | `stores/color.ts:17-28,60-126`                           | 无                                                   | ★★                    |
| **导出 HTML 报告** | 模板字符串拼整页 HTML，内联 `<style>`，light/dark 两套变量；中文字体 `-apple-system,'Microsoft YaHei','PingFang SC'`；`@media print{break-inside:avoid}` | `src/lib/utils/html-export.ts:73,161-182,236,342-390`    | 无                                                   | ★★                    |
| **导出 PDF**     | **必须走服务器**：`POST /api/report` → 服务器 `spawn chrome-headless-shell --print-to-pdf`                                                   | `server/pm-sync-server.mjs:214-251`                      | 无网络                                                 | ✗ 违背离线约束（可改用前端打印对话框）  |
| **教程/引导**      | `Tutorial.svelte` 421 行                                                                                                            | `src/lib/components/shared/Tutorial.svelte`              | 无                                                   | ★                     |
| **设置体系**       | 一个模态 + 8 Tab（appearance/colors/data/git/notifications/ai/plugins/about）                                                            | `src/lib/components/shared/Settings.svelte:11-45`        | 你已有独立路由 + 3 分类                                      | ✗ 你的更好                |

### E. 扩展性

| 功能       | ref-pm 实现                                                                                              | 依据                                                                                  | 建议                                      |
| -------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------- |
| **云同步**  | 三后端（自建 Node REST+SSE / WebDAV / GitHub Gist）；墓碑驱动删除；409 + `X-Base-Rev` 判定冲突                            | `src/lib/sync/types.ts:8-21`；`src/lib/sync/auto.ts:716`；`server/pm-sync-server.mjs` | ✗ 你要求纯本地无网络                             |
| **插件系统** | 单文件 JS，`new Function('ctx', '"use strict";\n'+code)` 执行；扩展 `commands`/`views`/`hooks`；**无沙箱**（与主应用同权限） | `src/lib/plugins/loader.ts:34-60`；`docs/PLUGINS.md` §4                              | ✗ 无沙箱 + 自用工具不需要                         |
| **自动更新** | Windows `tauri-plugin-updater`(minisign 签名) / Android 自定义 Rust + 系统安装器                                 | `src/lib/updater/index.ts:33-158`；`src-tauri/src/updater.rs:82-232`                 | ✗ 自用绿色软件不需要                             |
| **AI**   | OpenAI 兼容客户端；报告润色/任务拆解/进度汇报；密钥入 keyring                                                                | `src/lib/ai/index.ts`、`prompts.ts`                                                  | ★★ 你保留了另一会话的 feeds/AI 模块，可参考其 prompt 组织 |
| **凭据管理** | `keyring` crate                                                                                        | `src-tauri/src/sync/credentials.rs`                                                 | ✗ 不涉及                                   |

### F. 工程实践

| 功能                                   | ref-pm 实现                                                                                        | 依据                                                 | 建议                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------ |
| **i18n 一致性校验**                       | \~67 行正则抽取两个 ts 文件的 key→value，校验 ①key 双向对齐 ②`{占位符}` 集合一致 ③空文案                                    | `scripts/check-i18n.mjs`；`package.json:check:i18n` | ★★★ **最值得抄的脚本**                |
| **纯函数测试（无框架）**                       | 手写 `ok/eq` 断言；`ts-alias.mjs` + `--experimental-strip-types` 让 Node 直接 import TS                  | `scripts/test-*.mjs`、`ts-alias.mjs`                | ★★★ 你的 `verify-*.cjs` 已在做，可标准化 |
| **Rust 单测解耦**                        | `atomic_file.rs` 不依赖 tauri，`rustc --test` 直接跑                                                    | `atomic_file.rs:1-10`                              | ★★★                            |
| **e2e（裸 CDP，零依赖）**                   | 手写 WebSocket 驱动 headless Chrome（9223），**不引入 Playwright**                                         | `scripts/e2e-*.mjs`                                | ★★                             |
| **质量闸门**                             | `verify = svelte-check + check:i18n + check:acl + test`                                          | `package.json:verify`                              | ★★                             |
| **Android ACL 静态自检**                 | 解析 capabilities + cargo registry 权限 toml，与前端实际调用比对，**提前发现真机才报的错**                                | `scripts/check-android-acl.mjs`                    | ✗ 你不做 Android                  |
| **Tauri 资产路径修补**                     | 把 `build/*.html` 绝对 `/_app/` 改相对                                                                 | `scripts/fix-tauri-assets.mjs`                     | ✗ Vite 不需要                     |
| **文档生成**                             | 582 行自研 JSDoc/Rust doc → HTML 站点                                                                 | `scripts/generate-docs.mjs`                        | ★                              |
| **Conventional Commits + CHANGELOG** | 每版本记「问题/修改内容/结果」                                                                                 | `README.md:216-224`                                | ★★ 你已在用 conventional commits   |
| **模块级 JSDoc（写「为什么」）**                | 大量注释解释**为什么这么做**（如 `sortable.ts:1-22` 解释为何弃用 HTML5 DnD；`live-duration.ts:1-28` 记录 Svelte 5 响应式坑） | 全仓库                                                | ★★★ 这个习惯你已有，继续保持               |

***

## §2 值得深挖的 6 个机制

### §2.1 原子写：他现在比你多做三件事

```rust
// ref-pm  src-tauri/src/atomic_file.rs:19-50
create_dir_all(parent)
File::create("<path>.tmp") → write_all → flush → sync_all()   // ← ① fsync
if target.exists() { fs::copy(target, "<path>.bak") }         // ← ② 用 copy 不用 rename
fs::rename(tmp, target)
```

你的 `src-tauri/src/commands/data.rs:write_file`：

```rust
fs::write(&tmp, content)?;
if fs::rename(&tmp, path).is_err() { fs::copy(&tmp, path)?; remove_file(&tmp); }
```

差的三件事：

| # | 他做了                       | 你缺的后果                                                 |
| - | ------------------------- | ----------------------------------------------------- |
| ① | `sync_all()` 强制落盘（内容+元数据） | 断电时可能得到一个**长度正确但内容为空/全 0** 的 JSON 文件（NTFS 元数据与数据分离刷盘） |
| ② | `.bak` 保留上一版本             | 主文件损坏时**没有任何回退**；解析失败的 `Err` 直接冒泡到前端                  |
| ③ | `read_file_with_fallback` | 你没有自愈路径                                               |

**关于 ② 的一个细节值得学**：他用 `copy` 而不是 `rename(target, bak)`，注释写得很清楚 —— *"即便紧接着崩溃，原文件仍在原位，不会出现「两个都没了」"*（`atomic_file.rs:34-36`）。这个推理是对的。

**你已有但要注意的地方**：你的 `write_file` 里 `rename` 失败才 fallback 到 `copy`+`remove`。这个分支在 Windows 上意味着「目标被占用」—— 但 `copy` 到被占用的目标同样会失败。这个 fallback 基本是死代码，建议要么删掉、要么改成「先重试 3 次（间隔 100ms）再报错」。

**建议改动**（约 30 行）：`data.rs:write_file` 加 `sync_all()`；新增 `.bak` 写入与 `read_file` 回退；失败时 `Err` 里带上「哪一步 + 哪个路径 + os error」（他的 `ctx()` 辅助函数，`atomic_file.rs:53-56`）。

### §2.2 写失败可见告警：一个「单一出口」模式

他的核心设计是把 localStorage 的所有写入收进一个 `safeSetItem()`（`storage-health.ts:151-165`），让**配额、序列化失败、权限**三种失败都从同一处冒出：

```
safeSetItem(key, value):
  try  setItem → 成功则 clearError()
  catch e → reportStorageFailure(reason)  // error + console.error + 10s Toast
```

然后顶栏渲染一个红色告警条（`+layout.svelte:180-188`，`role="alert"`），点击进设置的数据页。

**你为什么需要它**：`src/lib/storage.ts:flush()` 现在是

```ts
.catch((e) => console.error(`[storage] write ${key}:`, e));
```

—— 用户改了分类名、切换了主题、编辑了任务，如果磁盘满了/目录被删了/权限变了，**界面毫无反应**，用户以为保存了。这是他这份代码里对「不可靠环境」最实事求是的处理。

**落地建议**：给你的 `src/lib/storage.ts` 加一个 `storageHealth` zustand store（`{error, problem, detail, at, clearError}`），`flush()` 的 catch 里写入；在 `titlebar.tsx` 下方渲染告警条。约 60 行。

### §2.3 一键备份/恢复：注意「恢复是合并，不是覆盖」

最值得学的是**恢复语义**（`backup.ts:215-243`）：

```
mergeBackupInto(backup):
  for each 备份项目:
    本地有同 id?  → 比 updated_at，新者胜
    本地没有?     → 新增
  本地独有的项目 → 永不删除
```

理由（README 原话）：*"恢复为合并模式（同 ID 比 updated\_at，本地独有永不删除）"*。

对比一下，`pm-schema.ts` 的**导入校验**是「严格失败即整体拒绝」，而**备份恢复**是「宽松、跳过坏条目并计数」（`backup.ts:130-193`）。这个区别不是不一致，是**刻意的**：导入是「引入外部数据」，宁可拒绝；恢复是「找回自己的数据」，宁可多救回来。这个判断力值得学。

**你的场景**：你的数据目录（`<exe>/data/` 或自定义目录）里有 `settings.json` / `files.json` / `fences.json` / `plans.json` / `plans-archive.json`。备份应打包这些 JSON + `categories/` 目录结构清单（**不打包实际文件**，你的分类目录可能很大）。恢复时按 id 合并，报告「新增 N / 更新 M / 跳过 K」。

### §2.4 撤销/重做：他这么做，但你可能不该照抄

他的实现（`history.ts:42-104`）：

```ts
MAX_HISTORY = 50
pushHistory() → undoStack.push(JSON.parse(JSON.stringify(get(_projects))))
                redoStack = []
```

**每次 mutation 前**深拷贝**全部项目（含全部任务）**，存内存，不落盘。清理只靠 50 上限。

优点：实现极简（约 60 行）、100% 正确（不写 diff 就不会算错 diff）。
缺点：50 × 全量数据的内存。他数据小（一个项目几百任务）所以无所谓。

**你的数据更大**（文件管理可能有几千条目 + 图标 data URL）。如果照抄，50 份深拷贝可能上百 MB。三个选项：

| 方案                                    | 成本                | 适合                         |
| ------------------------------------- | ----------------- | -------------------------- |
| A. 照抄但只快照当前域（如只快照 `plans.days[date]`） | 极低                | **推荐先做这个** —— 计划管理的单日任务量很小 |
| B. 命令式 undo（存逆操作）                     | 高（每个 action 都要写逆） | 不建议                        |
| C. 引入 `zundo`（zustand 生态）             | 中                 | 如果想要全局 undo                |

我倾向 **A**：先只给计划管理加单日撤销，`Ctrl+Z`，栈上限 30。

**他这里有个明确的 bug 你可以避开**：`undo()` 只 `_projects.set()`（`history.ts:82-84`），触发的 subscribe 只 `saveProjects`（`project.ts:58-60`），**不重写 `pm_file_<id>`** —— 所以撤销之后同步会把旧快照推上服务器。你的 `tauriJsonStorage` 是「一个 key 一个文件」，没有双写，**天然不会踩这个坑**。

### §2.5 循环任务：纯函数 + 边界正确 + 可单测

这是整个项目我认为**设计最干净**的部分。它的做法：

1. **纯函数模块**：`recurrence.ts` 不碰 store、不硬编码文案（只返回 i18n key），所以 `scripts/test-recurrence.mjs` 能用 node 直接跑边界用例（`recurrence.ts:1-13`）。
2. **归位不溢出**：
   ```
   makeClampedDate(y, m, d) = new Date(Date.UTC(y, m, min(d, daysInMonth(y,m))))
   ```
   1/31 每月 → 2/28 → 3/28（`recurrence.ts:46-54,143-155`）。
3. **规则归一化容错**：`normalizeRule` 把非法输入（freq 写错、interval=0、end 非法）全部修正为合法值，**保证写进文件的规则一定合法**（`recurrence.ts:74-86`）。
4. **消费语义明确**：`count` 是「剩余次数」，`consumeRule()` 每次 −1 且不低于 0，且**不改原对象**（返回新对象），顺带删掉 `sourceTaskId`（`recurrence.ts:174-180`）。
5. **原子变更**：原任务 `recurrence=null` + `status='done'` + push 新实例，**在同一次 `projects.update` 内完成**（`task.ts:237,260-269`）；规则在变更前先读出。

**一个他的 bug 值得你知道**：monthly/yearly **每次都从当前实例的日号重算，不记忆原始锚点日**。所以 1/31 → 2/28 → **3/28**（不是回到 31）。测试只覆盖单步所以没暴露（`recurrence.ts:147`）。你如果做循环任务，需要额外存一个 `anchorDay` 字段。

**对你的价值**：「每日计划 + 循环任务」是天然搭配 —— 「每天早上 9 点跑步」不用手动建 365 条。你的数据模型已经解决了最难的 `start`/`end` 区间 + `statusOf()` 纯函数派生，加 `recurrence` 是顺势而为。

### §2.6 提醒：前端自调度 + 去重键持久化

实现（`reminder.ts:92-149` + `+layout.svelte:49-92`）：

* **前端 `setTimeout` 自调度**（不用 `setInterval`，因为每轮要重读设置），`onMount` 启动，间隔 10–300s（默认 30s）
* 去重键持久化在 localStorage，手动提醒 `id:manual:<time>`，截止提醒 `id:deadline:<iso>:advance:<min>`
* 通知走 `tauri-plugin-notification`，先 `isPermissionGranted` 再 `requestPermission`，catch 回退 Web Notification API（`reminder.ts:160-179`）
* **应用关闭后不能提醒**（没有 Rust 侧后台任务）；关闭期间的提醒会在下次启动后因 `triggerTime <= now` **立即补发**

**你的现状**：`grep -rn "notification\|reminder" src src-tauri/src` → **零命中**。你完全没有通知能力。

**为什么这条性价比最高**：你的计划管理已经有 `start`/`end` + `useNow()` 分钟对齐（`plans/store.ts:194-206`）—— 距离「到点提醒」只差：

1. Rust 侧加 `tauri-plugin-notification`（Cargo.toml 加一行 + `lib.rs` 加 `.plugin()`）
2. 一个 `reminder.ts`（可大量参考他的，去掉移动端分支）
3. 在 `useNow()` 的 tick 里检查「哪些任务的 `start` 刚跨过」

**并且你应该做的比他好**：他**没有 Rust 侧后台任务**，应用关了就不提醒。你是 Tauri 2 + Windows，可以用 `tauri-plugin-autostart` 或一个轻量 Rust 定时器做到「应用在托盘里也能提醒」。不过你之前把「开机自启」列为暂缓 —— 那就先做「应用运行中提醒」。

***

## §3 与 NimbusDesk 的逐项对照

### 你已经有、不需要抄的

| 能力             | 你的实现                                                           | ref-pm                               |
| -------------- | -------------------------------------------------------------- | ------------------------------------ |
| 落盘防抖           | **250ms trailing debounce**（`storage.ts:17`）                   | 无 debounce，逐次全量写                     |
| 跨窗口同步          | `storage://changed` 广播 + `onStorageSynced`（`storage.ts:31-57`） | 无（单窗口）                               |
| 主题切换动画         | **View Transitions 径向扩散 + GSAP 回退**                            | 只有类名切换                               |
| 自定义标题栏 / 无边框窗口 | 完整实现                                                           | 用系统装饰                                |
| 桌面栅栏（拖入收集/拖出）  | OLE drag-out，Rust `dragdrop.rs`                                | 无                                    |
| 原生系统图标         | `SHGetImageList(SHIL_JUMBO)` + box-filter 降采样                  | 无（SVG 图标）                            |
| 原生右键菜单 / 新建文件  | `fileops.rs` + `newfile.rs`（4 级解析）                             | 只有应用内菜单                              |
| 回收站删除          | `SHFileOperationW` + `FOF_ALLOWUNDO`                           | 无（逻辑删除墓碑）                            |
| 设置独立路由页        | 已实现                                                            | 模态窗口                                 |
| 自定义数据目录 + 迁移   | `data.dir` 指针文件 + 3 级优先级                                       | 固定 localStorage                      |
| 多级嵌套任务树        | `PlanTask{parentId}` 无限层级                                      | 只有 1 层子任务 checklist                  |
| 时间范围 + 派生状态    | `start`/`end` + `statusOf()` 纯函数 + `useNow()`                  | `due_date`/`due_time` + 持久化 `status` |

### 你缺、值得做的（按性价比排序）

| #  | 事项                          | 成本                | 收益        | 参考                          |
| -- | --------------------------- | ----------------- | --------- | --------------------------- |
| 1  | 原子写补 `fsync` + `.bak` + 读回退 | \~30 行 Rust       | 防永久丢数据    | `atomic_file.rs:19-70`      |
| 2  | 写失败可见告警条                    | \~60 行 TS         | 防静默失败     | `storage-health.ts:107-165` |
| 3  | i18n key 校验脚本               | \~70 行            | 防静默故障     | `scripts/check-i18n.mjs`    |
| 4  | 一键备份/恢复（合并语义）               | \~250 行           | 防误删目录     | `backup.ts:88-243`          |
| 5  | 任务提醒（通知）                    | \~150 行 + 1 crate | 计划管理可用性翻倍 | `reminder.ts`               |
| 6  | 命令面板（cmdk 已装）               | \~200 行           | 多模块导航刚需   | `CommandPalette.svelte`     |
| 7  | 全局搜索                        | \~150 行           | 同上        | `search.ts`                 |
| 8  | 快捷键体系 + 帮助面板                | \~200 行           | 效率        | `+page.svelte:97-142`       |
| 9  | 主题「跟随系统」                    | \~30 行            | 细节体验      | `stores/ui.ts:24-61`        |
| 10 | 统计视图                        | \~200 行           | 数据洞察      | `Stats.svelte` + `stats.ts` |
| 11 | 任务优先级                       | 模型改动 + UI         | 排序/筛选基础   | `types/task.ts:37-41`       |
| 12 | 循环任务                        | \~250 行           | 每日计划刚需    | `recurrence.ts`             |
| 13 | 撤销/重做（单日范围）                 | \~120 行           | 防误操作      | `history.ts`（改造）            |
| 14 | 计划里加标签                      | 模型 + UI           | 与文件标签打通   | `types/task.ts:99-100`      |
| 15 | 甘特/跨日时间轴（第二个视图）             | \~400 行           | 与现有日内轴互补  | `Timeline.svelte`（重写）       |

***

## §4 明确不抄的 8 条（附理由）

| # | 功能                     | 不抄的理由                                                                                                      |
| - | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1 | **云同步三后端**             | 你的硬约束是「纯本地、无网络、无遥测」。这套东西（716 行 `auto.ts` + 独立 Node 服务器 + 墓碑机制 + 冲突弹窗）占了整个项目约 1/4 的复杂度，且与约束直接冲突             |
| 2 | **插件系统**               | `new Function` 执行任意 JS，**无沙箱**（他自己文档也承认「只装可信插件」）。给一个自用工具引入这个，成本 > 收益                                       |
| 3 | **自动更新**               | 绿色便携自用软件，不需要签名/发布/回滚链路                                                                                     |
| 4 | **Android / 触摸分支**     | 你的 DnD 代码里那些 `touch-action`、长按 220ms、`handleOnly` 全都是为移动端 WebView 服务的。在 Windows 桌面上是纯负担                    |
| 5 | **服务器端 PDF 导出**        | 需求里没有服务器。替代方案：`window.print()` + 打印 CSS（他其实也做了打印 CSS：`html-export.ts:161-182`）                             |
| 6 | **HTML5-DnD 替代方案的完整度** | 他用 Pointer Events 重写了 423 行拖拽是为了统一鼠标/触摸。**思想要学**（你已经在用 pointer capture），但不需要引入他那套 zone/ghost/autoScroll 全套 |
| 7 | **无索引全量搜索**            | 他的数据量小（几百任务）所以每次按键全扫无所谓。你的文件条目 + 图标可能有几千，需要建内存索引 + 防抖                                                      |
| 8 | **`sqrt(n)` 伪「自动布局」**  | `Flowchart.svelte:182-187` 的「自动布局」就是网格排列，名不副实。如果要做，直接用 dagre/elk                                           |

### 另外三个「他有 bug、你别抄」的点

| 位置                             | 问题                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `Timeline.svelte:77`           | `startDay = max(depEnd + dep.dayOffset - depComputed.duration)` —— 减掉了依赖任务的时长，公式与类型注释「完成后多少天后**开始**」语义不符，疑似 bug |
| `recurrence.ts:147`            | monthly/yearly 不记忆原始锚点日，1/31 → 2/28 → 3/28（回不到 31）                                                              |
| `task.ts:88-108` vs `:180-193` | `updateTask` 与 `canCompleteTask` **重复实现了依赖检查**，注释自己承认了这点，行为容易走偏                                                 |

以及他**宣传与实现不符**的地方（不要被 README 误导）：

* README 说备份有 `pm_backup_<ts>` 保留最近 3 份、导入前自动备份 → 代码里**不存在**，只有删除前备份（`backup.ts` 全文 + `sync/auto.ts:247-263`）
* README 说 Timeline 有「依赖感知自动排期、SVG 箭头展示依赖」→ 排期有（有 bug），**SVG 箭头只在 TaskGraph 里，Timeline 是纯 div**（`Timeline.svelte` 全文无 `<svg>`）
* README 说 Timeline 是甘特图 → 有甘特结构，但**无缩放、无吸附、不能拖动条改起止**

***

## §5 需要你决策的问题

1. **备份/恢复的范围**：只备份 5 个 JSON？还是也生成 `categories/` 目录结构清单（不含实际文件）？恢复时对已存在的磁盘文件怎么办（跳过/覆盖/提示）？
2. **撤销/重做做到什么程度**：只做计划管理单日？还是全局（需要处理文件管理的图标 data URL 内存问题）？
3. **循环任务要不要做**：如果做，是否采纳「存 `anchorDay`」以避免他的 1/31→2/28→3/28 问题？
4. **甘特图 vs 现有时间轴**：现有的是「日内时间轴（08:00–24:00）」，他的是「跨日甘特」。是要**两个都留**（互为不同视图），还是合并？
5. **优先级体系**：三值（高/中/低）够吗？还是想要四值（P0–P3）或数字权重？
6. **命令面板/全局搜索的搜索范围**：任务 + 文件条目 + 分类 + 标签 + 设置项？是否需要跨「计划」和「文件」两个域联合搜索？
7. **提醒的持久性**：接受「应用关闭后不提醒」（他的做法），还是要做托盘常驻/Rust 定时器？

***

## 附：几个直接可用的代码片段位置

需要时我可以把下面这些改写成 React/TSX + zustand 版本：

| 目标          | 参考文件                                                | 说明                                           |
| ----------- | --------------------------------------------------- | -------------------------------------------- |
| 原子写（Rust）   | `src-tauri/src/atomic_file.rs`                      | 全文仅 140 行，含 5 个单测，**结构可直接照搬到你的 `data.rs`**   |
| 写失败告警 store | `src/lib/stores/storage-health.ts:30-165`           | 只需 `error/problem/detail/at/clearError` 五个字段 |
| 备份序列化       | `src/lib/utils/backup.ts:88-102`（结构）、`:215-243`（合并） | 合并算法是核心                                      |
| 循环任务纯函数     | `src/lib/utils/recurrence.ts:46-180`                | 加 `anchorDay` 即可修正                           |
| 提醒调度器       | `src/lib/utils/reminder.ts:49-149`                  | 去掉移动端分支后约 80 行                               |
| i18n 校验     | `scripts/check-i18n.mjs`                            | 只需把 Svelte 的 i18n 换成 `react-i18next` 的取值方式   |
| 统计计算        | `src/lib/utils/stats.ts:86-209`                     | 纯函数，与框架无关                                    |

