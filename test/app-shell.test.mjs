import test from "node:test";
import assert from "node:assert/strict";
import { adminNav, NAV_GROUPS } from "../dist/html.js";
import { page } from "../dist/ui.js";

const render = (active = "supervisor", base = "/token2oauth") => page("Console", `<main class="wrap">${adminNav(base, active)}<section><h1>Existing page</h1></section></main>`);

test("shared renderer exposes the four audited workspace groups and current route", () => {
  const html = render();
  assert.deepEqual(NAV_GROUPS.map((group) => group.label), ["Command", "Resources", "Insights", "Settings"]);
  for (const label of ["Overview", "Supervisor", "Workspace accounts", "Models &amp; APIs", "Private workers", "Search", "Activity", "Clients", "Auth", "Diagnostics"]) assert.ok(html.includes(label));
  for (const path of ["/token2oauth/admin", "/token2oauth/admin/supervisor", "/token2oauth/admin#accounts", "/token2oauth/admin/models", "/token2oauth/admin/oracle", "/token2oauth/admin/resources", "/token2oauth/admin/security", "/token2oauth/admin/diagnostics"]) assert.ok(html.includes(`href="${path}"`), path);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 2);
  assert.match(html, /aria-current="page">Supervisor/);
  assert.doesNotMatch(html, /<span class="nav-link nav-unavailable"/);

  assert.match(html, /href="\/token2oauth\/admin\/jobs"/);
  assert.doesNotMatch(html, /href="[^\"]*\/admin\/analytics(?:[?#\"])/);
  assert.match(html, /<h1>Existing page<\/h1>/);
});

test("integrated shell carries workspace context, skip target, accessible mobile menu, and focus styling", () => {
  const html = render("pool", "");
  assert.match(html, /Gateway workspace/);
  assert.match(html, /Current page<\/span><strong class="rx-current-page">Overview/);
  assert.match(html, /<details class="rx-nav-details"><summary class="rx-mobile-menu">Menu/);
  assert.match(html, /<nav class="rx-nav-groups" aria-label="Workspace navigation">/);
  assert.match(html, /href="#rx-main-content">Skip to content/);
  assert.match(html, /<main id="rx-main-content" tabindex="-1"/);
  assert.match(html, /@media\(max-width:720px\)/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /overflow-wrap:anywhere/);
});

test("nav escapes custom labels and base while preserving server-rendered content", () => {
  const html = page("Console", `<main class="wrap">${adminNav('\"><x>', "jobs", [{ label: "<Ops>", items: [{ key: "jobs", label: "<Jobs>", href: "/admin/jobs" }] }])}<p>Trusted content</p></main>`);
  assert.match(html, /<h2 class="nav-label" id="nav-&lt;ops&gt;">&lt;Ops&gt;<\/h2>/);
  assert.match(html, /&lt;Jobs&gt;/);
  assert.doesNotMatch(html, /<Ops>|<Jobs>/);
  assert.match(html, /<p>Trusted content<\/p>/);
});
