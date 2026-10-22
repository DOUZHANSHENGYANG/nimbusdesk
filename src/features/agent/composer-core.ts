/**
 * 输入区那几个新控件的纯逻辑：权限三档 → 审批映射、目标/智能体的 instructions
 * 拼接、思考等级解析、放大面板的草稿往返。
 *
 * 与 `transcript.ts` 一样**刻意不 import 任何东西**：这些函数决定「写不写本机
 * 数据」和「发给模型的指令长什么样」，必须能脱离浏览器与 zustand 直接
 * `node --test` 验。需要的外部形状一律用结构化的最小类型描述。
 */

/* ── 权限三档 ─────────────────────────────────────────────── */

export type PermissionMode = "ask" | "readonly-auto" | "all-auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "readonly-auto", "all-auto"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** 写类工具：会改本机数据（目前只有落盘 SKILL.md 这一个）。 */
export const WRITE_TOOLS: readonly string[] = ["save_skill"];

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.includes(toolName);
}

/** 与 AI SDK 的 `ToolApprovalStatus` 同名的三个字符串（不 import，纯字符串）。 */
export type ApprovalStatus = "not-applicable" | "user-approval" | "approved";

/**
 * 权限档 → 单次工具调用的审批结论。
 *
 * | 档 | 只读工具 | 写类工具 |
 * | --- | --- | --- |
 * | `ask`（默认） | 也要批准 | 要批准 |
 * | `readonly-auto` | 直接跑 | 要批准 |
 * | `all-auto` | 直接跑 | 直接跑 |
 *
 * `ask` 连只读也会问，是因为三档必须彼此有区别 —— 若 `ask` 也放行只读，它和
 * `readonly-auto` 就是同一个档位（两个名字一个行为）。想改成「默认只问写类」，
 * 把最后一行换成 `return "not-applicable"` 即可，其余代码不用动。
 */
export function approvalFor(mode: PermissionMode, toolName: string): ApprovalStatus {
  if (mode === "all-auto") return "approved";
  if (isWriteTool(toolName)) return "user-approval";
  return mode === "ask" ? "user-approval" : "not-applicable";
}

/** `all-auto` 是唯一「不问就写」的档：按钮上要挂警示态。 */
export function permissionIsRisky(mode: PermissionMode): boolean {
  return mode === "all-auto";
}

/* ── 智能体预设 ───────────────────────────────────────────── */

export type AgentPreset = "build" | "plan" | "ask";

export const AGENT_PRESETS: readonly AgentPreset[] = ["build", "plan", "ask"];

export function isAgentPreset(value: unknown): value is AgentPreset {
  return typeof value === "string" && (AGENT_PRESETS as readonly string[]).includes(value);
}

/** 只读工具：`plan` 档仍然可以用它们把事实看清。 */
export const READONLY_TOOLS: readonly string[] = ["search_workspace", "list_skills", "list_prompts"];

/** 每档拼在基础 instructions 前面的那一段；`build` 不加东西。 */
export const PRESET_PREFIX: Record<AgentPreset, string> = {
  build: "",
  plan: "本次处于「计划」档：先只读地看清现状，只给方案（步骤、影响面、风险），不要执行任何写入；用户确认后再动手。",
  ask: "本次处于「追问」档：只回答问题、解释原因与取舍，不做任何改动，也不要声称已经改动了什么。",
};

/** 该档允许模型调用的工具；`null` = 全部。 */
export function presetTools(preset: AgentPreset): readonly string[] | null {
  if (preset === "build") return null;
  if (preset === "plan") return READONLY_TOOLS;
  return []; // 追问档：一个工具都不给
}

/* ── 本次目标 ─────────────────────────────────────────────── */

export const GOAL_LIMIT = 300;

/** 目标是一句话：压掉换行与连续空格，超长截断（UI 与 instructions 用同一份）。 */
export function cleanGoal(input: string | null | undefined): string {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, GOAL_LIMIT);
}

/** 非空时追加到 instructions 末尾的那一段；空则完全不加（等价于没设目标）。 */
export function goalSuffix(goal: string | null | undefined): string {
  const value = cleanGoal(goal);
  return value ? `\n\n本次目标：${value}` : "";
}

/** 档位前缀（自带尾部分隔），空档位返回空串。 */
export function presetPrefix(preset: AgentPreset): string {
  const text = PRESET_PREFIX[preset];
  return text ? `${text}\n\n` : "";
}

/** 真正发给模型的 instructions = 档位前缀 + 基础 instructions + 目标后缀。 */
export function composeInstructions(base: string, preset: AgentPreset, goal: string | null | undefined): string {
  return `${presetPrefix(preset)}${base}${goalSuffix(goal)}`;
}

/* ── 思考等级 ─────────────────────────────────────────────── */

export type ThinkingLevel = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * `auto` = 用服务商模型里配的 `reasoningEffort`；模型没配就什么都不发
 * （不假装有默认值）。其余档位直接覆盖。
 */
export function resolveReasoningEffort(level: ThinkingLevel, configured?: string | null): string | undefined {
  if (level !== "auto") return level;
  return configured ? configured : undefined;
}

/** 按钮上的短名：`auto` 且模型里配了值，就显示那个实际生效的值。 */
export function thinkingLabel(level: ThinkingLevel, configured?: string | null): string {
  return resolveReasoningEffort(level, configured) ?? "auto";
}

/* ── 模型短名 ─────────────────────────────────────────────── */

/** 模型短名：超过 `max` 就先退到第一段（`deepseek-chat` → `deepseek`）。 */
export function shortModelName(id: string, max = 12): string {
  const name = typeof id === "string" ? id.trim() : "";
  if (name.length <= max) return name;
  const head = name.split(/[-/:]/)[0];
  return head.length >= 4 ? head : name.slice(0, max);
}

/* ── 放大输入框的草稿往返 ─────────────────────────────────── */

/** 输入框最多长到 8 行，再多就在框内滚动。与 agent.css 的 max-height 同一个数。 */
export const COMPOSER_MAX_ROWS = 8;
export const COMPOSER_LINE_HEIGHT = 20.8;
export const COMPOSER_MAX_HEIGHT = Math.round(COMPOSER_MAX_ROWS * COMPOSER_LINE_HEIGHT);

/** 打开放大面板时拿到的草稿：换行统一成 `\n`（粘贴进来的 `\r\n` 会多出空行）。 */
export function draftForExpand(text: string): { value: string; caret: number } {
  const value = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  return { value, caret: value.length };
}

/**
 * 关闭放大面板时写回输入框的内容：换行归一，结尾多余的空行裁掉，行首与中间
 * 原样带回（Esc 关掉不该弄丢任何一个字）。
 */
export function draftAfterExpand(edited: string): string {
  if (typeof edited !== "string") return "";
  return edited.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}
