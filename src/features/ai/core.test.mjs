import test from "node:test";
import assert from "node:assert/strict";
import { cleanConnection, cleanProvider, selectProvider, migrateLegacy, cleanParameters, getProviderModels, selectModel } from "./core.ts";

const text = { id: "text", name: "Local", baseUrl: "http://127.0.0.1:8080/v1/", model: "model", vision: false };
const vision = { ...text, id: "vision", vision: true };

test("model catalog deduplicates ids and keeps only explicit supported metadata", () => {
  const provider = cleanProvider({ ...text, vision: true, models: [
    { id: " model ", vision: false, parameters: { temperature: 0, topP: 1, maxTokens: 2000000, tokenLimitField: "max_completion_tokens", reasoningEffort: "high", apiKey: "private" }, apiKey: "private" },
    { id: "model", vision: true },
    { id: "vision", vision: true },
  ] });
  assert.equal(provider.vision, false);
  assert.deepEqual(provider.models, [
    { id: "model", vision: false, parameters: { temperature: 0, topP: 1, maxTokens: 2000000, tokenLimitField: "max_completion_tokens", reasoningEffort: "high" } },
    { id: "vision", vision: true },
  ]);
});

test("catalog preserves the selected legacy model when refresh omitted it", () => {
  assert.deepEqual(cleanProvider({ ...vision, models: [{ id: "other", vision: false }] }).models,
    [{ id: "other", vision: false }, { id: "model", vision: true }]);
});

test("model helpers accept blank drafts and derive image support from model selection", () => {
  assert.deepEqual(getProviderModels({ ...text, model: "" }), []);
  assert.deepEqual(getProviderModels(vision), [{ id: "model", vision: true }]);
  const provider = { ...text, models: [{ id: "model", vision: false }, { id: "image", vision: true, parameters: { maxTokens: 256 } }] };
  const selected = selectModel(provider, "image");
  assert.equal(selected.model, "image");
  assert.equal(selected.vision, true);
  assert.deepEqual(selected.models[1].parameters, { maxTokens: 256 });
  assert.equal(provider.model, "model");
  assert.throws(() => selectModel(provider, "missing"), /AI_INVALID_MODEL/);
  assert.equal(selectProvider({ providers: [{ ...provider, model: "image", vision: false }], defaultTextId: "text", defaultVisionId: null }, true).vision, true);
});

test("image tasks select an independent model from the same provider", () => {
  const provider = { ...text, models: [{ id: "model", vision: false }, { id: "image", vision: true, parameters: { maxTokens: 256 } }] };
  const config = { providers: [provider], defaultTextId: provider.id, defaultVisionId: null, defaultVisionModel: "image" };
  assert.equal(selectProvider(config).model, "model");
  assert.equal(selectProvider(config, true).model, "image");
  assert.equal(selectProvider(config, true).vision, true);
  assert.throws(() => selectProvider({ ...config, defaultVisionModel: "model" }, true), /AI_PROVIDER_NO_VISION/);
  assert.throws(() => selectProvider({ ...config, defaultVisionModel: "missing" }, true), /AI_INVALID_MODEL/);
});

test("catalog helpers return detached metadata so draft edits cannot mutate saved settings", () => {
  const provider = { ...text, models: [{ id: "model", vision: false, parameters: { temperature: 0.4 } }] };
  const models = getProviderModels(provider);
  models[0].parameters.temperature = 0.8;
  const selected = selectModel(provider, "model");
  selected.models[0].vision = true;
  selected.models[0].parameters.temperature = 1;
  assert.deepEqual(provider.models, [{ id: "model", vision: false, parameters: { temperature: 0.4 } }]);
});

test("parameters preserve zero and explicit enums without fabricating defaults", () => {
  assert.deepEqual(cleanParameters(undefined), {});
  assert.deepEqual(cleanParameters({ temperature: 0, topP: 0.1, maxTokens: 1, tokenLimitField: "max_tokens", reasoningEffort: "none", key: "private" }),
    { temperature: 0, topP: 0.1, maxTokens: 1, tokenLimitField: "max_tokens", reasoningEffort: "none" });
  assert.deepEqual(cleanParameters({}), {});
});

test("parameters reject invalid ranges, types and unsupported enums", () => {
  for (const input of [null, [], "bad", { temperature: -0.1 }, { temperature: 2.1 }, { temperature: NaN }, { temperature: "1" }, { topP: 0 }, { topP: 1.1 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 2000001 }, { maxTokens: Infinity }, { tokenLimitField: "tokens" }, { reasoningEffort: "extreme" }]) {
    assert.throws(() => cleanParameters(input), /AI_INVALID_PARAMETERS/);
  }
});

test("catalog rejects invalid ids and excessive model catalogs", () => {
  for (const model of ["", "bad\nmodel", "x".repeat(513), 123]) {
    assert.throws(() => cleanProvider({ ...text, model }), /AI_INVALID/);
    assert.throws(() => cleanProvider({ ...text, models: [{ id: model, vision: false }] }), /AI_INVALID_MODEL/);
  }
  for (const models of [null, {}, [null], Array.from({ length: 1001 }, (_, n) => ({ id: `m${n}`, vision: false }))]) {
    assert.throws(() => cleanProvider({ ...text, models }), /AI_INVALID_MODEL/);
  }
});

test("provider configuration never copies secret fields", () => {
  assert.deepEqual(cleanProvider({ ...text, apiKey: "test-only-secret", llmApiKey: "test-only-secret" }), { ...text, baseUrl: text.baseUrl.slice(0, -1) });
});

test("model discovery validates a connection without requiring a model or name", () => {
  assert.deepEqual(cleanConnection({ id: "new", baseUrl: text.baseUrl, apiKey: "private" }), { id: "new", baseUrl: text.baseUrl.slice(0, -1) });
  assert.throws(() => cleanConnection({ id: "new", baseUrl: "https://example.com?key=private" }), /AI_INVALID_URL/);
});

test("text and image tasks resolve independent defaults", () => {
  const config = { providers: [text, vision], defaultTextId: text.id, defaultVisionId: vision.id };
  assert.equal(selectProvider(config).id, "text");
  assert.equal(selectProvider(config, true).id, "vision");
  assert.throws(() => selectProvider({ ...config, defaultVisionId: text.id }, true), /VISION/);
});

test("image tasks inherit the global provider unless explicitly overridden", () => {
  const config = { providers: [vision, text], defaultTextId: vision.id, defaultVisionId: null };
  assert.equal(selectProvider(config).id, vision.id);
  assert.equal(selectProvider(config, true).id, vision.id);
  assert.throws(() => selectProvider({ ...config, defaultTextId: text.id }, true), /VISION/);
  assert.throws(() => selectProvider({ ...config, defaultTextId: null }, true), /AI_NO_PROVIDER/);
});

test("provider URLs reject embedded authentication and unsupported schemes", () => {
  for (const baseUrl of ["file:///test", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/#key"]) {
    assert.throws(() => cleanProvider({ ...text, baseUrl }));
  }
});

test("malformed provider ids and field types are rejected", () => {
  assert.throws(() => cleanProvider({ ...text, id: 123 }));
  assert.throws(() => cleanProvider({ ...text, name: null }));
});

test("provider write failure never clears legacy plaintext", async () => {
  let cleared = false;
  await assert.rejects(migrateLegacy({ llmBaseUrl: text.baseUrl, llmModel: text.model, llmApiKey: "" }, {
    saveSecret: async () => {},
    saveProvider: async () => { throw new Error("disk full"); },
    clearLegacy: async () => { cleared = true; },
  }), /disk full/);
  assert.equal(cleared, false);
});

test("legacy migration stores credential and provider before clearing plaintext", async () => {
  const order = [];
  await migrateLegacy({ llmBaseUrl: text.baseUrl, llmModel: text.model, llmApiKey: "test-only-secret" }, {
    saveSecret: async (id, key) => { assert.equal(id, "legacy-news"); assert.equal(key, "test-only-secret"); order.push("secret"); },
    saveProvider: async (provider) => { assert.equal("llmApiKey" in provider, false); order.push("provider"); },
    clearLegacy: async () => { order.push("clear"); },
  });
  assert.deepEqual(order, ["secret", "provider", "clear"]);
});

test("credential failure preserves legacy config and does not switch provider", async () => {
  const order = [];
  await assert.rejects(migrateLegacy({ llmBaseUrl: text.baseUrl, llmModel: text.model, llmApiKey: "test-only-secret" }, {
    saveSecret: async () => { throw new Error("credential unavailable"); },
    saveProvider: async () => { order.push("provider"); },
    clearLegacy: async () => { order.push("clear"); },
  }), /credential unavailable/);
  assert.deepEqual(order, []);
});
