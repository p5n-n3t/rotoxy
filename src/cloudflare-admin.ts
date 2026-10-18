import express from "express";
import { randomBytes } from "node:crypto";
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
  let catalog: string[] = [], capturedAt: number | undefined, catalogTruncated = false;
  const perAccountCatalog = new Map<string, { models: string[]; capturedAt: number; truncated: boolean }>();
  router.use(["/admin/cloudflare", "/pool/cloudflare"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin"); next();
  });
  router.use("/admin/cloudflare", async (req, res, next) => {
    const state = await store.load(), token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, base + "/admin/login?next=" + encodeURIComponent(req.originalUrl));
    res.locals.scriptNonce = randomBytes(18).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${res.locals.scriptNonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
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
      const latest = perAccountCatalog.get(a.id);
      const options = [...new Set([...(latest?.models ?? catalog), ...a.allowedModels])].sort();
      const checks = `<div data-cf-picker><label>Find a model<input type="search" data-cf-search placeholder="Search model IDs"></label><div class="cf-picker-actions"><button type="button" class="secondary" data-cf-select-shown>Select shown</button> <button type="button" class="secondary" data-cf-clear>Clear selection</button><output data-cf-count aria-live="polite">${a.allowedModels.length} selected</output></div><div class="cf-model-options">${options.map(model => `<label class="toggle"><input type="checkbox" name="models" value="${esc(model)}"${a.allowedModels.includes(model) ? " checked" : ""}><span>${esc(model)}${latest && !latest.models.includes(model) ? " · saved ID absent from latest catalog (unverified)" : ""}</span></label>`).join("") || '<p>Refresh the catalog to discover models.</p>'}</div><label>Add model IDs manually (unverified until tested; one per line)<textarea name="manualModels" rows="3" placeholder="@cf/vendor/model"></textarea></label><p class="muted">Selected models are allowed to route, not proven executable. Save changes to persist selections. Clearing every selection blocks inference. Filtering does not change hidden selections.</p></div>`;
      return `<section class="card"><h2 style="overflow-wrap:anywhere">${esc(a.label)}</h2><p>${a.enabled ? "Enabled" : "Disabled"} · ${snapshot.inflight[a.id] ?? 0} active requests · ${a.allowedModels.length} allowed models${a.cooldownUntil && a.cooldownUntil > Date.now() ? " · Cooling down" : ""}</p><details><summary>Edit account and models</summary><form method="post" action="${esc(base)}/admin/cloudflare/update"><input type="hidden" name="id" value="${esc(a.id)}"><label>Label<input name="label" value="${esc(a.label)}" maxlength="80" required></label><label>Cloudflare account ID<input name="accountId" value="${esc(a.accountId)}" pattern="[a-fA-F0-9]{32}" required></label><label>Replacement token (leave empty to keep current)<input type="password" name="token" autocomplete="new-password"></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${a.enabled ? " checked" : ""}>Eligible for this pool</label><fieldset><legend>Allowed models</legend><button type="submit" class="secondary" formaction="${esc(base)}/admin/cloudflare/catalog">Refresh this account catalog (metadata only)</button><p class="muted">${latest ? "Account catalog captured " + esc(new Date(latest.capturedAt).toISOString()) + "; " + latest.models.length + " returned IDs." + (latest.truncated ? " Results truncated." : "") : "No account catalog has been checked during this process. Saved models may be stale."}</p>${checks || '<p>Refresh the catalog to choose models. An empty selection blocks inference.</p>'}</fieldset><button>Save changes</button></form></details><details><summary>Remove account</summary><p>Removes the encrypted credential from this gateway. Existing provider access is not revoked.</p><form method="post" action="${esc(base)}/admin/cloudflare/remove"><input type="hidden" name="id" value="${esc(a.id)}"><button class="secondary">Remove account</button></form></details></section>`;
    }).join("");
    const recent = snapshot.recent.slice(-20).reverse().map(r => `<tr><td>${esc(accounts.find(a => a.id === r.accountId)?.label ?? r.accountId)}</td><td>${esc(r.model)}</td><td>${esc(r.status)}</td><td>${r.durationMs} ms</td><td>${r.usage?.neurons ?? "Not reported"}</td></tr>`).join("");
    const body = `<main class="wrap">${adminNav(base, "cloudflare")}<h1>Cloudflare Workers AI</h1><p><strong>1.</strong> Add your account ID and Workers AI API token. <strong>2.</strong> Refresh that account’s read-only catalog. <strong>3.</strong> Select models and save.</p><details><summary>Permissions, billing and availability</summary><p>Catalog refresh requires Workers AI Read or Write permission and does not run inference. Saving an account or model ID does not verify access, entitlement, or execution; inference may incur charges. Model pricing and remaining allowance are unknown.</p></details><p>${accounts.length} accounts. Least-active routing with round-robin ties; one active request per account in this process. Remaining allowance is unknown. Reported neurons describe request consumption.</p><p><a href="${esc(base)}/admin/models">Model access tokens</a> authorize <code>${esc(base)}/pool/cloudflare/models</code> and <code>${esc(base)}/pool/cloudflare/run</code>.</p><form method="post" action="${esc(base)}/admin/cloudflare/catalog"><button class="secondary">Refresh model catalog</button></form><p role="status" aria-live="polite" class="muted">${_req.query.catalog_error === "auth" ? "Catalog rejected (401/403). Check token and Workers AI permissions; saved models unchanged." : _req.query.catalog_error === "unavailable" ? "Catalog refresh failed or timed out. Prior selections unchanged; previous results may be stale." : _req.query.catalog_error === "missing" ? "Account no longer exists. Saved models unchanged." : ""}</p><p class="muted">${capturedAt ? `Catalog captured ${esc(new Date(capturedAt).toISOString())}; ${catalog.length} returned models.${catalogTruncated ? " Results reached the bounded catalog limit." : ""}` : "Catalog has not been refreshed in this process."}</p><div class="grid">${cards}<section class="card full"><h2>Add account</h2><form method="post" action="${esc(base)}/admin/cloudflare/add"><label>Label<input name="label" maxlength="80" required></label><label>Cloudflare account ID<input name="accountId" pattern="[a-fA-F0-9]{32}" required></label><label>Workers AI API token<input type="password" name="token" autocomplete="new-password" required></label><button>Add account</button></form><p>Choose allowed models after connecting. No inference is enabled by default.</p></section><section class="card full"><h2>Recent inference</h2><p>Last 100 requests since gateway startup; payloads are not recorded. Refresh this page for the latest readings.</p><div class="table-scroll"><table><thead><tr><th>Account</th><th>Model</th><th>State</th><th>Duration</th><th>Reported neurons</th></tr></thead><tbody>${recent || '<tr><td colspan="5">No inference recorded in this process.</td></tr>'}</tbody></table></div></section></div></main>`;
    const picker = `<style>.cf-model-options{overflow:visible;border:1px solid var(--line);padding:8px}.cf-model-options .toggle{align-items:flex-start;overflow-wrap:anywhere}.cf-model-options .toggle[hidden]{display:none}.cf-picker-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0}.cf-picker-actions output{color:var(--muted)}</style><script nonce="${esc(res.locals.scriptNonce)}">(()=>{for(const picker of document.querySelectorAll('[data-cf-picker]')){const checks=[...picker.querySelectorAll('input[name="models"]')],output=picker.querySelector('[data-cf-count]');const count=()=>{output.textContent=checks.filter(c=>c.checked).length+' selected'};picker.querySelector('[data-cf-search]').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();for(const c of checks)c.closest('label').hidden=!c.value.toLowerCase().includes(q)});picker.querySelector('[data-cf-select-shown]').addEventListener('click',()=>{const visible=checks.filter(c=>!c.closest('label').hidden);if(visible.length+checks.filter(c=>c.checked&&c.closest('label').hidden).length>200){output.textContent='Narrow search: at most 200 models can be selected';return;}for(const c of visible)c.checked=true;count()});picker.querySelector('[data-cf-clear]').addEventListener('click',()=>{for(const c of checks)c.checked=false;count()});for(const c of checks)c.addEventListener('change',()=>{if(checks.filter(c=>c.checked).length>200){c.checked=false;output.textContent='At most 200 models can be enabled';return}count()})}})();</script>`;
    res.type("html").send(page("Cloudflare Workers AI", withCsrf(body + picker, res.locals.csrf)));
  });
  router.post("/admin/cloudflare/:action", async (req, res) => {
    try {
      const b = req.body;
      switch (req.params.action) {
        case "add": await credentials.addCredential({ label: b.label, accountId: b.accountId, token: b.token }); break;
        case "update": await credentials.updateCredential(b.id, { label: b.label, accountId: b.accountId, enabled: b.enabled === "1", allowedModels: [...(b.models === undefined ? [] : Array.isArray(b.models) ? b.models : [b.models]), ...(typeof b.manualModels === "string" ? b.manualModels.split(/[\r\n,]+/).map((id: string) => id.trim()).filter(Boolean) : [])], ...(b.token ? { token: b.token } : {}) }); break;
        case "remove": perAccountCatalog.delete(b.id); if (!await credentials.deleteCredential(b.id)) return res.status(404).json({ error: "account_not_found" }); break;
        case "catalog": {
          const id = typeof b.id === "string" && b.id ? b.id : undefined;
          const result = await ai.listModels(id) as { result?: Array<{ name?: string }>; result_info?: { truncated?: boolean } };
          const names = Array.isArray(result?.result) ? result.result.flatMap(m => typeof m?.name === "string" && m.name.length <= 200 ? [m.name] : []).slice(0, 2000) : [];
          const truncated = result?.result_info?.truncated === true;
          if (id) perAccountCatalog.set(id, { models: names, truncated, capturedAt: Date.now() });
          else { catalog = names; catalogTruncated = truncated; capturedAt = Date.now(); }
          break;
        }
        default: return res.status(404).json({ error: "unknown_action" });
      }
      res.redirect(303, res.locals.base + "/admin/cloudflare");
    } catch (error) {
      if (req.params.action === "catalog") {
        const reason = error instanceof CloudflareAIError && (error.status === 401 || error.status === 403) ? "auth" :
          error instanceof CloudflareAIError && error.code === "no_eligible_account" ? "missing" : "unavailable";
        return res.redirect(303, res.locals.base + "/admin/cloudflare?catalog_error=" + reason);
      }
      res.status(400).json({ error: "cloudflare_operation_failed" });
    }
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
