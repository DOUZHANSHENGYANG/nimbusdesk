import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { frontmatterRange, tagsFromContent, inferTags, withTags } from "../src/features/knowledge/metadata.ts";

const value = (key) => process.argv[process.argv.indexOf(key) + 1];
if (!process.argv.includes("--vault") || !process.argv.includes("--output")) throw new Error("Use --vault <root> --output <report directory> [--apply]");
const root = await fs.realpath(value("--vault"));
const output = path.resolve(value("--output"));
if (output.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error("Backups must be outside the vault");
const apply = process.argv.includes("--apply");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const body = (text) => { const range = frontmatterRange(text); return range ? text.slice(range.body) : text.replace(/^\ufeff/, ""); };
const records = [];
async function walk(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["skills", "node_modules", "target", "vendor", "_raw", "08-白板草图"].includes(entry.name)) continue;
    const filename = path.join(folder, entry.name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { await walk(filename); continue; }
    if (!entry.name.endsWith(".md") || /^(AGENTS|CLAUDE|SKILL|README|_INDEX)\.md$/i.test(entry.name) || entry.name.endsWith(".excalidraw.md")) continue;
    const relative = path.relative(root, filename).replaceAll("\\", "/");
    let record;
    try {
      const bytes = await fs.readFile(filename);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (bytes.length > 8 * 1024 * 1024 || body(content).trim().length < 30) { records.push({ path: relative, status: "skipped-short-or-large" }); continue; }
      if (tagsFromContent(content).length) { records.push({ path: relative, status: "already-tagged" }); continue; }
      const tags = inferTags(relative, content);
      if (!tags.length) { records.push({ path: relative, status: "needs-topic-review" }); continue; }
      const updated = withTags(content, tags, true);
      // A missing header adds a separating blank line, without changing body bytes.
      const expectedBody = frontmatterRange(content) ? body(content) : (content.includes("\r\n") ? "\r\n" : "\n") + content.replace(/^\ufeff/, "");
      if (body(updated) !== expectedBody) throw new Error("Body preservation check failed");
      record = { path: relative, tags, status: apply ? "tagged" : "planned", originalSha256: digest(bytes), updatedSha256: digest(Buffer.from(updated)), originalModifiedAt: stat.mtime.toISOString() };
      if (apply) {
        const resolved = await fs.realpath(filename);
        if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error("Note escaped the vault");
        const backup = path.join(output, "originals", ...relative.split("/"));
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, bytes, { flag: "wx" });
        const temporary = filename + ".workbench-tags.tmp";
        await fs.writeFile(temporary, updated, { encoding: "utf8", flag: "wx" });
        if (digest(await fs.readFile(filename)) !== record.originalSha256) throw new Error("External edit detected; original was not replaced");
        await fs.rename(temporary, filename);
        if (digest(await fs.readFile(filename)) !== record.updatedSha256) throw new Error("Post-write verification failed");
      }
    } catch (error) { record = { path: relative, status: "skipped-error", error: error.message }; }
    records.push(record);
  }
}
for (const scope of ["01-技术", "02-工作", "04-资源收藏", "08-收件箱"]) {
  const folder = path.join(root, scope);
  try { if (!(await fs.lstat(folder)).isSymbolicLink()) await walk(folder); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
await fs.mkdir(output, { recursive: true });
const summary = Object.fromEntries([...new Set(records.map((record) => record.status))].map((status) => [status, records.filter((record) => record.status === status).length]));
await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ apply, generatedAt: new Date().toISOString(), summary, records }, null, 2));
console.log(JSON.stringify({ apply, summary, preview: records.filter((record) => ["planned", "tagged", "needs-topic-review", "skipped-error"].includes(record.status)).slice(0, 18).map(({ path, tags, status, error }) => ({ path, tags, status, error })) }, null, 2));
