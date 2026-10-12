import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate before any module that could construct a StateStore.
const sandbox = mkdtempSync(join(tmpdir(), "rx-brand-"));
process.env.HOME = sandbox;
process.env.TOKEN2OAUTH_CONFIG_DIR = join(sandbox, "cfg");

const { adminNav, NAV_GROUPS, ROTOXY_MARK_SVG, withCsrf } = await import("../dist/html.js");
const { page } = await import("../dist/ui.js");

test("grouped navigation keeps every legacy admin URL and marks the active page", () => {
  const html = adminNav("https://gw.example/token2oauth", "supervisor");
  assert.deepEqual(NAV_GROUPS.map((g) => g.label), ["Workspace", "Providers", "Models & APIs", "Operations", "Platform"]);
  for (const path of ["/admin", "/admin/supervisor", "/admin/tools", "/admin/diagnostics", "/admin/security", "/admin/logout"]) {
    assert.ok(html.includes(`https://gw.example/token2oauth${path}"`), path);
  }
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /aria-current="page">Supervisor</);
  assert.match(html, /role="group" aria-label="Models &amp; APIs"/);
});

test("ROTOXY brand renders with Token2OAuth compatibility subtitle and authored mark", () => {
  const html = page("Pool", adminNav("", "pool"));
  assert.match(html, /<strong>ROTOXY<\/strong><div class="eyebrow">Token2OAuth gateway<\/div>/);
  assert.match(html, /<div class="logo"><svg viewBox="0 0 48 48" aria-hidden="true"/);
  assert.ok(html.includes(ROTOXY_MARK_SVG));
  assert.match(html, /<title>Pool · Token2OAuth<\/title>/); // title kept for compatibility
});

test("nav escapes base and extra groups, and logout keeps CSRF", () => {
  const html = withCsrf(adminNav('"><x>', "jobs", [...NAV_GROUPS, { label: "<Ops>", items: [{ key: "jobs", label: "Jobs", href: "/admin/jobs" }] }]), "t");
  assert.doesNotMatch(html, /"><x>|<Ops>/);
  assert.match(html, /aria-current="page">Jobs</);
  assert.match(html, /action="&quot;&gt;&lt;x&gt;\/admin\/logout"><input type="hidden" name="_csrf" value="t">/);
});

test("shell CSS: compact grouped bar, no horizontal nav scroll, nowrap buttons, responsive and reduced motion", () => {
  const css = page("x", "").match(/<style>([\s\S]*)<\/style>/)[1];
  assert.match(css, /\.topbar\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto/);
  assert.match(css, /button,\.btn\{white-space:nowrap\}/);
  assert.match(css, /@media\(max-width:620px\)\{\.groups\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css.slice(css.indexOf(".topbar")), /\.groups\{[^}]*overflow-x:auto/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css, /animation:[^n!]*infinite/);
});
