import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import type { StateStore } from "./store.js";
import { loadBedrockCatalog, loadBedrockSettings, normalizeBedrockSettings, refreshBedrockCatalog, saveBedrockSettings, type BedrockSettings } from "./bedrock-catalog.js";

function fallbackSettings(): BedrockSettings {
  const region = process.env.ROTOXY_BEDROCK_REGION ?? "";
  const transport = process.env.ROTOXY_BEDROCK_TRANSPORT === "invoke" ? "invoke" : "mantle";
  const enabledModels = (process.env.ROTOXY_BEDROCK_MODELS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  try { return normalizeBedrockSettings({ region, transport, enabledModels }); } catch { return { region: "", transport, enabledModels: [] }; }
}

function values(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [input];
  return raw.flatMap(value => typeof value === "string" ? value.split(/[\r\n,]+/) : []).map(value => value.trim()).filter(Boolean);
}

/** Private, session-protected operator controls for Bedrock configuration and read-only discovery. */
export function createBedrockAdminRouter(store: StateStore, sessions: AdminSessions) {
  const router = express.Router();
  router.use("/admin/bedrock", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next();
  });
  router.use("/admin/bedrock", async (req, res, next) => {
    try {
      const state = await store.load(); const token = parseCookies(req.headers.cookie).t2o_admin;
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      const nonce = randomBytes(18).toString("base64");
      res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
      res.locals.base = base; res.locals.origin = new URL(state.config.publicBaseUrl).origin;
      res.locals.csrf = sessions.csrfToken(token); res.locals.token = token; res.locals.scriptNonce = nonce; next();
    } catch { res.status(500).json({ error: "admin_state_unavailable" }); }
  });
  router.use("/admin/bedrock", express.urlencoded({ extended: false, limit: "24kb", parameterLimit: 150 }));
  router.use("/admin/bedrock", (req, res, next) => {
    if (req.method !== "POST") return next();
    const origin = req.get("origin");
    if (!origin || origin !== res.locals.origin) return res.status(403).json({ error: "origin_invalid" });
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    next();
  });

  router.get("/admin/bedrock", async (_req, res) => {
    const base = res.locals.base as string; let config: BedrockSettings;
    try { config = await loadBedrockSettings(store) ?? fallbackSettings(); }
    catch { return res.status(500).json({ error: "bedrock_configuration_invalid" }); }
    const catalog = await loadBedrockCatalog(store);
    const catalogMatches = catalog?.region === config.region && catalog.transport === config.transport;
    const saved = JSON.stringify(config.enabledModels).replaceAll("<", "\\u003c");
    const modelOptions = catalogMatches ? catalog!.models : [];
    const body = `<main class="wrap">${adminNav(base, "models")}<h1>Amazon Bedrock</h1><p>Configure a region and endpoint, inspect the endpoint's model catalog, then explicitly enable model IDs. Catalog visibility does not confirm account entitlement, model access, or credits. Empty selection denies inference.</p><div class="grid"><section class="card full"><h2>Endpoint and model selection</h2><form method="post" action="${esc(base)}/admin/bedrock/save" data-bedrock-form data-saved="${esc(saved)}"><label>AWS region<input name="region" value="${esc(config.region)}" maxlength="40" pattern="[a-z]{2}(-[a-z0-9]+)+-[0-9]" required></label><label>Transport<select name="transport"><option value="invoke"${config.transport === "invoke" ? " selected" : ""}>Bedrock Runtime</option><option value="mantle"${config.transport === "mantle" ? " selected" : ""}>Bedrock Mantle</option></select></label><input type="hidden" name="enabledModels" value="${esc(config.enabledModels.join("\n"))}" data-enabled-models><p><span data-bedrock-selection-count>${config.enabledModels.length} enabled model(s).</span> An empty selection denies inference.</p><button type="button" class="secondary" data-clear-bedrock-selection>Clear selection</button> <button>Save Bedrock selection</button></form><form method="post" action="${esc(base)}/admin/bedrock/refresh"><button class="secondary">Refresh catalog</button> <span>${catalogMatches && catalog ? `Last refreshed ${esc(new Date(catalog.refreshedAt).toISOString())} · ${catalog.models.length} entries${catalog.truncated ? " · capped; results may be incomplete" : ""}` : catalog ? "Saved catalog belongs to a different region or endpoint; refresh it to browse." : "No catalog loaded"}</span></form><label>Search catalog<input type="search" data-bedrock-search autocomplete="off" placeholder="Filter by name or model ID"></label><div class="model-options" data-bedrock-options aria-live="polite"></div><p class="muted">${config.transport === "invoke" ? "Runtime rows can include base models and inference profiles." : "Mantle listing uses the read-only /v1/models endpoint."} Entitlement and credit eligibility remain unknown.</p></section></div></main>`;
    const rows = JSON.stringify(modelOptions).replaceAll("<", "\\u003c");
    const newline = JSON.stringify("\n");
    const script = `<script nonce="${esc(res.locals.scriptNonce as string)}">(()=>{const form=document.querySelector('[data-bedrock-form]'),options=document.querySelector('[data-bedrock-options]'),search=document.querySelector('[data-bedrock-search]'),count=document.querySelector('[data-bedrock-selection-count]'),clear=document.querySelector('[data-clear-bedrock-selection]'),hidden=form?.querySelector('[data-enabled-models]');if(!form||!options||!search||!count||!clear||!hidden)return;const selected=new Set(JSON.parse(form.dataset.saved||'[]')),catalog=${rows},sep=${newline};function sync(){hidden.value=[...selected].join(sep);count.textContent=selected.size+' enabled model(s).'}function draw(){const q=search.value.trim().toLowerCase(),items=catalog.filter(row=>!q||row.id.toLowerCase().includes(q)||row.name.toLowerCase().includes(q));options.replaceChildren();if(!items.length){const p=document.createElement('p');p.textContent=catalog.length?'No matching models.':'Refresh the catalog to discover models.';options.append(p);return}for(const row of items){const label=document.createElement('label');label.className='toggle';const input=document.createElement('input');input.type='checkbox';input.checked=selected.has(row.id);input.addEventListener('change',()=>{input.checked?selected.add(row.id):selected.delete(row.id);sync()});const text=document.createElement('span');text.textContent=row.name+' ('+row.id+') · '+row.source+' · entitlement unknown';label.append(input,text);options.append(label)}}clear.addEventListener('click',()=>{selected.clear();sync();draw()});search.addEventListener('input',draw);form.addEventListener('submit',sync);sync();draw()})();</script>`;
    res.type("html").send(page("Amazon Bedrock", withCsrf(body + script, res.locals.csrf as string)));
  });

  router.post("/admin/bedrock/:action", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>; const base = res.locals.base as string;
    try {
      if (req.params.action === "save") {
        const settings = normalizeBedrockSettings({ region: body.region, transport: body.transport, enabledModels: values(body.enabledModels) });
        await saveBedrockSettings(store, settings); return res.redirect(303, `${base}/admin/bedrock`);
      }
      if (req.params.action === "refresh") {
        const settings = await loadBedrockSettings(store) ?? fallbackSettings();
        if (!settings.region) return res.status(400).json({ error: "bedrock_region_required" });
        const catalog = await refreshBedrockCatalog(store, settings);
        return res.redirect(303, `${base}/admin/bedrock`);
      }
      return res.status(404).json({ error: "unknown_action" });
    } catch (error) {
      if (req.params.action === "refresh") return res.status(502).json({ error: error instanceof Error && error.message === "bedrock_catalog_timeout" ? "catalog_timeout" : "catalog_unavailable" });
      return res.status(400).json({ error: "bedrock_configuration_invalid" });
    }
  });
  return router;
}
