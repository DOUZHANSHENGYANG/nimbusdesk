import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, normalizeBaseUrl, discoverModels, mergeDiscoveredModels } from "./setup.ts";

const provider = { id: "service", name: "Service", baseUrl: "https://example.com", model: "manual", vision: true };

test("service presets contain the official compatible endpoints and identify local services", () => {
  assert.deepEqual(PROVIDER_PRESETS.map(({ id, baseUrl, local }) => [id, baseUrl, local]), [
    ["custom", "", false], ["openai", "https://api.openai.com/v1", false],
    ["deepseek", "https://api.deepseek.com", false], ["siliconflow", "https://api.siliconflow.cn/v1", false],
    ["ollama", "http://localhost:11434/v1", true], ["lmstudio", "http://localhost:1234/v1", true],
  ]);
});

test("normalization removes endpoint suffixes while preserving custom prefixes and credentials for validation", () => {
  assert.equal(normalizeBaseUrl(" https://example.com/gateway/v4/chat/completions/// "), "https://example.com/gateway/v4");
  assert.equal(normalizeBaseUrl("http://localhost:1234/v1/models/"), "http://localhost:1234/v1");
  assert.equal(normalizeBaseUrl("https://example.com/custom/prefix/"), "https://example.com/custom/prefix");
  assert.equal(normalizeBaseUrl("https://user:pass@example.com/models"), "https://user:pass@example.com");
  assert.equal(normalizeBaseUrl("https://example.com/models?key=secret"), "https://example.com/models?key=secret");
});

test("normalization treats endpoint names as paths and keeps query and fragment text intact", () => {
  assert.equal(normalizeBaseUrl("http://models"), "http://models");
  assert.equal(normalizeBaseUrl("https://chat/completions"), "https://chat/completions");
  assert.equal(normalizeBaseUrl("https://example.com/models?key=/models"), "https://example.com/models?key=/models");
  assert.equal(normalizeBaseUrl("https://example.com/models#key/models"), "https://example.com/models#key/models");
});

test("discovery tries normalized endpoint first and adopts the working base", async () => {
  const calls = [];
  const result = await discoverModels({ id: provider.id, baseUrl: `${provider.baseUrl}/custom/models` }, async (connection) => {
    calls.push(connection);
    return [" alpha ", "alpha", "beta"];
  });
  assert.deepEqual(calls, [{ id: "service", baseUrl: "https://example.com/custom" }]);
  assert.deepEqual(result, { baseUrl: "https://example.com/custom", models: ["alpha", "beta"] });
});

test("only endpoint-not-found errors retry the same origin and prefix with v1", async () => {
  for (const error of ["AI_HTTP_404", new Error("AI_HTTP_405")]) {
    const calls = [];
    const result = await discoverModels({ id: "service", baseUrl: "https://example.com/proxy" }, async ({ baseUrl }) => {
      calls.push(baseUrl);
      if (calls.length === 1) throw error;
      return ["model"];
    });
    assert.deepEqual(calls, ["https://example.com/proxy", "https://example.com/proxy/v1"]);
    assert.equal(result.baseUrl, "https://example.com/proxy/v1");
  }
});

test("discovery never retries auth, network, arbitrary errors or an existing v1 path", async () => {
  for (const [baseUrl, error] of [[provider.baseUrl, "AI_HTTP_401"], [provider.baseUrl, "AI_HTTP_403"], [provider.baseUrl, "AI_NETWORK_ERROR"], [provider.baseUrl, "unexpected 404"], [provider.baseUrl, "AI_HTTP_500"], [`${provider.baseUrl}/v1`, "AI_HTTP_404"]]) {
    let calls = 0;
    await assert.rejects(discoverModels({ id: "service", baseUrl }, async () => { calls++; throw new Error(error); }), new RegExp(error));
    assert.equal(calls, 1);
  }
});

test("discovery validates before requests and treats an empty sanitized list as failure", async () => {
  for (const baseUrl of ["https://user:pass@example.com/models", "https://example.com/models?key=private", "file:///models"]) {
    await assert.rejects(discoverModels({ id: "service", baseUrl }, async () => { assert.fail("must not request"); }), /AI_INVALID_URL/);
  }
  await assert.rejects(discoverModels(provider, async () => ["", "bad\nmodel", "x".repeat(513)]), /AI_MODELS_EMPTY/);
});

test("refresh retains manual models and model parameters without trusting discovery metadata", () => {
  const existing = { ...provider, models: [{ id: "manual", vision: true, parameters: { temperature: 0.4 } }, { id: "older", vision: false }] };
  assert.deepEqual(mergeDiscoveredModels(existing, ["new", "manual", " new ", "", "bad\nmodel"]), [
    { id: "manual", vision: true, parameters: { temperature: 0.4 } }, { id: "older", vision: false }, { id: "new", vision: false },
  ]);
  assert.deepEqual(mergeDiscoveredModels(provider, ["new"]), [{ id: "manual", vision: true }, { id: "new", vision: false }]);
});

test("discovery and merges bound stored and rendered model counts", async () => {
  const ids = Array.from({ length: 1100 }, (_, n) => `m${n}`);
  const result = await discoverModels(provider, async () => ids);
  assert.equal(result.models.length, 1000);
  const merged = mergeDiscoveredModels(provider, ids);
  assert.equal(merged.length, 1000);
  assert.equal(merged[0].id, "manual");
});
