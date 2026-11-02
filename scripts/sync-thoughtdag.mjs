#!/usr/bin/env node
/**
 * Rebuild the embedded ThoughtDAG bundle from a local ThoughtDAG checkout.
 *
 * Usage:
 *   node scripts/sync-thoughtdag.mjs <path-to-thoughtdag>
 *
 * The source directory must contain `dist/index.html` (run `npm run build`
 * in ThoughtDAG first). The script copies dist, injects the Nimbus bridge and
 * rewrites the absolute asset/tutorial prefixes the SPA expects.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const source = process.argv[2];
if (!source) {
  console.error("usage: node scripts/sync-thoughtdag.mjs <path-to-thoughtdag>");
  process.exit(1);
}

const root = process.cwd();
const dist = path.join(source, "dist");
const target = path.join(root, "public", "thoughtdag");
const bridge = path.join(root, "src-tauri", "resources", "canvas-bridge.js");
const index = path.join(dist, "index.html");

if (!existsSync(index)) {
  console.error(`missing ${index}; run npm run build in the ThoughtDAG checkout first`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });
await cp(bridge, path.join(target, "__nimbus_bridge.js"));
if (existsSync(path.join(source, "LICENSE"))) {
  await cp(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
}

async function rewrite(file) {
  const text = await readFile(file, "utf8");
  const next = text
    .replaceAll("/assets/", "/thoughtdag/assets/")
    .replaceAll("/tutorial/", "/thoughtdag/tutorial/")
    .replaceAll('href="/favicon.svg"', 'href="/thoughtdag/favicon.svg"')
    .replaceAll('href="/logo-social', 'href="/thoughtdag/logo-social')
    .replaceAll('src="/logo-social', 'src="/thoughtdag/logo-social');
  if (next !== text) await writeFile(file, next);
}

async function walk(dir) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(js|html|css)$/.test(entry.name)) await rewrite(file);
  }
}

await walk(target);
const html = await readFile(path.join(target, "index.html"), "utf8");
const stamped = html.replace(/(src="\/thoughtdag\/assets\/[^"]+\.js)"/, `$1?v=${Date.now()}"`);
if (stamped !== html) await writeFile(path.join(target, "index.html"), stamped);
if (!stamped.includes("__nimbus_bridge.js")) {
  await writeFile(
    path.join(target, "index.html"),
    stamped.replace("</head>", '  <script src="/thoughtdag/__nimbus_bridge.js"></script>\n</head>'),
  );
}
console.log(`ThoughtDAG synced from ${dist} -> ${target}`);
