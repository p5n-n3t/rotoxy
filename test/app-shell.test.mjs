import test from "node:test";
import assert from "node:assert/strict";
import { APP_SHELL_GROUPS, renderAppShell } from "../dist/ui-shared.js";

test("app shell exposes grouped navigation only to audited page routes", () => {
  const html = renderAppShell({ base: "/token2oauth", active: "supervisor", pageTitle: "Supervisor", workspaceName: "Operations workspace", content: "<main><h1>Supervised projects</h1></main>" });
  assert.deepEqual(APP_SHELL_GROUPS.map((group) => group.label), ["Command", "Resources", "Insights", "Settings"]);
  for (const label of ["Overview", "Jobs", "Supervisor", "Workspace accounts", "Models", "Private workers", "Search", "Activity", "Analytics", "Clients", "Auth", "Diagnostics"]) assert.ok(html.includes(label));
  for (const path of ["/token2oauth/admin", "/token2oauth/admin/supervisor", "/token2oauth/admin#accounts", "/token2oauth/admin/models", "/token2oauth/admin/oracle", "/token2oauth/admin/resources", "/token2oauth/admin/security", "/token2oauth/admin/diagnostics"]) assert.ok(html.includes(`href="${path}"`), path);
  assert.match(html, /aria-current="page">Supervisor/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /No standalone jobs page is mounted yet/);
  assert.match(html, /Analytics is currently an authenticated JSON endpoint/);
  assert.doesNotMatch(html, /href="[^"]*\/admin\/(jobs|analytics|clients)(?:[?#"])/);
  assert.match(html, /<main><h1>Supervised projects<\/h1><\/main>/);
});

test("shell provides workspace identity, current-page context, keyboard mobile drawer, and focus path", () => {
  const html = renderAppShell({ active: "overview", pageTitle: "Overview", workspaceName: "North operations", content: "<main>body</main>" });
  assert.match(html, /North operations/);
  assert.match(html, /Current page<\/small><strong class="rx-current-page">Overview/);
  assert.match(html, /<details class="rx-nav-details"><summary class="rx-mobile-menu" aria-label="Toggle navigation menu">Menu<\/summary>/);
  assert.match(html, /<nav class="rx-nav-groups" aria-label="Workspace navigation">/);
  assert.match(html, /href="#app-main-content">Skip to content/);
  assert.match(html, /id="app-main-content" tabindex="-1"/);
  assert.match(html, /@media\(max-width:720px\)/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /<svg viewBox="0 0 48 48" aria-hidden="true"/);
});

test("shell escapes labels and rejects unsafe base URLs without touching page content", () => {
  const html = renderAppShell({ base: "//attacker.example", active: "overview", pageTitle: '<img src=x onerror="x">', workspaceName: "Ops <script>bad()</script>", content: "<main>Trusted server page</main>" });
  assert.match(html, /&lt;img src=x onerror=&quot;x&quot;&gt;/);
  assert.match(html, /Ops &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="\/\/attacker\.example/);
  assert.match(html, /href="\/admin"/);
  assert.match(html, /<main>Trusted server page<\/main>/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /Ops <script>/);
});
