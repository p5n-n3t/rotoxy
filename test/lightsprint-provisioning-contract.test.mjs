import test from "node:test";
import assert from "node:assert/strict";
import { classifyLightSprintProvisioningContract } from "../dist/providers/lightsprint-provisioning-contract.js";

const observedRoutes = [
  "POST /api/workspaces/{workspaceId}/tasks",
  "POST /api/workspaces/{workspaceId}/agent-sessions",
  "GET /api/workspaces/{workspaceId}/agent-sessions",
  "This API has default provider auto; model and effort are available in the product.",
].join("\n");

const explicitContract = [
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_ROUTE: POST /api/workspaces/{workspaceId}/tasks",
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_ACCOUNT_PINNED: true",
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_WORKSPACE_SCOPED: true",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_ROUTE: POST /api/workspaces/{workspaceId}/agent-sessions",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_ACCOUNT_PINNED: true",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_WORKSPACE_SCOPED: true",
  "ROTOXY_PROVISIONING_V1 CORRELATION_LOOKUP_ROUTE: GET /api/workspaces/{workspaceId}/agent-sessions",
  "ROTOXY_PROVISIONING_V1 CORRELATION_LOOKUP_KEYS: accountId,workspaceId,taskId,idempotencyKey,payloadDigest",
  "ROTOXY_PROVISIONING_V1 MODEL_PIN: supported; exact=true; values=claude-sonnet-5,codex-medium",
  "ROTOXY_PROVISIONING_V1 EFFORT_PIN: supported; exact=true; values=low,high",
].join("\n");

test("observed routes without identity correlation or exact pins stay unknown", () => {
  const result = classifyLightSprintProvisioningContract({ accountId: "account-a", description: observedRoutes });
  assert.equal(result.contract.status, "unknown");
  assert.equal(result.contract.semantics.taskCreate, false);
  assert.equal(result.contract.semantics.sessionLaunch, false);
  assert.equal(result.contract.semantics.correlationLookup, false);
  assert.equal(result.contract.modelPin.status, "unknown");
  assert.equal(result.contract.effortPin.status, "unknown");
  assert.ok(result.diagnostics.includes("task_create_evidence_missing"));
  assert.ok(result.diagnostics.includes("correlation_lookup_evidence_missing"));
  assert.ok(result.diagnostics.includes("model_pin_semantics_unproven"));
  assert.ok(result.diagnostics.includes("effort_pin_semantics_unproven"));
});

test("fully explicit contract declarations produce a documented, account-pinned contract", () => {
  const result = classifyLightSprintProvisioningContract({ accountId: "account-a", description: explicitContract });
  assert.equal(result.contract.status, "documented");
  assert.deepEqual(result.contract.semantics, {
    accountPinned: true,
    workspaceScoped: true,
    taskCreate: true,
    sessionLaunch: true,
    correlationLookup: true,
  });
  assert.deepEqual(result.contract.modelPin, { status: "supported", values: ["claude-sonnet-5", "codex-medium"] });
  assert.deepEqual(result.contract.effortPin, { status: "supported", values: ["low", "high"] });
  assert.deepEqual(result.diagnostics, []);
});

test("explicitly unsupported exact pin semantics are documented without enabling pins", () => {
  const description = explicitContract
    .replace("MODEL_PIN: supported; exact=true; values=claude-sonnet-5,codex-medium", "MODEL_PIN: unsupported; exact=true")
    .replace("EFFORT_PIN: supported; exact=true; values=low,high", "EFFORT_PIN: unsupported; exact=true");
  const result = classifyLightSprintProvisioningContract({ accountId: "account-a", description });
  assert.equal(result.contract.status, "documented");
  assert.deepEqual(result.contract.modelPin, { status: "unsupported" });
  assert.deepEqual(result.contract.effortPin, { status: "unsupported" });
});

test("malformed and oversized descriptions fail closed without echoing catalog data", () => {
  const secret = "catalog-secret-value";
  const malformed = classifyLightSprintProvisioningContract({ accountId: "account-a", description: null });
  assert.equal(malformed.contract.status, "unknown");
  assert.deepEqual(malformed.diagnostics, ["catalog_invalid"]);

  const oversized = classifyLightSprintProvisioningContract({ accountId: "account-a", description: `${secret}${"x".repeat(128 * 1024)}` });
  assert.equal(oversized.contract.status, "unknown");
  assert.deepEqual(oversized.diagnostics, ["catalog_oversized"]);
  assert.ok(!JSON.stringify(oversized).includes(secret));
});

test("duplicate evidence and incomplete correlation identity cannot establish support", () => {
  const description = explicitContract
    .replace("ROTOXY_PROVISIONING_V1 TASK_CREATE_ACCOUNT_PINNED: true", "ROTOXY_PROVISIONING_V1 TASK_CREATE_ACCOUNT_PINNED: true\nROTOXY_PROVISIONING_V1 TASK_CREATE_ACCOUNT_PINNED: true")
    .replace("accountId,workspaceId,taskId,idempotencyKey,payloadDigest", "accountId,workspaceId,taskId");
  const result = classifyLightSprintProvisioningContract({ accountId: "account-a", description });
  assert.equal(result.contract.status, "unknown");
  assert.equal(result.contract.semantics.taskCreate, false);
  assert.equal(result.contract.semantics.correlationLookup, false);
  assert.ok(result.diagnostics.includes("task_create_account_binding_unproven"));
  assert.ok(result.diagnostics.includes("correlation_lookup_identity_unproven"));
});

test("diagnostics never include raw catalog lines, credentials, or identifiers", () => {
  const result = classifyLightSprintProvisioningContract({
    accountId: "account-a",
    description: `secret bearer-token-abc account-opaque-id\nPOST /private/accounts/account-opaque-id/tasks`,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("bearer-token-abc"));
  assert.ok(!serialized.includes("account-opaque-id"));
  assert.ok(!serialized.includes("/private/accounts"));
});


test("generated base64url account IDs retain contract identity", () => {
  for (const accountId of ["_account", "-account"]) {
    const result = classifyLightSprintProvisioningContract({accountId,description:explicitContract});
    assert.equal(result.contract.accountId,accountId);
    assert.equal(result.contract.status,"documented");
  }
});
