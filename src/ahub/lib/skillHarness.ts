import type { HarnessReport, SkillMeta } from "./types";

/** 只取技能标识：卡片、批量对话框都只需要这两个字段 */
export type SkillRef = Pick<SkillMeta, "dirName" | "name">;

/** 路径末级目录名，小写；用于和中枢里的 dirName 对齐 */
export function dirBase(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
}

/**
 * 某工具目录里是否已有这份技能。
 *
 * 优先按目录名匹配（apply 时就是 `dir.join(dirName)` 复制过去的）；
 * 也接受 frontmatter name 相同的情况 —— 用户手工放进工具目录的技能，
 * 文件夹名未必和中枢一致。
 */
export function isSkillApplied(report: HarnessReport, skill: SkillRef): boolean {
  if (!report.supportsSkills) return false;
  const dir = skill.dirName.toLowerCase();
  const name = skill.name.toLowerCase();
  return report.skills.some((d) => {
    const base = dirBase(d.path);
    return base === dir || (!!d.name && d.name.toLowerCase() === name);
  });
}

export function appliedHarnesses(reports: HarnessReport[], skill: SkillRef): HarnessReport[] {
  return reports.filter((r) => isSkillApplied(r, skill));
}

/**
 * 最近一次同步到工具的时间（毫秒）。0 = 从未接入任何工具。
 *
 * 取的是工具目录里 SKILL.md 的修改时间，也就是「这份技能上次被写进该工具目录」
 * 的时刻。各 harness 都不暴露运行时调用记录，这是能拿到的、最接近「用过没有」
 * 的信号：从未接入的技能，删除时最没有顾虑。
 */
export function lastAppliedAt(reports: HarnessReport[], skill: SkillRef): number {
  const dir = skill.dirName.toLowerCase();
  let max = 0;
  for (const r of reports) {
    if (!r.supportsSkills) continue;
    for (const d of r.skills) {
      if (dirBase(d.path) !== dir) continue;
      if (d.updatedAt > max) max = d.updatedAt;
    }
  }
  return max;
}

/** 卡片徽标上的名字：优先用全名，超过 12 个字符才截断（230px 的卡片最多放两个） */
export function shortHarnessName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}
