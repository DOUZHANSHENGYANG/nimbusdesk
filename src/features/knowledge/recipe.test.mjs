import assert from "node:assert/strict";
import test from "node:test";
import { recipeParameters, fillRecipe } from "./recipe-logic.ts";

test("parameters deduplicate, trim and preserve first appearance", () => {
  assert.deepEqual(recipeParameters("{{ port }} {{路径}} {{port}} {{ }}"), ["port", "路径"]);
});
test("replacement stays literal and leaves missing parameters intact", () => {
  assert.equal(fillRecipe("{{ port }} {{missing}} {{path}}", { port: "$&", path: "C:\\tmp" }), "$& {{missing}} C:\\tmp");
  assert.equal(fillRecipe("{{__proto__}}", {}), "{{__proto__}}");
});
