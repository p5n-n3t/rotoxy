import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { normalizeSupervisorSnapshot, renderSupervisorDashboard, renderSupervisorWorkerView } from "../dist/supervisor-ui.js";
import { normalizeSupervisionInbox } from "../dist/admin.js";

test("dispatch controls retain mounted paths and render only authoritative revision data", () => {
  const snapshot = normalizeSupervisorSnapshot({ projectControl: { projectId: "project-a", state: "paused", revision: 4, maxConcurrency: 3, activeTaskCount: 1 } });
  const html = renderSupervisorDashboard(snapshot, { nonce: "n", csrfToken: "csrf", liveFeedUrl: "/token2oauth/admin/api/v1/supervisor/project-a/live" });
  assert.match(html, /data-endpoint="\/token2oauth\/admin\/api\/v1\/supervisor\/control"/);
  assert.match(html, /data-revision="4"/);
  assert.match(html, /\/token2oauth\/admin\/api\/v1\/supervisor\/project-a\/inbox/);
  assert.match(html, /x-csrf-token/);
  assert.match(html, /do not cancel in-flight work/);
});

test("ROTOXY supervisor uses worker-first tabs and honest attribution/status fields", () => {
  const html = renderSupervisorDashboard(normalizeSupervisorSnapshot({ workers: [{ id: "session-1", accountId: "acct-1", accountLabel: "Primary account", workspace: "ws-1", requestedModel: "gpt-requested", actualModel: "gpt-observed", taskCorrelation: "assignment-1:task-1", status: "needs_instructions", monitorState: "needs_instructions", heartbeatAt: 1791792000 }] }), { nonce: "tab-nonce", liveFeedUrl: "/token2oauth/admin/api/v1/supervisor/project-a/live" });
  assert.match(html, /role="tablist"[^>]*aria-label="Supervisor sections"/);
  for (const tab of ["workers", "inbox", "recovery", "handoffs"]) assert.match(html, new RegExp(`data-tab="${tab}"`));
  assert.match(html, /class="workers-table"/);
  assert.match(html, /Primary account/);
  assert.match(html, /Requested: gpt-requested/);
  assert.match(html, /Actual: gpt-observed/);
  assert.match(html, /assignment-1:task-1/);
  assert.match(html, /Waiting on a human/);
  assert.match(html, /question or approval context was not captured/i);
  assert.match(html, /Session resumption: no supported resume interface reported/);
  assert.match(html, /Next check: schedule not reported/);
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /\.table-wrap\{overflow:auto\}/);
  assert.match(html, /ArrowRight/);
  assert.doesNotMatch(html, /<details class="distribution">/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /<script nonce="tab-nonce">/);
});

test("provider questions are bounded, attributable, escaped, and handed off without an invented answer protocol", () => {
  const snapshot = normalizeSupervisorSnapshot({ workers: [{ id: "session-a", accountId: "acct-a", accountLabel: "Operator A", requestedModel: "model-requested", actualModel: "model-observed", taskCorrelation: "task-77", promptCount: 12, question: { id: "q-3", text: '<img src=x onerror="x"> Please choose', choices: ["Continue", "Stop"], source: "provider", kind: "question" } }] });
  const worker = snapshot.workers[0];
  assert.equal(worker.promptCount, 12);
  assert.equal(worker.question.id, "q-3");
  assert.equal(worker.question.source, "provider");
  const html = renderSupervisorDashboard(snapshot, { nonce: "q-nonce", csrfToken: "csrf-token", liveFeedUrl: "/token2oauth/admin/api/v1/supervisor/project-a/live" });
  assert.match(html, /Operator A/);
  assert.match(html, /Requested: model-requested/);
  assert.match(html, /Actual: model-observed/);
  assert.match(html, /task-77/);
  assert.match(html, /&lt;img src=x onerror=&quot;x&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /data-guidance-base="\/token2oauth\/admin\/api\/v1\/supervisor\/project-a"/);
  assert.doesNotMatch(html, /<form class="guidance-form"/);
  assert.match(html, /Answer this parked question in the provider/);
  assert.match(html, /X-CSRF-Token/);
  assert.match(html, /expectedPromptCount:count/);
  assert.match(html, /expectedQuestionId:question/);

});

test("approval handoffs have no approval or reply controls, and unknown prompt count disables question reply", () => {
  const approval = renderSupervisorDashboard(normalizeSupervisorSnapshot({ workers: [{ id: "session-a", promptCount: 8, question: { text: "Approve this action?", choices: ["Approve", "Reject"], source: "provider", kind: "approval" } }] }), { nonce: "n", csrfToken: "c", liveFeedUrl: "/admin/api/v1/supervisor/p/live" });
  assert.match(approval, /Native approval actions are not supported/);
  assert.doesNotMatch(approval, /<button type="button" data-guidance-choice/);
  assert.doesNotMatch(approval, /<button type="submit">Send reply/);
  const unknown = renderSupervisorDashboard(normalizeSupervisorSnapshot({ workers: [{ id: "session-b", promptCount: "3", question: { text: "Need input", source: "provider", kind: "review" } }] }), { nonce: "n", csrfToken: "c", liveFeedUrl: "/admin/api/v1/supervisor/p/live" });
  assert.match(unknown, /native answer protocol has not been verified/);
  assert.doesNotMatch(unknown, /<form class="guidance-form"/);
  const untrusted = normalizeSupervisorSnapshot({ workers: [{ id: "session-c", promptCount: 3, question: { text: "forged", source: "monitor", kind: "question" } }] });
  assert.equal(untrusted.workers[0].question, undefined);
});

test("reply client sends bounded CSRF request and reuses an idempotency key after ambiguity", async () => {
  const html = renderSupervisorDashboard({}, { nonce: "n" });
  const script = html.match(/<script nonce="n">\(\(\)=>\{const root=document.getElementById\("workers-live"\)[\s\S]*?<\/script>/)?.[0]?.replace(/^<script nonce="n">/, "").replace(/<\/script>$/, "");
  assert.ok(script);
  const handlers = {};
  const root = { dataset: {}, querySelectorAll: () => [], addEventListener: (name, fn) => { handlers[name] = fn; } };
  const requests = [];
  let responseOutcome;
  let generated = 0;
  const form = { dataset: { workerId: "session-1", guidanceBase: "/token2oauth/admin/api/v1/supervisor/project-a", csrfToken: "csrf", promptCount: "4", questionId: "question-1" }, elements: { namedItem: () => field }, querySelector: (selector) => selector.includes("guidance-status") ? status : button, closest: () => form };
  const field = { value: "Continue" };
  const status = { textContent: "" };
  const button = { disabled: false };
  const context = { document: { getElementById: () => root }, MutationObserver: class { observe() {} }, URL, location: { href: "https://local.test/token2oauth/admin/supervisor/project-a", origin: "https://local.test" }, crypto: { randomUUID: () => `stable-request-id-${++generated}` }, fetch: async (url, options) => { requests.push({ url: String(url), options }); if (!responseOutcome) throw new Error("connection lost after submit"); return { text: async () => JSON.stringify({ outcome: responseOutcome }) }; }, Date, Math };
  vm.runInNewContext(script, context);
  const submit = async () => handlers.submit({ target: form, preventDefault() {} });
  await submit();
  await submit();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://local.test/token2oauth/admin/api/v1/supervisor/project-a/workers/session-1/guidance");
  assert.equal(requests[0].options.headers["X-CSRF-Token"], "csrf");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), { requestId: "stable-request-id-1", message: "Continue", expectedPromptCount: 4, expectedQuestionId: "question-1" });
  assert.equal(requests[1].options.body, requests[0].options.body);
  assert.match(status.textContent, /ambiguous/);
  responseOutcome = "accepted";
  await submit();
  assert.match(status.textContent, /accepted by the backend/);
  responseOutcome = "rejected";
  field.value = "Try a corrected reply";
  await submit();
  assert.match(status.textContent, /rejected by the backend/);
  assert.notEqual(requests[3].options.body, requests[2].options.body);
});

test("capacity bars require a known positive denominator and show exact values", () => {
  const html = renderSupervisorDashboard({ providers: [{ id: "known", label: "Known", status: "ready", capacity: { used: 4, limit: 10, unit: "jobs" }, accounts: [{ id: "unknown", label: "Unknown", status: "ready", quota: { used: 3 } }] }] });
  assert.match(html, /4 \/ 10 jobs/);
  assert.match(html, /aria-valuenow="4"/);
  assert.match(html, /Limit not reported/);
  assert.equal((html.match(/role="meter"/g) || []).length, 1);
});

test("escapes untrusted content and redacts structured and embedded secrets in raw details", () => {
  const html = renderSupervisorDashboard({ state: "error", error: '<img src=x onerror="alert(1)">', events: [{ severity: "error", message: '<svg onload="x"> Bearer abc123.def4567890123456', raw: { api_key: "hidden-key", note: "authorization=Bearer abc123.def4567890123456" } }] });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;svg onload=&quot;x&quot;&gt;/);
  assert.match(html, /Show sanitized raw event/);
  assert.match(html, /\[REDACTED\]/);
  assert.doesNotMatch(html, /hidden-key|abc123\.def4567890123456|<img src=x|<svg onload=/);
});

test("search, severity and pause filters apply to bounded local event data", () => {
  const snapshot = { events: [
    { id: "a", severity: "warning", message: "quota paused", paused: true },
    { id: "b", severity: "info", message: "worker started", paused: false },
  ] };
  const html = renderSupervisorDashboard(snapshot, { search: "quota", severity: "warning", pause: "paused" });
  assert.match(html, /quota paused/);
  assert.doesNotMatch(html, /worker started/);
  assert.match(html, /name="search" value="quota"/);
});

test("empty/loading/error states are explicit, records are bounded, and no write controls are invented", () => {
  const loading = renderSupervisorDashboard({ state: "loading", jobs: Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, status: "queued" })) }, { maxItems: 2 });
  assert.match(loading, /Loading operations data/);
  assert.match(loading, /No provider groups are available/);
  assert.equal((loading.match(/<code>j\d<\/code>/g) || []).length, 2);
  assert.doesNotMatch(loading, /Pause all|Resume|Retry job|<form[^>]*method="post"/i);
  const errored = renderSupervisorDashboard({ state: "error" });
  assert.match(errored, /role="alert"/);
  const partial = renderSupervisorDashboard(normalizeSupervisorSnapshot({ state: "partial", error: "Configured accounts and sessions are shown; durable ledger data was not reported.", workers: [{ id: "session-1", status: "unobserved" }] }));
  assert.match(partial, /Partial operations data/);
  assert.match(partial, /Configured accounts and sessions are shown/);
  assert.match(partial, /session-1/);
  assert.doesNotMatch(partial, /Operations data unavailable/);
});

test("time series use only supplied points and malformed timestamps degrade safely", () => {
  const html = renderSupervisorDashboard({ observedAt: 9e99, series: [{ label: "Queue depth", unit: "jobs", points: [{ value: 2 }, { value: 5 }] }] });
  assert.match(html, /Measured values: 2jobs · 5jobs/);
  assert.match(html, /Invalid provider timestamp/);
  assert.doesNotMatch(html, /setInterval|Math\.random|Loading traffic/);
});

test("live polling is nonce-gated and preserves unrelated hierarchy/focus nodes", () => {
  const standalone = renderSupervisorDashboard({});
  assert.doesNotMatch(standalone, /id="live-pause"|<script\b/);
  const html = renderSupervisorDashboard({}, { nonce: "nonce-value", liveFeedUrl: "/admin/api/v1/supervisor/project/live" });
  assert.match(html, /<script nonce="nonce-value">/);
  assert.match(html, /new URL\(root\.dataset\.feedUrl,location\.href\)/);
  assert.match(html, /url\.origin!==location\.origin/);
  assert.match(html, /clearInterval\(timer\)/);
  assert.match(html, /addEventListener\("pagehide"/);
  assert.match(html, /Live updates paused/);
  assert.match(html, /id="live-pause" type="button"/);
  assert.match(html, /document\.activeElement\.closest\("#live-events"\)/);
  assert.match(html, /list\.innerHTML=payload\.eventsHtml/);
  const pollScript = html.match(/<script nonce="nonce-value">([\s\S]*?)<\/script>/)?.[1] || "";
  assert.doesNotMatch(pollScript, /getElementById\("workforce"\)|getElementById\("live-health"\).*innerHTML/);
});

test("live pause stops polling and pagehide clears the interval", async () => {
  const html = renderSupervisorDashboard({}, { nonce: "n", liveFeedUrl: "/admin/api/v1/supervisor/p/live" });
  const script = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes('getElementById("live-shell")'));
  assert.ok(script);
  const events = { innerHTML: "initial" };
  const status = { textContent: "" };
  const button = { textContent: "", attributes: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; } };
  const root = { dataset: { feedUrl: "/admin/api/v1/supervisor/p/live" } };
  const nodes = { "live-shell": root, "live-pause": button, "live-status": status, "live-events": events, "event-filter": null };
  const listeners = {};
  let nextTimer = 0;
  const intervals = new Map();
  const cleared = [];
  const health = { textContent: "unknown" };
  const context = {
    URL,
    location: { href: "https://local.test/admin/supervisor/p", origin: "https://local.test" },
    document: { hidden: false, activeElement: null, getElementById: (id) => nodes[id] || null, querySelector: (selector) => selector.includes("supervisor") ? health : null, addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async (url) => ({ ok: true, json: async () => ({ ok: true, eventsHtml: "<p>fresh</p>", supervisor: "healthy", orchestrator: "unknown" }) }),
    setInterval: (fn) => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearInterval: (id) => { cleared.push(id); intervals.delete(id); },
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.innerHTML, "<p>fresh</p>");
  assert.equal(health.textContent, "healthy");
  assert.equal(intervals.size, 1);
  button.listeners.click();
  assert.equal(intervals.size, 0);
  assert.equal(status.textContent, "Live updates paused");
  button.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervals.size, 1);
  listeners.pagehide();
  assert.equal(intervals.size, 0);
  assert.ok(cleared.length >= 2);
});

test("trusted snapshot normalization preserves absent observations as unknown", () => {
  const snapshot = normalizeSupervisorSnapshot({ summary: { active_tasks: 9 }, accounts: [{ id: "account-1", capacity: 5 }] });
  assert.equal(snapshot.providers, undefined);
  assert.equal(snapshot.events, undefined);
  assert.equal(snapshot.supervisor, undefined);
  assert.equal(snapshot.orchestrator, undefined);
});

test("responsive layout contains intrinsic mobile widths and wraps long identifiers", () => {
  const html = renderSupervisorDashboard({ providers: [{ id: "provider-" + "x".repeat(120), label: "Provider", status: "ready" }] });
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
  assert.match(style, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(style, /\.rail nav\{[^}]*width:100%;min-width:0;max-width:100%;overflow-x:auto/);
  assert.match(style, /summary\{max-width:100%;overflow-wrap:anywhere\}/);
  assert.match(style, /\.filter label\{[^}]*min-width:0;flex:1 1 145px\}/);
  assert.match(style, /input,select\{[^}]*width:100%;max-width:100%;min-width:0/);
  assert.doesNotMatch(style, /overflow-x\s*:\s*hidden/);
  assert.match(html, /provider-x{20,}/);
});

test("Python assignment receipts normalize into visible jobs without fabricating provider data", () => {
  const snapshot = normalizeSupervisorSnapshot({
    assignments: [{ assignmentId: "batch-1", projectId: "project-1", state: "queued", revision: 3, taskCount: 2 }],
    total: 1,
    offset: 0,
    hasMore: false,
  });
  assert.equal(snapshot.providers, undefined);
  assert.equal(snapshot.jobs[0].id, "batch-1");
  assert.equal(snapshot.jobs[0].status, "queued");
  assert.equal(snapshot.jobs[0].taskCount, 2);
  assert.equal(snapshot.jobs[0].revision, 3);
  assert.equal(snapshot.jobs[0].workspace, undefined);
  const html = renderSupervisorDashboard(snapshot);
  assert.match(html, /Job summary not supplied/);
  assert.match(html, /<code>batch-1<\/code>/);
  assert.match(html, /2 tasks · revision 3/);
  assert.match(html, /No provider groups are available/);
  assert.doesNotMatch(html, /snapshot supplied|no actions are implied|unknown denominator/i);
});

test("reported task and account usage stays provisional, sourced, and unknown when absent", () => {
  const html = renderSupervisorDashboard(normalizeSupervisorSnapshot({
    providers: [{ id: "p", label: "LightSprint", status: "available", accounts: [
      { id: "acct-known", label: "Known", status: "healthy", usage: { reportedCostDeltaUsd: 0.125, coveredTaskGenerations: 2, totalTaskGenerations: 3, observedAt: 1791000000, source: "lightsprint-session-status", provisional: true } },
      { id: "acct-unknown", label: "Unknown", status: "healthy" },
    ] }],
    workers: [{ id: "session-a", status: "eligible", model: "gpt-6-luna", usage: { reportedSessionCostUsd: 0.5, reportedCostDeltaUsd: 0.125, promptCountDelta: 2, budgetUsed: 4, maxBudget: 10, fundingSource: "shared", sandboxTier: "standard", observedAt: 1791000000, source: "lightsprint-session-status", provisional: true, budgetUnit: "unknown" } }],
  }));
  assert.match(html, /Reported USD increase: \$0\.1250 USD · provisional/);
  assert.match(html, /2 of 3 task generations with reported cost/);
  assert.match(html, /Task increase.*\$0\.1250 USD/);
  assert.match(html, /Reported session total:.*\$0\.5000 USD/);
  assert.match(html, /Provider session budget \(unit not reported\): 4 \/ 10/);
  assert.match(html, /Remaining quota is not reported; workspace billing may be shared/);
  assert.match(html, /LightSprint session status/);
  assert.match(html, /Actual: gpt-6-luna/);
  assert.doesNotMatch(html, /Model: <strong>gpt-6-luna/);
  assert.doesNotMatch(html, /credits? remaining|credit balance|\$0\.0000/);
  assert.equal((html.match(/role="meter"/g) || []).length, 1);
});

test("malformed and secret-bearing usage never becomes fabricated zero or active markup", () => {
  const html = renderSupervisorDashboard(normalizeSupervisorSnapshot({
    providers: [{ id: "p", label: "P", status: "available", accounts: [{ id: "a", label: "A", status: "ready", usage: { reportedCostDeltaUsd: -1, coveredTaskGenerations: 1, totalTaskGenerations: 1 } }] }],
    workers: [{ id: "s", status: "eligible", usage: { reportedCostDeltaUsd: -1, budgetUsed: 4, maxBudget: 0, fundingSource: '<img src=x> Bearer abc123.def4567890123456' } }],
  }));
  assert.match(html, /Usage not reported|No reported increase/);
  assert.match(html, /Provider session budget: 4 \/ maximum not reported/);
  assert.doesNotMatch(html, /\$0\.0000|aria-valuenow="4"|<img src=x|abc123\.def4567890123456/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /\[REDACTED\]/);
});

test("Python epoch-second event timestamps render the actual observation date", () => {
  const html = renderSupervisorDashboard({ events: [{ id: "1", at: 1791652719.336, severity: "info", message: "operation_complete" }] });
  assert.match(html, /2026-10-10T17:18:39\.336Z/);
  assert.doesNotMatch(html, /1970-01-/);
});

test("brand system, snapshot ledger, and project-scoped supervision inbox are rendered", () => {
  const html = renderSupervisorDashboard({
    providers: [{ id: "p", label: "P", status: "ready", accounts: [{ id: "a", label: "A", status: "ready", workspaces: [{ id: "w", workers: [{ id: "worker", status: "ready" }] }] }] }],
    jobs: [{ id: "job", status: "queued" }],
  }, { nonce: "brand-nonce", csrfToken: "csrf", liveFeedUrl: "/admin/api/v1/supervisor/project-7/live" });
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /data:image\/svg\+xml/);
  assert.match(html, /class="brand-name" href="\/admin">ROTOXY/);
  assert.match(html, /class="page-mark"/);
  assert.match(html, /Providers listed/);
  assert.match(html, /Accounts listed/);
  assert.match(html, /Workers listed/);
  assert.match(html, /Assignments listed/);
  assert.match(html, /Counts are records in this project snapshot/);
  assert.match(html, /data-endpoint="\/admin\/api\/v1\/supervisor\/project-7\/inbox\?after=0&amp;limit=20"/);
  assert.match(html, /data-project-id="project-7"/);
  assert.match(html, /X-CSRF-Token/);
  assert.match(html, /body:JSON\.stringify\(\{\}\)/);
  assert.match(html, /Inbox unavailable; retry when supervision service is available/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /@media\(max-width:520px\)/);
});

test("overview ledger keeps missing snapshot sections unknown, not zero", () => {
  const html = renderSupervisorDashboard({});
  assert.doesNotMatch(html, />Unknown</, "empty health and heartbeat states explain missing observations");
  assert.equal((html.match(/listed<\/dt><dd class="unknown">Not reported<\/dd>/g) || []).length, 4);
  assert.doesNotMatch(html, /Providers listed<\/dt><dd[^>]*>0<\/dd>/);
  assert.match(html, /authenticated project API is not available/);
  const emptyKnownLists = renderSupervisorDashboard({ providers: [], jobs: [], workers: [] });
  assert.match(emptyKnownLists, /Providers listed<\/dt><dd class="">0<\/dd>/);
  assert.match(emptyKnownLists, /Assignments listed<\/dt><dd class="">0<\/dd>/);
});

test("inbox normalizer bounds event and model inventory fields and rejects unknown shapes", () => {
  assert.equal(normalizeSupervisionInbox({ events: [], models: [] }), undefined);
  const inbox = normalizeSupervisionInbox({
    available: true,
    events: Array.from({ length: 24 }, (_, index) => ({ id: `row-${index}`, eventId: `event-${index}`, worker: "w".repeat(400), oracle: { result: "r".repeat(900) } })),
    models: [{ host: "h", models: Array.from({ length: 40 }, (_, index) => `model-${index}`), error: "e".repeat(400) }],
  });
  assert.equal(inbox.events.length, 20);
  assert.equal(inbox.events[0].eventId, "event-0");
  assert.equal(inbox.events[0].worker.length, 240);
  assert.equal(inbox.events[0].oracle.result.length, 480);
  assert.equal(inbox.models[0].models.length, 30);
  assert.equal(inbox.models[0].error.length, 240);
});

test("recovery projection bounds diagnostic text, hides owners, and labels advice as non-executable", () => {
  const inbox = normalizeSupervisionInbox({ available: true, events: [], models: [], recovery: {
    available: true, project: "project-a", state: "handoff", cursor: 44, owner: "must-not-render",
    decisions: [{ eventId: "guidance-44", kind: "failed", decision: { level: "rules", outcome: "human_handoff", reason: "Bearer secret" } }],
    pendingHandoffs: [{ eventId: "guidance-44", kind: "failed", state: "handoff", reason: "manual review" }],
    notifyReceipts: [{ eventId: "guidance-44", kind: "failed", at: 1791792000 }],
    oracleAdvice: [{ eventId: "guidance-44", status: "complete", advisoryOnly: true, result: "api_key=private-value ".repeat(50) }],
  } });
  assert.equal(inbox.recovery.cursor, 44);
  assert.equal(inbox.recovery.pendingHandoffs.length, 1);
  assert.ok(inbox.recovery.oracleAdvice[0].result.length <= 1200);
  assert.doesNotMatch(inbox.recovery.oracleAdvice[0].result, /private-value/);
  const html = renderSupervisorDashboard({}, { nonce: "n", liveFeedUrl: "/token2oauth/admin/api/v1/supervisor/project-a/live" });
  assert.match(html, /dormant initiating chat can remain dormant/i);
  assert.match(html, /Oracle diagnostics are advisory only/);
  assert.match(html, /id="supervision-recovery"/);
  const recoveryScript = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes("renderRecovery")) || "";
  assert.doesNotMatch(recoveryScript, /setInterval|job_resume|sendMessage/);
});

test("inbox acknowledgment sends same-origin CSRF header and project-scoped endpoint", async () => {
  const html = renderSupervisorDashboard({}, { nonce: "n", csrfToken: "csrf-token", liveFeedUrl: "/admin/api/v1/supervisor/project-7/live" });
  const script = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes('getElementById("supervision-feed")'));
  assert.ok(script);
  class Node {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {}
  }
  const root = new Node(); root.dataset = { endpoint: "/admin/api/v1/supervisor/project-7/inbox?after=0&limit=20", projectId: "project-7", csrfToken: "csrf-token" };
  const status = new Node(), events = new Node(), models = new Node(), recovery = new Node(), refresh = new Node("button");
  const nodes = { "supervision-feed": root, "supervision-status": status, "supervision-events": events, "supervision-models": models, "supervision-recovery": recovery, "supervision-refresh": refresh };
  const requests = [];
  const listeners = {};
  const context = {
    document: { getElementById: (id) => nodes[id] || null, createElement: (tag) => new Node(tag) },
    location: { href: "https://local.test/admin/supervisor/project-7", origin: "https://local.test" },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === "POST") return { ok: true };
      return new Response(JSON.stringify({ available: true, events: [{ id: 17, kind: "job.done", at: "2026-10-12T00:00:00Z" }], models: [], recovery: { available: true, project: "project-7", state: "handoff", cursor: 17, decisions: [{eventId:"nested",decision:{outcome:"human_handoff",reason:"Nested decision reason"}}], pendingHandoffs: [{ kind: "failed", reason: "review" }], notifyReceipts: [], oracleAdvice: [] } }), { headers: { "Content-Type": "application/json" } });
    },
    URL, TextDecoder, Uint8Array, JSON, Date, encodeURIComponent,
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  const findButton = (node) => node.tagName === "button" && node.textContent === "Acknowledge" ? node : node.children.map(findButton).find(Boolean);
  const acknowledge = findButton(events);
  assert.ok(acknowledge);
  const recoveryText = (node) => [node.textContent, ...node.children.map(recoveryText)].join(" ");
  assert.match(recoveryText(recovery), /manual review|handoff/);
  assert.match(recoveryText(recovery), /Project cursor 17/);
  assert.match(recoveryText(recovery), /Nested decision reason/);
  await acknowledge.listeners.click();
  assert.equal(requests[1].options.method, "POST");
  assert.equal(new URL(requests[1].url).pathname, "/admin/api/v1/supervisor/project-7/inbox/17/ack");
  assert.equal(requests[1].options.headers["X-CSRF-Token"], "csrf-token");
  assert.deepEqual(JSON.parse(requests[1].options.body), {});
});

 test("numeric durable event IDs survive normalization", () => {
  const inbox = normalizeSupervisionInbox({ available: true, events: [{ id: 17, kind: "finished" }], models: [] });
  assert.equal(inbox.events[0].id, "17");
});

 test("idle guidance is actionable but unobserved or running sessions never advertise dispatch", () => {
  const opts = {nonce:"n",csrfToken:"c",liveFeedUrl:"/admin/api/v1/supervisor/p/live"};
  const page = state => renderSupervisorDashboard({workers:[{id:"s",status:state,monitorState:state,promptCount:3}]},opts);
  assert.match(page("idle"), /Send guidance to this idle worker/);
  assert.match(page("idle"), /data-prompt-count="3"/);
  assert.doesNotMatch(page("running"), /<form class="guidance-form"/);
  assert.doesNotMatch(page("unobserved"), /<form class="guidance-form"/);
});


test("human timestamps preserve exact machine heartbeat and explain missing attribution",()=>{
 const heartbeat=1792756800;
 const view=renderSupervisorWorkerView([{id:"session-human",status:"unknown",heartbeatAt:heartbeat}]);
 assert.equal(view.latestHeartbeat,new Date(heartbeat*1000).toISOString());
 assert.match(view.html,/data-timestamp="2026-/);
 assert.match(view.html,/Oct 2026/);
 assert.match(view.html,/Account not attributed/);
 assert.match(view.html,/Not reported by provider/);
 assert.doesNotMatch(view.html,/>Unknown</);
});

test("missing supervisor statuses and labels are human-readable while raw status values remain stable",()=>{
 const snapshot=normalizeSupervisorSnapshot({
  state:"ready",
  providers:[{id:"unknown",label:"Unknown",status:"unknown",accounts:[{id:"unknown",label:"Unknown",status:"unknown",workspaces:[{id:"unknown",label:"Unknown",workers:[{id:"unknown",label:"Unknown",status:"unknown",monitorState:"unknown",actualModel:"unknown",requestedModel:"unknown",accountId:"unknown",accountLabel:"unknown"}]}]}]}],
  events:[{severity:"unknown",message:"No severity from provider"}],
  workers:[{id:"session-1",status:"unknown",question:{text:"Please review",source:"provider",kind:"unrecognized"}}],
 });
 const html=renderSupervisorDashboard(snapshot);
 assert.equal(snapshot.workers[0].status,"unknown");
 assert.match(html,/Status not reported/);
 assert.match(html,/Provider name not reported/);
 assert.match(html,/Account name not reported/);
 assert.match(html,/Workspace name not reported/);
 assert.match(html,/Worker name not reported/);
 assert.match(html,/Not reported by provider/);
 assert.match(html,/Severity not reported/);
 assert.match(html,/request type not reported/);
 assert.doesNotMatch(html,/>unknown<\/span>/i,"machine enums may remain inside the expandable sanitized event payload");
 assert.doesNotMatch(html,/>Unknown</);
});

test("nested account workers show their available account, workspace, model, and task attribution",()=>{
 const html=renderSupervisorDashboard(normalizeSupervisorSnapshot({providers:[{id:"lightsprint",label:"LightSprint",status:"ready",accounts:[{id:"acct-7",label:"Mary Jo",status:"ready",workspaces:[{id:"ws-7",label:"engineering",workers:[{id:"sess-7",status:"running",actualModel:"claude-opus",taskId:"task-92"}]}]}]}]}));
 assert.match(html,/Mary Jo · acct-7 · Workspace engineering/);
 assert.match(html,/Model claude-opus · Task task-92/);
});
