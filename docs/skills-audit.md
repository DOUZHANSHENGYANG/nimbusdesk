# Skills 现状盘点与差距（2026-10-25）

> 依据：`src/ahub/lib/api.ts`（后端命令）、`src/ahub/components/AddSkillDialog.tsx`、`src/ahub/pages/SkillsPage.tsx`、`src/ahub/components/VersionList.tsx`。

## 一、已经有的能力

| 环节 | 现状 | 位置 |
|---|---|---|
| 新建：空白 | 表单直接写 name/desc/tags/body | `AddSkillDialog` mode=`create` |
| 新建：文件 | **文件夹**与 **ZIP** 两种，拖拽或选择 | mode=`file`；`import_skill_folder` / `import_skill_zip` |
| 新建：Git | 克隆仓库自动发现多技能、勾选导入；内置 Anthropic / MiniMax / Superpowers 三个源 | mode=`git`，`skill_import_explore` |
| 新建：市场 | 腾讯 SkillHub 搜索、分类、批量安装 | `MarketCategory` / `MarketSkill` |
| 导入质检 | 导入前 explore 报告 + 一键修 + AI 修 | `skill_import_apply_fixes` / `skill_import_ai_fix` |
| 编辑 | 名称、描述、标签、正文、frontmatter | `save_skill` |
| 版本 | 打版本（L1/L2…）、版本列表、行级 diff、回滚、清空 | `release_skill_version` / `VersionList` |
| 审查 | `vet_skill`：verdict + critical/high/medium + findings | `VetReviewPanel` |
| 摘要 | 单个 / 批量生成 | `skill_generate_summary(_batch)` |
| 状态 | 启用 / 停用 / superseded | `set_skill_status` |
| 打包 | 单个 / 批量导出 zip、skillpack | `pack_skill(s_batch)` |
| 接入 | 批量补齐协议文件并审查 | `onboard_skills_batch` |
| 检索 | 关键词 + 标签（与/或）+ 预设 + 网格/分组视图 | `SkillsPage` |
| 批量 | 全选、接入、摘要、导出、启停、删除 | `batchMode` 工具条 |
| 标签 | 卡片仓（分组）+ 页签治理台（改名/删/换组） | `TagShelf` / `TagManagerView` |
| 来源 | harness 扫描导入、源目录 | `HarnessDialog`、`skillSourceDirs` |

结论：**引擎很全，缺的是「串起来」和「批量」**。

## 二、差距（按影响排序）

1. **批量打标签缺失** —— 只有单个编辑里能加；20 个技能要打同一个标签得逐个点开（S1 已补：批量工具条「打标签」）。
2. **新建时只能手输标签** —— 不能从已有标签/分组里选，必然产生 `code` 与 `代码` 这种同义词（S1 已补：`TagPicker` 按分组选）。
3. **版本时间轴是手写的** —— `VersionList` 自己实现了 LCS diff 和行渲染；按约定应换开源件（S2 已换：`react-vertical-timeline-component` + `react-diff-viewer-continued`）。
4. **没有「检查更新」** —— git 来源的技能无法一键 re-pull、看上游变化；`skill_extension` 已经给了 treeHash，但没接 UI（S2b 已补：页头「检查更新」批量跑 `check_upstream`）。
5. **没有流水线** —— 审查 → 摘要 → 发版是三个按钮，没有「一键走完 + 结果面板」（S3 已补：`SkillPipelineDialog`）。
6. **标签治理只有单条操作** —— 没有批量换组、批量合并、按使用次数清理（分组已可增改删；标签按设计只读，只能在条目自己的编辑框里改）。
7. **Harness 维度被删过头** —— 上一轮把「按来源筛选」整行删了，之前没有任何按 harness 收窄的入口（S4 已补回左栏「工具」区块）。
8. **没有使用统计** —— 不知道哪些技能从没被用过，删起来没依据（S4 已补：用工具目录里 SKILL.md 的 mtime 作「上次同步」信号）。
9. **空态几乎空白** —— 0 个技能时只有一句「暂无标签」（S4 已补：ZIP / 文件夹 / Git 三入口）。

## 三、执行顺序（每刀独立可验证）

- ✅ **S1 批量标签**（`98b9251`）：批量工具条加「打标签」；新建与编辑共用 `TagPicker`
  （可从已有标签按分组选，也可新建）。
- ✅ **S2 版本与 diff 换开源组件**（`6bc45e7`）：`react-vertical-timeline-component` 做时间轴、
  `react-diff-viewer-continued` 做逐行/词级差异。
- ✅ **S2b 检查更新**（`c4f0e44`）：页头「检查更新」批量跑 `check_upstream`，结果弹窗按
  «有新版本 → 失败 → 未跟踪 → 已最新» 排序。
- ✅ **S3 流水线**（`581ad39`）：审查（体检）→ AI 摘要 → 打包导出，逐步状态与「只重跑这一步」。
- ✅ **S4 Harness 维度**（`4d89335`；按工具分组视图 `2f764ab`）：卡片徽标 + 左栏「工具」区块 +
  批量接入/移出对话框 + 接入统计 + 空态三入口。

## 四、S4 明细（已做）

1. **按工具看技能**：卡片底部列出「已接入 Claude Code / Codex …」；左栏标签仓下面是
   独立的「工具」区块（不是页头药丸行），每行显示该工具下有多少条，并带「未接入工具」
   兜底项，点一下就把列表收窄到那个工具；视图切换还多一档「按工具」分组。
2. **批量接入 / 移出**：批量工具条 →「接入工具」打开对话框，切「接入 / 移出」两个方向，
   每个工具写清「将新增 / 将移除 n 项」，跑完按工具报成功、失败、跳过。
   后端 `remove_from_harness` 新增 `kind="skills"`，只删工具技能目录里的副本
   （校验目录名与 `SKILL.md`，不碰中枢库）。
3. **接入统计**：`scan_harnesses` 的每个 `DetectedSkill` 增加 `updatedAt`（SKILL.md 的
   mtime），即「上次同步到该工具的时间」；卡片徽标 hover 显示，详情页头部直接列出
   工具与日期。从未出现在任何工具目录里的技能标「未接入任何工具」，删除前一眼可见。
   工具运行时的真实调用记录各家都不落盘，这是能拿到的、最接近「用过没有」的信号。
4. **空态引导**：0 个技能时给 ZIP / 文件夹 / Git 仓库三张入口卡，加一个「扫描本机」，
   点任意一张直接打开 `AddSkillDialog` 对应入口。

截图：`docs/screenshots/tag-shelf.png`（徽标 + 工具区块）、
`docs/screenshots/harness-batch.png`、`harness-batch-remove.png`、`tag-empty.png`。

## 五、为什么之前总是做一半

每个回合都按「小步提交 + verify」推进，遇到新指令就切换战线，导致每次都只完成一个切面。
这次按 S1→S4 连续做，每刀都有截图和 `npm run verify`，不中途换方向。

## 六、2026-10-25 复查：还缺的（体验层，按优先级）

1. ✅ **上游只「检查」不「更新」**（2026-10-26 已补）：`UpstreamCheckDialog` 每行「拉取更新」+ 底部「全部更新」；按远端分组 clone，匹配同名技能覆盖，旧正文进版本历史，写回 `[source.upstream]` 后重新检查。
2. ✅ **删除技能不会处理工具目录里的副本**（2026-10-26 已补）：单个/批量删除统一走 `DeleteSkillsDialog`，有副本时默认勾选「同时从工具移出」，按工具合并调用 `remove_from_harness`。
3. **使用统计是代理指标**：现在用工具目录里 `SKILL.md` 的 mtime 表示「上次同步」，
   不是运行时调用次数；各 harness 不暴露调用日志，这一项只能做到「从未接入」这一层。
4. ✅ **标签治理只能整组拖拽**（2026-10-26 已补）：标签治理台支持勾选多个标签后批量归组（也可清空到未分组）；标签本身仍不可改名/删除。
5. **跨类型总览缺失**：技能和 MCP 各自有「工具」区块，但没有一屏能看到「某个工具下
   有多少 skills、多少 MCP、哪些过期」，`HarnessDialog` 还是按 kind 分开的。
6. ✅ **MCP 空态还很素**（2026-10-26 已补）：空态补「从 JSON 粘贴」「从工具导入」两个入口。

> 导入打标签这一条本轮已经补上：ZIP / 文件夹 / Git / 市场导入成功后自动弹出批量打标签，
> 作用范围是刚导入的那批技能。

## 七、2026-10-26 本轮补齐（上游更新 + 删除联动）

| 项 | 做了什么 | 证据 |
|---|---|---|
| 上游一键更新 | 检查结果每行「拉取更新」、底部「全部更新（n）」；同一 remote 只 clone 一次，按目录名/技能名匹配后覆盖；旧正文自动写入版本历史；覆盖后写回 `[source.upstream]` 并重新检查 | `docs/screenshots/upstream-check.png`、`upstream-updated.png` |
| 删除联动工具副本 | 单个与批量删除共用 `DeleteSkillsDialog`：列出会动到的工具，默认勾选「同时从工具移出」，按工具合并调用 `remove_from_harness(kind="skills")`；不勾选则只删中枢 | `docs/screenshots/skill-delete-harness.png` |
| 覆盖导入保留标签 | `import_skill_dir_as` 在覆盖时合并旧 `.hub.json` 标签与上游 frontmatter 新标签，不再把用户手打标签清掉 | `cargo test`（ahub::skills 57 项通过） |

剩余体验层差距仍是第六节第 3–6 条；下一步优先做「跨类型工具总览」或「标签治理批量归组」。


