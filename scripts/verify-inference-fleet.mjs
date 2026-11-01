#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { createSupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";
import { CloudflareCredentialStore } from "../dist/cloudflare-ai.js";
import { pkceS256 } from "../dist/crypto.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const REQUIRED = ["--config", "--state-dir", "--project-id", "--cloudflare-account-id", "--oracle-account-id", "--job-id"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL = new Set(["complete", "completed", "failed", "cancelled", "ambiguous", "blocked"]);
const ORACLE_MODELS = new Set(["oracle/qwen3.5:2b", "oracle/deepseek-r1:1.5b"]);

export function parseArgs(argv) {
  const out = { execute: false, timeout_seconds: 300 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--execute") { out.execute = true; continue; }
    if (![...REQUIRED, "--timeout-seconds"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("Usage: verify-inference-fleet.mjs --config PRIVATE_JSON --state-dir PRIVATE_STATE_DIR --project-id ID --cloudflare-account-id ID --oracle-account-id ID --job-id STABLE_ID --execute [--timeout-seconds 300]");
    }
    out[key.slice(2).replaceAll("-", "_")] = argv[++i];
  }
  for (const key of REQUIRED) if (!out[key.slice(2).replaceAll("-", "_")]) throw new Error(`${key} is required`);
  for (const key of ["project_id", "cloudflare_account_id", "oracle_account_id", "job_id"]) {
    if (!SAFE_ID.test(out[key])) throw new Error(`${key} is invalid`);
  }
  if (out.cloudflare_account_id === out.oracle_account_id) throw new Error("Oracle and Cloudflare account IDs must differ");
  out.timeout_seconds = Number(out.timeout_seconds);
  if (!Number.isInteger(out.timeout_seconds) || out.timeout_seconds < 30 || out.timeout_seconds > 300) throw new Error("--timeout-seconds must be 30..300");
  if (!out.execute) throw new Error("Live execution requires explicit --execute");
  return out;
}

export function buildCanaryTasks(jobId, oracleModel, cloudflareModel) {
  const task = (taskId, provider, model, dependsOn, marker) => ({
    taskId, dependsOn, scopeKeys: [`path:inference-canary/${jobId}/${taskId}`],
    instructions: `Reply exactly ${marker} and nothing else. Do not add an explanation, preamble, or other text.`,
    execution: { mode: "inference", provider, model, maxOutputTokens: 64 },
    output: { kind: "text", maxBytes: 1024, format: "plain text", expectedMarker: marker },
  });
  return [
    task("oracle-independent", "oracle", oracleModel, [], `${jobId}-oracle-OK`),
    task("cloudflare-independent", "cloudflare", cloudflareModel, [], `${jobId}-cloudflare-OK`),
    task("oracle-dependency-join", "oracle", oracleModel, ["oracle-independent", "cloudflare-independent"], `${jobId}-join-OK`),
  ];
}

export function validateCanaryResources(resources, { cloudflareAccountId, oracleAccountId, oracleModel, cloudflareModel }) {
  const rows = new Map((Array.isArray(resources) ? resources : []).filter(row => row && typeof row.accountId === "string").map(row => [row.accountId, row]));
  const oracle = rows.get(oracleAccountId);
  const cloudflare = rows.get(cloudflareAccountId);
  const valid = (row, provider, model) => row?.provider === provider && row.enabled === true && row.authorized === true &&
    row.health === "healthy" && row.quota === "unknown" && Array.isArray(row.models) && row.models.includes(model) &&
    Number.isSafeInteger(row.capacity) && row.capacity >= 1 && row.maxOutputTokens >= 64;
  if (!ORACLE_MODELS.has(oracleModel) || !valid(oracle, "oracle", oracleModel)) throw new Error("oracle_resource_not_currently_eligible");
  if (typeof cloudflareModel !== "string" || !/^@cf\/[A-Za-z0-9._/-]{1,180}$/.test(cloudflareModel) || !valid(cloudflare, "cloudflare", cloudflareModel)) {
    throw new Error("cloudflare_resource_not_currently_eligible");
  }
  return { oracle, cloudflare };
}

export function inspectCanaryResources(resources, { cloudflareAccountId, oracleAccountId, oracleModel, cloudflareModel }) {
  const rows = new Map((Array.isArray(resources) ? resources : []).filter(row => row && typeof row.accountId === "string").map(row => [row.accountId, row]));
  const check = (accountId, provider, model, label) => {
    const row = rows.get(accountId);
    const reasons = [];
    if (!row) reasons.push("resource_missing");
    else {
      if (row.provider !== provider) reasons.push("provider_mismatch");
      if (row.enabled !== true) reasons.push("disabled");
      if (row.authorized !== true) reasons.push("authorization_unavailable");
      if (row.health !== "healthy") reasons.push(`health_${row.health === "unknown" ? "unknown" : "degraded"}`);
      if (row.quota !== "unknown") reasons.push("quota_state_not_unknown");
      if (!Array.isArray(row.models) || !row.models.includes(model)) reasons.push("model_not_in_live_allowlist_catalog");
      if (!Number.isSafeInteger(row.capacity) || row.capacity < 1) reasons.push("capacity_unavailable");
      if (!Number.isSafeInteger(row.maxOutputTokens) || row.maxOutputTokens < 64) reasons.push("output_limit_below_64");
    }
    return { provider: label, eligible: reasons.length === 0, reasons,
      ...(row ? { enabled: row.enabled === true, authorized: row.authorized === true, health: row.health,
        quota: row.quota === "unknown" ? "unknown" : "unavailable", modelAllowed: Array.isArray(row.models) && row.models.includes(model),
        capacity: Number.isSafeInteger(row.capacity) ? row.capacity : null,
        maxOutputTokens: Number.isSafeInteger(row.maxOutputTokens) ? row.maxOutputTokens : null,
        provenance: typeof row.provenance === "string" ? row.provenance : "unknown",
        ...(provider === "oracle" ? { eligibleHostCount: Number.isSafeInteger(row.eligibleHostCount) ? row.eligibleHostCount : null } : {}) } : {}) };
  };
  return { oracle: check(oracleAccountId, "oracle", oracleModel, "oracle"),
    cloudflare: check(cloudflareAccountId, "cloudflare", cloudflareModel, "cloudflare") };
}

export async function assertOracleCredentialReady(tokenPath, uid = process.getuid?.()) {
  if (typeof tokenPath !== "string" || !isAbsolute(tokenPath)) throw new Error("ROTOXY_ORACLE_API_TOKEN_FILE must identify an owner-only API token file in this process environment");
  const info = await lstat(tokenPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || uid !== undefined && info.uid !== uid || (info.mode & 0o077) !== 0 ||
      (info.mode & 0o400) === 0 || info.size < 8 || info.size > 4096) {
    throw new Error("ROTOXY_ORACLE_API_TOKEN_FILE is unavailable or not owner-only; no token value was read or logged");
  }
}

const safeError = error => ({ name: error?.name || "Error", code: /^[A-Za-z0-9_]{1,80}$/.test(error?.code || "") ? error.code : undefined, message: String(error?.message || "operation failed").slice(0, 240) });
const responseJson = async response => { if (!response.ok) throw new Error(`local_gateway_http_${response.status}`); return response.json(); };
const listen = server => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen(server.address())); });
const closeServer = server => new Promise(resolveClose => server.close(resolveClose));

function ephemeralIssuerStore(store, base) {
  return new Proxy(store, { get(target, property) {
    if (property === "load") return async () => { const state = await target.load(); return { ...state, config: { ...state.config, publicBaseUrl: base() } }; };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function issueScopedToken(base, password, cleanup) {
  const redirectUri = `${base}/local-oauth-callback`;
  const registration = await responseJson(await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: `inference-canary-${Date.now()}`, redirect_uris: [redirectUri] }) }));
  if (typeof registration.client_id !== "string") throw new Error("temporary_oauth_registration_failed");
  cleanup.clientId = registration.client_id;
  const verifier = randomBytes(48).toString("base64url"), stateValue = randomBytes(24).toString("base64url");
  const form = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri, response_type: "code",
    code_challenge: pkceS256(verifier), code_challenge_method: "S256", state: stateValue, resource: `${base}/mcp`,
    scope: "mcp jobs:read jobs:write", admin_password: password });
  const consent = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const location = consent.headers.get("location");
  if (consent.status < 300 || consent.status >= 400 || !location) throw new Error(`temporary_oauth_consent_failed_${consent.status}`);
  const callback = new URL(location, base);
  if (callback.origin !== base || callback.searchParams.get("state") !== stateValue) throw new Error("temporary_oauth_state_mismatch");
  const code = callback.searchParams.get("code"); if (!code) throw new Error("temporary_oauth_code_missing");
  const token = await responseJson(await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: `${base}/mcp` }) }));
  cleanup.refreshToken = token.refresh_token;
  if (typeof token.access_token !== "string" || token.scope !== "mcp jobs:read jobs:write") throw new Error("temporary_oauth_scope_mismatch");
  return { clientId: registration.client_id, accessToken: token.access_token, refreshToken: token.refresh_token };
}

async function mcp(base, accessToken, id, method, params) {
  const response = await fetch(`${base}/mcp`, { method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const packet = await responseJson(response);
  if (packet.error) throw new Error(`mcp_${method}_error`);
  return packet.result;
}

async function tool(base, token, id, name, args) {
  const result = await mcp(base, token, id, "tools/call", { name, arguments: args });
  if (!result || result.isError) throw new Error(`mcp_tool_${name}_failed`);
  const text = result.content?.find(part => part?.type === "text")?.text;
  if (typeof text !== "string") return result.structuredContent ?? result;
  try { return JSON.parse(text); } catch { throw new Error(`mcp_tool_${name}_invalid_json`); }
}

async function initialize(base, token) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" };
  const init = await responseJson(await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rotoxy-inference-canary", version: "1" } } }) }));
  if (init.result?.protocolVersion !== "2025-06-18" || !init.result?.capabilities?.tools) throw new Error("mcp_initialize_failed");
  const note = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  if (note.status !== 204) throw new Error("mcp_initialized_notification_failed");
  return mcp(base, token, 1, "tools/list", {});
}

function rowsOf(status) { return Array.isArray(status?.tasks) ? status.tasks.filter(row => row && typeof row.taskId === "string") : []; }
function isTerminal(status) {
  if (TERMINAL.has(String(status?.state || "").toLowerCase())) return true;
  const rows = rowsOf(status);
  return rows.some(row => ["failed", "cancelled", "ambiguous", "blocked"].includes(String(row.state || "").toLowerCase())) ||
    rows.length === 3 && rows.every(row => TERMINAL.has(String(row.state || "").toLowerCase()));
}
function hasTerminalFailure(status) {
  return rowsOf(status).some(row => ["failed", "cancelled", "ambiguous", "blocked"].includes(String(row.state || "").toLowerCase()));
}
const pause = milliseconds => new Promise(resolvePause => setTimeout(resolvePause, milliseconds));

/** Drive the durable job protocol through an injectable authenticated MCP tool caller. */
export async function executeCanaryJobFlow({ callTool, projectId, jobId, body, oracleAccountId, cloudflareAccountId,
  timeoutMs = 300_000, pollMs = 750, pauseFn = pause }) {
  const evidence = { jobId, state: "not_started", submission: "not_attempted", idempotency: "not_checked", blockers: [], tasks: [] };
  let submitted;
  try {
    submitted = await callTool("job_submit", body);
    evidence.submission = "accepted";
    evidence.assignmentId = submitted.assignmentId;
    evidence.state = submitted.state || "queued";
  } catch (error) {
    evidence.submission = "ambiguous";
    evidence.blockers.push("submission response ambiguous; the job will not be resubmitted or replayed");
    evidence.submitError = safeError(error);
    return evidence;
  }
  if (submitted.assignmentId !== jobId) throw new Error("assignment_id_mismatch");
  const tasks = body.tasks;
  evidence.tasks = tasks.map(task => ({ taskId: task.taskId, provider: task.execution.provider, model: task.execution.model,
    dependsOn: task.dependsOn, expectedMarker: task.output.expectedMarker, state: "not_started", markerMatched: false }));
  const deadline = Date.now() + timeoutMs;
  const samples = [];
  let status;
  while (Date.now() < deadline) {
    try { status = await callTool("job_status", { projectId, jobId }); }
    catch (error) { evidence.blockers.push(`read-only status lookup failed (${safeError(error).name}); provider work will not be replayed`); break; }
    const rows = rowsOf(status);
    samples.push({ at: new Date().toISOString(), runningTaskIds: rows.filter(row => row.state === "running").map(row => row.taskId) });
    if (isTerminal(status)) break;
    await pauseFn(pollMs);
  }
  evidence.state = status?.state || (Date.now() >= deadline ? "timeout" : "status_unconfirmed");
  evidence.statusSamples = samples;
  const taskRows = rowsOf(status);
  if (!TERMINAL.has(String(status?.state || "").toLowerCase()) && hasTerminalFailure(status)) {
    evidence.state = taskRows.find(row => ["failed", "cancelled", "ambiguous", "blocked"].includes(String(row.state || "").toLowerCase()))?.state || "blocked";
  }
  evidence.tasks = evidence.tasks.map(task => {
    const row = taskRows.find(candidate => candidate.taskId === task.taskId);
    return { ...task, state: row?.state || "unknown", selectedAccountId: row?.selectedAccountId || null,
      generation: row?.generation ?? null, dispatchAt: row?.dispatchAt ?? null, releasedAt: row?.releasedAt ?? null };
  });
  evidence.parallelIndependentObserved = samples.some(sample => sample.runningTaskIds.includes("oracle-independent") && sample.runningTaskIds.includes("cloudflare-independent"));
  if (evidence.tasks.find(task => task.taskId === "oracle-independent")?.selectedAccountId !== oracleAccountId ||
      evidence.tasks.find(task => task.taskId === "cloudflare-independent")?.selectedAccountId !== cloudflareAccountId ||
      evidence.tasks.find(task => task.taskId === "oracle-dependency-join")?.selectedAccountId !== oracleAccountId) {
    evidence.blockers.push("task account pinning did not match requested Oracle/Cloudflare provider accounts");
  }
  const dependencyJoin = taskRows.find(row => row.taskId === "oracle-dependency-join");
  if (dependencyJoin && JSON.stringify(dependencyJoin.dependsOn) !== JSON.stringify(["oracle-independent", "cloudflare-independent"])) {
    evidence.blockers.push("dependency join edges were not returned as submitted");
  }
  if (!evidence.parallelIndependentObserved) evidence.blockers.push("status polling did not observe both independent tasks running simultaneously");
  if (evidence.state === "complete" || evidence.state === "completed") {
    const result = await callTool("job_results", { projectId, jobId });
    const resultRows = Array.isArray(result.results) ? result.results : [];
    for (const task of evidence.tasks) {
      const row = resultRows.find(item => item.taskId === task.taskId);
      task.markerMatched = typeof row?.text === "string" && row.text.split(/\r?\n/).filter(line => line.trim()).at(-1) === task.expectedMarker;
      task.reportedModel = row?.reportedModel ?? null;
      task.finishReason = row?.finishReason ?? null;
      task.terminationEvidence = row?.terminationEvidence ?? null;
      task.modelEvidence = row?.modelEvidence ?? null;
      task.providerHost = row?.providerHost ?? null;
      task.providerAccountId = row?.providerAccountId ?? null;
    }
    evidence.idempotency = "checking_same_request_after_terminal_completion";
    const repeated = await callTool("job_submit", body);
    if (repeated.assignmentId === jobId && repeated.taskCount === 3) evidence.idempotency = "same_assignment_returned_without_new_provider_operations";
    else evidence.blockers.push("same-key submission did not return the original durable assignment");
  }
  if (!evidence.tasks.every(task => task.markerMatched)) evidence.blockers.push("one or more exact terminal markers were not verified in durable results");
  const joinedTask = evidence.tasks.find(task => task.taskId === "oracle-dependency-join");
  if (joinedTask?.state !== "complete" || !joinedTask.dependsOn.includes("oracle-independent") || !joinedTask.dependsOn.includes("cloudflare-independent")) {
    evidence.blockers.push("Oracle dependency join did not complete behind both independent task edges");
  }
  return evidence;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const originalEnvironment = { rotoxy: process.env.ROTOXY_CONFIG_DIR, token2oauth: process.env.TOKEN2OAUTH_CONFIG_DIR };
  const productionStateDir = resolve(options.state_dir);
  const productionConfigPath = resolve(options.config);
  process.env.ROTOXY_CONFIG_DIR = productionStateDir;
  process.env.TOKEN2OAUTH_CONFIG_DIR = productionStateDir;
  const state = new StateStore();
  const stateMeta = await lstat(state.statePath).catch(() => undefined), keyMeta = await lstat(state.keyPath).catch(() => undefined);
  const credentialMeta = await lstat(join(productionStateDir, "cloudflare-ai-credentials.json")).catch(() => undefined);
  const uid = process.getuid?.();
  if (!stateMeta?.isFile() || stateMeta.isSymbolicLink() || !keyMeta?.isFile() || keyMeta.isSymbolicLink() ||
      uid !== undefined && (stateMeta.uid !== uid || keyMeta.uid !== uid) || (stateMeta.mode & 0o077) || (keyMeta.mode & 0o077)) {
    throw new Error("state_dir_must_be_existing_owner_only_state_store");
  }
  if (!credentialMeta?.isFile() || credentialMeta.isSymbolicLink() || uid !== undefined && credentialMeta.uid !== uid || (credentialMeta.mode & 0o077)) {
    throw new Error("cloudflare_credential_store_must_be_existing_owner_only_file");
  }
  await state.init();
  await state.load();
  await assertOracleCredentialReady(process.env.ROTOXY_ORACLE_API_TOKEN_FILE, uid);
  const config = await readSupervisorRuntimeConfig(productionConfigPath);
  const project = config.projects.find(row => row.projectId === options.project_id);
  if (!project) throw new Error("configured_project_not_found");
  const cfCredentialStore = new CloudflareCredentialStore(state);
  const cfAccount = (await cfCredentialStore.listCredentials()).find(row => row.id === options.cloudflare_account_id);
  if (!cfAccount?.enabled) throw new Error("selected_cloudflare_credential_disabled_or_missing");
  if (!cfAccount.allowedModels.length || !cfAccount.allowedModels.every(model => model.startsWith("@cf/"))) throw new Error("selected_cloudflare_credential_has_no_cloudflare_model_allowlist");
  const cloudflareModel = cfAccount.allowedModels[0];
  const oracleModel = "oracle/qwen3.5:2b";
  if (options.oracle_account_id === options.cloudflare_account_id) throw new Error("provider_account_ids_must_be_distinct");

  let authDir, runtimeDir, runtime, gateway, oauth;
  const cleanup = {};
  let submissionAttempted = false;
  const evidence = { jobId: options.job_id, projectId: project.projectId, state: "not_started", submission: "not_attempted",
    providerCallsExpected: 3, tasks: [], dependencySemantics: "scheduler_gate_only; dependency outputs are not interpolated into task prompts",
    idempotency: "not_checked", blockers: [] };
  try {
    runtimeDir = await mkdtemp(join(tmpdir(), "rotoxy-inference-canary-runtime-"));
    authDir = await mkdtemp(join(tmpdir(), "rotoxy-inference-canary-auth-"));
    await mkdir(join(runtimeDir, "bridge"), { mode: 0o700 });
    process.env.ROTOXY_CONFIG_DIR = authDir;
    process.env.TOKEN2OAUTH_CONFIG_DIR = authDir;
    const authStore = new StateStore();
    const temporaryPassword = randomBytes(48).toString("base64url");
    await authStore.init({ adminPassword: temporaryPassword });
    const lazyBackend = { callTool: (...args) => runtime ? runtime.callTool(...args) : Promise.reject(new Error("runtime_not_ready")) };
    const built = await buildApp(ephemeralIssuerStore(authStore, () => `http://127.0.0.1:${gateway?.address()?.port ?? 0}`), { supervisorBackend: lazyBackend });
    gateway = createServer(built.app);
    const address = await listen(gateway);
    const base = `http://127.0.0.1:${address.port}`;
    oauth = await issueScopedToken(base, temporaryPassword, cleanup);
    const isolatedConfig = structuredClone(config);
    const selectedProject = isolatedConfig.projects.find(row => row.projectId === project.projectId);
    selectedProject.clientIds = [oauth.clientId];
    selectedProject.accountIds = [...new Set([options.oracle_account_id, options.cloudflare_account_id])];
    selectedProject.registeredSessions = [];
    selectedProject.freshProvisioningBindings = [];
    selectedProject.inferenceBindings = [{ accountId: options.oracle_account_id, provider: "oracle", maxOutputTokens: 128 }];
    isolatedConfig.projects = [selectedProject];
    delete isolatedConfig.sharedWorkspace;
    const privateConfig = join(runtimeDir, "runtime.json");
    await writeFile(privateConfig, `${JSON.stringify(isolatedConfig, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    runtime = await createSupervisorRuntime({ configPath: privateConfig, configDir: join(runtimeDir, "bridge"),
      supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)), store: state,
      routingConfigDir: productionStateDir,
      supervisionDbPath: join(runtimeDir, "supervision.sqlite3"), recoveryDbPath: join(runtimeDir, "recovery.sqlite3") });

    const listed = await initialize(base, oauth.accessToken);
    const submitTool = Array.isArray(listed.tools) ? listed.tools.find(item => item?.name === "job_submit") : undefined;
    const inferenceArm = submitTool?.inputSchema?.properties?.tasks?.items?.properties?.execution?.oneOf?.some(arm => arm?.properties?.mode?.const === "inference");
    if (!inferenceArm) throw new Error("job_submit_inference_schema_unavailable");
    const workers = await tool(base, oauth.accessToken, 2, "job_workers", { projectId: project.projectId });
    evidence.resourcePreflight = inspectCanaryResources(workers.inferenceResources, { oracleAccountId: options.oracle_account_id,
      cloudflareAccountId: options.cloudflare_account_id, oracleModel, cloudflareModel });
    if (!evidence.resourcePreflight.oracle.eligible || !evidence.resourcePreflight.cloudflare.eligible) {
      evidence.blockers.push(...["oracle", "cloudflare"].filter(provider => !evidence.resourcePreflight[provider].eligible)
        .map(provider => `${provider}_resource_not_currently_eligible:${evidence.resourcePreflight[provider].reasons.join(",")}`));
      return;
    }
    const resources = validateCanaryResources(workers.inferenceResources, { oracleAccountId: options.oracle_account_id,
      cloudflareAccountId: options.cloudflare_account_id, oracleModel, cloudflareModel });
    evidence.resources = { oracle: { model: oracleModel, capacity: resources.oracle.capacity,
      quota: resources.oracle.quota, provenance: resources.oracle.provenance, eligibleHostCount: resources.oracle.eligibleHostCount },
      cloudflare: { model: cloudflareModel, capacity: resources.cloudflare.capacity,
        quota: resources.cloudflare.quota, provenance: resources.cloudflare.provenance } };

    const tasks = buildCanaryTasks(options.job_id, oracleModel, cloudflareModel);
    const body = { schemaVersion: 1, jobId: options.job_id, idempotencyKey: options.job_id, projectId: project.projectId,
      eligibleAccountIds: [options.oracle_account_id, options.cloudflare_account_id], scheduling: { profile: "custom", maxConcurrency: 3 }, tasks };
    evidence.submittedAt = new Date().toISOString();
    submissionAttempted = true;
    const flow = await executeCanaryJobFlow({
      callTool: (name, args) => tool(base, oauth.accessToken, name === "job_submit" ? 3 : name === "job_status" ? 4 : name === "job_results" ? 5 : 6, name, args),
      projectId: project.projectId, jobId: options.job_id, body, oracleAccountId: options.oracle_account_id,
      cloudflareAccountId: options.cloudflare_account_id, timeoutMs: options.timeout_seconds * 1000,
    });
    Object.assign(evidence, flow);
  } finally {
    const authStore = new StateStore();
    if (authDir) process.env.TOKEN2OAUTH_CONFIG_DIR = authDir;
    if (cleanup.clientId) await authStore.update(current => {
      current.oauthClients = current.oauthClients.filter(client => client.clientId !== cleanup.clientId);
      if (cleanup.refreshToken) {
        const tokenHash = createHash("sha256").update(cleanup.refreshToken).digest("base64url");
        current.refreshTokens = current.refreshTokens.filter(record => record.tokenHash !== tokenHash);
      }
    }).catch(() => undefined);
    if (oauth) { oauth.accessToken = ""; oauth.refreshToken = ""; }
    if (runtime) await runtime.close().catch(() => undefined);
    if (gateway?.listening) {
      gateway.closeAllConnections();
      await closeServer(gateway);
    }
    if (originalEnvironment.rotoxy === undefined) delete process.env.ROTOXY_CONFIG_DIR;
    else process.env.ROTOXY_CONFIG_DIR = originalEnvironment.rotoxy;
    if (originalEnvironment.token2oauth === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
    else process.env.TOKEN2OAUTH_CONFIG_DIR = originalEnvironment.token2oauth;
    const retain = submissionAttempted && (evidence.submission !== "accepted" || evidence.state !== "complete" || evidence.blockers.length > 0);
    if (!retain) { if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined); if (authDir) await rm(authDir, { recursive: true, force: true }).catch(() => undefined); }
    else evidence.retainedRuntimeDir = runtimeDir;
    evidence.cleanup = "temporary OAuth records removed; temporary auth/runtime retained only if execution needs reconciliation; gateway and bridge closed";
    evidence.observedAt = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch(error => { process.stderr.write(`${JSON.stringify({ state: "harness_error", error: safeError(error) })}\n`); process.exitCode = 1; });
}
