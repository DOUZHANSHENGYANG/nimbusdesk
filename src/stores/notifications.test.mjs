import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

async function load() {
  const code = ts.transpileModule(await readFile(new URL("./notifications.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?;\s*/gm, "");
  const deps = {
    create,
    persist,
    createJSONStorage,
    tauriJsonStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  const key = `__notifications${Date.now()}${Math.random().toString(36).slice(2)}`;
  globalThis[key] = deps;
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(deps).join(",")}}=globalThis.${key};\n${code}`).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

test("dedupes by key, keeps unread, and caps the inbox", async () => {
  const { useNotifications } = await load();
  const add = useNotifications.getState().add;
  const first = add({ source: "skill", level: "error", title: "更新失败", dedupeKey: "skill:a" });
  const second = add({ source: "skill", level: "error", title: "更新失败（重试）", dedupeKey: "skill:a" });
  assert.equal(first.id, second.id);
  assert.equal(useNotifications.getState().items.length, 1);
  assert.equal(useNotifications.getState().items[0].count, 2);
  assert.equal(useNotifications.getState().items[0].read, false);

  useNotifications.getState().markRead(first.id);
  add({ source: "skill", level: "error", title: "再次失败", dedupeKey: "skill:a" });
  assert.equal(useNotifications.getState().items[0].read, false);
  assert.equal(useNotifications.getState().items[0].count, 3);

  for (let index = 0; index < 205; index++) {
    add({ source: "schedule", level: "info", title: `task ${index}`, dedupeKey: `task:${index}` });
  }
  assert.equal(useNotifications.getState().items.length, 200);
});
