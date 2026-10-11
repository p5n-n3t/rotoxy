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
  assert.match(html, /<div class="logo"><svg viewBox="0 0 48 48" aria-hidden="true"/);
  assert.match(html, /aria-current="page">Pool</);
  assert.equal(brandMarkup("<p>no badge</p>"), "<p>no badge</p>");
});

test("theme wrapper keeps CSRF injection on every POST form and escapes the title", () => {
  const body = `${adminNav("", "pool")}<form method="post" action="/admin/accounts"><input name="label"></form><form method="get" action="/x"></form>`;
  const html = withCsrf(page("<Pool>", body), "tok-123");
  assert.equal((html.match(/name="_csrf" value="tok-123"/g) || []).length, 2); // logout + accounts
  assert.match(html, /<title>&lt;Pool&gt; · Token2OAuth<\/title>/);
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
