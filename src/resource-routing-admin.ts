import express from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, NAV_GROUPS, withCsrf } from "./html.js";
import { ModelCredentialStore } from "./model-credentials.js";
import { ResourceRoutingRulesStore } from "./resource-routing.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

/** Admin-only editor for account routing constraints; runtime adapters enforce pool and account dispatch rules. */
export function createResourceRoutingAdminRouter(store: StateStore, sessions: AdminSessions) {
  const router = express.Router();
  const rulesStore = new ResourceRoutingRulesStore(store);
  const models = new ModelCredentialStore(store);
  const cloudflare = new CloudflareCredentialStore(store);
  const navGroups = NAV_GROUPS;

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
  const knownAccounts=async()=>{
    const [state,ollama,cf]=await Promise.all([store.load(),models.listCredentials(),cloudflare.listCredentials()]);
    const native=state.config.upstreamUrl==="https://app.lightsprint.ai/mcp";
    return [...state.accounts.filter(a=>a.provider==="lightsprint"||(native&&a.provider==="generic-bearer-mcp")).map(a=>({provider:"LightSprint",id:a.id,label:a.label})),...ollama.map(a=>({provider:"Ollama",id:a.id,label:a.label})),...cf.map(a=>({provider:"Cloudflare Workers AI",id:a.id,label:a.label}))];
  };
  router.post("/admin/routing/controls",async(req,res)=>{
    if(!sessions.verifyCsrf(res.locals.token,req.body?._csrf))return res.status(403).json({error:"csrf_invalid"});
    try{
      const b=req.body;if(typeof b.expected!=="string"||!["true","false"].includes(b.enabled))throw new Error("invalid");
      if(b.accountId&&!(await knownAccounts()).some(a=>a.id===b.accountId))throw new Error("account");
      const capacity=b.capacity===""||b.capacity===undefined?undefined:Number(b.capacity);
      await rulesStore.patchControls({...(b.pool?{pool:b.pool}:{accountId:b.accountId}),enabled:b.enabled==="true",capacity,expected:b.expected});
      return res.redirect(303,`${res.locals.base}/admin/routing?saved=1`);
    }catch(error){return res.status(error instanceof Error&&error.message.includes("revision")?409:400).type("text").send("Controls were not saved. Refresh this page and check the selected account and worker ceiling.");}
  });
  router.get("/admin/routing", async (req, res) => {
    const [rules, accounts] = await Promise.all([rulesStore.read(), knownAccounts()]);
    const expected=esc(JSON.stringify(rules));
    const controls=`<section class="card full"><h2>Pool dispatch</h2><p>Automatic routing stays enabled inside these limits. Pausing a pool stops new dispatch; monitoring and existing work continue.</p>${["lightsprint","ollama","cloudflare"].map(id=>`<form class="inline" method="post" action="${esc(res.locals.base)}/admin/routing/controls"><input type="hidden" name="expected" value="${expected}"><input type="hidden" name="pool" value="${id}"><input type="hidden" name="enabled" value="${rules.pools?.[id]?.enabled===false}"><button>${rules.pools?.[id]?.enabled===false?"Resume":"Pause"} ${esc(id)} pool</button></form>`).join(" ")}<p><a href="${esc(res.locals.base)}/admin/oracle">Oracle host, model and maintenance controls</a></p></section><section class="card full"><h2>Account worker ceilings</h2><p>A blank ceiling uses the available registered sessions or adapter limit. Raising a ceiling does not create workers or override depleted credentials.</p>${accounts.map(a=>`<form method="post" action="${esc(res.locals.base)}/admin/routing/controls"><input type="hidden" name="expected" value="${expected}"><input type="hidden" name="accountId" value="${esc(a.id)}"><strong>${esc(a.label)}</strong> · ${esc(a.provider)}<label>Allow new work<select name="enabled"><option value="true"${rules.resources[a.id]?.enabled!==false?" selected":""}>Enabled</option><option value="false"${rules.resources[a.id]?.enabled===false?" selected":""}>Paused</option></select></label><label>Maximum concurrent workers<input type="number" name="capacity" min="1" max="1000" placeholder="Automatic" value="${rules.resources[a.id]?.capacity??""}"></label><button>Save account ceiling</button></form>`).join("")}</section>`;
    const accountList = accounts.length ? `<ul>${accounts.map((a) => `<li>${esc(a.provider)} · ${esc(a.label)} · <code>${esc(a.id)}</code></li>`).join("")}</ul>` : "<p>No Ollama or Cloudflare accounts are configured yet.</p>";
    const body = `<main class="wrap">${adminNav(res.locals.base, "routing", navGroups)}<h1>Resource routing</h1>${controls}<p>Rules are persisted locally and apply to future LightSprint dispatch, Cloudflare and Ollama account selection. An account rule may disable an account, set its relative request weight, lower its concurrency ceiling, or restrict inference to exact model IDs.</p><p><strong>Model IDs:</strong> <code>allowedModels</code> is optional. Omit it to preserve existing behavior; set <code>[]</code> to deny all inference through that account, or list exact IDs such as <code>gpt-oss:20b</code> and <code>@cf/meta/llama-3.1-8b-instruct</code>. Wildcards are rejected. For Cloudflare, this adds a restriction alongside the credential's existing model allowlist; it never replaces that allowlist. Model listing endpoints remain available.</p><p><strong>Account capacity is a ceiling:</strong> a configured value is clamped to the adapter's hard per-account limit (Cloudflare ${esc(1)} by default; Ollama ${esc(2)} by default, configurable by the host). This editor cannot raise those limits.</p><p><strong>Scope:</strong> <code>providerCaps</code> is planner metadata only. Live adapters do not enforce a shared provider/group cap because they do not reserve capacity globally across processes.</p><section class="card full"><h2>Account IDs</h2>${accountList}</section><section class="card full"><h2>Editable rules document</h2><form method="post" action="${esc(res.locals.base)}/admin/routing"><label for="routing-rules">JSON rules (version 1)</label><textarea id="routing-rules" name="rules" rows="18" spellcheck="false" autocomplete="off">${esc(JSON.stringify(rules, null, 2))}</textarea><button type="submit">Validate and save</button></form>${req.query.saved === "1" ? '<p role="status">Rules saved.</p>' : ""}</section><section class="card full"><h2>Read-only template</h2><p>Start with this empty rules document; account entries are keyed by the IDs above.</p><pre>${esc(rulesStore.template())}</pre><p>Example account entry: <code>"resources": { "ACCOUNT_ID": { "enabled": false, "weight": 1, "capacity": 1, "allowedModels": ["gpt-oss:20b"] } }</code>. Weights affect request distribution across sequential calls; they are not usage or quota measurements.</p></section></main>`;
    res.type("html").send(page("Resource routing", withCsrf(body, res.locals.csrf)));
  });
  return { router, rules: rulesStore };
}
