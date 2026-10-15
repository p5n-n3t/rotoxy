import { createHash } from "node:crypto";

/**
 * Deterministic, read-only diagnosis and bounded repair planning.
 *
 * This module deliberately consumes snapshots instead of reading machine or
 * application state. Repair plans are previews only; this module executes no
 * commands and mutates no configuration.
 */

export type DoctorStage =
  | "process"
  | "config"
  | "credentials"
  | "upstream"
  | "oauth"
  | "tools"
  | "funnel";

export type StageStatus = "passed" | "failed" | "unverified";
export type FindingSeverity = "critical" | "error" | "warning" | "info";

export interface ProcessSnapshot {
  checked: boolean;
  running?: boolean;
  listening?: boolean;
  healthStatus?: number;
  port?: number;
}

export interface ConfigSnapshot {
  checked: boolean;
  upstreamUrl?: string;
  publicBaseUrl?: string;
  basePath?: string;
  requestTimeoutMs?: number;
}

export interface CredentialSnapshot {
  id: string;
  label?: string;
  enabled: boolean;
  /** Boolean metadata only; never supply credential material to this module. */
  secretAvailable?: boolean;
  state?: string;
  lastStatus?: number;
  lastProbeStatus?: number;
  lastProbeOk?: boolean;
  lastError?: string;
  cooldownUntil?: number;
}

export interface CredentialsSnapshot {
  checked: boolean;
  /** Timestamp used to evaluate cooldownUntil values in the same snapshot. */
  observedAt?: number;
  accounts?: CredentialSnapshot[];
}

export interface UpstreamSnapshot {
  checked: boolean;
  connected?: boolean;
  timedOut?: boolean;
  status?: number;
  initializeOk?: boolean;
  error?: string;
}

export interface OAuthSnapshot {
  checked: boolean;
  expectedIssuer?: string;
  advertisedIssuer?: string;
  expectedResource?: string;
  observedResource?: string;
  callbackUri?: string;
  registeredRedirectUris?: string[];
}

export interface ToolsSnapshot {
  checked: boolean;
  toolsListOk?: boolean;
  status?: number;
  toolCount?: number;
  error?: string;
}

export interface FunnelMountSnapshot {
  path: string;
  targetHost?: string;
  targetPort?: number;
}

export interface FunnelSnapshot {
  checked: boolean;
  enabled?: boolean;
  expectedPath?: string;
  reportedCollision?: boolean;
  mounts?: FunnelMountSnapshot[];
}

export interface DoctorSnapshot {
  process?: ProcessSnapshot;
  config?: ConfigSnapshot;
  credentials?: CredentialsSnapshot;
  upstream?: UpstreamSnapshot;
  oauth?: OAuthSnapshot;
  tools?: ToolsSnapshot;
  funnel?: FunnelSnapshot;
}

export type DoctorActionKind =
  | "inspect-local-process"
  | "review-gateway-config"
  | "review-credential-pool"
  | "check-upstream-availability"
  | "compare-oauth-metadata"
  | "check-tools-list"
  | "review-funnel-mounts";

export interface DoctorAction {
  kind: DoctorActionKind;
  summary: string;
  mode: "manual" | "plan-only";
  repairAction?: RepairCandidate["action"];
}

export interface FindingEvidence {
  source: DoctorStage;
  observation: string;
  statusCode?: number;
  count?: number;
  path?: string;
}

export interface DoctorFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  evidence: FindingEvidence[];
  action: DoctorAction;
}

export interface StageCheck {
  stage: DoctorStage;
  status: StageStatus;
  summary: string;
}

export interface DoctorReport {
  status: "healthy" | "issues" | "incomplete";
  stageChecks: StageCheck[];
  findings: DoctorFinding[];
}

export type RepairCandidate =
  | { action: "set-upstream-url"; value: string }
  | { action: "set-public-base-url"; value: string }
  | { action: "add-funnel-path-mount"; path: string; targetPort: number }
  | { action: "enable-account"; accountId: string; explicitlyRequested: true };

export interface RepairPrecondition {
  name: string;
  satisfied: boolean;
  reason: string;
}

export interface RepairPlan {
  id: string;
  action: RepairCandidate["action"] | "unsupported";
  applicable: boolean;
  preconditions: RepairPrecondition[];
  preview?: { before: Record<string, unknown>; after: Record<string, unknown> };
  summary: string;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validBasePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  if (value === "" || value === "/") return true;
  if (!value.startsWith("/") || value.startsWith("//") || value.endsWith("/")) return false;
  return value
    .slice(1)
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part));
}

function normalizeMountPath(value: string): string | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 128) return undefined;
  if (value === "/") return "/";
  const normalized = value.replace(/\/+$/, "");
  if (!validBasePath(normalized)) return undefined;
  return normalized;
}

function configIssues(config: ConfigSnapshot | undefined): string[] {
  if (!config) return ["config snapshot missing"];
  const issues: string[] = [];
  if (!isHttpUrl(config.upstreamUrl)) issues.push("upstreamUrl must be an HTTP(S) URL without embedded credentials, query, or fragment");
  if (!isHttpUrl(config.publicBaseUrl)) issues.push("publicBaseUrl must be an HTTP(S) URL without embedded credentials, query, or fragment");
  if (!validBasePath(config.basePath)) issues.push("basePath must be an empty path or a normalized absolute path");
  if (!Number.isSafeInteger(config.requestTimeoutMs) || (config.requestTimeoutMs ?? 0) <= 0) {
    issues.push("requestTimeoutMs must be a positive integer");
  }
  return issues;
}

function eligibleAccounts(snapshot: CredentialsSnapshot | undefined): CredentialSnapshot[] {
  return (snapshot?.accounts ?? []).filter(
    (account) =>
      account.enabled &&
      account.secretAvailable === true &&
      !["auth-failed", "exhausted", "disabled"].includes(account.state ?? "") &&
      (account.state !== "cooldown" ||
        (snapshot?.observedAt !== undefined &&
          account.cooldownUntil !== undefined &&
          account.cooldownUntil <= snapshot.observedAt)),
  );
}

function stageChecks(snapshot: DoctorSnapshot): StageCheck[] {
  const process = snapshot.process;
  const processFailed = Boolean(
    process?.checked &&
      (process.running === false ||
        process.listening === false ||
        (process.healthStatus !== undefined && (process.healthStatus < 200 || process.healthStatus >= 300))),
  );
  const processPassed = Boolean(
    process?.checked &&
      process.running === true &&
      process.listening === true &&
      (process.healthStatus === undefined || (process.healthStatus >= 200 && process.healthStatus < 300)),
  );

  const issues = configIssues(snapshot.config);
  const configCheck: StageCheck = !snapshot.config?.checked
    ? { stage: "config", status: "unverified", summary: "Configuration has not been checked." }
    : issues.length
      ? { stage: "config", status: "failed", summary: "Configuration has invalid or missing required fields." }
      : { stage: "config", status: "passed", summary: "Required gateway configuration fields are valid." };

  const accounts = snapshot.credentials;
  const available = eligibleAccounts(accounts);
  const credentialsCheck: StageCheck = !accounts?.checked
    ? { stage: "credentials", status: "unverified", summary: "Credential availability has not been checked." }
    : !accounts.accounts
      ? { stage: "credentials", status: "unverified", summary: "Credential records were not included in the snapshot." }
      : available.length === 0
        ? { stage: "credentials", status: "failed", summary: "No enabled credential with available material is ready." }
        : { stage: "credentials", status: "passed", summary: "At least one enabled credential is available." };

  const upstream = snapshot.upstream;
  const upstreamFailed = Boolean(
    upstream?.checked &&
      (upstream.timedOut === true ||
        upstream.connected === false ||
        upstream.initializeOk === false ||
        (upstream.status !== undefined && (upstream.status < 200 || upstream.status >= 300))),
  );
  const upstreamPassed = Boolean(
    upstream?.checked &&
      upstream.connected === true &&
      upstream.initializeOk === true &&
      upstream.status !== undefined &&
      upstream.status >= 200 &&
      upstream.status < 300 &&
      upstream.timedOut !== true,
  );

  const oauth = snapshot.oauth;
  const oauthHasMismatch = Boolean(
    oauth &&
      ((oauth.expectedIssuer !== undefined && oauth.advertisedIssuer !== undefined && oauth.expectedIssuer !== oauth.advertisedIssuer) ||
        (oauth.expectedResource !== undefined && oauth.observedResource !== undefined && oauth.expectedResource !== oauth.observedResource) ||
        (oauth.callbackUri !== undefined && oauth.registeredRedirectUris !== undefined && !oauth.registeredRedirectUris.includes(oauth.callbackUri))),
  );
  const oauthComplete = Boolean(
    oauth?.checked &&
      oauth.expectedIssuer !== undefined &&
      oauth.advertisedIssuer !== undefined &&
      oauth.expectedResource !== undefined &&
      oauth.observedResource !== undefined &&
      oauth.callbackUri !== undefined &&
      oauth.registeredRedirectUris !== undefined,
  );

  const tools = snapshot.tools;
  const toolsFailed = Boolean(tools?.checked && (tools.toolsListOk === false || (tools.status !== undefined && (tools.status < 200 || tools.status >= 300))));
  const toolsPassed = Boolean(tools?.checked && tools.toolsListOk === true && Number.isSafeInteger(tools.toolCount) && (tools.toolCount ?? -1) >= 0);

  const funnel = snapshot.funnel;
  const funnelState = inspectFunnel(funnel);

  return [
    {
      stage: "process",
      status: processFailed ? "failed" : processPassed ? "passed" : "unverified",
      summary: processFailed ? "The local process or listener check failed." : processPassed ? "The local process and listener were checked." : "A running process and listening local endpoint have not both been confirmed.",
    },
    configCheck,
    credentialsCheck,
    {
      stage: "upstream",
      status: upstreamFailed ? "failed" : upstreamPassed ? "passed" : "unverified",
      summary: upstreamFailed ? "The upstream connection or MCP initialize check failed." : upstreamPassed ? "The upstream connection and MCP initialize probe passed." : "A successful upstream MCP initialize probe has not been recorded.",
    },
    {
      stage: "oauth",
      status: oauthHasMismatch ? "failed" : oauthComplete ? "passed" : "unverified",
      summary: oauthHasMismatch ? "OAuth issuer, resource, or redirect values do not match." : oauthComplete ? "Issuer, resource, and redirect URI values were compared." : "OAuth issuer, resource, and redirect URI checks are incomplete.",
    },
    {
      stage: "tools",
      status: toolsFailed ? "failed" : toolsPassed ? "passed" : "unverified",
      summary: toolsFailed ? "The MCP tools/list check failed." : toolsPassed ? "MCP tools/list returned a valid result." : "A successful MCP tools/list result has not been recorded.",
    },
    {
      stage: "funnel",
      status: funnelState.status,
      summary: funnelState.summary,
    },
  ];
}

function inspectFunnel(funnel: FunnelSnapshot | undefined): { status: StageStatus; summary: string } {
  if (!funnel?.checked || funnel.enabled === undefined) {
    return { status: "unverified", summary: "Funnel status has not been explicitly checked." };
  }
  if (!funnel.enabled) return { status: "passed", summary: "Funnel is explicitly disabled; no external mount is required." };
  if (funnel.reportedCollision || findFunnelCollisions(funnel).length) {
    return { status: "failed", summary: "Funnel mount paths contain a collision." };
  }
  const expected = funnel.expectedPath && normalizeMountPath(funnel.expectedPath);
  if (!expected || !funnel.mounts) {
    return { status: "unverified", summary: "The expected Funnel path or mount listing is missing." };
  }
  if (!funnel.mounts.some((mount) => normalizeMountPath(mount.path) === expected)) {
    return { status: "failed", summary: "The expected Funnel path is not mounted." };
  }
  return { status: "passed", summary: "The expected Funnel path is mounted without a path collision." };
}

function findFunnelCollisions(funnel: FunnelSnapshot | undefined): string[] {
  if (!funnel?.mounts) return [];
  const seen = new Map<string, string>();
  const collisions = new Set<string>();
  for (const mount of funnel.mounts) {
    const path = normalizeMountPath(mount.path);
    if (!path) continue;
    const target = `${mount.targetHost ?? ""}:${mount.targetPort ?? ""}`;
    const prior = seen.get(path);
    if (prior !== undefined && (prior !== target || !target || target === ":")) collisions.add(path);
    else if (prior === undefined) seen.set(path, target);
  }
  return [...collisions].sort();
}

function finding(
  id: string,
  severity: FindingSeverity,
  title: string,
  source: DoctorStage,
  observation: string,
  action: DoctorActionKind,
  actionSummary: string,
  extra: Partial<Pick<FindingEvidence, "statusCode" | "count" | "path">> = {},
  repairAction?: RepairCandidate["action"],
): DoctorFinding {
  return {
    id,
    severity,
    title,
    evidence: [{ source, observation, ...extra }],
    action: {
      kind: action,
      summary: actionSummary,
      mode: repairAction ? "plan-only" : "manual",
      ...(repairAction ? { repairAction } : {}),
    },
  };
}

/** Analyze explicitly supplied observations without I/O or mutation. */
export function diagnoseDoctorSnapshot(snapshot: DoctorSnapshot): DoctorReport {
  const findings: DoctorFinding[] = [];
  const config = snapshot.config;
  const invalidConfig = configIssues(config);
  if (config?.checked && invalidConfig.length) {
    findings.push(finding(
      "config.invalid",
      "error",
      "Gateway configuration is incomplete or invalid",
      "config",
      invalidConfig.join("; "),
      "review-gateway-config",
      "Correct the named fields using the existing configuration UI or CLI.",
      { count: invalidConfig.length },
      !isHttpUrl(config.upstreamUrl) ? "set-upstream-url" : undefined,
    ));
  }

  const process = snapshot.process;
  if (process?.checked && (process.running === false || process.listening === false || (process.healthStatus !== undefined && (process.healthStatus < 200 || process.healthStatus >= 300)))) {
    findings.push(finding(
      "process.unavailable",
      "critical",
      "Local ROTOXY process or listener is unavailable",
      "process",
      "The supplied process snapshot reports a stopped process, closed listener, or failed local health response.",
      "inspect-local-process",
      "Inspect the service manager and local listener state before retrying the pipeline.",
      { ...(process.healthStatus !== undefined ? { statusCode: process.healthStatus } : {}) },
    ));
  }

  const credentials = snapshot.credentials;
  if (credentials?.checked && credentials.accounts) {
    const available = eligibleAccounts(credentials);
    if (available.length === 0) {
      findings.push(finding(
        "credentials.unavailable",
        "error",
        "No enabled credential is ready for an upstream request",
        "credentials",
        "No account is both enabled, confirmed to have encrypted material, and outside a terminal auth or quota state.",
        "review-credential-pool",
        "Check account enablement and credential availability; enter or replace credentials only through the existing secret-safe flow.",
        { count: credentials.accounts.length },
        "enable-account",
      ));
    }
    const rejected = credentials.accounts.filter((account) => account.lastStatus === 401 || account.lastProbeStatus === 401);
    if (rejected.length) {
      findings.push(finding(
        "credentials.rejected",
        "error",
        "An upstream credential was rejected with HTTP 401",
        "credentials",
        "One or more account request or probe snapshots report HTTP 401.",
        "review-credential-pool",
        "Verify the provider credential out of band, then update it through the existing secret-safe flow.",
        { statusCode: 401, count: rejected.length },
      ));
    }
  }

  const upstream = snapshot.upstream;
  const credentialRows = credentials?.accounts ?? [];
  const upstreamQuotaStatus = upstream?.status === 402 || upstream?.status === 429 ? upstream.status : undefined;
  const credentialQuotaStatus = credentialRows
    .flatMap((account) => [account.lastStatus, account.lastProbeStatus])
    .find((status) => status === 402 || status === 429);
  const quotaEvidence = upstreamQuotaStatus ?? credentialQuotaStatus;
  const quotaSource: DoctorStage = upstreamQuotaStatus !== undefined ? "upstream" : "credentials";
  const quotaTextSeen = [upstream?.error, ...credentialRows.map((account) => account.lastError)]
    .some((value) => typeof value === "string" && /rate[\s_-]?limit|quota|credits?\s*(?:are\s*)?(?:depleted|exhausted|exceeded)|insufficient\s+(?:credits?|balance)/i.test(value));
  if (quotaEvidence !== undefined || quotaTextSeen) {
    findings.push(finding(
      "upstream.quota-or-rate-limit",
      "warning",
      "Upstream quota or rate limiting was observed",
      quotaSource,
      "A configured quota status or quota-related error pattern matched the supplied observations.",
      "check-upstream-availability",
      "Review provider quota and Retry-After observations; allow the configured cooldown to expire before retrying.",
      { ...(quotaEvidence !== undefined ? { statusCode: quotaEvidence } : {}) },
    ));
  }

  const timeoutSeen = upstream?.timedOut === true || (typeof upstream?.error === "string" && /timeout|timed out|aborterror/i.test(upstream.error));
  if (upstream?.checked && timeoutSeen) {
    findings.push(finding(
      "upstream.timeout",
      "error",
      "The upstream MCP request timed out",
      "upstream",
      "The supplied upstream observation reports a request timeout.",
      "check-upstream-availability",
      "Check upstream responsiveness and the configured request timeout.",
    ));
  } else if (upstream?.checked && (upstream.connected === false || (typeof upstream.error === "string" && /ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|fetch failed/i.test(upstream.error)))) {
    findings.push(finding(
      "upstream.connection-failed",
      "error",
      "The gateway could not connect to the upstream MCP server",
      "upstream",
      "The supplied connection observation reports a network or name-resolution failure.",
      "check-upstream-availability",
      "Check the upstream URL, DNS, network route, and provider availability.",
    ));
  }
  if (upstream?.checked && upstream.status === 401 && !credentialRows.some((account) => account.lastStatus === 401 || account.lastProbeStatus === 401)) {
    findings.push(finding(
      "credentials.rejected",
      "error",
      "The upstream rejected the request with HTTP 401",
      "upstream",
      "The upstream probe or request returned HTTP 401.",
      "review-credential-pool",
      "Verify the provider credential out of band, then update it through the existing secret-safe flow.",
      { statusCode: 401 },
    ));
  }

  const oauth = snapshot.oauth;
  if (oauth?.checked) {
    const mismatches: string[] = [];
    if (oauth.expectedIssuer !== undefined && oauth.advertisedIssuer !== undefined && oauth.expectedIssuer !== oauth.advertisedIssuer) mismatches.push("issuer");
    if (oauth.expectedResource !== undefined && oauth.observedResource !== undefined && oauth.expectedResource !== oauth.observedResource) mismatches.push("resource");
    if (oauth.callbackUri !== undefined && oauth.registeredRedirectUris !== undefined && !oauth.registeredRedirectUris.includes(oauth.callbackUri)) mismatches.push("redirect URI");
    if (mismatches.length) {
      findings.push(finding(
        "oauth.metadata-mismatch",
        "error",
        "OAuth metadata or redirect values do not match",
        "oauth",
        `The supplied comparisons found mismatched ${mismatches.join(", ")}.`,
        "compare-oauth-metadata",
        "Compare the configured public URL and registered callback with the values used by the client.",
        { count: mismatches.length },
        "set-public-base-url",
      ));
    }
  }

  const tools = snapshot.tools;
  if (tools?.checked && (tools.toolsListOk === false || (tools.status !== undefined && (tools.status < 200 || tools.status >= 300)))) {
    findings.push(finding(
      "tools.discovery-failed",
      "error",
      "MCP tools/list discovery failed",
      "tools",
      "The supplied tools/list probe failed or returned a non-success HTTP status.",
      "check-tools-list",
      "Check that the upstream implements tools/list and inspect its protocol response.",
      { ...(tools.status !== undefined ? { statusCode: tools.status } : {}) },
    ));
  } else if (tools?.checked && tools.toolsListOk === true && tools.toolCount === 0) {
    findings.push(finding(
      "tools.empty",
      "warning",
      "MCP tools/list succeeded but returned no tools",
      "tools",
      "The successful tools/list response contained zero tools.",
      "check-tools-list",
      "Confirm that the selected upstream account exposes the expected tools.",
      { count: 0 },
    ));
  }

  const funnel = snapshot.funnel;
  if (funnel?.checked && funnel.enabled === true) {
    const collisions = findFunnelCollisions(funnel);
    if (funnel.reportedCollision || collisions.length) {
      findings.push(finding(
        "funnel.mount-collision",
        "error",
        "A Funnel mount path is claimed by different targets",
        "funnel",
        "Two supplied mounts use the same normalized path with different targets, or status explicitly reports a collision.",
        "review-funnel-mounts",
        "Inspect only the conflicting path and target; preserve all unrelated Serve and Funnel routes.",
        { count: collisions.length, ...(collisions[0] ? { path: collisions[0] } : {}) },
      ));
    } else if (funnel.expectedPath && funnel.mounts && !funnel.mounts.some((mount) => normalizeMountPath(mount.path) === normalizeMountPath(funnel.expectedPath!))) {
      findings.push(finding(
        "funnel.mount-missing",
        "warning",
        "The expected Funnel path is not mounted",
        "funnel",
        "The expected path does not appear in the supplied mount listing.",
        "review-funnel-mounts",
        "Review an additive mount for the configured path after confirming it is unclaimed.",
        { path: normalizeMountPath(funnel.expectedPath) ?? funnel.expectedPath },
        "add-funnel-path-mount",
      ));
    }
  }

  const checks = stageChecks(snapshot);
  const hasIssues = findings.length > 0 || checks.some((check) => check.status === "failed");
  const complete = checks.every((check) => check.status === "passed");
  return {
    status: hasIssues ? "issues" : complete ? "healthy" : "incomplete",
    stageChecks: checks,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function plan(
  candidate: RepairCandidate,
  preconditions: RepairPrecondition[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  summary: string,
): RepairPlan {
  const applicable = preconditions.every((precondition) => precondition.satisfied);
  // Keep plan identifiers stable without reflecting a supplied URL or account
  // value (which could contain data the caller does not want echoed).
  const identity = [
    candidate.action,
    "value" in candidate && typeof candidate.value === "string" ? candidate.value : "",
    "path" in candidate && typeof candidate.path === "string" ? candidate.path : "",
    "targetPort" in candidate && Number.isSafeInteger(candidate.targetPort) ? candidate.targetPort : 0,
    "accountId" in candidate && typeof candidate.accountId === "string" ? candidate.accountId : "",
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
  return {
    id: `${candidate.action}:${digest}`,
    action: candidate.action,
    applicable,
    preconditions,
    ...(applicable ? { preview: { before, after } } : {}),
    summary: applicable ? summary : `${summary} Preconditions are not all satisfied; no change is proposed.`,
  };
}

function condition(name: string, satisfied: boolean, yes: string, no: string): RepairPrecondition {
  return { name, satisfied, reason: satisfied ? yes : no };
}

/**
 * Build previews for a small, typed allowlist. This function only compares
 * supplied data and never applies any plan.
 */
export function planDoctorRepairs(
  snapshot: DoctorSnapshot,
  candidates: readonly RepairCandidate[],
): RepairPlan[] {
  const report = diagnoseDoctorSnapshot(snapshot);
  const findings = new Set(report.findings.map((item) => item.id));
  return candidates.map((candidate): RepairPlan => {
    if (!candidate || typeof candidate !== "object" || !("action" in candidate)) {
      return { id: "unsupported", action: "unsupported", applicable: false, preconditions: [{ name: "allowlisted action", satisfied: false, reason: "This action is outside the repair allowlist." }], summary: "Unsupported repair actions are rejected." };
    }

    if (candidate.action === "set-upstream-url" || candidate.action === "set-public-base-url") {
      const isUpstream = candidate.action === "set-upstream-url";
      const relevantFinding = isUpstream ? findings.has("config.invalid") : findings.has("oauth.metadata-mismatch");
      const key = isUpstream ? "upstreamUrl" : "publicBaseUrl";
      const validTarget = isHttpUrl(candidate.value);
      const preconditions = [
        condition("configuration checked", snapshot.config?.checked === true, "Configuration snapshot is checked.", "Configuration must be checked before proposing a value."),
        condition("matching diagnosis", relevantFinding, "A matching configuration or OAuth diagnosis exists.", "No matching diagnosis authorizes this field change."),
        condition("validated target", validTarget, "Target is a plain HTTP(S) URL without credentials, query, or fragment.", "Target URL is invalid or contains disallowed credentials, query, or fragment data."),
        ...(isUpstream
          ? [condition("upstream URL invalid", !isHttpUrl(snapshot.config?.upstreamUrl), "Current upstream URL is missing or invalid.", "Current upstream URL already validates; replacing it is outside the plan.")]
          : [condition("target matches observed expectation", snapshot.oauth?.expectedIssuer === candidate.value, "Target equals the explicitly supplied expected issuer.", "Target does not equal the supplied expected issuer.")]),
      ];
      const safeBefore = isHttpUrl(snapshot.config?.[key]) ? snapshot.config![key]! : "<missing-or-invalid>";
      return plan(candidate, preconditions, { [key]: safeBefore }, { [key]: validTarget ? candidate.value : "<rejected>" }, `Preview setting ${key} to the validated target.`);
    }

    if (candidate.action === "add-funnel-path-mount") {
      const expectedPath = snapshot.funnel?.expectedPath;
      const path = normalizeMountPath(candidate.path);
      const collisions = findFunnelCollisions(snapshot.funnel);
      const missingFinding = findings.has("funnel.mount-missing");
      const requestedPort = Number.isSafeInteger(candidate.targetPort) && candidate.targetPort >= 1 && candidate.targetPort <= 65535;
      const preconditions = [
        condition("Funnel checked and enabled", snapshot.funnel?.checked === true && snapshot.funnel.enabled === true, "Funnel is checked and enabled.", "Funnel must be explicitly checked and enabled."),
        condition("missing mount diagnosis", missingFinding, "The expected mount is absent.", "A missing-mount diagnosis is required."),
        condition("configured path", path !== undefined && path === normalizeMountPath(expectedPath ?? ""), "Target path equals the configured expected path.", "Target path does not equal the expected path or is malformed."),
        condition("no existing collision", !snapshot.funnel?.reportedCollision && collisions.length === 0, "No path collision is present.", "A collision must be resolved by an operator before an additive plan."),
        condition("local listener target", requestedPort && candidate.targetPort === snapshot.process?.port, "Target port equals the checked local listener port.", "Target must equal the checked local listener port."),
      ];
      return plan(candidate, preconditions, { path: path ?? "<invalid>", target: "not-mounted" }, { path: path ?? "<invalid>", target: `127.0.0.1:${requestedPort ? candidate.targetPort : "<rejected>"}`, operation: "add-path-only" }, "Preview adding one path-specific local mount; existing mounts are not modified.");
    }

    if (candidate.action === "enable-account") {
      const account = snapshot.credentials?.accounts?.find((item) => item.id === candidate.accountId);
      const requested = candidate.explicitlyRequested === true;
      const unavailableFinding = findings.has("credentials.unavailable");
      const preconditions = [
        condition("explicit operator request", requested, "The caller explicitly requested this account enablement.", "Account enablement requires an explicit request."),
        condition("matching diagnosis", unavailableFinding, "Credential availability is diagnosed.", "No credential-unavailable diagnosis exists."),
        condition("existing account", Boolean(account), "The requested account exists in the snapshot.", "Only an existing account can be referenced."),
        condition("account disabled", account?.enabled === false, "The account is currently disabled.", "The account is not disabled."),
        condition("secret material available", account?.secretAvailable === true, "Snapshot confirms stored material is available.", "Stored material must be confirmed available; no secret is accepted by this API."),
      ];
      return plan(candidate, preconditions, { accountId: account?.id ?? "<unknown>", enabled: account?.enabled ?? "<unknown>" }, { accountId: account?.id ?? "<unknown>", enabled: true }, "Preview enabling one existing account; no credential data is read or changed.");
    }

    return {
      id: "unsupported",
      action: "unsupported",
      applicable: false,
      preconditions: [{ name: "allowlisted action", satisfied: false, reason: "This action is outside the repair allowlist." }],
      summary: "Unsupported repair actions are rejected.",
    };
  });
}
