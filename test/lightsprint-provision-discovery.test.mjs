import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LightSprintJobsAdapter } from "../dist/providers/lightsprint-jobs.js";

const ACCOUNT_A = "account-a";
const legacyDescription = [
  "POST /api/tasks",
  "POST /api/tasks/{taskId}/lightsprint-agents/{claude|codex|auto|pi}",
  "GET /api/tasks/{taskId}/lightsprint-agents",
  "The generic client prose mentions models and effort, but not exact pins.",
].join("\n");
const workspaceDescription = [
  "POST /api/tasks",
  "POST /api/agent-sessions",
  "GET /api/agent-sessions",
].join("\n");

test("recognizes the observed workspace catalog shorthand only with its explicit prefix declaration", async () => {
  const routes=["POST …/tasks", "POST …/agent-sessions", "GET …/agent-sessions"].join("\n");
  const description="Every path starts /api/workspaces/{workspaceId}/, written `…/` below — send it in full.\n"+routes;
  const h=harness({description});
  const result=await h.adapter.discoverProvisioningContract();
  assert.equal(result.family,"workspace-task");
  assert.equal(result.launchRouteAvailable,true);
  assert.equal(result.listRouteAvailable,true);
  assert.deepEqual(h.calls.map(c=>c.method),["tools/list"]);
  assert.equal((await harness({description:routes}).adapter.discoverProvisioningContract()).family,"unknown");
  const full=await harness({description:routes.replaceAll("…/","/api/workspaces/{workspaceId}/")}).adapter.discoverProvisioningContract();
  assert.equal(full.family,"workspace-task");
  assert.equal(full.listRouteAvailable,true);
});

function harness({ accountId = ACCOUNT_A, description, pages, error, provider = "lightsprint" } = {}) {
  const calls = [];
  const factoryOptions = [];
  const storeCalls = [];
  const store = {
    async load() {
      storeCalls.push("load");
      return { config: {}, accounts: [{ id: accountId, provider, enabled: true, stats: { state: "healthy" } }] };
    },
    async revealToken(account) {
      storeCalls.push(`reveal:${account.id}`);
      return `private-token-${account.id}`;
    },
  };
  const listedPages = pages ?? [{ tools: [{ name: "lightsprint_api", description }] }];
  let pageIndex = 0;
  const adapter = new LightSprintJobsAdapter(store, accountId, {
    clientFactory(options) {
      factoryOptions.push(options);
      return {
        async request(method, params) {
          calls.push({ method, params });
          if (method !== "tools/list") throw new Error("unexpected mutating call");
          if (error) throw error;
          return listedPages[pageIndex++];
        },
      };
    },
  });
  return { adapter, calls, factoryOptions, storeCalls };
}

test("recognizes exact legacy task routes, hashes description, and makes only tools/list calls", async () => {
  const h = harness({ description: legacyDescription });
  const result = await h.adapter.discoverProvisioningContract();
  assert.equal(result.accountId, ACCOUNT_A);
  assert.equal(result.family, "legacy-task");
  assert.equal(result.descriptionSha256, createHash("sha256").update(legacyDescription).digest("hex"));
  assert.equal(result.launchRouteAvailable, true);
  assert.equal(result.listRouteAvailable, true);
  assert.equal(result.modelPin, "unknown");
  assert.equal(result.effortPin, "unknown");
  assert.equal(result.status, "documented");
  assert.deepEqual(h.calls, [{ method: "tools/list", params: {} }]);
  assert.equal(h.factoryOptions[0].token, `private-token-${ACCOUNT_A}`);
  assert.deepEqual(h.storeCalls, ["load", "reveal:account-a"]);
});

test("recognizes workspace-task only from the exact launch route and reports documented list availability", async () => {
  const h = harness({ description: workspaceDescription });
  const result = await h.adapter.discoverProvisioningContract();
  assert.equal(result.family, "workspace-task");
  assert.equal(result.launchRouteAvailable, true);
  assert.equal(result.listRouteAvailable, true);
  assert.equal(result.modelPin, "unknown", "generic model wording never establishes an exact pin");

  const noList = harness({ description: "POST /api/tasks\nPOST /api/agent-sessions" });
  assert.equal((await noList.adapter.discoverProvisioningContract()).listRouteAvailable, false);
});

test("different pinned accounts can expose different documented contracts", async () => {
  const legacy = harness({ accountId: "account-legacy", description: legacyDescription });
  const workspace = harness({ accountId: "account-workspace", description: workspaceDescription });
  const [a, b] = await Promise.all([
    legacy.adapter.discoverProvisioningContract(), workspace.adapter.discoverProvisioningContract(),
  ]);
  assert.equal(a.family, "legacy-task");
  assert.equal(b.family, "workspace-task");
  assert.equal(legacy.factoryOptions[0].token, "private-token-account-legacy");
  assert.equal(workspace.factoryOptions[0].token, "private-token-account-workspace");
});

test("missing, malformed, and drifted catalogs remain unknown", async () => {
  const missing = harness({ pages: [{ tools: [{ name: "other_tool", description: "POST /api/tasks" }] }] });
  const missingResult = await missing.adapter.discoverProvisioningContract();
  assert.equal(missingResult.family, "unknown");
  assert.equal(missingResult.reason, "catalog_missing");
  assert.equal(missingResult.descriptionSha256, null);

  const malformed = harness({ pages: [{ tools: "not-an-array" }] });
  const malformedResult = await malformed.adapter.discoverProvisioningContract();
  assert.equal(malformedResult.family, "unknown");
  assert.equal(malformedResult.reason, "catalog_malformed");

  const badDescription = harness({ pages: [{ tools: [{ name: "lightsprint_api", description: { text: "POST /api/agent-sessions" } }] }] });
  assert.equal((await badDescription.adapter.discoverProvisioningContract()).reason, "catalog_malformed");

  const drift = harness({ description: "POST /api/tasks\nPOST /api/agent-sessions/create\nGET /api/agent-sessions" });
  const driftResult = await drift.adapter.discoverProvisioningContract();
  assert.equal(driftResult.family, "unknown");
  assert.equal(driftResult.reason, "contract_unrecognized");
  assert.ok(driftResult.descriptionSha256);
});

test("catalog pagination is bounded and cursor loops become unknown", async () => {
  const paged = harness({ pages: [
    { tools: [{ name: "other" }], nextCursor: "second" },
    { tools: [{ name: "lightsprint_api", description: workspaceDescription }] },
  ] });
  const result = await paged.adapter.discoverProvisioningContract();
  assert.equal(result.family, "workspace-task");
  assert.deepEqual(paged.calls.map((call) => call.params), [{}, { cursor: "second" }]);

  const loop = harness({ pages: [{ tools: [{ name: "lightsprint_api", description: workspaceDescription }], nextCursor: "loop" },
    { tools: [{ name: "other" }], nextCursor: "loop" }] });
  const loopResult = await loop.adapter.discoverProvisioningContract();
  assert.equal(loopResult.family, "unknown");
  assert.equal(loopResult.reason, "catalog_malformed");
});

test("auth and transport failures return sanitized metadata without raw error text", async () => {
  const auth = harness({ error: Object.assign(new Error("private bearer token"), { status: 401 }) });
  const authResult = await auth.adapter.discoverProvisioningContract();
  assert.equal(authResult.status, "unavailable");
  assert.equal(authResult.reason, "auth_failed");
  assert.ok(!JSON.stringify(authResult).includes("private bearer token"));

  const transport = harness({ error: new Error("secret endpoint credential") });
  const transportResult = await transport.adapter.discoverProvisioningContract();
  assert.equal(transportResult.status, "unavailable");
  assert.equal(transportResult.reason, "transport_failed");
  assert.ok(!JSON.stringify(transportResult).includes("secret endpoint credential"));
  assert.deepEqual([...auth.calls, ...transport.calls].map((call) => call.method), ["tools/list", "tools/list"]);
});
