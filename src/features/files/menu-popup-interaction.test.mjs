import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

let moduleId = 0;
async function harness(component = "MenuPopupWindow", props = {}) {
  const state = [], refs = [], effects = [], frames = [], listeners = new Map(), calls = { focus: [], action: [], resize: 0 };
  let stateIndex, refIndex, effectIndex, tree, host;
  const first = { focus: () => calls.focus.push("first") };
  const trigger = { focus: () => calls.focus.push("trigger") };
  const document = { activeElement: null };
  const icon = () => null;
  const deps = {
    React: { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children: children.flat(Infinity).filter(child => child !== false && child != null) } }) },
    useState: initial => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useRef: initial => refs[refIndex++] ??= { current: initial }, useCallback: fn => fn,
    useEffect: (fn, dependencies) => {
      const index = effectIndex++, previous = effects[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) effects[index] = { dependencies, fn, pending: true, cleanup: previous?.cleanup };
    },
    useMenuBounds: (_ref, key) => ({ key, w: 200, h: 200 }),
    useMenuHost: (open, close) => { host = { open, close }; }, useReadyResponder: () => {},
    markPopupReady: async () => {}, reportMenuSize: async () => {},
    sendMenuAction: async (...args) => calls.action.push(args),
    i18n: { language: "en" }, applyTheme: () => {}, changeLang: () => {},
    cn: (...parts) => parts.filter(Boolean).join(" "), Providers: icon,
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document, requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: () => {},
  };
  for (const name of ["FolderPlus", "FilePlus2", "Pencil", "Trash2", "ExternalLink", "FolderOpen", "Copy", "FolderTree", "FolderX", "Monitor", "MonitorOff", "Folder", "FileText", "FileSpreadsheet", "FileCode", "FileImage", "FileArchive", "ArrowRightLeft"]) deps[name] = icon;
  const source = await readFile(new URL("./menu-popup.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(`${source}\nexport { MenuRow };`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText.replace(/^import[\s\S]*?;\s*/gm, "");
  globalThis.__menuPopupInteraction = deps;
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(",")}} = globalThis.__menuPopupInteraction;\n${code}\n// ${moduleId++}`).toString("base64")}`);
  delete globalThis.__menuPopupInteraction;
  const walk = (node, predicate) => !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...(node.props?.children ?? []).flatMap(child => walk(child, predicate))];
  const nodes = predicate => walk(tree, predicate);
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    tree = module[component]({ onRun: node => calls.action.push(node), onSubToggle: () => calls.resize++, ...props });
    for (const node of nodes(node => node.props.ref && typeof node.props.ref === "object")) {
      node.props.ref.current = node.type === "button" ? trigger : { querySelector: () => first };
    }
    for (const effect of effects) if (effect?.pending) {
      effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false;
    }
    return tree;
  };
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  const key = (node, value, extra = {}) => {
    const event = { key: value, target: {}, currentTarget: {}, preventDefault() {}, stopPropagation() {}, ...extra };
    node.props.onKeyDown?.(event); return event;
  };
  render();
  return { render, nodes, key, calls, document, first, trigger, flushFrames, listeners, open: payload => host.open(payload) };
}

const payload = { seq: 1, owner: "fence-a", lang: "en", theme: "dark", nodes: [{ kind: "item", label: "Open", action: "open" }] };
const submenu = { kind: "sub", label: "Move", items: [{ kind: "item", label: "Projects", action: "move", value: "projects" }] };

test("opening a popup focuses its first enabled menu item and root Escape/Tab close it", async () => {
  const h = await harness();
  h.open(payload); h.render(); h.flushFrames();
  assert.deepEqual(h.calls.focus, ["first"]);
  h.listeners.get("keydown")({ key: "Escape", preventDefault() {} });
  h.listeners.get("keydown")({ key: "Tab", preventDefault() {} });
  assert.deepEqual(h.calls.action, [["fence-a", { action: "close" }], ["fence-a", { action: "close" }]]);
});

test("vertical navigation wraps within the current menu column and skips nested columns", async () => {
  const h = await harness(); h.open(payload); h.render();
  const root = h.nodes(node => node.props["data-menu-col"] !== undefined)[0];
  const focused = [], items = [];
  const childColumn = {};
  const column = { querySelectorAll: () => [...items, nested] };
  for (let i = 0; i < 3; i++) items.push({ closest: selector => selector === "[data-menu-col]" ? column : items[i], focus: () => focused.push(i) });
  const nested = { closest: () => childColumn, focus: () => focused.push("nested") };
  h.key(root, "ArrowDown", { target: items[0] });
  h.key(root, "ArrowUp", { target: items[0] });
  h.key(root, "Home", { target: items[2] });
  h.key(root, "End", { target: items[0] });
  assert.deepEqual(focused, [1, 2, 0, 2]);
});

test("clicking and ArrowRight open a submenu and focus its first item", async () => {
  for (const action of ["click", "ArrowRight"]) {
    const h = await harness("MenuRow", { node: submenu });
    let button = h.nodes(node => node.type === "button")[0];
    assert.equal(button.props["aria-haspopup"], "menu");
    if (action === "click") { assert.equal(typeof button.props.onClick, "function"); button.props.onClick(); }
    else h.key(button, action);
    h.render(); h.flushFrames();
    button = h.nodes(node => node.type === "button")[0];
    assert.equal(button.props["aria-expanded"], true);
    assert.deepEqual(h.calls.focus, ["first"]);
  }
});

test("a click after pointer hover keeps its submenu open", async () => {
  const h = await harness("MenuRow", { node: submenu });
  h.nodes(node => node.props.onMouseEnter)[0].props.onMouseEnter(); h.render();
  h.nodes(node => node.type === "button")[0].props.onClick(); h.render(); h.flushFrames();
  assert.equal(h.nodes(node => node.type === "button")[0].props["aria-expanded"], true);
  assert.deepEqual(h.calls.focus, ["first"]);
});

test("Escape/ArrowLeft close only the active submenu and restore its trigger focus", async () => {
  for (const action of ["Escape", "ArrowLeft"]) {
    const h = await harness("MenuRow", { node: submenu });
    h.nodes(node => node.props.onMouseEnter)[0].props.onMouseEnter(); h.render();
    const row = h.nodes(node => node.props.onMouseEnter)[0];
    let stopped = false;
    h.key(row, action, { stopPropagation: () => { stopped = true; } }); h.render();
    assert.equal(stopped, true);
    assert.equal(h.nodes(node => node.type === "button")[0].props["aria-expanded"], false);
    assert.deepEqual(h.calls.focus, ["trigger"]);
  }
});

test("pointer leave keeps a keyboard-focused submenu mounted until focus leaves its row", async () => {
  const h = await harness("MenuRow", { node: submenu });
  h.nodes(node => node.props.onMouseEnter)[0].props.onMouseEnter(); h.render();
  const row = h.nodes(node => node.props.onMouseEnter)[0];
  h.document.activeElement = h.first;
  row.props.onMouseLeave({ currentTarget: { contains: target => target === h.first } }); h.render();
  assert.equal(h.nodes(node => node.type === "button")[0].props["aria-expanded"], true);
  const currentRow = h.nodes(node => node.props.onMouseEnter)[0];
  assert.equal(typeof currentRow.props.onBlurCapture, "function");
  currentRow.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null }); h.render();
  assert.equal(h.nodes(node => node.type === "button")[0].props["aria-expanded"], false);
});

test("leaf button activation retains the action/value contract and disabled state", async () => {
  const node = submenu.items[0], h = await harness("MenuRow", { node });
  const button = h.nodes(node => node.type === "button")[0];
  assert.equal(button.props.role, "menuitem");
  button.props.onClick();
  assert.deepEqual(h.calls.action, [node]);
  const disabled = await harness("MenuRow", { node: { ...node, disabled: true } });
  assert.equal(disabled.nodes(node => node.type === "button")[0].props.disabled, true);
});
