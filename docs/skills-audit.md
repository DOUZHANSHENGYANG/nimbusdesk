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

1. **批量打标签缺失** —— 只有单个编辑里能加；20 个技能要打同一个标签得逐个点开。
2. **新建时只能手输标签** —— 不能从已有标签/分组里选，必然产生 `code` 与 `代码` 这种同义词。
3. **版本时间轴是手写的** —— `VersionList` 自己实现了 LCS diff 和行渲染；按约定应换开源件（diff：`react-diff-viewer-continued` 或 `diff` + 虚拟列表；时间轴：`react-chrono` / shadcn timeline block）。
4. **没有「检查更新」** —— git 来源的技能无法一键 re-pull、看上游变化；`skill_extension` 已经给了 treeHash，但没接 UI。
5. **没有流水线** —— 审查 → 摘要 → 发版是三个按钮，没有「一键走完 + 结果面板」。
6. **标签治理只有单条操作** —— 没有批量换组、批量合并、按使用次数清理。
7. **Harness 维度被删过头** —— 上一轮把「按来源筛选」整行删了，现在没有任何按 harness 收窄的入口；应作为标签体系里的「来源」分组回来，而不是一行药丸。
8. **没有使用统计** —— 不知道哪些技能从没被用过，删起来没依据。
9. **空态几乎空白** —— 0 个技能时只有一句「暂无标签」。

## 三、执行顺序（每刀独立可验证）

- ✅ **S1 批量标签**（`98b9251`）：批量工具条加「打标签」；新建与编辑共用 `TagPicker`
  （可从已有标签按分组选，也可新建）。
- ✅ **S2 版本与 diff 换开源组件**（`6bc45e7`）：`react-vertical-timeline-component` 做时间轴、
  `react-diff-viewer-continued` 做逐行/词级差异。
- ✅ **S2b 检查更新**（`c4f0e44`）：页头「检查更新」批量跑 `check_upstream`，结果弹窗按
  «有新版本 → 失败 → 未跟踪 → 已最新» 排序。
- ✅ **S3 流水线**（`581ad39`）：审查（体检）→ AI 摘要 → 打包导出，逐步状态与「只重跑这一步」。
- ⬜ **S4 Harness 维度**：每个技能接了哪些工具（徽标）、按工具收窄/分组、批量接入与移出、
  使用统计、空态引导。

## 四、还欠的（S4 明细）

1. **按工具看技能**：卡片上显示「已接入 Claude Code / Codex…」徽标；工具维度需要可收窄，
   但**不回到页头那一行药丸**——放进左栏卡片仓下面的一个「工具」区块，或独立的页签。
2. **批量接入 / 移出**：`apply_to_harness` / `remove_from_harness` 已有命令，缺一个
   「选工具 + 勾技能 + 一次执行」的对话框（含每工具成功/失败计数）。
3. **使用统计**：至少记录「上次使用时间」与「从未使用」，让删除有依据。
4. **空态引导**：0 个技能时给三条入口（ZIP / 文件夹 / Git 仓库），而不是一句「暂无」。

## 五、为什么之前总是做一半

每个回合都按「小步提交 + verify」推进，遇到新指令就切换战线，导致每次都只完成一个切面。
这次按 S1→S4 连续做，每刀都有截图和 `npm run verify`，不中途换方向。

