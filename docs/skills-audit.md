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

- **S1 批量标签**：批量工具条加「打标签 / 清标签」；新建与编辑共用 `TagPicker`（可从已有标签选，也可新建并归组）。
- **S2 版本与 diff 换开源组件** + 「检查更新」（git 来源：拉取、比较 treeHash、展示变更）。
- **S3 流水线**：`审查 → 摘要 → 发版` 一键执行，逐步状态与失败重试。
- **S4 Harness 维度**：来源徽标、按来源分组/批量更新/停用；补使用统计与空态引导。

## 四、为什么之前总是做一半

每个回合都按「小步提交 + verify」推进，遇到新指令就切换战线，导致每次都只完成一个切面。这次按 S1→S4 连续做，每刀都有截图和 `npm run verify`，不中途换方向。
