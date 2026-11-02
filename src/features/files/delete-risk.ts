/**
 * 删除风险分级 —— 参考 Pogget 的 `DeleteUndoRiskPolicy`。
 *
 * 为什么要有它：现在的删除确认框对「一个 3 KB 的快捷方式」和「一个 80 GB 的项目目录」
 * 说一样的话，用户很快就学会无脑点确定。分级之后，只有真正值得停一下的操作才会
 * 被强调；小文件仍然一次确认就走完。
 *
 * 判定只看三件低成本能拿到的事（不多读一次磁盘）：
 *  - 是不是文件夹（目录内容不可直接看到，误删代价最大）
 *  - 总字节数（`path_meta` 给的文件大小；目录不递归统计，见 Rust 侧注释）
 *  - 条目数（批量删除）
 *
 * 纯函数，`node --test` 里直接跑。
 */

export interface DeleteRiskEntry {
  /** 与 FileItem.type 对齐；网页条目不动磁盘，不参与风险 */
  kind: "file" | "folder" | "url";
  /** 文件字节数；目录或取不到时为 null */
  size?: number | null;
}

export interface DeleteRisk {
  /** 参与风险判定的本地条目数（网页条目已排除） */
  localCount: number;
  /** 已知字节总数 */
  bytes: number;
  hasFolder: boolean;
  /** 有条目拿不到大小 —— 不能把「未知」当成「很小」 */
  unknownSize: boolean;
  severity: "low" | "high";
}

/** 单个文件超过这个体量就值得停一下 */
export const BIG_BYTES = 100 * 1024 * 1024;
/** 一次删这么多条，即使都很小也值得停一下 */
export const BATCH_LIMIT = 5;

export function assessDeleteRisk(entries: DeleteRiskEntry[]): DeleteRisk {
  const local = entries.filter((entry) => entry.kind !== "url");
  const bytes = local.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const hasFolder = local.some((entry) => entry.kind === "folder");
  const unknownSize = local.some((entry) => entry.size === null || entry.size === undefined);
  const high = hasFolder || bytes >= BIG_BYTES || local.length >= BATCH_LIMIT;
  return {
    localCount: local.length,
    bytes,
    hasFolder,
    unknownSize,
    severity: high ? "high" : "low",
  };
}

/** 「12.3 MB」这种给人看的体积；拿不到大小返回空串 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
