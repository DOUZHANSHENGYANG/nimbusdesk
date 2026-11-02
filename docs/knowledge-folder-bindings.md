# 笔记面：分类与归档落点

## 分类来自库结构，不来自应用配置

「笔记」面按**知识库自己的顶层目录**分类：`01-工作`、`02-IT`、`03-生活`、`04-资源`……目录改了名、加了一个区，界面跟着变，应用里不需要再绑一遍。收件箱（`00-Human工作区/Inbox`）单列成一类。

扫描规则（`src-tauri/src/knowledge/storage.rs` 的 `walk` / `note_kind`）：

| 位置 | 处理 |
| --- | --- |
| 库根下任意顶层目录 | 每一层目录算一个分类，分类名去掉数字前缀显示 |
| `00-Human工作区/Inbox/**` | 归到「收件箱」 |
| `99-系统`、`07-模板`、`assets`、`_raw`、`Trash`、`skills`、`node_modules` | 不扫描 |
| 隐藏文件、符号链接/联接 | 跳过（不跟随） |

## 三个绑定文件夹只决定「归档去哪」

设置 → 开发知识 → **归档落点** 里的三条路径（默认 `01-工作/开发经验`、`01-工作/开发配方`、`04-资源`）**不再决定笔记栏显示什么**，只决定 AI 整理完的笔记落到哪。改它们不会移动任何文件，缺失目录在归档时创建。

新收集的材料仍在 `00-Human工作区/Inbox/工作台/<条目ID>/`，图片仍用 `assets/images/工作台/` 和 WikiLink。

> 全库管理（体检 / 分诊 / 闭环）见 `docs/knowledge-vault-management.md`。

## 怎么验证

```powershell
npm run check:knowledge
cargo test --manifest-path src-tauri/Cargo.toml --lib knowledge
```

夹具：`npm run dev` 后打开 `http://127.0.0.1:17800/src/features/knowledge/fixtures/manager.html?view=notes`，能看到按区域分的六类（全部 / 收件箱 / 工作 / IT / 生活 / 资源）。

后端单测里固定了这条规则：

- `scan_covers_every_area_by_top_folder`：每个顶层目录都进列表，`kind` 就是目录名，收件箱单列；
- `bindings_do_not_limit_the_scanned_scope`：换绑定不影响扫描范围；
- `scanning_limits_scope_and_reports_failures`：`skills/`、隐藏目录不扫。
