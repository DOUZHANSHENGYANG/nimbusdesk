#!/usr/bin/env node
/**
 * Guard against bridge drift: `src-tauri/resources/canvas-bridge.js` is the
 * source of truth, `public/thoughtdag/__nimbus_bridge.js` is the copy that the
 * embedded SPA actually loads. They must stay byte-identical (line endings
 * aside) or the canvas silently runs an old bridge.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "src-tauri", "resources", "canvas-bridge.js");
const embedded = path.join(root, "public", "thoughtdag", "__nimbus_bridge.js");
const normalize = (text) => text.replace(/\r\n/g, "\n");

const [expected, actual] = await Promise.all([
  readFile(source, "utf8").then(normalize),
  readFile(embedded, "utf8").then(normalize),
]);

if (expected !== actual) {
  console.error(
    `${path.relative(root, embedded)} is out of date.\n` +
      `Run: Copy-Item ${path.relative(root, source)} ${path.relative(root, embedded)} -Force\n` +
      `or: npm run sync:thoughtdag -- <ThoughtDAG checkout>`,
  );
  process.exit(1);
}

console.log("canvas bridge in sync");
