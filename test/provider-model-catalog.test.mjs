import test from "node:test";
import assert from "node:assert/strict";
import { fetchProviderModelCatalog, parseProviderModelCatalog } from "../dist/provider-model-catalog.js";

test("OpenRouter free classification requires explicit zero prompt and completion prices", () => {
  const catalog = parseProviderModelCatalog({ data: [
    { id: "vendor/free", name: "Free", pricing: { prompt: "0", completion: "0" } },
    { id: "vendor/paid", pricing: { prompt: "0", completion: "0.0001" } },
    { id: "vendor/unknown", pricing: { prompt: "0" } },
    { id: "vendor/bad", pricing: { prompt: "free", completion: "0" } },
    { id: "vendor/blank", pricing: { prompt: "", completion: "0" } },
    { id: "vendor/hex", pricing: { prompt: "0x0", completion: "0" } },
    { id: "vendor/underflow", pricing: { prompt: "1e-999", completion: "0" } },
    { id: "vendor/request-fee", pricing: { prompt: "0", completion: "0", request: "0.01" } },
    { id: "vendor/request-free", pricing: { prompt: "0.0", completion: "0e+2", request: "0" } },
    { id: "vendor/numeric", pricing: { prompt: 0, completion: 0 } },
    { id: "invalid id", pricing: { prompt: "0", completion: "0" } },
  ] }, "openrouter");
  assert.deepEqual(catalog, [
    { id: "vendor/bad", name: "vendor/bad", free: null },
    { id: "vendor/blank", name: "vendor/blank", free: null },
    { id: "vendor/free", name: "Free", free: true },
    { id: "vendor/hex", name: "vendor/hex", free: null },
    { id: "vendor/numeric", name: "vendor/numeric", free: null },
    { id: "vendor/paid", name: "vendor/paid", free: false },
    { id: "vendor/request-fee", name: "vendor/request-fee", free: false },
    { id: "vendor/request-free", name: "vendor/request-free", free: true },
    { id: "vendor/underflow", name: "vendor/underflow", free: null },
    { id: "vendor/unknown", name: "vendor/unknown", free: null },
  ]);
  assert.equal(parseProviderModelCatalog({ data: [{ id: "gpt-1" }] }, "openai")[0].free, null);
});

test("explicit refresh reads only the saved account origin and returns metadata without changing policy", async () => {
  const account = { id: "account_123456", provider: "openrouter", enabled: true, allowedModels: ["old/model"] };
  const accounts = { credentialForRequest: async id => id === account.id ? { view: account, token: "synthetic-token", origin: "https://openrouter.ai/api/v1" } : undefined };
  let requested;
  const models = await fetchProviderModelCatalog(accounts, account.id, { fetch: async (url, init) => {
    requested = { url, init };
    return new Response(JSON.stringify({ data: [{ id: "vendor/free", pricing: { prompt: "0", completion: "0" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  assert.equal(requested.url, "https://openrouter.ai/api/v1/models");
  assert.equal(requested.init.method, "GET");
  assert.equal(requested.init.redirect, "error");
  assert.equal(requested.init.headers.authorization, "Bearer synthetic-token");
  assert.deepEqual(models, [{ id: "vendor/free", name: "vendor/free", free: true }]);
  assert.deepEqual(account.allowedModels, ["old/model"]);
  await assert.rejects(fetchProviderModelCatalog(accounts, "missing_123", { fetch: async () => { throw Error("must not call"); } }), /account_not_found/);
});

test("catalog rejects malformed and excessive response shapes", () => {
  assert.throws(() => parseProviderModelCatalog({ nope: [] }, "openrouter"), /catalog_invalid/);
  assert.throws(() => parseProviderModelCatalog({ data: Array.from({ length: 2_001 }, (_, i) => ({ id: `m-${i}` })) }, "openrouter"), /catalog_too_large/);
});
