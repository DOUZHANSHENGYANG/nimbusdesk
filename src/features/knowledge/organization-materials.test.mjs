import assert from "node:assert/strict";
import test from "node:test";
import { loadOrganizationMaterials } from "./organization-materials.ts";

const notes = [
  { path: "inbox/capture.md", title: "Captured", kind: "inbox", modifiedAt: 1, preview: "" },
  { path: "resources/article.md", title: "Article", kind: "resource", modifiedAt: 2, preview: "" },
  { path: "inbox/old.md", title: "Old", kind: "inbox", modifiedAt: 3, preview: "" },
];
const captures = [
  { id: "capture", title: "Captured", createdAt: 1, project: "project", source: "https://source", status: "inbox", attachments: [{ name: "diagram.png", path: "assets/images/diagram.png", mime: "image/png" }], notePath: notes[0].path },
  { id: "old", title: "Old", createdAt: 1, project: "", source: "", status: "archived", attachments: [], notePath: notes[2].path, archivedPath: "resources/old.md" },
];
const read = async (path) => ({ path, content: `Content ${path}`, fingerprint: `fingerprint:${path}` });

test("only explicitly selected managed notes are read and each is loaded once", async () => {
  const calls = [];
  const result = await loadOrganizationMaterials(notes, captures, [notes[1].path, notes[1].path], async (path) => { calls.push(path); return read(path); });
  assert.deepEqual(calls, [notes[1].path]);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin, "note");
  assert.equal(result[0].capture.source, notes[1].path);
  assert.equal(result[0].note.fingerprint, `fingerprint:${notes[1].path}`);
});

test("inbox sources preserve capture ownership, attachment paths and read fingerprints", async () => {
  const [result] = await loadOrganizationMaterials(notes, captures, [notes[0].path], read);
  assert.equal(result.capture, captures[0]);
  assert.equal(result.origin, undefined);
  assert.equal(result.note.path, captures[0].notePath);
  assert.equal(result.note.fingerprint, `fingerprint:${captures[0].notePath}`);
});

test("archived canonical notes keep capture identity and attachment ownership", async () => {
  const [result] = await loadOrganizationMaterials(notes, captures, [notes[2].path], read);
  assert.equal(result.capture, captures[1]);
  assert.equal(result.capture.status, "archived");
});

test("unknown or currently unsaved material is rejected before any reads", async () => {
  const calls = [];
  const reader = async (path) => { calls.push(path); return read(path); };
  await assert.rejects(loadOrganizationMaterials(notes, captures, ["unknown.md"], reader));
  await assert.rejects(loadOrganizationMaterials(notes, captures, [notes[0].path], reader, notes[0].path));
  assert.deepEqual(calls, []);
});

test("a read error rejects the selection instead of returning partial material", async () => {
  await assert.rejects(loadOrganizationMaterials(notes, captures, [notes[0].path, notes[1].path], async (path) => {
    if (path === notes[1].path) throw new Error("read failed");
    return read(path);
  }), /read failed/);
});
