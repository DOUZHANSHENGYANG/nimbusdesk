/**
 * 项目文档槽位：五个固定文件，文件名即身份。
 *
 * 为什么是文件而不是数据库：项目目录本来就是这些文档的归宿，能被 Git / Obsidian / 编辑器
 * 直接看到；应用只负责「用模板建出来」和「打开它」。改名不会丢文件，只是这个槽位回到未创建。
 *
 * shortcut: 一类型只认一个固定文件名，要支持同类型多份时改成 manifest。
 */
export type DocKind = "feasibility" | "prd" | "architecture" | "design" | "plan";

export interface DocSlot {
  kind: DocKind;
  /** 相对项目根目录 */
  path: string;
  /** 模板正文；空模板也要可用，所以每条都带标题骨架 */
  body: string;
}

const FEASIBILITY = `# 可行性分析

## 背景与问题
要解决的是什么问题，现在是怎么凑合过去的，不做会怎样。

## 同类产品与解决方案
| 方案 | 形态 | 优点 | 缺点 | 可借鉴 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 关键技术探索与突破
- 待验证的假设：
- 已验证的结论（附证据：链接 / 原型 / 实测数据）：
- 卡点与替代路径：

## 结论与取舍
做 / 不做 / 先做哪一段，明确写出放弃的选项和原因。

## 风险
| 风险 | 触发条件 | 影响 | 应对 |
| --- | --- | --- | --- |
|  |  |  |  |
`;

const PRD = `# PRD

## 目标用户与场景
谁在什么情况下用它，一次典型使用从哪开始、到哪结束。

## 用户流程
1. 
2. 

## 需求清单
| 编号 | 需求 | 优先级 | 说明 |
| --- | --- | --- | --- |
| R1 |  | P0 |  |

## 非目标
这一版明确不做的事，避免范围蔓延。

## 验收口径
每条需求怎么算做完，能被谁验证。

## 开放问题
| 问题 | 需要谁确认 | 结论 |
| --- | --- | --- |
|  |  |  |

## 依赖与假设
`;

const ARCHITECTURE = `# 技术架构

## 选型
| 层 | 选择 | 理由 | 放弃的替代 |
| --- | --- | --- | --- |
|  |  |  |  |

## 模块边界
每个模块负责什么、不负责什么，模块之间只通过哪些接口说话。

## 数据流
从输入到落盘/上屏的路径，标出唯一的真源在哪里。

## 运行与部署
本机怎么起、数据存哪、怎么备份与迁移。

## 风险
`;

const DESIGN = `# 详细设计

## 功能设计
按功能逐条写：入口、交互、状态、写回的字段。

## 非功能
- 性能：数据量上限与可接受耗时
- 安全：信任边界、校验位置
- 兼容：旧数据与老版本怎么处理

## 核心用户流程
1. 
2. 
3. 

## 数据结构
| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
|  |  |  |  |

## 错误与边界
空数据、重复提交、并发写入、失败回滚分别怎么处理。
`;

const DEV_PLAN = `# 开发计划

## 里程碑
| 里程碑 | 目标 | 验收 | 计划完成 |
| --- | --- | --- | --- |
| M1 |  |  |  |

## 子计划清单
- [ ] 
- [ ] 

## 验收标准
每条里程碑怎么算通过：跑什么、看什么、谁确认。

## 排期与依赖
哪一段卡在别人身上，先做什么能解锁后面的。
`;

export const DOC_SLOTS: readonly DocSlot[] = [
  { kind: "feasibility", path: "docs/01-feasibility.md", body: FEASIBILITY },
  { kind: "prd", path: "docs/02-prd.md", body: PRD },
  { kind: "architecture", path: "docs/03-architecture.md", body: ARCHITECTURE },
  { kind: "design", path: "docs/04-detailed-design.md", body: DESIGN },
  { kind: "plan", path: "docs/05-dev-plan.md", body: DEV_PLAN },
];

/** 槽位里已经存在哪些文件：按路径或文件名精确匹配，改过名的不算。 */
export function createdSlots(paths: readonly string[]): Set<DocKind> {
  const normalized = paths.map(path => path.replace(/\\/g, "/"));
  const present = new Set([...normalized, ...normalized.map(path => path.split("/").pop() ?? path)]);
  return new Set(DOC_SLOTS.filter(slot => present.has(slot.path) || present.has(slot.path.split("/").pop()!)).map(slot => slot.kind));
}
