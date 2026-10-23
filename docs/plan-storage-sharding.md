# 存储层：把「一个 key = 一份大 JSON」拆开

> 状态：**阶段 1–3 已完成并上线**（Rust 行级表 + 前端增量写入 + 搜索/备份读表）。
> 阶段 4（删除旧 `files` 键的回退读取）留到下一版。第一阶段（大文档批处理窗口 + 兜底落盘）
> 见 `docs/performance.md`。

## 效果

| | 之前 | 现在 |
|---|---|---|
| 改一个条目 | 整份文档序列化（8000 条 ≈ 12 ms）+ IPC 2.5 MB + SQLite 重写整行 | **一条 `UPDATE`**：增量里只有那一条 |
| 拖动排序 | 整份重写 | 只推 `reorder`（位置），**不重写任何 payload** |
| 搜索索引 | 读 `module_state['files']` 整份 blob | 读 `file_items` 行 |
| 备份导出 | `readJson("files")` | `files_load`（形状不变，导入侧不用改） |

浏览器回归里的实测断言：800 条批量导入 → 一次 `files_apply`（800 条 upsert）；随后只改一条
→ 下一次 `files_apply` 的增量里**只有 1 条 upsert**（`check:files-list` 里那条「行级写入：改一条只推一条」）。

## 为什么是「行级表」而不是「分片 JSON」

一开始的方案是按分类把 `files` 切成 `files:items:<categoryId>` 几个 key。放弃的原因很具体：
**整目录映射进来的东西通常全在同一个分类里**，那一片就是整份文档，拆了等于没拆。
真正让代价与总量脱钩的只有行级 —— 改一条就是一条 `UPDATE`。

这也符合用户此前的判断：「合适用 sqlite3 保存，用它没问题；软件还在开发阶段，没有真实用户」——
所以**不需要迁移**：旧 `files` 键不回写，读到空表时回退读一次旧键（兜底而非迁移）。

## 问题（实测）

存储形态：SQLite 单表 `module_state(module, feature, key, value_json, …)`，**一个 key 一行、整份 JSON**。
`write_json` 走「读远程 → 三方合并（`state_merge::merge`）→ `upsert` 重写整行」，项目相关的键还会
在同事务里同步到 `project_*` 规范化表。也就是说：**改一个字段 = 整份文档序列化 + 一次 IPC + 整行重写**。

用真实形状的合成数据量到的量级：

| 文档 | 体积 | `JSON.stringify` | `JSON.parse`（Rust 侧同量级） |
|---|---|---|---|
| `files` 500 条 | 0.15 MB | 1.0 ms | 0.7 ms |
| `files` 2000 条 | 0.61 MB | 3.3 ms | 2.2 ms |
| `files` 8000 条 | 2.46 MB | 12.2 ms | 12.5 ms |
| `files` 20000 条 | 6.18 MB | 27.2 ms | 19.7 ms |
| `plans` 3 年（1095 天 × 8 条） | 1.45 MB | 8.7 ms | 6.8 ms |
| `plans` 10 年（3650 天 × 8 条） | 4.86 MB | 28.9 ms | 22.3 ms |

第一阶段之后，这类写入的**频次**已经降下来了（1.2 s 窗口 + 重复内容跳过 + 隐藏即落盘），
但**单次代价**没变：拖动整理文件、批量改标签时，1.2 s 一次 2.5 MB 的整行重写仍然可观。

## 目标

让「改一条」的代价与**文档总量无关**，只与改动的那一片有关。不改内存里的 store 形状（UI 不动），
只在持久化这一层把文档切开。

## 方案：按自然分区切 key

`files` 与 `plans` 都有天然分区，且 UI 一次只看一片：

| 现状 | 拆成 |
|---|---|
| `files`（categories + items） | `files:meta`（categories，很小）+ `files:items:<categoryId>`（该分类的条目） |
| `plans` + `plans-archive` | `plans:meta` + `plans:day:<date>`（每天一份），归档同理 |

要点：

1. **写入**：store 的 `set()` 仍产出整份状态，但持久化层按分区切片，逐片与「上次写出去的内容」
   比对（现成的 `sent` 去重表可以直接复用）——只有真正变过的片才排队、才走 IPC。改一条 = 写一片。
2. **读取**：水合时先读 `files:meta`，再按 meta 里的分类 id 逐个读分片（并发）。分类数量是几十量级，
   拆开读的总字节数与一次读整份相同，但可以并发，且首屏只等 meta。
3. **跨窗口回灌**：现有 `storage://changed` 是按 key 广播的 —— 分片天然受益：改一条只广播一片，
   其他窗口也只重读那一片（`applyRemote` 已按 key 处理）。
4. **Rust 侧不改**：`module_state` 本来就是通用 key→JSON，分片只是多了几个 key；
   `namespace(key)` 需要确认 `files:items:xxx` 能落到同一个模块命名空间（否则会分散到不同 module 行，无害但要看一眼）。
5. **备份**：`src/features/settings/backup.ts` 目前按键名枚举。需要改成「前缀枚举」——
   导出时把 `files:*`、`plans:*` 一起打包；导入时整组校验后再落盘（保持现在的原子性要求）。

### 迁移（必须可回滚）

1. 启动读 `files:meta`；不存在则读旧的 `files`。
2. 若读到旧 `files`：**先**把分片写成功，**再**写 `files:meta`（带 `shardedAt` 时间戳）作为「已迁移」标记；
   旧键**不删**，留作回滚与人工核对。
3. 之后所有写入只动分片；旧键保持不变（陈旧但完整）。
4. 回滚：删掉 `files:meta` 与所有 `files:items:*`，旧 `files` 立即重新成为真源。

同样的流程用于 `plans`（`plans-archive` 与它的成对事务需要保留：归档/恢复要把两天分片放进一个事务里，
`write_plan_pair` 要扩展成「多片一个事务」）。

## 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 数据丢失 | 迁移中任一步失败 | 只增不改：旧键保留到下一版；分片写成功才写 meta 标记 |
| 半迁移状态 | meta 存在但某些分片缺 | 读时校验「meta 列出的分类/日期都读到了」，缺则视为未迁移并回退到旧键 |
| 一致性 | 跨窗口同时改不同分片 | 每片独立的三方合并（`state_merge` 按片合并，语义比整份合并更简单） |
| 事务性 | 归档/撤销跨两个 day 分片 | 扩展 `write_plan_pair` 为多片事务；Rust 侧已在一个 writer 事务里，改动可控 |
| 备份/恢复 | 枚举不全 = 静默丢数据 | 备份改为前缀枚举 + 导入后比对条目总数（数量不符直接失败） |
| 搜索索引 | `sources_key(key)` 可能按 key 判断是否刷新 | 给分片 key 归一到同一个来源名 |

## 实施步骤（每步都能独立验收）

1. **✅ 阶段 1（已完成）**：Rust 行级表 + 两个命令 + 单测。
   - `src-tauri/src/files_table.rs`：`file_categories` / `file_items` 两张表（`payload` 存 JSON、
     `ord` 单独一列存顺序），`load()` / `apply(delta)` / `search_entries()`；
   - `commands/data.rs`：`files_load`、`files_apply`（在 `with_data_dir` 里跑，命令注册进 `lib.rs`）；
   - 单测 4 项：增量只动变了的行、顺序跟随推送的 index、`reorder` 不动 payload、
     删分类不留孤儿行、搜索读同一批行。

2. **✅ 阶段 2（已完成）**：前端切到行级写入。
   - `src/stores/files-storage.ts`（新）：`PersistStorage` 适配器 —— `getItem` 走 `files_load`
     （空表回退读一次旧 `files` 键）、`setItem` 与上一份落库快照比对后只推增量、成功后广播
     `files://changed`；
   - `src/lib/files-diff.ts`（新）+ 7 项单测：`diffFiles`（靠**引用相等**比对，不做序列化）与
     `applyFilesDelta`（按 `order` 重排，幂等）；
   - `src/app/providers.tsx`：`StorageSync` 增加 `files://changed` 监听，用
     `applyingRemote` 把回灌引起的 `set()` 挡在回写之外。

3. **✅ 阶段 3（已完成）**：两个读旧 blob 的读者切过来。
   - `src-tauri/src/search/sources.rs`：`from_states` 增加 `files_items` 参数，优先用行表数据，
     表空时回退整份 blob；`search/runtime.rs` 的 `rebuild` 从 `files_table::search_entries` 取；
   - `src/features/settings/backup.ts`：导出时用 `files_load`（放在附件导出之后，保持「先校验
     材料再动元数据」的既有次序），备份文件形状不变，导入侧零改动。

4. **阶段 4（部分完成）**：删掉 blob 时代的残件。
   - ✅ `search/sources.rs` 里那段 `states["files"]` 回退，并从 `KEYS` 移除 `"files"`；
   - ✅ `database.rs` 的 `"files" => ("files","catalog")` 命名空间映射；
   - ✅ `providers.tsx` 里 `storage://changed` 的旧 `files` 分支（整份文档回灌）；
   - ✅ **补上搜索刷新**：以前 `write_json("files")` 会经 `sources_key()` 触发索引重建，现在写路径换了，
     所以 `files_apply` 成功后显式 `request_refresh()` —— 漏了这条就是「改了文件但搜索里还是旧的」；
   - ⏳ **保留**：`files-storage.ts` 里「表为空时回退读一次旧 `files` 键」。删它的那天我试过，
     夹具立刻挂了 —— 那正是真机上的症状：**表刚上线时表还是空的，数据还在旧键里**，
     直接删回退 = 用户第一次启动看到空的文件库。等表里确认有数据、并跑过一次真实升级后再删。

## 关于 `plans`

**不建议现在动**：`plans` 的增长是自然的（一年约 0.5 MB），而它牵扯归档/恢复/撤销的**成对事务**
（`write_plan_pair`），要改成「多行一个事务」。风险与收益不成比例 —— 等 `files` 这条路跑顺、
并确认真机上 `plans` 确实变大之后再说。

## 我建议的前置条件

- 先在**真机上取一次真实数据**（`workbench.sqlite3` 里 `module_state` 各 key 的 `length(value_json)`），
  确认实际分布：如果最大的 key 也就 200–300 KB，这项的优先级应当降到「大文档才受益」的档位，
  不如把时间花在别处。
- 若真要动，建议**只做 `files`**：它是唯一会随「整目录映射」线性膨胀的键，`plans` 的增长是自然增长
  （一年 0.5 MB），且它牵扯成对事务与归档语义，风险远大于收益。

## 真机验证清单（只有你能跑，我这边没有 Tauri 运行时）

浏览器夹具用的是假后端，`files_apply`/`files_load` 的**真实**边界（真 SQLite、真 IPC、真重启）
只能在这台机器上确认。跑一次 `pnpm tauri dev`，按下面五项过一遍：

1. **数据没丢**：打开文件页，分类和条目都在（读的是旧的 `files` 键回退，不是空库）。
2. **第一次写入把它搬进表**：随便改一个条目标题 → 关掉应用 → 打开数据目录下的
   `workbench.sqlite3`，`SELECT count(*) FROM file_items;` 应该等于条目数（不再是 0）。
3. **重启后还在**：重开应用，刚才那处修改还在。
4. **增量生效**：改一个条目后立刻关窗，重开确认落盘；同时留意写盘是否变轻
   （资源监视器里该进程的磁盘写入，改一条不该再出现 MB 级写入）。
5. **搜索仍能搜到文件**：全局搜索里搜一个文件名，命中的是「书签/文件」类结果
   （这条验证 `files_apply → request_refresh()` 的接线）。

任一项不对，把 `%APPDATA%\nimbusdesk`（或 `data.dir` 指向的目录）里的 `workbench.sqlite3` 留下，
我可以按表里的实际状态定位。
