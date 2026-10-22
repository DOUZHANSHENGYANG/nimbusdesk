import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSER_MAX_HEIGHT,
  GOAL_LIMIT,
  PERMISSION_MODES,
  approvalFor,
  cleanGoal,
  composeInstructions,
  draftAfterExpand,
  draftForExpand,
  goalSuffix,
  isAgentPreset,
  isPermissionMode,
  isThinkingLevel,
  permissionIsRisky,
  presetPrefix,
  presetTools,
  resolveReasoningEffort,
  shortModelName,
  thinkingLabel,
} from "./composer-core.ts";

/* ── 权限三档 → 审批映射 ───────────────────────────────────── */

test("permission: ask 连只读也问，readonly-auto 只拦写类，all-auto 全放行", () => {
  // 只读工具
  assert.equal(approvalFor("ask", "search_workspace"), "user-approval");
  assert.equal(approvalFor("readonly-auto", "search_workspace"), "not-applicable");
  assert.equal(approvalFor("all-auto", "search_workspace"), "approved");

  // 写类工具：只有 all-auto 不问
  assert.equal(approvalFor("ask", "save_skill"), "user-approval");
  assert.equal(approvalFor("readonly-auto", "save_skill"), "user-approval");
  assert.equal(approvalFor("all-auto", "save_skill"), "approved");
});

test("permission: 三档彼此都有区别（不能有两档行为相同）", () => {
  const read = PERMISSION_MODES.map((mode) => approvalFor(mode, "list_skills"));
  assert.equal(new Set(read).size, 3, `只读工具在三个档位下必须三种结果，实际 ${read.join(",")}`);
});

test("permission: 未知工具名不会被当成只读而默默放行", () => {
  // 不在 WRITE_TOOLS 里的名字按「非写类」处理，但 ask 档依旧会拦下来问一次
  assert.equal(approvalFor("ask", "some_new_tool"), "user-approval");
  assert.equal(approvalFor("readonly-auto", "some_new_tool"), "not-applicable");
});

test("permission: 只有 all-auto 算危险档", () => {
  assert.deepEqual(PERMISSION_MODES.filter(permissionIsRisky), ["all-auto"]);
});

test("permission: 持久化值校验挡得住手改坏的值", () => {
  assert.equal(isPermissionMode("ask"), true);
  assert.equal(isPermissionMode("readonly-auto"), true);
  assert.equal(isPermissionMode("all-auto"), true);
  assert.equal(isPermissionMode("auto"), false);
  assert.equal(isPermissionMode(""), false);
  assert.equal(isPermissionMode(null), false);
});

/* ── 目标 / 智能体 → instructions ─────────────────────────── */

const BASE = "你是云台里的助手。";

test("instructions: 空目标 + build 档等于基础文本，一个字符都不多", () => {
  assert.equal(composeInstructions(BASE, "build", null), BASE);
  assert.equal(composeInstructions(BASE, "build", ""), BASE);
  assert.equal(composeInstructions(BASE, "build", "   "), BASE);
  assert.equal(goalSuffix(null), "");
});

test("instructions: 目标非空时追加成「本次目标：<text>」", () => {
  assert.equal(composeInstructions(BASE, "build", "把侧栏改轻"), `${BASE}\n\n本次目标：把侧栏改轻`);
  assert.ok(goalSuffix("x").startsWith("\n\n本次目标："));
});

test("instructions: 目标里的换行与连续空格压成一句，超长截断", () => {
  assert.equal(cleanGoal("  第一行\n第二行\t第三行 "), "第一行 第二行 第三行");
  assert.equal(cleanGoal("x".repeat(GOAL_LIMIT + 50)).length, GOAL_LIMIT);
  assert.equal(goalSuffix("a\n\nb"), "\n\n本次目标：a b");
});

test("instructions: 预设前缀在最前、目标在最后", () => {
  const text = composeInstructions(BASE, "plan", "先给方案");
  assert.ok(text.startsWith(presetPrefix("plan")), "档位前缀必须排在最前面");
  assert.ok(text.includes(BASE), "基础 instructions 不能被顶掉");
  assert.ok(text.endsWith("本次目标：先给方案"), "目标必须在末尾");
  assert.equal(composeInstructions(BASE, "plan", null), presetPrefix("plan") + BASE);
});

test("instructions: build 档没有前缀，另外两档各有一段且互不相同", () => {
  assert.equal(presetPrefix("build"), "");
  assert.ok(presetPrefix("plan").length > 0);
  assert.ok(presetPrefix("ask").length > 0);
  assert.notEqual(presetPrefix("plan"), presetPrefix("ask"));
});

test("preset: 只有构建档拿全部工具，追问档一个都不给", () => {
  assert.equal(presetTools("build"), null);
  assert.deepEqual([...(presetTools("plan") ?? [])], ["search_workspace", "list_skills", "list_prompts"]);
  assert.deepEqual([...(presetTools("ask") ?? [])], []);
});

test("preset: 持久化值校验挡得住手改坏的值", () => {
  assert.equal(isAgentPreset("plan"), true);
  assert.equal(isAgentPreset("Plan"), false);
  assert.equal(isAgentPreset(1), false);
});

/* ── 思考等级 ─────────────────────────────────────────────── */

test("thinking: auto 跟随模型配置，没配就什么都不发", () => {
  assert.equal(resolveReasoningEffort("auto", "high"), "high");
  assert.equal(resolveReasoningEffort("auto", undefined), undefined);
  assert.equal(resolveReasoningEffort("auto", null), undefined);
  assert.equal(thinkingLabel("auto", "high"), "high");
  assert.equal(thinkingLabel("auto", undefined), "auto");
});

test("thinking: 显式档位覆盖模型配置", () => {
  assert.equal(resolveReasoningEffort("low", "high"), "low");
  assert.equal(thinkingLabel("minimal", "high"), "minimal");
  assert.equal(isThinkingLevel("high"), true);
  assert.equal(isThinkingLevel("highest"), false);
});

/* ── 模型短名 ─────────────────────────────────────────────── */

test("model: 短名优先保留可读的那一段", () => {
  assert.equal(shortModelName("deepseek-chat"), "deepseek");
  assert.equal(shortModelName("gpt-4o-mini"), "gpt-4o-mini"); // 够短就原样
  assert.equal(shortModelName("qwen2.5-coder:14b"), "qwen2.5");
  assert.equal(shortModelName("  gpt-4o  "), "gpt-4o");
  assert.equal(shortModelName(""), "");
  // 退到第一段太短时退回硬截断，不产出 "gpt" 这种看不懂的名字
  assert.equal(shortModelName("gpt-4o-mini-preview-2026").length, 12);
});

/* ── 放大面板的草稿往返 ───────────────────────────────────── */

test("draft: 打开时换行归一，光标落在末尾", () => {
  const opened = draftForExpand("a\r\nb\r\nc");
  assert.equal(opened.value, "a\nb\nc");
  assert.equal(opened.caret, 5);
  assert.equal(COMPOSER_MAX_HEIGHT, 166); // 8 行 × 20.8px，与 agent.css 同一个数
});

test("draft: 往返不丢字，只裁掉结尾空行", () => {
  const original = "第一行\n第二行";
  const back = draftAfterExpand(`${draftForExpand(original).value}\n\n`);
  assert.equal(back, original);
  // 行首与中间的空行是用户自己敲的，必须保留
  assert.equal(draftAfterExpand("\n\n中间\n\n"), "\n\n中间");
  assert.equal(draftAfterExpand("a\r\nb"), "a\nb");
  assert.equal(draftAfterExpand(""), "");
});
