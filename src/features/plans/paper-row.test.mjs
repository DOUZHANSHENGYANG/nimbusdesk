import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the real row's state and handlers; browser layout/native pickers are explicit boundaries.
const source = readFileSync(new URL("./views/paper-row.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const Picker = () => null, StaticLink = () => null;
const copy = { expandTask: "Expand text", collapseTask: "Collapse text", details: "Details", edit: "Edit", time: "Time", link: "Link" };
function harness(extra = {}, height = 120) {
  const slots = [], pending = [], calls = [];
  let cursor = 0;
  let tree;
  const node = { scrollHeight: height };
  const hooks = {
    useState(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
      return [slots[at], value => { slots[at] = typeof value === "function" ? value(slots[at]) : value; }];
    },
    useRef(value) { const at = cursor++; return slots[at] ??= { current: value }; },
    useId() { cursor++; return "row-test"; },
    useEffect(callback, deps) {
      const at = cursor++;
      const before = slots[at];
      if (!before || !deps || deps.some((value, i) => !Object.is(value, before.deps?.[i]))) pending.push(() => { before?.cleanup?.(); slots[at] = { deps, cleanup: callback() }; });
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  function require(name) {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "@/features/plans/types") return { statusOf: () => "todo" };
    if (name === "@/features/plans/views/task-link") return { TaskLinkStatic: StaticLink, TaskLinkPicker: Picker };
    if (name === "@/features/plans/store") return { usePlans: { getState: () => ({ updateTask: (...args) => calls.push(args) }) } };
    if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
    if (name === "@/features/plans/copy") return { usePlanCopy: () => copy };
    return new Proxy({}, { get: () => () => null });
  }
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  let props = { date: "2026-10-18", task: { id: "task", title: "Complete text ".repeat(40), parentId: null, done: false, createdAt: 1, updatedAt: 1 }, now: new Date(), onToggle() {}, onEdit() {}, ...extra };
  function all(root) {
    if (!arguments.length) root = tree;
    if (!root || typeof root !== "object") return [];
    if (Array.isArray(root)) return root.flatMap(child => all(child));
    return [root, ...all(root.props?.children)];
  }
  function render(patch = {}) {
    props = { ...props, ...patch }; cursor = 0;
    tree = module.exports.PaperRow(props);
    for (const item of all()) if (item.type === "span" && item.props.ref) item.props.ref.current = node;
    while (pending.length) pending.shift()();
    return tree;
  }
  render(); render();
  return { render, all, calls, props, text: () => all().find(item => item.type === "span" && item.props.children === props.task.title) };
}

globalThis.getComputedStyle = () => ({ lineHeight: "20px" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

test("long text folds to two visual lines without truncating the underlying title or edit value", () => {
  const row = harness();
  const toggle = row.all().find(item => item.type === "button" && item.props["aria-label"] === copy.expandTask);
  assert.ok(toggle, "long task text needs a fold control");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(row.text().props.style.WebkitLineClamp, 2);
  assert.equal(row.text().props.children, row.props.task.title);
  toggle.props.onClick(); row.render();
  assert.equal(row.text().props.style?.WebkitLineClamp, undefined);
  row.text().props.onDoubleClick(); row.render();
  assert.equal(row.all().find(item => item.type === "input" && item.props["aria-label"] === copy.edit).props.value, row.props.task.title);
});

test("a search hit reveals long text and short text does not get a fold control", () => {
  const row = harness();
  assert.equal(row.text().props.style?.WebkitLineClamp, 2);
  row.render({ searchMatch: "current" }); row.render();
  assert.equal(row.text().props.style?.WebkitLineClamp, undefined);
  const short = harness({ task: { id: "short", title: "Short", done: false } }, 20);
  assert.equal(short.all().some(item => item.type === "button" && item.props["aria-label"] === copy.expandTask), false);
});

test("paper details reuse the link picker for file, folder, URL and unlink while keeping static launch", () => {
  const link = { type: "file", path: "E:/report.txt" };
  const row = harness({ task: { id: "task", title: "Linked", done: false, link } }, 20);
  row.all().find(item => item.type === "button" && item.props["aria-controls"]).props.onClick(); row.render();
  const picker = row.all().find(item => item.type === Picker);
  assert.ok(picker, "details must expose the existing TaskLinkPicker");
  assert.equal(picker.props.link, link);
  assert.equal(row.all().find(item => item.type === StaticLink).props.link, link);
  for (const next of [link, { type: "folder", path: "E:/project" }, { type: "url", path: "https://example.com" }, undefined]) picker.props.onChange(next);
  assert.deepEqual(row.calls, [link, { type: "folder", path: "E:/project" }, { type: "url", path: "https://example.com" }, undefined].map(next => ["2026-10-18", "task", { link: next }]));
});
