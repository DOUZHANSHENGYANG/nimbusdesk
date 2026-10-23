# 存储层：把「一个 key = 一份大 JSON」拆开

> 状态：**阶段 1 已完成**（Rust 行级表 + `files_load` / `files_apply` + 单测，尚未被前端调用，
> 因此**还没有性能变化**）；阶段 2 起是真正切换写入路径，见下面的「实施步骤」。
> 第一阶段（大文档批处理窗口 + 兜底落盘）已上线，见 `docs/performance.md`。

## 为什么是「行级表」而不是「分片 JSON」

一开始的方案是按分类把 `files` 切成 `files:items:<categoryId>` 几个 key。放弃的原因很具体：
**整目录映射进来的东西通常全在同一个分类里**，那一片就是整份文档，拆了等于没拆。
真正让代价与总量脱钩的只有行级 —— 改一条就是一条 `UPDATE`。

这也符合用户此前的判断：「合适用 sqlite3 保存，用它没问题；软件还在开发阶段，没有真实用户」——
所以**不需要迁移**：旧 `files` 键直接弃用，读到空表时回退读一次旧键即可（兜底而非迁移）。

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
     删分类不留孤儿行、搜索读同一批行。`cargo test --lib` 628 项全绿。
   - **尚未被前端调用，因此还没有性能变化。**

2. **⚠️ 阶段 2（下一步）**：前端切到行级写入。
   - `src/stores/files.ts`：把 `createJSONStorage(() => tauriJsonStorage)` 换成一个
     `PersistStorage` 适配器：`getItem` → `files_load`（空表则回退读一次旧 `files` 键）；
     `setItem` → 与上一份快照比对后只推增量（内容变了的带 `value`，只是位置变了的走 `reorder`），
     调 `files_apply`；
   - 增量的比对逻辑抽成纯函数（`src/lib/files-diff.ts`）并单测：新增/删除/改字段/移动/换分类；
   - 跨窗口：`files_apply` 后由 Rust 发 `files://changed`（带同一份增量），
     `providers.tsx` 的 `StorageSync` 监听并合并进本窗口的 store。

3. **⚠️ 阶段 3（与阶段 2 同一个提交才有意义）**：把两个「读旧 blob」的读者切过来。
   - `src-tauri/src/search/sources.rs`：`from_states` 里那段 `states["files"].items` 改成
     读 `files_table::search_entries(&conn)`（调用方需要把连接传进来，`runtime.rs` 侧顺一遍）；
   - `src/features/settings/backup.ts`：导出时 `readJson("files")` 改成 `invoke("files_load")`；
     导入侧不用动（它只把数据写回 store，由新写入路径落库）；
   - 验收：`cargo test --lib`、`npm run verify`、`npm run verify:dist`、
     以及新加一条浏览器断言（文件页做一次编辑后，`files_apply` 的增量只含那一条）。

4. **阶段 4**：删掉旧 `files` 键的回退读取与 `database.rs` 里 `"files"` 的命名空间映射。

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
