import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../dist/store.js";
import { refreshBedrockCatalog, loadBedrockCatalog, loadBedrockSettings, saveBedrockSettings } from "../dist/bedrock-catalog.js";

async function withStore(t) {
  const dir = await mkdtemp(join(tmpdir(), "rotoxy-bedrock-catalog-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(dir, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(dir, "config");
  const store = new StateStore(); await store.init({ adminPassword: "temporary-bedrock-catalog-password" });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldConfig === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR; else process.env.TOKEN2OAUTH_CONFIG_DIR = oldConfig;
  });
  return { dir, store };
}

test("runtime refresh lists paginated foundation models and inference profiles with entitlement unknown", async t => {
  const { dir, store } = await withStore(t); const calls = [];
  const snapshot = await refreshBedrockCatalog(store, { region: "us-east-1", transport: "invoke", enabledModels: [] }, {
    now: () => 1234,
    runtimeClientFactory: () => ({ send: async command => {
      calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListFoundationModelsCommand") {
        assert.equal(command.input.byProvider, "Anthropic");
        return { modelSummaries: [{ modelId: "anthropic.claude-3-5-haiku-20241022-v1:0", modelName: "Claude Haiku" }, { modelId: "amazon.titan-text-v2", modelName: "Titan Text" }] };
      }
      if (!command.input.nextToken) return { inferenceProfileSummaries: [{ inferenceProfileId: "us.anthropic.claude-sonnet-4-6", inferenceProfileName: "Claude profile" }], nextToken: "page2" };
      return { inferenceProfileSummaries: [{ inferenceProfileId: "global.anthropic.claude-opus-4-6-v1", inferenceProfileName: "Claude Opus profile" }] };
    }, destroy() {} }),
  });
  assert.equal(snapshot.refreshedAt, 1234);
  assert.equal(snapshot.models.length, 3);
  assert.ok(snapshot.models.every(row => row.entitlement === "unknown"));
  assert.deepEqual(calls.map(row => row.name), ["ListFoundationModelsCommand", "ListInferenceProfilesCommand", "ListInferenceProfilesCommand"]);
  assert.deepEqual(await loadBedrockCatalog(store), snapshot);
  assert.deepEqual(await loadBedrockSettings(store), undefined);
  assert.equal((await stat(join(dir, "config", "state.json"))).mode & 0o777, 0o600);
});

test("Mantle discovery is injected, read-only, and settings persist through StateStore.update", async t => {
  const { store } = await withStore(t); let requestedRegion;
  await saveBedrockSettings(store, { region: "eu-west-1", transport: "mantle", enabledModels: ["anthropic.claude-3-5-haiku-20241022-v1:0"] });
  const snapshot = await refreshBedrockCatalog(store, { region: "eu-west-1", transport: "mantle", enabledModels: [] }, {
    mantleList: async region => { requestedRegion = region; return { data: [{ id: "anthropic.claude-3-5-haiku-20241022-v1:0", name: "Claude Haiku" }] }; },
  });
  assert.equal(requestedRegion, "eu-west-1");
  assert.deepEqual(snapshot.models, [{ id: "anthropic.claude-3-5-haiku-20241022-v1:0", name: "Claude Haiku", source: "mantle", entitlement: "unknown" }]);
  assert.deepEqual((await loadBedrockSettings(store)).enabledModels, ["anthropic.claude-3-5-haiku-20241022-v1:0"]);
});
