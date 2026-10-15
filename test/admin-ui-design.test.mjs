import test from "node:test";
import assert from "node:assert/strict";
import { page, brandMarkup } from "../dist/ui.js";
import { adminNav, withCsrf } from "../dist/html.js";

const style = (html) => html.match(/<style>([\s\S]*)<\/style>/)[1];

test("admin pages share the relay-gate theme with light and dark palettes", () => {
  const html = page("Admin", "<main class=\"wrap\"></main>");
  const css = style(html);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(css, /--signal:#0f7b6c/);
  assert.match(css, /prefers-color-scheme:dark\)\{:root\{[^}]*--signal:#4fd1b8/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /font-variant-numeric:tabular-nums/);
  // Anti-reference: no glow gradients, glassmorphism or gradient-clipped text.
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|backdrop-filter|background-clip/);
});

test("legacy T2 text badge is replaced by the authored SVG mark, including shared nav", () => {
  const html = page("Pool", adminNav("https://gw.example", "pool"));
  assert.doesNotMatch(html, /<div class="logo">T2<\/div>/);
  assert.match(html, /<span class="logo"><svg viewBox="0 0 48 48" aria-hidden="true"/);
  assert.match(html, /aria-current="page">Overview</);
  assert.equal(brandMarkup("<p>no badge</p>"), "<p>no badge</p>");
});

test("theme wrapper keeps CSRF injection on every POST form and escapes the title", () => {
  const body = `${adminNav("", "pool")}<form method="post" action="/admin/accounts"><input name="label"></form><form method="get" action="/x"></form>`;
  const html = withCsrf(page("<Pool>", body), "tok-123");
  assert.equal((html.match(/name="_csrf" value="tok-123"/g) || []).length, 2); // logout + accounts
  assert.match(html, /<title>&lt;Pool&gt; · ROTOXY<\/title>/);
});

test("mobile rules keep forms single-column and nav scrollable without hiding overflow", () => {
  const css = style(page("x", ""));
  assert.match(css, /@media\(max-width:850px\)\{[^@]*\.row\{grid-template-columns:1fr\}/);
  assert.match(css, /nav\.actions\{width:100%;overflow-x:auto/);
  assert.match(css, /input,select,textarea\{[^}]*min-width:0/);
  assert.doesNotMatch(css, /overflow-x:hidden/);
  // No sub-12px body text.
  for (const m of css.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
});

import { renderOverview, accountBuckets } from "../dist/ui.js";
import { TelemetryRecorder } from "../dist/telemetry.js";

const acct = (id, state, enabled = true, extra = {}) => ({ id, label: `Acct ${id}`, enabled, state, requests: 0, successes: 0, failures: 0, ...extra });
const base = { base: "https://gw.example", strategy: "adaptive-sticky", upstreamUrl: "https://mcp.provider.example/mcp", maxFailoverAttempts: 3, now: 1_000_000 };

test("account buckets: disabled wins, ready counts healthy, exhausted/cooldown are depleted", () => {
  assert.deepEqual(accountBuckets([acct("a", "healthy"), acct("b", "ready"), acct("c", "exhausted"), acct("d", "cooldown"), acct("e", "auth-failed"), acct("f", "healthy", false), acct("g", "unknown")]),
    { healthy: 2, depleted: 2, failing: 1, disabled: 1, unknown: 1 });
});

test("overview leads with operational verdict and keeps unobserved telemetry and quota unknown, never zero", () => {
  const html = renderOverview({ ...base, accounts: [acct("a", "healthy"), acct("b", "cooldown")] });
  assert.match(html, /<h1>Credential gateway<\/h1>/);
  assert.match(html, /1 of 2 credentials can route; 1 need attention/);
  assert.match(html, /href="https:\/\/gw\.example\/admin\/supervisor"/);
  assert.match(html, /Requests seen<\/dt><dd class="">Not observed yet/);
  assert.match(html, /Latency<\/dt><dd class="unknown">Not observed/);
  assert.match(html, /Quota \/ capacity<\/dt><dd class="unknown">Unknown/);
  assert.match(html, /No requests observed since this gateway process started/);
  assert.match(html, /one MCP connection<\/strong>/);
  assert.match(html, /mcp\.provider\.example/);
  assert.match(html, /1<\/strong> is waiting out a quota cooldown/);
  assert.doesNotMatch(html, />0(\.0)?%|>0 ms/);
});

test("overview with no credentials says so instead of drawing an empty bar", () => {
  const html = renderOverview({ ...base, accounts: [] });
  assert.match(html, /No credentials in the pool/);
  assert.match(html, /Routable<\/dt><dd class="bad">None/);
  assert.doesNotMatch(html, /class="bar"/);
});

test("overview uses real telemetry: success rate, latency percentiles and recent requests with account labels", () => {
  const t = new TelemetryRecorder();
  t.recordGateway({ kind: "request", at: 999_000, method: "tools/call", tool: "web_search_exa", accountId: "a", status: 200, latencyMs: 120 });
  t.recordGateway({ kind: "request", at: 999_500, method: "tools/call", tool: "<b>x</b>", accountId: "a", status: 429, latencyMs: 300, retries: 1 });
  const html = renderOverview({ ...base, accounts: [acct("a", "healthy")], summary: t.summary(), recent: t.recent({ limit: 10 }) });
  assert.match(html, /Requests seen<\/dt><dd class="">2</);
  assert.match(html, /50\.0%/);
  assert.match(html, /1 ok · 1 errors · 1 retries/);
  assert.match(html, /Latency p50 \/ p95<\/dt><dd class="">120/);
  assert.match(html, /<strong>web_search_exa<\/strong> <span class="muted">via Acct a<\/span>/);
  assert.match(html, /class="err">429/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
