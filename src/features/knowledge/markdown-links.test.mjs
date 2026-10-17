import assert from "node:assert/strict";
import test from "node:test";
import { remarkWikiLinks, vaultImagePath } from "./markdown-links.ts";

test("WikiLinks produce note links and named image embeds without changing code", () => {
  const tree = { type: "root", children: [
    { type: "paragraph", children: [{ type: "text", value: "参考 [[开发配方#排错|排错流程]] 与 ![[assets/images/测试.png|300]]。" }] },
    { type: "code", value: "[[不要转换]]" },
    { type: "link", url: "https://example.com", children: [{ type: "text", value: "[[文字]]" }] },
  ] };
  remarkWikiLinks()(tree);
  const nodes = tree.children[0].children;
  assert.deepEqual(nodes.map((node) => node.type), ["text", "link", "text", "image", "text"]);
  assert.equal(nodes[1].type, "link");
  assert.equal(nodes[1].url, "vault-note:" + encodeURIComponent("开发配方#排错"));
  assert.equal(nodes[1].children[0].value, "排错流程");
  assert.equal(nodes[3].type, "image");
  assert.equal(nodes[3].url, "vault-image:" + encodeURIComponent("assets/images/测试.png"));
  assert.equal(nodes[3].alt, "测试.png");
  assert.equal(tree.children[1].value, "[[不要转换]]");
  assert.equal(tree.children[2].children[0].type, "text");
});

test("image resolution supports vault and relative paths but rejects escaping and remote sources", () => {
  const note = "02-工作/开发经验/笔记.md";
  assert.equal(vaultImagePath("../../assets/images/测试%20图.png", note), "assets/images/测试 图.png");
  assert.equal(vaultImagePath("assets/images/截图.png", note), "assets/images/截图.png");
  for (const path of ["../../../assets/images/a.png", "https://example.com/a.png", "C:/a.png", "assets/images/../../secret.png", "assets/images/../../assets/images/ok.png", "assets/images/%00.png"]) {
    assert.equal(vaultImagePath(path, note), null, path);
  }
});
