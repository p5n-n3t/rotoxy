import express from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, NAV_GROUPS, withCsrf } from "./html.js";
import { ModelCredentialStore } from "./model-credentials.js";
import { ResourceRoutingRulesStore } from "./resource-routing.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

/** Admin-only editor for account routing constraints; runtime adapters enforce only account-scoped rules. */
export function createResourceRoutingAdminRouter(store: StateStore, sessions: AdminSessions) {
  const router = express.Router();
  const rulesStore = new ResourceRoutingRulesStore(store);
  const models = new ModelCredentialStore(store);
  const cloudflare = new CloudflareCredentialStore(store);
  const navGroups = NAV_GROUPS.map((group) => group.label === "Resources"
    ? { ...group, items: [...group.items, { key: "routing", label: "Routing", href: "/admin/routing" }] }
    : group);

  router.use("/admin/routing", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const state = await store.load();
    const token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base;
    res.locals.token = token;
    res.locals.csrf = sessions.csrfToken(token);
    next();
  });
  router.use("/admin/routing", express.urlencoded({ extended: false, limit: "32kb" }));
  router.post("/admin/routing", async (req, res) => {
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    try {
      if (typeof req.body?.rules !== "string" || Buffer.byteLength(req.body.rules, "utf8") > 24_000) throw new TypeError("invalid rules document");
      await rulesStore.replace(JSON.parse(req.body.rules));
      return res.redirect(303, `${res.locals.base}/admin/routing?saved=1`);
    } catch {
      return res.status(400).type("text").send("Routing rules were not saved. Check the JSON schema and account IDs.");
    }
  });
  router.get("/admin/routing", async (req, res) => {
    const [rules, modelAccounts, cloudflareAccounts] = await Promise.all([rulesStore.read(), models.listCredentials(), cloudflare.listCredentials()]);
    const accounts = [
      ...modelAccounts.map((a) => ({ provider: "Ollama", id: a.id, label: a.label })),
      ...cloudflareAccounts.map((a) => ({ provider: "Cloudflare Workers AI", id: a.id, label: a.label })),
    ];
    const accountList = accounts.length ? `<ul>${accounts.map((a) => `<li>${esc(a.provider)} · ${esc(a.label)} · <code>${esc(a.id)}</code></li>`).join("")}</ul>` : "<p>No Ollama or Cloudflare accounts are configured yet.</p>";
    const body = `<main class="wrap">${adminNav(res.locals.base, "routing", navGroups)}<h1>Resource routing</h1><p>Rules are persisted locally and apply to future Cloudflare and Ollama account selection. An account rule may disable an account, set its relative request weight, lower its concurrency ceiling, or restrict inference to exact model IDs.</p><p><strong>Model IDs:</strong> <code>allowedModels</code> is optional. Omit it to preserve existing behavior; set <code>[]</code> to deny all inference through that account, or list exact IDs such as <code>gpt-oss:20b</code> and <code>@cf/meta/llama-3.1-8b-instruct</code>. Wildcards are rejected. For Cloudflare, this adds a restriction alongside the credential's existing model allowlist; it never replaces that allowlist. Model listing endpoints remain available.</p><p><strong>Account capacity is a ceiling:</strong> a configured value is clamped to the adapter's hard per-account limit (Cloudflare ${esc(1)} by default; Ollama ${esc(2)} by default, configurable by the host). This editor cannot raise those limits.</p><p><strong>Scope:</strong> <code>providerCaps</code> is planner metadata only. Live adapters do not enforce a shared provider/group cap because they do not reserve capacity globally across processes.</p><section class="card full"><h2>Account IDs</h2>${accountList}</section><section class="card full"><h2>Editable rules document</h2><form method="post" action="${esc(res.locals.base)}/admin/routing"><label for="routing-rules">JSON rules (version 1)</label><textarea id="routing-rules" name="rules" rows="18" spellcheck="false" autocomplete="off">${esc(JSON.stringify(rules, null, 2))}</textarea><button type="submit">Validate and save</button></form>${req.query.saved === "1" ? '<p role="status">Rules saved.</p>' : ""}</section><section class="card full"><h2>Read-only template</h2><p>Start with this empty rules document; account entries are keyed by the IDs above.</p><pre>${esc(rulesStore.template())}</pre><p>Example account entry: <code>"resources": { "ACCOUNT_ID": { "enabled": false, "weight": 1, "capacity": 1, "allowedModels": ["gpt-oss:20b"] } }</code>. Weights affect request distribution across sequential calls; they are not usage or quota measurements.</p></section></main>`;
    res.type("html").send(page("Resource routing", withCsrf(body, res.locals.csrf)));
  });
  return { router, rules: rulesStore };
}
