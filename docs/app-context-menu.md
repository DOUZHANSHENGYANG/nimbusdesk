# 全局右键菜单

宿主在 `src/components/shell/app-context-menu.tsx`，包住整个工作台。菜单本身只有两项：

| 项 | 行为 |
| --- | --- |
| 全局搜索 | 呼出搜索窗 |
| 设置 | 跳到设置页（已在设置页时打勾） |

**不再有「快速跳转」那一长串导航**：首页 / 计划 / 知识库 / 插件 …… 都从侧栏走，
右键菜单里铺 12 项只是把侧栏抄了一遍。

## 页面自己加菜单项

```tsx
import { useAppMenuItems } from "@/components/shell/app-context-menu";

useAppMenuItems([
  { id: "files.new-box", label: t("files.newBox"), icon: FolderPlus, onSelect: () => setNewBox(...) },
  { id: "files.desktop-grid", label: desktopShown ? t("files.desktopGridOff") : t("files.desktopGridOn"),
    icon: Monitor, onSelect: () => void toggleAllFences(!desktopShown) },
]);
```

- 只在当前路由显示：注册时按 `pathname` 记，离开页面自动注销；
- 项目顺序 = 传给钩子的顺序，渲染在「搜索」下面、「设置」上面，前面自动加分隔线；
- 回调从 ref 取最新一份，所以列表里可以读当前 state（上面的 `desktopShown`），
  不必把函数塞进依赖；
- `id` 要稳定，钩子靠它判断要不要重挂。

现有注册：文件收纳页 → **新建收纳盒** / **开启（关闭）桌面栅格**。

## 验证

- `npx tsc --noEmit`、`npm run check:desktop`（菜单数据模型与图标桩）。
- 手测（真窗口）：文件收纳页右键 → 全局搜索 / 新建收纳盒 / 开启（关闭）桌面栅格 / 设置；
  切到别的功能页 → 只留 搜索 + 设置。浏览器夹具不支持右键，这两条没在夹具里跑过。
