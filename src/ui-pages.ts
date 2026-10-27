/**
 * Admin console pages for tools, diagnostics and security. Renderers are pure:
 * they take already-collected data and return HTML with every dynamic value
 * escaped. CSRF tokens are injected by the caller (see withCsrf).
 */

import { adminNav, esc } from "./html.js";
import { JOB_TOOLS, requiredJobScope } from "./job-submit.js";
import { ORACLE_TOOL_DEFINITIONS, oracleToolRequiredScope } from "./oracle-tools.js";
import type { ToolCatalogEntry } from "./capabilities.js";
import type { DoctorReport, FindingSeverity } from "./doctor.js";
import type { AggregateStats, GatewayEvent, GatewaySummary, ProviderUsageRecord } from "./telemetry.js";
import { formatProviderUsage } from "./telemetry.js";
import { formatDiagnosticEntry } from "./diagnostics-view.js";
import type { PersistedState } from "./types.js";
import type { LifecycleStatus } from "./lifecycle.js";

function when(ms: number | undefined): string {
  if (!ms) return "never";
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "not reported";
}

function flash(notice: string | undefined): string {
  return notice ? `<div class="flash" role="status">${esc(notice)}</div>` : "";
}

function accountLabel(state: PersistedState, id: string | undefined): string {
  if (!id) return "no credential";
  const account = state.accounts.find((a) => a.id === id);
  return account ? account.label : "removed account " + id;
}

// ---------------------------------------------------------------- Tools page

export interface ToolsPageInput {
  base: string;
  state: PersistedState;
  catalog: ToolCatalogEntry[];
  notice?: string;
}

export function renderToolsPage({ base, state, catalog, notice }: ToolsPageInput): string {
  const gatewayTools = [
    ...JOB_TOOLS.map(name => ({ name, scope: requiredJobScope(name), service: "Distributed jobs" })),
    ...ORACLE_TOOL_DEFINITIONS.map(tool => ({ name: tool.name, scope: oracleToolRequiredScope(tool.name), service: "Private workers" })),
    { name: "web_search", scope: "web:search", service: "Search providers" },
    { name: "web_extract", scope: "web:extract", service: "Search providers" },
  ];
  const gatewayRows = gatewayTools.map(tool => `<tr><td><code>${esc(tool.name)}</code></td><td>${esc(tool.service)}</td><td><code>${esc(tool.scope)}</code></td></tr>`).join("");
  const policy = state.config.toolPolicy;
  const denied = new Set(policy?.denyTools || []);
  const allow = policy?.allowTools ? new Set(policy.allowTools) : undefined;
  const readOnly = new Set(state.config.readOnlyTools || []);
  const enabledAccounts = state.accounts.filter((a) => a.enabled);

  const inventoryRows = state.accounts.map((account) => {
    const caps = state.capabilities?.[account.id];
    const status = !caps
      ? '<span class="muted">Not inventoried yet</span>'
      : caps.ok
        ? `<span class="pill"><span class="dot"></span>${caps.tools.length} upstream tools</span>`
        : `<span class="pill"><span class="dot bad"></span>Failed</span> <span class="tiny muted">${esc(caps.error || "no error detail reported")}</span>`;
    const server = caps?.serverName ? `${esc(caps.serverName)}${caps.serverVersion ? " " + esc(caps.serverVersion) : ""}` : "—";
    return `<tr><td><strong>${esc(account.label)}</strong><div class="tiny muted mono">${esc(account.id)}</div></td><td>${status}</td><td>${server}</td><td class="tiny">${esc(when(caps?.capturedAt))}</td><td class="mono tiny">${esc(caps?.surfaceHash?.slice(0, 12) || "—")}</td><td><form class="inline" method="post" action="${esc(base)}/admin/tools/refresh"><input type="hidden" name="accountId" value="${esc(account.id)}"><button class="secondary" type="submit"${account.enabled ? "" : " disabled"}>Refresh</button></form></td></tr>`;
  }).join("");
  const surfaces = new Set(Object.values(state.capabilities || {}).filter((c) => c.ok).map((c) => c.surfaceHash));

  const toolRows = catalog.map((tool) => {
    const blockedByAllow = allow !== undefined && !allow.has(tool.name);
    const enabled = !denied.has(tool.name) && !blockedByAllow;
    const hints = [
      tool.readOnlyHint === true ? '<span class="pill">read-only hint</span>' : "",
      tool.destructiveHint === true ? '<span class="pill"><span class="dot bad"></span>destructive hint</span>' : "",
      tool.schemaDrift ? '<span class="pill"><span class="dot warn"></span>schema differs across accounts</span>' : "",
    ].join(" ");
    const coverage = tool.accountIds.length === state.accounts.length
      ? "all accounts"
      : tool.accountIds.map((id) => accountLabel(state, id)).join(", ");
    return `<tr><td><label class="toggle"><input type="checkbox" name="enabled" value="${esc(tool.name)}"${enabled ? " checked" : ""}${blockedByAllow ? " disabled" : ""}> <strong class="mono">${esc(tool.name)}</strong></label>${blockedByAllow ? '<div class="tiny muted">Not in the CLI-managed allowlist.</div>' : ""}</td><td class="tiny muted">${esc(tool.description || tool.title || "")}</td><td class="tiny">${esc(coverage)}</td><td>${hints}</td><td><label class="toggle tiny"><input type="checkbox" name="readOnly" value="${esc(tool.name)}"${readOnly.has(tool.name) ? " checked" : ""}> replay-safe</label></td></tr>`;
  }).join("");

  const orphanDenied = [...denied].filter((name) => !catalog.some((t) => t.name === name));
  const endpointNote = policy?.endpoints?.length
    ? `<p class="tiny muted">Endpoint allowlists are active for: ${policy.endpoints.map((ep) => `<code>${esc(ep.tool || "lightsprint_api")}</code> (${ep.rules.length} rules)`).join(", ")}. Manage them with <code>rotoxy tools policy</code>.</p>`
    : "";

  return `<main class="wrap">${adminNav(base, "tools")}${flash(notice)}<section class="grid">
<div class="card full"><h1>Tools</h1><p>The client receives upstream tools plus ROTOXY tools permitted by its OAuth scopes and configured services. A single LightSprint API tool can expose many endpoint operations; it is not the total gateway tool count.</p><h2>ROTOXY tool definitions · ${gatewayTools.length}</h2><p class="muted tiny">These are built-in definitions, not a claim that every tool is enabled for every client. The authenticated client's tools/list response is authoritative. Jobs and private workers require their services; search requires provider configuration.</p><div class="table-scroll"><table><thead><tr><th>Tool</th><th>Service</th><th>Required scope</th></tr></thead><tbody>${gatewayRows}</tbody></table></div></div>
<div class="card full"><div class="eyebrow">Upstream inventory</div><h2>Tools exposed by each upstream account</h2><p class="muted tiny">Refreshing sends <code>initialize</code> and paginated <code>tools/list</code> with one account's credential, stores tool names, descriptions and schema hashes (never tokens), then closes the upstream session.${surfaces.size > 1 ? " <strong>Accounts currently expose different tool surfaces.</strong>" : ""}</p>
<div class="actions" style="margin:12px 0"><form class="inline" method="post" action="${esc(base)}/admin/tools/refresh"><button type="submit"${enabledAccounts.length ? "" : " disabled"}>Refresh all enabled accounts</button></form></div>
${state.accounts.length ? `<div style="overflow:auto"><table><thead><tr><th>Account</th><th>Inventory</th><th>Server</th><th>Captured</th><th>Surface</th><th></th></tr></thead><tbody>${inventoryRows}</tbody></table></div>` : '<p class="muted">Add an upstream credential first.</p>'}</div>
<div class="card full"><div class="eyebrow">Policy</div><h2>Enabled tools</h2><p class="muted tiny">Unchecked tools are removed from <code>tools/list</code> and every <code>tools/call</code> for them is rejected by the gateway before it reaches the upstream. This is enforced server-side for all MCP clients. <em>Replay-safe</em> marks tools you know are read-only, so a timeout or 5xx on one account may be retried on another; all other tool calls are never replayed after an ambiguous failure.</p>${endpointNote}
${catalog.length ? `<form method="post" action="${esc(base)}/admin/tools/policy"><input type="hidden" name="present" value="1"><div style="overflow:auto"><table><thead><tr><th>Tool</th><th>Description (from upstream)</th><th>Exposed by</th><th>Hints</th><th>Retry</th></tr></thead><tbody>${toolRows}</tbody></table></div>${orphanDenied.length ? `<p class="tiny muted">Also denied (not in the current inventory): ${orphanDenied.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p>` : ""}<button type="submit" style="margin-top:12px">Save tool policy</button></form>` : '<p class="muted">No inventory yet. Refresh an account to list its tools.</p>'}
<p class="tiny muted">Current policy: ${policy ? `${denied.size} denied${allow ? `, allowlist of ${allow.size}` : ""}${policy.endpoints?.length ? `, ${policy.endpoints.length} endpoint allowlist(s)` : ""}` : "none — every upstream tool passes through"}.</p></div>
</section></main>`;
}

// ---------------------------------------------------------- Diagnostics page

export interface DiagnosticsPageInput {
  base: string;
  state: PersistedState;
  summary: GatewaySummary;
  recent: GatewayEvent[];
  stats: { recorded: number; retained: number; dropped: number };
  report: DoctorReport;
  checks: { live: boolean; funnel: boolean; publicMetadata: boolean };
  providerUsage: ProviderUsageRecord[];
  lifecycle?: { status?: LifecycleStatus; upCommands?: string[]; upBlockers?: string[]; error?: string };
  ownership: { sessions: number; tasks: number };
}

const SEVERITY_DOT: Record<FindingSeverity, string> = { critical: "bad", error: "bad", warning: "warn", info: "" };

function statsCells(stats: AggregateStats): string {
  const latency = stats.latency.count
    ? `${Math.round(stats.latency.p50 ?? 0)} / ${Math.round(stats.latency.p95 ?? 0)} ms`
    : "—";
  return `<td>${stats.count}</td><td>${stats.success}</td><td>${stats.error}</td><td>${(stats.errorRate * 100).toFixed(1)}%</td><td>${stats.retries}</td><td>${latency}</td>`;
}

/** A plain-language sentence for one gateway event. */
export function humanizeEvent(event: GatewayEvent, state: PersistedState): string {
  const what = event.kind === "probe"
    ? `Health check (${event.method || "probe"})`
    : event.kind === "attempt"
      ? `Upstream attempt for ${event.tool ? `tool “${event.tool}”` : event.method || "request"}`
      : `Client request ${event.tool ? `calling tool “${event.tool}”` : event.method || ""}`.trim();
  const who = event.accountId ? ` using ${accountLabel(state, event.accountId)}` : "";
  if (event.errorClass === "policy-denied") {
    return `${what} was blocked by the tool policy and never sent upstream.`;
  }
  const result = event.outcome === "success"
    ? `succeeded${event.status ? ` (HTTP ${event.status})` : ""}`
    : `failed${event.status ? ` with HTTP ${event.status}` : ""}${event.errorClass ? ` — ${ERROR_TEXT[event.errorClass] || event.errorClass}` : ""}`;
  const time = event.latencyMs !== undefined ? ` in ${Math.round(event.latencyMs)} ms` : "";
  const retries = event.retries ? ` after ${event.retries} failover${event.retries === 1 ? "" : "s"}` : "";
  return `${what}${who} ${result}${time}${retries}.`;
}

const ERROR_TEXT: Record<string, string> = {
  "policy-denied": "blocked by the tool policy",
  "policy-invalid": "the tool policy configuration is invalid",
  "policy-unparseable": "body was not JSON-RPC while a tool policy is active",
  "owner-unavailable": "the credential owning this session is gone; client must start a new session",
  "session-not-found": "no credential recognised the MCP session",
  "upstream-rejected": "upstream refused the credential (auth or quota)",
  "upstream-http": "upstream returned an error",
  "not-replayed": "not retried on another account because the call may have run already",
  "timeout": "upstream timed out",
  transport: "could not reach the upstream",
  "no-credential": "no eligible credential",
  "probe-failed": "probe could not complete",
  "inventory-failed": "tool inventory could not be collected",
  "stream-interrupted": "the response stream was interrupted",
  "client-closed": "the client disconnected",
};

export function renderDiagnosticsPage(input: DiagnosticsPageInput): string {
  const { base, state, summary, recent, stats, report, checks, providerUsage, lifecycle, ownership } = input;
  const requests = summary.by.kind["request"];
  const accountRows = Object.entries(summary.by.accountId)
    .filter(([key]) => key !== "(none)")
    .map(([id, s]) => `<tr><td>${esc(accountLabel(state, id))}</td>${statsCells(s)}</tr>`).join("");
  const toolRows = Object.entries(summary.by.tool)
    .filter(([key]) => key !== "(none)")
    .map(([tool, s]) => `<tr><td class="mono">${esc(tool)}</td>${statsCells(s)}</tr>`).join("");
  const statHead = "<th>Events</th><th>OK</th><th>Errors</th><th>Error rate</th><th>Failovers</th><th>p50 / p95</th>";

  const stageRows = report.stageChecks.map((check) => {
    const dot = check.status === "passed" ? "" : check.status === "failed" ? "bad" : "warn";
    return `<tr><td>${esc(check.stage)}</td><td><span class="pill"><span class="dot ${dot}"></span>${esc(check.status)}</span></td><td class="tiny muted">${esc(check.summary)}</td></tr>`;
  }).join("");
  const findings = report.findings.map((finding) => `<li><span class="pill"><span class="dot ${SEVERITY_DOT[finding.severity]}"></span>${esc(finding.severity)}</span> <strong>${esc(finding.title)}</strong><div class="tiny muted">${finding.evidence.map((ev) => esc(ev.observation)).join(" · ")}</div><div class="tiny">Next step: ${esc(finding.action.summary)}${finding.action.mode === "plan-only" ? " (preview with <code>rotoxy doctor --repairs</code>)" : ""}</div></li>`).join("");

  const eventItems = recent.map((event) => `<li><div><span class="tiny muted mono">${esc(when(event.at))}</span> ${esc(humanizeEvent(event, state))}</div><details class="tiny muted"><summary>Raw record (redacted)</summary><pre>${esc(formatDiagnosticEntry(event, "json", { maxChars: 2000 }))}</pre></details></li>`).join("");

  const usage = providerUsage.length
    ? `<ul class="tiny">${providerUsage.map((r) => `<li class="mono">${esc(formatProviderUsage(r))}</li>`).join("")}</ul>`
    : `<p class="muted tiny"><strong>Unavailable.</strong> The upstream does not report remaining credits, quota or balances to the gateway. ROTOXY only observes reactive signals (HTTP 402/429 and quota-like error text), shown per account on the Pool page as cooldown/exhausted states. Request counts are not credit usage.</p>`;

  let exposure = '<p class="muted tiny">Not checked. Run the check with “Inspect service and Funnel route” to read <code>systemctl --user is-active</code> and <code>tailscale serve status --json</code> (read-only).</p>';
  if (lifecycle?.error) exposure = `<p class="tiny"><span class="pill"><span class="dot warn"></span>Unavailable</span> ${esc(lifecycle.error)}</p>`;
  else if (lifecycle?.status) {
    const r = lifecycle.status.routes;
    exposure = `<p class="tiny"><span class="pill"><span class="dot ${lifecycle.status.healthy ? "" : "warn"}"></span>${lifecycle.status.healthy ? "Healthy" : "Needs attention"}</span> service ${esc(lifecycle.status.service.active)} · Funnel ${r.funnel ? "on" : "off"} · <code>${esc(state.config.basePath || "/")}</code> ${esc(r.owned.state)} · root <code>/</code> ${r.root.present ? "→ " + esc(r.root.target || "") + " (left untouched)" : "not mapped"}${r.foreignMounts.length ? " · other mounts preserved: " + r.foreignMounts.map(esc).join(", ") : ""}</p>${lifecycle.status.problems.length ? `<ul class="tiny">${lifecycle.status.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}<p class="tiny muted">The dashboard never changes Tailscale or the service. To expose or withdraw only this gateway's own path, run on the host: <code>rotoxy up</code> (dry-run, prints the exact commands) then add <code>--execute</code>.${lifecycle.upCommands?.length ? " Planned now: " + lifecycle.upCommands.map((c) => `<code>${esc(c)}</code>`).join(" ; ") : " Nothing to do for up."}${lifecycle.upBlockers?.length ? " Blocked: " + lifecycle.upBlockers.map(esc).join("; ") : ""}</p>`;
  }

  return `<main class="wrap">${adminNav(base, "diagnostics")}<section class="grid">
<div class="card full"><div class="eyebrow">Doctor</div><h2>Gateway health: ${esc(report.status)}</h2>
<form method="post" action="${esc(base)}/admin/diagnostics" class="actions" style="align-items:center;margin:8px 0 14px"><label class="toggle tiny"><input type="checkbox" name="live" value="1"${checks.live ? " checked" : ""}> Live upstream probe + tool inventory (one account)</label><label class="toggle tiny"><input type="checkbox" name="funnel" value="1"${checks.funnel ? " checked" : ""}> Inspect service and Funnel route (read-only)</label><label class="toggle tiny"><input type="checkbox" name="publicMetadata" value="1"${checks.publicMetadata ? " checked" : ""}> Fetch public OAuth metadata through the Funnel URL</label><button type="submit">Run checks</button></form>
<div style="overflow:auto"><table><thead><tr><th>Stage</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${stageRows}</tbody></table></div>
${findings ? `<h3>Findings</h3><ul class="findings">${findings}</ul>` : '<p class="muted tiny">No findings from the checks that ran. Stages marked unverified were not observed.</p>'}</div>
<div class="card full"><div class="eyebrow">Exposure</div><h3>Service and Tailscale route</h3>${exposure}</div>
<div class="card full"><div class="eyebrow">Analytics since start</div><h2>${requests ? requests.count : 0} client requests</h2><p class="muted tiny">In-memory and bounded: ${stats.retained} of ${stats.recorded} events retained${stats.dropped ? `, ${stats.dropped} older evicted` : ""}; resets when the service restarts. Request events are downstream client requests; attempt events are individual upstream tries, so failovers show up as extra attempts. Tracked ownership: ${ownership.sessions} MCP sessions, ${ownership.tasks} tasks. <a href="${esc(base)}/admin/diagnostics.json">JSON</a></p>
${requests ? `<div style="overflow:auto"><table><thead><tr><th>All requests</th>${statHead}</tr></thead><tbody><tr><td>total</td>${statsCells(requests)}</tr></tbody></table></div>` : ""}
${accountRows ? `<h3>By account (requests, attempts and probes)</h3><div style="overflow:auto"><table><thead><tr><th>Account</th>${statHead}</tr></thead><tbody>${accountRows}</tbody></table></div>` : ""}
${toolRows ? `<h3>By tool</h3><div style="overflow:auto"><table><thead><tr><th>Tool</th>${statHead}</tr></thead><tbody>${toolRows}</tbody></table></div>` : ""}</div>
<div class="card full"><div class="eyebrow">Quota &amp; credits</div><h3>Provider-reported usage</h3>${usage}</div>
<div class="card full"><div class="eyebrow">Recent activity</div><h3>Latest events</h3>${eventItems ? `<ul class="events">${eventItems}</ul>` : '<p class="muted">No traffic since the service started.</p>'}</div>
</section></main>`;
}

// ------------------------------------------------------------- Security page

export function renderSecurityPage(base: string, state: PersistedState, notice?: string): string {
  const security = state.security || {};
  return `<main class="wrap">${adminNav(base, "security")}${flash(notice)}<section class="grid">
<div class="card wide"><div class="eyebrow">Admin credential</div><h2>Regenerate admin password</h2><p class="muted tiny">Generates a new random 256-bit password, shows it exactly once on the next page, and signs out every admin session (including this one) and cancels pending OAuth consent codes. Upstream credentials, the encryption master key, settings and registered OAuth clients are not changed.</p>
<form method="post" action="${esc(base)}/admin/security/rotate"><label for="current-password">Current admin password</label><input id="current-password" type="password" name="currentPassword" autocomplete="current-password" required><label class="toggle tiny" style="margin-top:12px"><input type="checkbox" name="revokeConnections" value="1"> Also disconnect every MCP client (revoke all refresh and access tokens). ChatGPT and other clients will have to reconnect and re-authorize.</label><button class="danger" type="submit" style="margin-top:14px">Regenerate password</button></form></div>
<div class="card"><div class="eyebrow">Status</div><h3>Authorization</h3><p class="tiny muted">Last rotation: ${esc(when(security.adminRotatedAt))}<br>Admin epoch: ${esc(security.adminEpoch ?? 0)}<br>OAuth clients: ${state.oauthClients.length}<br>Active refresh tokens: ${state.refreshTokens.filter((r) => r.expiresAt > Date.now()).length}<br>Access tokens issued before: ${security.accessTokenNotBefore ? esc(when(security.accessTokenNotBefore * 1000)) + " are rejected" : "no cutoff"}</p><p class="tiny muted">From the host you can also run <code>rotoxy admin reset-password</code>; it prints the new password once to your terminal and signs out dashboard sessions in the running server.</p></div>
</section></main>`;
}

export function renderRotatedPage(base: string, password: string, revokedConnections: boolean): string {
  return `<main class="login"><section class="card"><div class="eyebrow">Shown once</div><h2>New admin password</h2><p class="muted tiny">Copy it into your password manager now. It is not stored in plain text, not logged, and cannot be displayed again. All admin sessions were signed out${revokedConnections ? " and every MCP client connection was revoked" : ""}.</p><div class="copy mono" aria-label="New admin password">${esc(password)}</div><p style="margin-top:16px"><a class="btn" href="${esc(base)}/admin/login">Sign in with the new password →</a></p></section></main>`;
}
