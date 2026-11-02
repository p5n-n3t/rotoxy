import test from "node:test";
import assert from "node:assert/strict";
import { adminNav, NAV_GROUPS } from "../dist/html.js";
import { renderAdminLanding } from "../dist/navigation-admin.js";
import { page } from "../dist/ui.js";

const render = (active = "supervisor", base = "/token2oauth") => page("Console", `<main class="wrap">${adminNav(base, active)}<section><h1>Existing page</h1></section></main>`);

test("shared renderer exposes six primary destinations and reachable secondary pages", () => {
  const html = render();
  assert.deepEqual(NAV_GROUPS.map((group) => group.label), ["ROTOXY", "Workspaces", "Manage"]);
  for (const label of ["Overview", "Jobs", "Pools", "Connections", "Activity", "Settings", "Supervisor", "Agent workspace", "ChatGPT &amp; Codex", "Private workers", "Search tools", "Security", "Diagnostics"]) assert.ok(html.includes(label));
  for (const path of ["/token2oauth/admin", "/token2oauth/admin/jobs", "/token2oauth/admin/providers", "/token2oauth/admin/endpoints", "/token2oauth/admin/activity", "/token2oauth/admin/settings", "/token2oauth/admin/supervisor", "/token2oauth/admin/agents", "/token2oauth/admin/codex", "/token2oauth/admin/oracle", "/token2oauth/admin/resources", "/token2oauth/admin/security", "/token2oauth/admin/diagnostics"]) assert.ok(html.includes(`href="${path}"`), path);
  assert.doesNotMatch(html, /\/admin#accounts/, "workspace account link does not point to a missing overview fragment");
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /aria-current="page">Supervisor/);
  assert.doesNotMatch(html, /<span class="nav-link nav-unavailable"/);

  assert.match(html, /href="\/token2oauth\/admin\/jobs"/);
  assert.doesNotMatch(html, /href="[^\"]*\/admin\/analytics(?:[?#\"])/);
  assert.match(html, /<h1>Existing page<\/h1>/);
});

test("shared navigation has one stable destination per entry and resolves compatibility active keys", () => {
  const items = NAV_GROUPS.flatMap((group) => group.items);
  assert.equal(new Set(items.map((item) => item.key)).size, items.length, "each navigation key is unique");
  assert.equal(new Set(items.map((item) => item.href)).size, items.length, "each navigation destination is unique");
  assert.ok(!items.some((item) => item.key === "clients"), "client link is omitted until a dedicated client-connections page exists");
  assert.equal(items.filter((item) => ["Overview", "Jobs", "Pools", "Connections", "Activity", "Settings"].includes(item.label)).length, 6);

  const html = render("chatgpt-codex");
  assert.equal((html.match(/href="\/token2oauth\/admin\/codex"/g) || []).length, 1, "one responsive navigation tree renders one Codex link");
  assert.equal((html.match(/aria-current="page">ChatGPT &amp; Codex/g) || []).length, 1, "the current destination has one active marker");
});

test("Activity and Settings landings link to existing views without inventing records", () => {
  const activity = renderAdminLanding("/base", "activity");
  assert.match(activity, /<h1>Activity<\/h1>/);
  for (const path of ["/base/admin/jobs", "/base/admin/supervisor", "/base/admin/diagnostics"]) assert.ok(activity.includes(`href="${path}"`));
  assert.doesNotMatch(activity, /No activity|0 events|activity records/i);

  const settings = renderAdminLanding("/base", "settings");
  assert.match(settings, /<h1>Settings<\/h1>/);
  for (const path of ["/base/admin/security", "/base/admin/routing", "/base/admin/tools"]) assert.ok(settings.includes(`href="${path}"`));
});

test("integrated shell carries workspace context, skip target, accessible mobile menu, and focus styling", () => {
  const html = render("pool", "");
  assert.match(html, /ROTOXY Fleet/);
  assert.match(html, /Current page<\/span><strong class="rx-current-page">Overview/);
  assert.match(html, /<details class="rx-nav-details"><summary class="rx-mobile-menu">Menu/);
  assert.doesNotMatch(html, /<script\b/i, "shared navigation works under a strict script CSP");
  assert.match(html, /\.rx-nav-details::details-content\{content-visibility:visible;display:contents\}/, "desktop shows the disclosure contents without JavaScript");
  assert.match(html, /<nav class="rx-nav-groups" aria-label="ROTOXY navigation">/);
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
