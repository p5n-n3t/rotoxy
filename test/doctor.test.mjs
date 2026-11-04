import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseDoctorSnapshot, planDoctorRepairs } from "../dist/doctor.js";

const healthySnapshot = () => ({
  process: { checked: true, running: true, listening: true, healthStatus: 200, port: 2030 },
  config: {
    checked: true,
    upstreamUrl: "https://provider.example/mcp",
    publicBaseUrl: "https://node.example.ts.net/token2oauth",
    basePath: "/token2oauth",
    requestTimeoutMs: 30_000,
  },
  credentials: {
    checked: true,
    accounts: [{ id: "acct-1", enabled: true, secretAvailable: true, state: "healthy", lastProbeOk: true }],
  },
  upstream: { checked: true, connected: true, status: 200, initializeOk: true },
  oauth: {
    checked: true,
    expectedIssuer: "https://node.example.ts.net/token2oauth",
    advertisedIssuer: "https://node.example.ts.net/token2oauth",
    expectedResource: "https://node.example.ts.net/token2oauth/mcp",
    observedResource: "https://node.example.ts.net/token2oauth/mcp",
    callbackUri: "https://client.example/callback",
    registeredRedirectUris: ["https://client.example/callback"],
  },
  tools: { checked: true, toolsListOk: true, status: 200, toolCount: 2 },
  funnel: {
    checked: true,
    enabled: true,
    expectedPath: "/token2oauth",
    mounts: [
      { path: "/", targetHost: "127.0.0.1", targetPort: 2025 },
      { path: "/token2oauth", targetHost: "127.0.0.1", targetPort: 2030 },
    ],
  },
});

const findingIds = (snapshot) => diagnoseDoctorSnapshot(snapshot).findings.map((finding) => finding.id);

test("reports healthy only after every required pipeline stage passes", () => {
  const report = diagnoseDoctorSnapshot(healthySnapshot());
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.stageChecks.map(({ stage, status }) => [stage, status]), [
    ["process", "passed"],
    ["config", "passed"],
    ["credentials", "passed"],
    ["upstream", "passed"],
    ["oauth", "passed"],
    ["tools", "passed"],
    ["funnel", "passed"],
  ]);
  assert.deepEqual(report.findings, []);
});

test("missing probes are incomplete and do not imply health", () => {
  const report = diagnoseDoctorSnapshot({});
  assert.equal(report.status, "incomplete");
  assert.ok(report.stageChecks.every((check) => check.status === "unverified"));
});

test("an absent optional upstream does not make otherwise valid configuration invalid", () => {
  const snapshot = healthySnapshot();
  delete snapshot.config.upstreamUrl;
  const report = diagnoseDoctorSnapshot(snapshot);
  assert.equal(report.stageChecks.find((check) => check.stage === "config").status, "passed");

  snapshot.config.upstreamUrl = "not a URL";
  assert.ok(findingIds(snapshot).includes("config.invalid"));
});

test("an absent upstream leaves optional checks unverified with current gateway guidance", () => {
  const snapshot = healthySnapshot();
  delete snapshot.config.upstreamUrl;
  snapshot.upstream = { checked: false };
  snapshot.tools = { checked: false };
  const report = diagnoseDoctorSnapshot(snapshot);
  assert.equal(report.stageChecks.find(check => check.stage === "upstream").status, "unverified");
  assert.match(report.stageChecks.find(check => check.stage === "upstream").summary, /No upstream MCP URL is configured/);
  assert.equal(report.stageChecks.find(check => check.stage === "tools").status, "unverified");
  assert.match(report.stageChecks.find(check => check.stage === "tools").summary, /Local broker tools remain authenticated/);
  assert.equal(findingIds(snapshot).includes("tools.discovery-failed"), false);
});

test("evaluates cooldowns against the timestamp in the same credential snapshot", () => {
  const snapshot = healthySnapshot();
  snapshot.credentials.accounts[0].state = "cooldown";
  snapshot.credentials.accounts[0].cooldownUntil = 2000;
  snapshot.credentials.observedAt = 1000;
  assert.ok(findingIds(snapshot).includes("credentials.unavailable"));

  snapshot.credentials.observedAt = 2000;
  assert.equal(findingIds(snapshot).includes("credentials.unavailable"), false);
});

test("diagnoses process, invalid configuration, unavailable credentials, and 401", () => {
  const snapshot = healthySnapshot();
  snapshot.process.listening = false;
  snapshot.config.upstreamUrl = "file:///etc/passwd";
  snapshot.credentials.accounts = [{
    id: "acct-1",
    enabled: false,
    secretAvailable: false,
    lastProbeStatus: 401,
    lastError: "Bearer do-not-return-this",
  }];
  assert.deepEqual(findingIds(snapshot), [
    "config.invalid",
    "credentials.rejected",
    "credentials.unavailable",
    "process.unavailable",
  ]);
  const serialized = JSON.stringify(diagnoseDoctorSnapshot(snapshot));
  assert.equal(serialized.includes("do-not-return-this"), false);
  assert.equal(serialized.includes("/etc/passwd"), false);
});

test("classifies upstream quota, connect failures, and timeouts", () => {
  const quota = healthySnapshot();
  quota.upstream.status = 429;
  assert.ok(findingIds(quota).includes("upstream.quota-or-rate-limit"));

  const connection = healthySnapshot();
  connection.upstream.connected = false;
  connection.upstream.error = "connect ECONNREFUSED 127.0.0.1:9000";
  assert.ok(findingIds(connection).includes("upstream.connection-failed"));

  const timeout = healthySnapshot();
  timeout.upstream.timedOut = true;
  assert.ok(findingIds(timeout).includes("upstream.timeout"));
});

test("detects issuer, resource, and callback mismatches", () => {
  const snapshot = healthySnapshot();
  snapshot.oauth.advertisedIssuer = "https://wrong.example";
  snapshot.oauth.observedResource = "https://wrong.example/mcp";
  snapshot.oauth.callbackUri = "https://client.example/new-callback";
  const report = diagnoseDoctorSnapshot(snapshot);
  const mismatch = report.findings.find((item) => item.id === "oauth.metadata-mismatch");
  assert.equal(mismatch.evidence[0].count, 3);
  assert.equal(mismatch.action.repairAction, "set-public-base-url");
});

test("distinguishes tools/list errors and an empty successful result", () => {
  const failed = healthySnapshot();
  failed.tools.toolsListOk = false;
  failed.tools.status = 500;
  assert.ok(findingIds(failed).includes("tools.discovery-failed"));

  const empty = healthySnapshot();
  empty.tools.toolCount = 0;
  assert.ok(findingIds(empty).includes("tools.empty"));
});

test("detects only conflicting exact Funnel paths and preserves root plus subpath mounts", () => {
  const valid = healthySnapshot();
  assert.equal(diagnoseDoctorSnapshot(valid).stageChecks.find((check) => check.stage === "funnel").status, "passed");

  const collision = healthySnapshot();
  collision.funnel.mounts.push({ path: "/token2oauth/", targetHost: "127.0.0.1", targetPort: 9999 });
  const report = diagnoseDoctorSnapshot(collision);
  const finding = report.findings.find((item) => item.id === "funnel.mount-collision");
  assert.equal(finding.evidence[0].path, "/token2oauth");
  assert.equal(finding.action.mode, "manual");
  assert.equal(finding.action.summary.includes("unrelated"), true);
});

test("creates previews only for allowlisted, preconditioned repairs", () => {
  const snapshot = healthySnapshot();
  snapshot.config.upstreamUrl = "file:///etc/passwd";
  snapshot.funnel.mounts = [{ path: "/", targetHost: "127.0.0.1", targetPort: 2025 }];
  snapshot.credentials.accounts = [{ id: "acct-off", enabled: false, secretAvailable: true, state: "disabled" }];
  const beforePlanning = structuredClone(snapshot);

  const plans = planDoctorRepairs(snapshot, [
    { action: "set-upstream-url", value: "https://provider.example/mcp" },
    { action: "add-funnel-path-mount", path: "/token2oauth", targetPort: 2030 },
    { action: "enable-account", accountId: "acct-off", explicitlyRequested: true },
  ]);
  assert.equal(plans.length, 3);
  assert.ok(plans.every((item) => item.applicable));
  assert.deepEqual(plans[0].preview, {
    before: { upstreamUrl: "<missing-or-invalid>" },
    after: { upstreamUrl: "https://provider.example/mcp" },
  });
  assert.equal(plans[1].preview.after.operation, "add-path-only");
  assert.deepEqual(plans[2].preview.after, { accountId: "acct-off", enabled: true });
  assert.equal(JSON.stringify(plans).includes("command"), false);
  assert.deepEqual(snapshot, beforePlanning);
});

test("blocks Funnel repair on a collision and rejects unsafe target URLs", () => {
  const snapshot = healthySnapshot();
  snapshot.config.upstreamUrl = "file:///etc/passwd";
  snapshot.funnel.mounts.push({ path: "/token2oauth", targetPort: 9999 });
  const [urlPlan, mountPlan] = planDoctorRepairs(snapshot, [
    { action: "set-upstream-url", value: "https://user:password@provider.example/mcp" },
    { action: "add-funnel-path-mount", path: "/token2oauth", targetPort: 2030 },
  ]);
  assert.equal(urlPlan.applicable, false);
  assert.equal(urlPlan.preview, undefined);
  assert.equal(mountPlan.applicable, false);
  assert.ok(mountPlan.preconditions.some((condition) => condition.name === "no existing collision" && !condition.satisfied));
  assert.equal(JSON.stringify([urlPlan, mountPlan]).includes("password"), false);
});

test("rejects unsupported runtime actions without reflecting their payload", () => {
  const unsupported = { action: "run-shell", command: "tailscale funnel reset", token: "secret" };
  const [plan] = planDoctorRepairs(healthySnapshot(), [unsupported]);
  assert.equal(plan.action, "unsupported");
  assert.equal(JSON.stringify(plan).includes("tailscale"), false);
  assert.equal(JSON.stringify(plan).includes("secret"), false);
});
