import express from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import { CloudflareAIAdapter, CloudflareAIError, CloudflareCredentialStore } from "./cloudflare-ai.js";
import type { ModelCredentialStore } from "./model-credentials.js";
import type { StateStore } from "./store.js";

/** Admin cookies authorize management; independently scoped tokens authorize inference. */
export function createCloudflareRouter(store: StateStore, sessions: AdminSessions, tokens: ModelCredentialStore, adapter?: CloudflareAIAdapter) {
  const router = express.Router(), credentials = new CloudflareCredentialStore(store);
  const ai = adapter ?? new CloudflareAIAdapter(credentials, { maxTokens: 2048 });
  let catalog: string[] = [], capturedAt: number | undefined;
  router.use(["/admin/cloudflare", "/pool/cloudflare"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); next();
  });
  router.use("/admin/cloudflare", async (req, res, next) => {
    const state = await store.load(), token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, base + "/admin/login?next=" + encodeURIComponent(req.originalUrl));
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base; res.locals.csrf = sessions.csrfToken(token); res.locals.token = token; next();
  });
  router.use("/admin/cloudflare", express.urlencoded({ extended: false, limit: "32kb" }));
  router.use("/admin/cloudflare", (req, res, next) => {
    if (req.method === "POST" && !sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    next();
  });
  router.get("/admin/cloudflare", async (_req, res) => {
    const base = res.locals.base as string, accounts = await credentials.listCredentials(), snapshot = ai.snapshot();
    const cards = accounts.map(a => {
      const options = [...new Set([...catalog, ...a.allowedModels])].sort();
      const checks = options.map(model => `<label class="toggle"><input type="checkbox" name="models" value="${esc(model)}"${a.allowedModels.includes(model) ? " checked" : ""}>${esc(model)}</label>`).join("");
      return `<section class="card"><h2 style="overflow-wrap:anywhere">${esc(a.label)}</h2><p>${a.enabled ? "Enabled" : "Disabled"} · ${snapshot.inflight[a.id] ?? 0} active requests · ${a.allowedModels.length} allowed models${a.cooldownUntil && a.cooldownUntil > Date.now() ? " · Cooling down" : ""}</p><details><summary>Edit account and models</summary><form method="post" action="${esc(base)}/admin/cloudflare/update"><input type="hidden" name="id" value="${esc(a.id)}"><label>Label<input name="label" value="${esc(a.label)}" maxlength="80" required></label><label>Cloudflare account ID<input name="accountId" value="${esc(a.accountId)}" pattern="[a-fA-F0-9]{32}" required></label><label>Replacement token (leave empty to keep current)<input type="password" name="token" autocomplete="new-password"></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${a.enabled ? " checked" : ""}>Eligible for this pool</label><fieldset><legend>Allowed models</legend>${checks || '<p>Refresh the catalog to choose models. An empty selection blocks inference.</p>'}</fieldset><button>Save changes</button></form></details><details><summary>Remove account</summary><p>Removes the encrypted credential from this gateway. Existing provider access is not revoked.</p><form method="post" action="${esc(base)}/admin/cloudflare/remove"><input type="hidden" name="id" value="${esc(a.id)}"><button class="secondary">Remove account</button></form></details></section>`;
    }).join("");
    const recent = snapshot.recent.slice(-20).reverse().map(r => `<tr><td>${esc(accounts.find(a => a.id === r.accountId)?.label ?? r.accountId)}</td><td>${esc(r.model)}</td><td>${esc(r.status)}</td><td>${r.durationMs} ms</td><td>${r.usage?.neurons ?? "Not reported"}</td></tr>`).join("");
    const body = `<main class="wrap">${adminNav(base, "cloudflare")}<h1>Cloudflare Workers AI</h1><p>${accounts.length} accounts. Least-active routing with round-robin ties; one active request per account in this process. Remaining allowance is unknown. Reported neurons describe request consumption.</p><p><a href="${esc(base)}/admin/models">Model access tokens</a> authorize <code>${esc(base)}/pool/cloudflare/models</code> and <code>${esc(base)}/pool/cloudflare/run</code>.</p><form method="post" action="${esc(base)}/admin/cloudflare/catalog"><button class="secondary">Refresh model catalog</button></form><p class="muted">${capturedAt ? `Catalog captured ${esc(new Date(capturedAt).toISOString())}; ${catalog.length} returned models.` : "Catalog has not been refreshed in this process."}</p><div class="grid">${cards}<section class="card full"><h2>Add account</h2><form method="post" action="${esc(base)}/admin/cloudflare/add"><label>Label<input name="label" maxlength="80" required></label><label>Cloudflare account ID<input name="accountId" pattern="[a-fA-F0-9]{32}" required></label><label>Workers AI API token<input type="password" name="token" autocomplete="new-password" required></label><button>Add account</button></form><p>Choose allowed models after connecting. No inference is enabled by default.</p></section><section class="card full"><h2>Recent inference</h2><p>Last 100 requests since gateway startup; payloads are not recorded. Refresh this page for the latest readings.</p><div class="table-scroll"><table><thead><tr><th>Account</th><th>Model</th><th>State</th><th>Duration</th><th>Reported neurons</th></tr></thead><tbody>${recent || '<tr><td colspan="5">No inference recorded in this process.</td></tr>'}</tbody></table></div></section></div></main>`;
    res.type("html").send(page("Cloudflare Workers AI", withCsrf(body, res.locals.csrf)));
  });
  router.post("/admin/cloudflare/:action", async (req, res) => {
    try {
      const b = req.body;
      switch (req.params.action) {
        case "add": await credentials.addCredential({ label: b.label, accountId: b.accountId, token: b.token }); break;
        case "update": await credentials.updateCredential(b.id, { label: b.label, accountId: b.accountId, enabled: b.enabled === "1", allowedModels: b.models === undefined ? [] : Array.isArray(b.models) ? b.models : [b.models], ...(b.token ? { token: b.token } : {}) }); break;
        case "remove": if (!await credentials.deleteCredential(b.id)) return res.status(404).json({ error: "account_not_found" }); break;
        case "catalog": {
          const result = await ai.listModels() as { result?: Array<{ name?: string }> };
          catalog = Array.isArray(result?.result) ? result.result.flatMap(m => typeof m?.name === "string" && m.name.length <= 200 ? [m.name] : []).slice(0, 200) : [];
          capturedAt = Date.now(); break;
        }
        default: return res.status(404).json({ error: "unknown_action" });
      }
      res.redirect(303, res.locals.base + "/admin/cloudflare");
    } catch { res.status(400).json({ error: "cloudflare_operation_failed" }); }
  });
  router.use("/pool/cloudflare", async (req, res, next) => {
    const scope = req.method === "GET" ? "model:read" : "model:invoke";
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token || !await tokens.authorizeToken(token, scope)) return res.status(401).set("WWW-Authenticate", 'Bearer realm="ROTOXY models"').json({ error: "unauthorized" });
    next();
  });
  router.use("/pool/cloudflare", express.json({ limit: "64kb" }));
  router.get("/pool/cloudflare/models", async (_req, res) => {
    const accounts = await credentials.listCredentials();
    const names = [...new Set(accounts.filter(a => a.enabled).flatMap(a => a.allowedModels))];
    res.json({ object: "list", data: names.map(id => ({ id, object: "model", owned_by: "cloudflare" })) });
  });
  router.post("/pool/cloudflare/run", async (req, res) => {
    try {
      if (req.body?.input?.stream === true) return res.status(400).json({ error: "streaming_not_supported" });
      res.json(await ai.run(req.body));
    } catch (error) {
      const code = error instanceof CloudflareAIError ? error.code : "provider_failure";
      res.status(code === "invalid_request" ? 400 : code === "model_not_allowed" ? 403 : 503).json({ error: code });
    }
  });
  return { router, credentials, adapter: ai };
}
