# 标签卡片仓（技能 / MCP / 提示词共用）

标签筛选从「一行药丸」换成**分组卡片**：每组一张卡，卡内多选，选中的进篮子；「管理」打开后可以新建分组、改名、删组，把标签拖到别的组。

## 为什么换

原来的 `TagFilter` 把标签、来源筛选、视图切换挤在同一层：标签一多就铺满两行，看不出标签属于哪个维度，也说不清「这些标签在筛什么」。

## 数据模型

标签本身仍是技能/MCP/提示词上的字符串数组，新增的只有一张「标签 → 组」的映射：

- `useTagGroups`（`src/ahub/stores/tag-groups.ts`，持久化键 `tag-groups`）；
- 纯逻辑在 `src/ahub/lib/tag-groups.ts`：`groupTags` / `assignTag` / `addGroup` / `removeGroup` / `renameGroup` / `pruneGroups`；
- 不迁移旧数据：没归组的标签显示在「未分组」卡里；删组只是把标签放回「未分组」，不会跟着消失。

## 交互

- 三个页面顶部都是 `列表 / 标签` 两个**页签**（不是弹窗）：`标签` 页整页是治理台 —— 左侧分组、中间表格（分组下拉 / 使用次数 / 改名 / 删除）、右侧当前命中数。
- 卡片仓的「管理」切到这个页签；⌘K 或仓里的 `⌘K` 按钮打开检索面板（分组列出标签，↑↓ 选、回车切换）。
- 点标签 = 加入/移出筛选；选满 2 个时出现「与 / 或」切换。
- 「管理」后拖动标签到任意分组卡即改归属；同一标签只属于第一个命中的组。
- 标签数超过 8 个或正在搜索时，右上角出现「搜索标签」输入框。
- 改名/删标签会真正写回条目：技能走 `readSkill` + `saveSkill`（保正文与 frontmatter），MCP 走 `saveMcp`，提示词走 `savePrompt`。

## 顺带删掉

技能页顶部的「按来源筛选（harness）」整行：一页里只服务一种来源，占一整行没用。`harnessFilter` 状态与两处过滤条件一并删除。

## 验证

- `npm run check:ahub`：`src/ahub/lib/tag-groups.test.mjs` 6 项（分组、去重、换组、删组回退、改名、剪枝）。
- 截图：`docs/screenshots/tag-shelf.png`（`src/ahub/fixtures/tag-shelf.html`，预置领域/阶段/来源三组）。
- 三个方向的探索稿在 `design-demos/tag-shelf/`（A 卡片仓 / B 检索优先 / C 治理台）。
