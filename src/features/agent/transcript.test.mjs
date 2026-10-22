import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_BUDGET_CHARS,
  FILE_PERSIST_LIMIT,
  firstUserText,
  isIncomplete,
  messageChars,
  messageText,
  sessionTitle,
  stripFiles,
  toMarkdown,
  trimContext,
} from "./transcript.ts";
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, buildPrompt, readAttachment } from "./attachments.ts";

const msg = (id, role, parts, metadata) => ({ id, role, parts, metadata });
const text = (value, size = value.length) => ({ type: "text", text: value.padEnd(size, ".") });
const image = (url) => ({ type: "file", mediaType: "image/png", filename: "shot.png", url });

/* ── 上下文裁剪：最容易把用户的东西悄悄弄丢的地方 ───────── */

test("context under budget is returned untouched", () => {
  const messages = [msg("1", "user", [text("hi")]), msg("2", "assistant", [text("hello")])];
  const result = trimContext(messages, 1000);
  assert.equal(result.dropped, 0);
  assert.equal(result.messages, messages);
});

test("context trims whole turns only, and never the last turn", () => {
  const messages = [
    msg("1", "user", [text("a", 1000)]),
    msg("2", "assistant", [text("b", 1000)]),
    msg("3", "user", [text("c", 1000)]),
    msg("4", "assistant", [text("d", 1000)]),
  ];
  const result = trimContext(messages, 2500);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.messages.map((m) => m.id), ["3", "4"]);

  // 即使预算小到最后一轮也装不下，也保留最后一轮整轮（不拆）
  const tight = trimContext(messages, 10);
  assert.deepEqual(tight.messages.map((m) => m.id), ["3", "4"]);
  assert.equal(tight.dropped, 2);
});

test("context never cuts a turn in half when a user message follows an assistant one", () => {
  const messages = [
    msg("1", "assistant", [text("orphan", 900)]),
    msg("2", "user", [text("a", 900)]),
    msg("3", "assistant", [text("b", 900)]),
    msg("4", "user", [text("c", 10)]),
  ];
  const result = trimContext(messages, 1000);
  assert.deepEqual(result.messages.map((m) => m.id), ["4"]);
  assert.equal(result.dropped, 3);
  assert.ok(result.dropped < messages.length, "不能把整段会话都丢掉");
});

test("character count covers text, attachment data and tool output", () => {
  assert.equal(messageChars({ parts: [text("ab", 2)] }), 2);
  assert.equal(messageChars({ parts: [image("data:image/png;base64,AAAA")] }), 26);
  assert.equal(messageChars({ parts: [{ type: "tool-x", output: { a: 1 } }] }), JSON.stringify({ a: 1 }).length);
  assert.equal(messageChars({ parts: [{ type: "tool-x", errorText: "boom" }] }), 4);
});

test("default budget is the documented constant", () => {
  assert.equal(CONTEXT_BUDGET_CHARS, 240_000);
});

/* ── 落盘降级：图片超限就不写盘 ─────────────────────────── */

test("oversized images are dropped on save and marked as not kept", () => {
  const big = "data:image/png;base64," + "A".repeat(FILE_PERSIST_LIMIT);
  const small = "data:image/png;base64,AAAA";
  const session = [
    msg("1", "user", [image(big), text("看图")], { attachments: [{ name: "shot.png", kind: "image", size: 9, kept: true }] }),
    msg("2", "user", [image(small), text("小图")], { attachments: [{ name: "tiny.png", kind: "image", size: 9, kept: true }] }),
    msg("3", "user", [text("带个文本附件")], { attachments: [{ name: "a.md", kind: "text", size: 3, kept: true }] }),
  ];
  const saved = stripFiles(session);
  assert.equal(saved[0].parts.length, 1);
  assert.equal(saved[0].parts[0].type, "text");
  assert.equal(saved[0].metadata.attachments[0].kept, false);
  // 小图与文本附件照旧
  assert.equal(saved[1].parts.length, 2);
  assert.equal(saved[1].metadata.attachments[0].kept, true);
  assert.equal(saved[2].metadata.attachments[0].kept, true);
  // 不改动原数组（persist 的 partialize 不能有副作用）
  assert.equal(session[0].parts.length, 2);
});

/* ── 标题 ──────────────────────────────────────────────── */

test("title follows the first user message and yields to a manual name", () => {
  const session = { title: null, messages: [msg("0", "assistant", [text("hi")]), msg("1", "user", [text("  帮我看\n看技能  ")])] };
  assert.equal(firstUserText(session.messages), "帮我看 看技能");
  assert.equal(sessionTitle(session, "未命名"), "帮我看 看技能");
  assert.equal(sessionTitle({ ...session, title: "手改的" }, "未命名"), "手改的");
  assert.equal(sessionTitle({ title: null, messages: [] }, "未命名"), "未命名");
  assert.equal(sessionTitle({ title: null, messages: [msg("1", "user", [text("x".repeat(60))])] }, "未命名").length, 41);
});

test("message text joins only text parts", () => {
  assert.equal(messageText(msg("1", "user", [image("data:x"), text("ab")])), "ab");
});

/* ── 重启恢复 ──────────────────────────────────────────── */

test("an interrupted run is detected from the last message", () => {
  assert.equal(isIncomplete([]), false);
  assert.equal(isIncomplete([msg("1", "user", [text("hi")])]), true);
  assert.equal(isIncomplete([msg("1", "assistant", [text("done")])]), false);
  assert.equal(isIncomplete([msg("1", "assistant", [{ type: "tool-x", state: "input-available" }])]), true);
});

/* ── 导出 ──────────────────────────────────────────────── */

test("markdown export hides system turns and fences tool results", () => {
  const out = toMarkdown(
    {
      id: "s1",
      title: null,
      providerId: "local",
      model: "deepseek",
      createdAt: Date.UTC(2026, 9, 22, 1, 0),
      messages: [
        msg("1", "user", [text("看看技能")], { createdAt: Date.UTC(2026, 9, 22, 1, 1) }),
        msg("2", "assistant", [
          { type: "reasoning", text: "先列一下" },
          { type: "tool-list_skills", state: "output-available", toolName: "list_skills", output: { total: 1 } },
          text("你有一个技能。"),
        ], { createdAt: Date.UTC(2026, 9, 22, 1, 2), model: "deepseek" }),
        msg("3", "user", [text("继续")], { hidden: true }),
      ],
    },
    { user: "我", assistant: "助手", tool: "工具" },
  );
  assert.match(out, /^# 看看技能/);
  assert.match(out, /> local · deepseek/);
  assert.match(out, /## 我 · /);
  assert.match(out, /工具: list_skills/);
  assert.match(out, /"total": 1/);
  assert.doesNotMatch(out, /继续/);
});

/* ── 附件 ──────────────────────────────────────────────── */

test("text attachments become inline context, images become file parts", () => {
  const built = buildPrompt("看这个", [
    { id: "a", name: "note.md", size: 5, kind: "text", body: "内容" },
    { id: "b", name: "shot.png", size: 5, kind: "image", body: "data:image/png;base64,AAAA" },
  ]);
  assert.match(built.text, /^看这个/);
  assert.match(built.text, /<attachment name="note.md">\n内容\n<\/attachment>/);
  assert.deepEqual(built.files, [{ type: "file", mediaType: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAA" }]);
  assert.deepEqual(built.attachments, [
    { name: "note.md", kind: "text", size: 5, kept: true },
    { name: "shot.png", kind: "image", size: 5, kept: true },
  ]);
});

test("attachment limits are explicit and non-zero", () => {
  assert.ok(MAX_IMAGE_BYTES > 0 && MAX_TEXT_BYTES > 0);
  assert.ok(MAX_TEXT_BYTES < MAX_IMAGE_BYTES);
});

test("an image is refused when the model has no vision, and unknown types are refused", async () => {
  const file = (name, type, size) => ({ name, type, size, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => readAttachment(file("a.png", "image/png", 10), false), /AI_ATTACH_NO_VISION/);
  await assert.rejects(() => readAttachment(file("a.exe", "application/octet-stream", 10), true), /AI_ATTACH_UNSUPPORTED/);
  await assert.rejects(() => readAttachment(file("a.png", "image/png", MAX_IMAGE_BYTES + 1), true), /AI_ATTACH_TOO_LARGE/);
  await assert.rejects(() => readAttachment(file("a.md", "text/markdown", MAX_TEXT_BYTES + 1), true), /AI_ATTACH_TOO_LARGE/);
});
