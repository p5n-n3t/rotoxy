import express from "express";
import { randomBytes } from "node:crypto";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import { INFERENCE_PROVIDER_PRESETS, InferenceProviderStore, type InferenceProvider } from "./inference-providers.js";
import type { StateStore } from "./store.js";
import { fetchProviderModelCatalog, ProviderCatalogError, type ProviderCatalogOptions } from "./provider-model-catalog.js";

function readModels(value: unknown): string[] {
  if (typeof value !== "string") throw new TypeError("model allowlist is invalid");
  return value.split(/[\r\n,]+/).map(model => model.trim()).filter(Boolean);
}

/** Authenticated, CSRF-protected operator page for fixed and admin-defined OpenAI-compatible providers. */
export function createInferenceProviderAdminRouter(store: StateStore, sessions: AdminSessions, catalogOptions: ProviderCatalogOptions = {}) {
  const router = express.Router();
  const accounts = new InferenceProviderStore(store);
  router.use("/admin/inference", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  router.use("/admin/inference", async (req, res, next) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    const nonce = randomBytes(18).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.locals.base = base;
    res.locals.csrf = sessions.csrfToken(token);
    res.locals.token = token;
    res.locals.scriptNonce = nonce;
    next();
  });
  router.use("/admin/inference", express.urlencoded({ extended: false, limit: "64kb" }));
  router.use("/admin/inference", (req, res, next) => {
    if (req.method === "POST" && !sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    next();
  });

  router.get("/admin/inference", async (_req, res) => {
    const base = res.locals.base as string;
    const entries = await accounts.listAccounts();
    const customProviders = await accounts.listCustomProviders();
    const providerLabels = { ...Object.fromEntries(Object.entries(INFERENCE_PROVIDER_PRESETS).map(([id, p]) => [id, p.label])), ...Object.fromEntries(customProviders.map(p => [p.id, p.label])) } as Record<string, string>;
    const cards = entries.map(account => {
      const models = esc(account.allowedModels.join("\n"));
      const saved = JSON.stringify(account.allowedModels).replaceAll("<", "\\u003c");
      return `<section class="card"><h2>${esc(account.label)}</h2><p>${esc(providerLabels[account.provider] ?? "Custom provider")} · ${account.enabled ? "Enabled" : "Disabled"} · ${account.allowedModels.length} allowed models${account.allowedModels.length ? "" : " · inference disabled until models are allowed"}</p><form method="post" action="${esc(base)}/admin/inference/update" data-model-form data-saved="${esc(saved)}"><input type="hidden" name="id" value="${esc(account.id)}"><label>Label<input name="label" value="${esc(account.label)}" maxlength="80" required></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${account.enabled ? " checked" : ""}>Enabled</label><input type="hidden" name="models" value="${models}"><div class="model-picker" data-account="${esc(account.id)}"><p>Saved model allowlist: ${account.allowedModels.length} model(s). Discovery only reads model metadata and never changes this selection.</p><div><button type="button" data-refresh-catalog>Refresh model catalog</button> <button type="button" class="secondary" data-test-connection>Test connection (metadata only)</button> <span role="status" data-catalog-status></span> <span data-selected-count>${account.allowedModels.length} selected</span></div><div><button type="button" data-select-shown>Select shown</button> <button type="button" class="secondary" data-clear-shown>Clear shown</button> <button type="button" class="secondary" data-clear-all>Clear entire allowlist</button> <button type="button" class="secondary" data-replace-shown>Replace allowlist with shown models</button></div><label>Search catalog<input type="search" data-model-search placeholder="Filter by name or ID" autocomplete="off"></label>${account.provider === "openrouter" ? `<label class="toggle"><input type="checkbox" data-free-only>Only show models with zero prompt and completion pricing</label>` : ""}<div class="model-options" data-model-options aria-live="polite"><p>Refresh to load available models. Saved IDs remain selected even if absent from the catalog.</p></div><details><summary>Edit model IDs manually (unverified until tested)</summary><textarea data-model-textarea maxlength="40000" rows="5">${models}</textarea></details></div><label>Replacement API token (leave blank to retain; required after endpoint change)<input type="password" name="token" autocomplete="new-password"></label><button>Save account</button></form><form method="post" action="${esc(base)}/admin/inference/remove"><input type="hidden" name="id" value="${esc(account.id)}"><button class="secondary">Remove account</button></form></section>`;
    }).join("");
    const providerOptions = [...(Object.keys(INFERENCE_PROVIDER_PRESETS) as InferenceProvider[]).map(provider => `<option value="${provider}">${esc(INFERENCE_PROVIDER_PRESETS[provider as "openai" | "openrouter"].label)}</option>`), ...customProviders.map(provider => `<option value="${esc(provider.id)}">${esc(provider.label)}</option>`)].join("");
    const customCards = customProviders.map(p => `<section class="card"><h2>${esc(p.label)}</h2><p>Custom OpenAI-compatible endpoint · ${esc(p.origin)}</p><form method="post" action="${esc(base)}/admin/inference/custom-update"><input type="hidden" name="id" value="${esc(p.id)}"><label>Label<input name="label" value="${esc(p.label)}" maxlength="80" required></label><label>HTTPS base URL (include API path)<input name="origin" value="${esc(p.origin)}" maxlength="300" required></label><button>Save endpoint</button></form><form method="post" action="${esc(base)}/admin/inference/custom-remove"><input type="hidden" name="id" value="${esc(p.id)}"><button class="secondary">Remove provider (after removing its accounts)</button></form></section>`).join("");
    const body = `<main class="wrap">${adminNav(base, "models")}<h1>Inference providers</h1><p><strong>1.</strong> Choose a preset or add a public HTTPS-compatible base URL. <strong>2.</strong> Add an account and test its <code>/models</code> endpoint. <strong>3.</strong> Select models and save. Unselected models cannot be routed.</p><details><summary>Protocol compatibility and security</summary><p>Only OpenAI-style <code>/models</code> and non-streaming <code>/chat/completions</code> with bearer authentication are supported here. Agent workspaces, local/remote agent clients, and search tools use separate integrations. Saving a URL or receiving model metadata does not prove inference compatibility. Credentials are encrypted locally, never shown after saving, and bound to their provider origin. Custom providers require public HTTPS base URLs (including an API path if necessary). Changing the origin requires replacing each saved account token; empty model allowlists deny inference.</p></details><div class="grid">${cards}${customCards}<section class="card"><h2>Add custom provider</h2><form method="post" action="${esc(base)}/admin/inference/custom-add"><label>Label<input name="label" maxlength="80" required></label><label>HTTPS public base URL (include /v1 if needed; no query or fragment)<input name="origin" maxlength="300" placeholder="https://api.example.com/v1" required></label><button>Add provider</button></form></section><section class="card"><h2>Add account</h2><form method="post" action="${esc(base)}/admin/inference/add"><label>Provider<select name="provider">${providerOptions}</select></label><label>Label<input name="label" maxlength="80" required></label><label>API token<input type="password" name="token" autocomplete="new-password" required></label><label>Allowed models, one per line<textarea name="models" maxlength="40000" rows="5"></textarea></label><button>Add account</button></form></section></div></main>`;
    const script = `<script nonce="${esc(res.locals.scriptNonce as string)}">(()=>{
for(const form of document.querySelectorAll('[data-model-form]')){
  const selected=new Set(JSON.parse(form.dataset.saved||'[]'));
  const hidden=form.elements.namedItem('models'), area=form.querySelector('[data-model-textarea]');
  const options=form.querySelector('[data-model-options]'), status=form.querySelector('[data-catalog-status]');
  const count=form.querySelector('[data-selected-count]'), search=form.querySelector('[data-model-search]');
  const free=form.querySelector('[data-free-only]'); let catalog=[];
  function updateCount(){const shown=new Set([...options.querySelectorAll('[data-model-id]')].map(input=>input.dataset.modelId));const hiddenCount=[...selected].filter(id=>!shown.has(id)).length;count.textContent=selected.size+' selected ('+hiddenCount+' hidden by filters)';}
  function sync(writeArea=true){hidden.value=[...selected].join('\\n');if(area&&writeArea)area.value=[...selected].join('\\n');updateCount();}
  function draw(){
    const q=search.value.trim().toLowerCase(),showFree=free?.checked===true;
    const rows=new Map([...selected].map(id=>[id,{id,name:id,free:null,unverified:true}]));
    for(const item of catalog)rows.set(item.id,{...item,unverified:false});
    const matches=[...rows.values()].filter(item=>(!q||item.id.toLowerCase().includes(q)||item.name.toLowerCase().includes(q))&&(!showFree||item.free===true));
    options.replaceChildren();
    if(!matches.length){const p=document.createElement('p');p.textContent=showFree?'No models are confirmed zero-priced for both prompt and completion.':'No matching models.';options.append(p);updateCount();return;}
    for(const item of matches){const label=document.createElement('label');label.className='toggle';const input=document.createElement('input');input.type='checkbox';input.checked=selected.has(item.id);input.dataset.modelId=item.id;input.addEventListener('change',()=>{if(input.checked&&selected.size>=200){input.checked=false;status.textContent='The allowlist supports at most 200 models.';return;}input.checked?selected.add(item.id):selected.delete(item.id);sync();});const text=document.createElement('span');text.textContent=item.name+' ('+item.id+')'+(item.unverified?' · not in refreshed catalog / unverified':item.free===true?' · $0 prompt + completion':item.free===false?' · priced':' · pricing unknown');label.append(input,text);options.append(label);}
    updateCount();
  }
  function readManual(){const manual=area.value.split(/[\\r\\n,]+/).map(x=>x.trim()).filter(Boolean);selected.clear();for(const id of manual)selected.add(id);sync(false);}
  area?.addEventListener('input',()=>{readManual();draw();});
  form.addEventListener('submit',()=>{if(area)readManual();sync(false);});
  search.addEventListener('input',draw);free?.addEventListener('change',draw);
  form.querySelector('[data-select-shown]').addEventListener('click',()=>{const shown=[...options.querySelectorAll('[data-model-id]')].map(input=>input.dataset.modelId);if(selected.size+shown.filter(id=>!selected.has(id)).length>200){status.textContent='Selecting these models would exceed the 200-model limit.';return;}for(const id of shown)selected.add(id);sync();for(const input of options.querySelectorAll('[data-model-id]'))input.checked=true;});
  form.querySelector('[data-clear-all]').addEventListener('click',()=>{selected.clear();sync();draw();status.textContent='Entire allowlist cleared locally. Save account to block all models.';});
  form.querySelector('[data-clear-shown]').addEventListener('click',()=>{for(const input of options.querySelectorAll('[data-model-id]'))selected.delete(input.dataset.modelId);sync();for(const input of options.querySelectorAll('[data-model-id]'))input.checked=false;});
  form.querySelector('[data-replace-shown]').addEventListener('click',()=>{const shown=[...options.querySelectorAll('[data-model-id]')];if(shown.length>200){status.textContent='Narrow the search or free-only filter to 200 models or fewer before replacing the allowlist.';return;}selected.clear();for(const input of shown){selected.add(input.dataset.modelId);input.checked=true;}sync();status.textContent='Pending selection replaced with shown models; save account to apply it.';});
  const csrf=form.querySelector('[name=_csrf]')?.value, id=form.elements.namedItem('id').value;
  const errors={account_not_found:'Account was removed.',account_disabled:'Account disabled.',credential_replacement_required:'Base URL changed: replace API token before testing.',authentication_rejected:'Authentication rejected (HTTP 401/403). Verify the token and permissions.',models_endpoint_missing:'The server returned 404 for /models. This endpoint may not support OpenAI model listing.',catalog_rejected:'Provider rejected the catalog request.',catalog_invalid:'The /models response has an unsupported structure.',catalog_too_large:'The model catalog exceeds limits.',catalog_unavailable:'Could not reach the endpoint securely. Check DNS, TLS, public endpoint policy and network availability.'};
  async function requestMetadata(action){
    const url=location.pathname.slice(0,location.pathname.lastIndexOf('/admin/inference'))+'/admin/inference/'+action;
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf||'',id})});
    const data=await response.json();
    if(!response.ok)throw new Error(errors[data.error]||'Metadata request failed.');
    return data;
  }
  form.querySelector('[data-test-connection]').addEventListener('click',async()=>{
    status.textContent='Checking /models using saved credentials; no inference…';
    try{const data=await requestMetadata('connection');status.textContent='Model endpoint returned '+data.modelCount+' IDs at '+new Date(data.checkedAt).toLocaleString()+'. Inference not tested.';}
    catch(error){status.textContent=error.message;}
  });
  form.querySelector('[data-refresh-catalog]').addEventListener('click',async()=>{
    status.textContent='Refreshing model metadata…';
    try{const data=await requestMetadata('catalog');catalog=data.models;draw();status.textContent=catalog.length?'Loaded '+catalog.length+' IDs at '+new Date(data.checkedAt).toLocaleString()+'. Saved selection unchanged.':'Empty model catalog; enter manual IDs only if protocol support is known. No selection changed.';}
    catch(error){status.textContent=error.message+' Saved selection unchanged; previous results may be stale.';}
  });
  sync(false);draw();
}
})();</script>`;
    res.type("html").send(page("Inference providers", withCsrf(body + script, res.locals.csrf as string)));
  });

  router.post("/admin/inference/:action", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      switch (req.params.action) {
        case "catalog": {
          const models = await fetchProviderModelCatalog(accounts, String(body.id ?? ""), catalogOptions);
          return res.json({ models, checkedAt: Date.now() });
        }
        case "connection": {
          const models = await fetchProviderModelCatalog(accounts, String(body.id ?? ""), { ...catalogOptions, allowDisabled: true });
          return res.json({ ok: true, modelCount: models.length, checkedAt: Date.now(), inferenceVerified: false });
        }
        case "custom-add": await accounts.addCustomProvider(String(body.label ?? "").trim(), String(body.origin ?? "")); break;
        case "custom-update": await accounts.updateCustomProvider(String(body.id ?? ""), String(body.label ?? "").trim(), String(body.origin ?? "")); break;
        case "custom-remove": if (!await accounts.removeCustomProvider(String(body.id ?? ""))) return res.status(404).json({ error: "provider_not_found" }); break;
        case "add":
          await accounts.addAccount({ provider: body.provider as InferenceProvider, label: typeof body.label === "string" ? body.label.trim() : "", token: body.token as string, allowedModels: readModels(body.models) });
          break;
        case "update":
          await accounts.updateAccount(String(body.id ?? ""), {
            label: typeof body.label === "string" ? body.label.trim() : undefined,
            enabled: body.enabled === "1",
            allowedModels: readModels(body.models),
            ...(typeof body.token === "string" && body.token ? { token: body.token } : {}),
          });
          break;
        case "remove":
          if (!await accounts.removeAccount(String(body.id ?? ""))) return res.status(404).json({ error: "account_not_found" });
          break;
        default: return res.status(404).json({ error: "unknown_action" });
      }
      return res.redirect(303, `${res.locals.base}/admin/inference`);
    } catch (error) {
      if ((req.params.action === "catalog" || req.params.action === "connection") && error instanceof ProviderCatalogError)
        return res.status(error.code === "account_not_found" ? 404 : 400).json({ error: error.code });
      return res.status(400).json({ error: "inference_account_operation_failed" });
    }
  });
  return { router, accounts };
}
