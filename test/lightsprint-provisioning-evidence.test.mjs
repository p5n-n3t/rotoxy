import test from "node:test";
import assert from "node:assert/strict";
import { classifyLightSprintProvisioningContract } from "../dist/providers/lightsprint-provisioning-contract.js";
import { projectLightSprintProvisioningEvidence } from "../dist/providers/lightsprint-provisioning-evidence.js";

const observedRoutes = [
  "POST /api/workspaces/{workspaceId}/tasks",
  "POST /api/workspaces/{workspaceId}/agent-sessions",
  "GET /api/workspaces/{workspaceId}/agent-sessions",
  "provider=unverified secret=do-not-leak",
].join("\n");

const documented = [
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_ROUTE: POST /api/workspaces/{workspaceId}/tasks",
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_ACCOUNT_PINNED: true",
  "ROTOXY_PROVISIONING_V1 TASK_CREATE_WORKSPACE_SCOPED: true",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_ROUTE: POST /api/workspaces/{workspaceId}/agent-sessions",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_ACCOUNT_PINNED: true",
  "ROTOXY_PROVISIONING_V1 SESSION_LAUNCH_WORKSPACE_SCOPED: true",
  "ROTOXY_PROVISIONING_V1 CORRELATION_LOOKUP_ROUTE: GET /api/workspaces/{workspaceId}/agent-sessions",
  "ROTOXY_PROVISIONING_V1 CORRELATION_LOOKUP_KEYS: accountId,workspaceId,taskId,idempotencyKey,payloadDigest",
  "ROTOXY_PROVISIONING_V1 MODEL_PIN: supported; exact=true; values=model-secret-name",
  "ROTOXY_PROVISIONING_V1 EFFORT_PIN: supported; exact=true; values=low,high",
].join("\n");

test("observed task/session routes remain unknown when correlation and exact pins are undocumented", () => {
  const result = classifyLightSprintProvisioningContract({ accountId: "private-account-id", description: observedRoutes });
  const projected = projectLightSprintProvisioningEvidence(result);
  assert.equal(projected.status, "unknown");
  assert.equal(projected.capabilities.taskCreate, false);
  assert.equal(projected.capabilities.sessionLaunch, false);
  assert.equal(projected.capabilities.correlationLookup, false);
  assert.equal(projected.capabilities.modelPin, false);
  assert.equal(projected.capabilities.effortPin, false);
  assert.ok(projected.reasons.includes("correlation_lookup_evidence_missing"));
  assert.ok(projected.reasons.includes("model_pin_semantics_unproven"));
  assert.ok(projected.reasons.includes("effort_pin_semantics_unproven"));
});

test("fully documented contract projects available core provisioning and supported pin capabilities", () => {
  const result = classifyLightSprintProvisioningContract({ accountId: "account-a", description: documented });
  const projected = projectLightSprintProvisioningEvidence(result);
  assert.equal(projected.status, "available");
  assert.deepEqual(projected.capabilities, {
    accountPinned: true,
    workspaceScoped: true,
    taskCreate: true,
    sessionLaunch: true,
    correlationLookup: true,
    modelPin: true,
    effortPin: true,
  });
  assert.deepEqual(projected.reasons, []);
});

test("malformed input fails closed and never leaks raw catalog strings or identifiers", () => {
  const malformed = projectLightSprintProvisioningEvidence({
    accountId: "secret-account",
    contract: { status: "totally-secret-status", route: "https://private.example/key?token=secret" },
    diagnostics: ["raw provider text: bearer-secret"],
  });
  assert.equal(malformed.status, "unknown");
  assert.deepEqual(malformed.reasons, ["evidence_malformed"]);
  assert.deepEqual(malformed.capabilities, {
    accountPinned: false,
    workspaceScoped: false,
    taskCreate: false,
    sessionLaunch: false,
    correlationLookup: false,
    modelPin: false,
    effortPin: false,
  });
  const serialized = JSON.stringify(malformed);
  for (const secret of ["secret-account", "totally-secret-status", "private.example", "bearer-secret"]) {
    assert.ok(!serialized.includes(secret));
  }
});

test("unknown or malicious diagnostic text is discarded instead of echoed", () => {
  const classified = classifyLightSprintProvisioningContract({ accountId: "account-a", description: observedRoutes });
  const projected = projectLightSprintProvisioningEvidence({
    ...classified,
    diagnostics: [...classified.diagnostics, "provider says: token=secret-value"],
  });
  assert.ok(projected.reasons.every((reason) => /^[a-z_]+$/.test(reason)));
  assert.ok(!JSON.stringify(projected).includes("secret-value"));
});
