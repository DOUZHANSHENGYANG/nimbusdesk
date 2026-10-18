import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the real component handlers. Only React's renderer, store and native
// boundaries are substituted; no browser or Tauri process is needed.
let moduleId = 0;
async function harness({ ghost = false, viewMode = 'icons', locked = false, native = false } = {}) {
  const state = [], refs = [], calls = { open: [], rename: [], categoryRename: [], menu: [], move: [], hold: [], windowDrag: [] };
  let stateIndex = 0, refIndex = 0, tree, menuOptions;
  const items = Array.from({ length: 14 }, (_, i) => ({ id: `item-${i}`, title: `File ${i}`, path: `/files/${i}`, type: "file", categoryId: "a" }));
  const files = { items, categories: [{ id: "a", name: "Documents" }], moveItemBefore: (...args) => calls.move.push(args), renameCategory: (...args) => calls.categoryRename.push(args) };
  const fences = { fences: { a: { x: 10, y: 10, w: 300, h: 300, form: "paper", scale: 1, ghost, viewMode, locked } } };
  for (const name of ["setGhost", "setGeometry", "setOpen", "setPinned", "setScale", "setForm", "setEdge", "setEdgeY"]) fences[name] = () => {};
  fences.setViewMode = (id, value) => { fences.fences[id].viewMode = value; };
  fences.setLocked = (id, value) => { fences.fences[id].locked = value; };
  const useFiles = selector => selector(files); useFiles.getState = () => files;
  const useFences = selector => selector(fences); useFences.getState = () => fences;
  const icon = () => null;
  const presentation = ts.transpileModule(await readFile(new URL('./fence-presentation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { fenceLayout, fenceInsertionBefore, FENCE_GAP: GAP } = await import(`data:text/javascript;base64,${Buffer.from(presentation).toString('base64')}`);
  const windowEvents = new Map();
  const deps = {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(child => child !== false && child != null) } }) },
    useState: initial => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      if (state[index]?.w === 0 && state[index]?.h === 0) state[index] = { w: 260, h: 210 };
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useRef: initial => refs[refIndex++] ??= { current: initial }, useMemo: fn => fn(), useEffect: () => {},
    useTranslation: () => ({ t: key => key, i18n: { language: "en" } }),
    useFiles, useFences, DEFAULT_FENCE: fences.fences.a, inTauri: native,
    getCurrentWebviewWindow: () => ({ startDragging: async () => calls.windowDrag.push(true) }),
    window: { addEventListener: (key, fn) => windowEvents.set(key, fn), removeEventListener: key => windowEvents.delete(key) },
    fenceLayout, fenceInsertionBefore, GAP,
    useFileActions: () => ({ rename: async (...args) => calls.rename.push(args) }),
    usePopupMenu: options => {
      menuOptions = options;
      return async (...args) => { calls.menu.push(args); options.onOpenChange?.(true); };
    },
    useEdgeDock: () => ({ hold: (...args) => calls.hold.push(args) }),
    openPath: async path => calls.open.push(path), openUrl: async path => calls.open.push(path),
    cn: (...parts) => parts.filter(Boolean).join(" "), ITEM_ATTR: "data-item-id",
    requestAnimationFrame: () => {}, toast: { error: error => { throw new Error(error); } },
    Eye: icon, EyeOff: icon, X: icon, Pin: icon, PinOff: icon, PanelRightClose: icon, ArrowLeftRight: icon, Expand: icon, ItemIcon: icon,
    List: icon, LayoutGrid: icon, LockKeyhole: icon, UnlockKeyhole: icon, MoreHorizontal: icon,
  };
  const source = await readFile(new URL("./fence.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(`${source}\nexport { FencePanel };`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText.replace(/^import[\s\S]*?;\s*/gm, "");
  globalThis.__fenceInteraction = deps;
  const { FencePanel } = await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(",")}} = globalThis.__fenceInteraction;\n${code}\n// ${moduleId++}`).toString("base64")}`);
  delete globalThis.__fenceInteraction;
  const walk = (node, predicate) => {
    if (!node || typeof node !== "object") return [];
    return [...(predicate(node) ? [node] : []), ...(node.props?.children ?? []).flatMap(child => walk(child, predicate))];
  };
  const elements = new Map();
  const render = () => {
    stateIndex = 0; refIndex = 0; tree = FencePanel({ categoryId: "a" });
    for (const node of walk(tree, node => typeof node.props.ref === "function")) {
      const id = node.props[deps.ITEM_ATTR];
      if (!id) continue;
      const index = items.findIndex(item => item.id === id) % 6;
      const list = fences.fences.a.viewMode === 'list';
      const left = list ? 10 : 10 + index % 3 * 84, top = list ? 50 + index * 40 : 50 + Math.floor(index / 3) * 100;
      const handlers = new Map();
      const element = { getBoundingClientRect: () => ({ left, right: left + 78, top, bottom: top + 94, width: 78, height: 94 }),
        focus: () => node.props.onFocus?.(), closest: () => element,
        setPointerCapture: () => {}, hasPointerCapture: () => true, releasePointerCapture: () => {},
        addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), handlers };
      elements.set(id, element); node.props.ref(element);
    }
    for (const node of walk(tree, node => node.props.ref && typeof node.props.ref === "object")) {
      node.props.ref.current = { getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 300, width: 300, height: 300 }), select: () => {}, focus: () => {} };
    }
    return tree;
  };
  const nodes = predicate => walk(tree, predicate);
  const entry = id => nodes(node => node.props[deps.ITEM_ATTR] === id)[0];
  const key = (node, value, extra = {}) => {
    const event = { key: value, shiftKey: false, nativeEvent: { isComposing: false }, target: elements.get(node.props[deps.ITEM_ATTR]) ?? {}, currentTarget: elements.get(node.props[deps.ITEM_ATTR]) ?? {}, preventDefault() {}, stopPropagation() {}, ...extra };
    node.props.onKeyDown?.(event); return event;
  };
  render();
  return { render, nodes, entry, key, elements, items, calls, windowEvents, fences, menuChange: open => menuOptions.onOpenChange?.(open) };
}

test('list/icon switching changes the actual row layout and preserves keyboard opening', async () => {
  const h = await harness();
  const toggle = () => h.nodes(node => node.type?.name === 'TitleBtn' && /files\.(?:listView|iconView)/.test(node.props.title))[0];
  assert.equal(toggle().props.title, 'files.listView');
  toggle().props.onClick(); h.render();
  assert.equal(h.nodes(node => node.props.role === 'listbox')[0].props['data-view-mode'], 'list');
  assert.match(h.entry('item-0').props.className, /flex-row/);
  assert.equal(h.nodes(node => node.props['data-item']).length, 5);
  h.key(h.entry('item-0'), 'ArrowDown'); h.render();
  assert.equal(h.entry('item-1').props.tabIndex, 0);
  h.key(h.entry('item-1'), 'Enter');
  assert.deepEqual(h.calls.open, ['/files/1']);
  toggle().props.onClick(); h.render();
  assert.equal(h.nodes(node => node.props.role === 'listbox')[0].props['data-view-mode'], 'icons');
  assert.equal(h.nodes(node => node.props['data-item']).length, 6);
});

test('locked fence rejects title movement while leaving file opening and unlocking available', async () => {
  const h = await harness({ locked: true, native: true });
  const title = () => h.nodes(node => node.props.onPointerDown && !node.props['data-item'])[0];
  const event = { button: 0, clientX: 10, clientY: 10, target: { closest: () => null }, currentTarget: { addEventListener() {}, removeEventListener() {} } };
  title().props.onPointerDown(event);
  assert.equal(h.windowEvents.has('pointermove'), false);
  h.key(h.entry('item-0'), 'Enter');
  assert.deepEqual(h.calls.open, ['/files/0']);
  h.nodes(node => node.type?.name === 'TitleBtn' && node.props.title === 'files.unlockPosition')[0].props.onClick(); h.render();
  title().props.onPointerDown(event);
  h.windowEvents.get('pointermove')({ clientX: 20, clientY: 20 });
  await Promise.resolve();
  assert.deepEqual(h.calls.windowDrag, [true]);
});

test("visible fence items have one keyboard entry point and directional navigation", async () => {
  const h = await harness();
  assert.equal(h.entry("item-0").props.tabIndex, 0);
  assert.equal(h.nodes(node => node.props["data-item"] && node.props.tabIndex === 0).length, 1);
  h.key(h.entry("item-0"), "ArrowDown"); h.render();
  assert.equal(h.entry("item-3").props.tabIndex, 0);
  h.key(h.entry("item-3"), "End"); h.render();
  assert.equal(h.entry("item-5").props.tabIndex, 0);
  h.key(h.entry("item-5"), "Home"); h.render();
  assert.equal(h.entry("item-0").props.tabIndex, 0);
  h.key(h.entry("item-0"), "ArrowRight"); h.render();
  assert.equal(h.entry("item-1").props.tabIndex, 0);
  h.key(h.entry("item-1"), "ArrowLeft"); h.render();
  assert.equal(h.entry("item-0").props.tabIndex, 0);
});

test("Enter opens, F2 renames, and keyboard context menu anchors at the focused item", async () => {
  const h = await harness();
  h.key(h.entry("item-0"), "Enter");
  assert.deepEqual(h.calls.open, ["/files/0"]);
  h.key(h.entry("item-0"), "F10", { shiftKey: true });
  assert.equal(h.calls.menu.at(-1)[0].item.id, "item-0");
  assert.ok(h.calls.menu.at(-1)[1].y > 0);
  h.key(h.entry("item-0"), "ContextMenu");
  assert.equal(h.calls.menu.length, 2);
  h.key(h.entry("item-0"), "F2"); h.render();
  assert.equal(h.nodes(node => node.type === "input").length, 1);
});

test("IME Enter keeps item rename active; Escape cancels before a following blur", async () => {
  const h = await harness();
  h.key(h.entry("item-0"), "F2"); h.render();
  let input = h.nodes(node => node.type === "input")[0];
  assert.ok(input, "F2 must start an inline rename");
  input.props.onChange({ target: { value: "中文名" } }); h.render();
  input = h.nodes(node => node.type === "input")[0];
  h.key(input, "Enter", { nativeEvent: { isComposing: true } }); h.render();
  assert.equal(h.nodes(node => node.type === "input").length, 1);
  assert.deepEqual(h.calls.rename, []);
  input = h.nodes(node => node.type === "input")[0];
  let stopped = false;
  h.key(input, "Escape", { stopPropagation: () => { stopped = true; } });
  input.props.onBlur(); h.render();
  assert.equal(stopped, true);
  assert.equal(h.nodes(node => node.type === "input").length, 0);
  assert.deepEqual(h.calls.rename, []);
});

test("a confirmed rename is committed once and mouse double-click still opens files", async () => {
  const h = await harness();
  h.entry("item-0").props.onDoubleClick();
  assert.deepEqual(h.calls.open, ["/files/0"]);
  h.key(h.entry("item-0"), "F2"); h.render();
  h.nodes(node => node.type === "input")[0].props.onChange({ target: { value: "Renamed file" } }); h.render();
  const input = h.nodes(node => node.type === "input")[0];
  h.key(input, "Enter"); input.props.onBlur(); h.render();
  assert.equal(h.calls.rename.length, 1);
  assert.equal(h.calls.rename[0][1], "Renamed file");
  assert.equal(h.nodes(node => node.type === "input").length, 0);
});

test("category rename ignores composing Enter and Escape cannot be saved by blur", async () => {
  const h = await harness();
  h.nodes(node => node.type === "span" && node.props.onDoubleClick)[0].props.onDoubleClick(); h.render();
  let input = h.nodes(node => node.type === "input")[0];
  input.props.onChange({ target: { value: "新分类" } }); h.render();
  input = h.nodes(node => node.type === "input")[0];
  h.key(input, "Enter", { nativeEvent: { isComposing: true } }); h.render();
  assert.equal(h.nodes(node => node.type === "input").length, 1);
  assert.deepEqual(h.calls.categoryRename, []);
  input = h.nodes(node => node.type === "input")[0];
  h.key(input, "Escape"); input.props.onBlur(); h.render();
  assert.deepEqual(h.calls.categoryRename, []);
});

test("cancelled item drag clears feedback without committing its last insertion point", async () => {
  const h = await harness(), item = h.entry("item-0"), target = h.elements.get("item-0");
  item.props.onPointerDown({ button: 0, pointerId: 1, clientX: 30, clientY: 70, currentTarget: target });
  target.handlers.get("pointermove")({ clientX: 150, clientY: 70 });
  target.handlers.get("pointercancel")({ clientX: 150, clientY: 70 }); h.render();
  assert.deepEqual(h.calls.move, []);
  assert.deepEqual(h.calls.hold.at(-1), ["item-drag", false]);
  assert.equal(h.nodes(node => String(node.props.className).includes("opacity-40")).length, 0);
});

test("page and title buttons retain compact visuals inside usable named hit areas", async () => {
  const h = await harness();
  const pages = h.nodes(node => node.type === "button" && node.props["aria-current"] !== undefined);
  assert.equal(pages.length, 3);
  assert.equal(pages[0].props["aria-current"], "page");
  assert.ok(pages.every(node => node.props["aria-label"] && /(?:size-6|size-7)/.test(node.props.className)));
  const titles = h.nodes(node => node.type?.name === "TitleBtn").map(node => node.type(node.props));
  assert.ok(titles.length > 0 && titles.every(node => /(?:size-6|size-7)/.test(node.props.className) && node.props["aria-label"]));
  pages[1].props.onClick(); h.render();
  assert.equal(h.entry("item-6").props.tabIndex, 0);
});

const cardOf = h => h.nodes(node => typeof node.props.onMouseEnter === "function")[0];
const opacityOf = h => h.nodes(node => String(node.props.className).includes("transition-opacity"))[0].props.className;

test("ghost mode keeps keyboard focus visible after pointer leave and internal focus movement", async () => {
  const h = await harness({ ghost: true });
  assert.match(opacityOf(h), /opacity-\[0\.14\]/);
  assert.equal(typeof cardOf(h).props.onFocusCapture, "function", "keyboard focus must reveal ghost content");
  cardOf(h).props.onFocusCapture(); cardOf(h).props.onMouseLeave(); h.render();
  assert.match(opacityOf(h), /opacity-100/);
  cardOf(h).props.onBlurCapture({ currentTarget: { contains: () => true }, relatedTarget: {} }); h.render();
  assert.match(opacityOf(h), /opacity-100/);
  cardOf(h).props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null }); h.render();
  assert.match(opacityOf(h), /opacity-\[0\.14\]/);
});

test("ghost category and item rename stay readable until editing is cancelled", async () => {
  const h = await harness({ ghost: true });
  h.nodes(node => node.type === "span" && node.props.onDoubleClick)[0].props.onDoubleClick(); h.render();
  assert.match(opacityOf(h), /opacity-100/);
  h.key(h.nodes(node => node.type === "input")[0], "Escape"); h.render();
  assert.match(opacityOf(h), /opacity-\[0\.14\]/);
  h.key(h.entry("item-0"), "F2"); h.render();
  assert.match(opacityOf(h), /opacity-100/);
  h.key(h.nodes(node => node.type === "input")[0], "Escape"); h.render();
  assert.match(opacityOf(h), /opacity-\[0\.14\]/);
});

test("a keyboard popup keeps its ghost owner readable while the popup holds focus", async () => {
  const h = await harness({ ghost: true });
  h.key(h.entry("item-0"), "F10", { shiftKey: true }); h.render();
  assert.match(opacityOf(h), /opacity-100/);
  assert.deepEqual(h.calls.hold.at(-1), ["menu", true]);
  h.menuChange(false); h.render();
  assert.match(opacityOf(h), /opacity-\[0\.14\]/);
  assert.deepEqual(h.calls.hold.at(-1), ["menu", false]);
});
