import { CodexProfiles, renderCodexProfilesPage } from "./codex-profiles.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { join } from "node:path";
import { readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import type { StateStore } from "./store.js";
import type { ModelCredentialStore, ModelScope } from "./model-credentials.js";
import { loadOracleOpsSnapshot, renderOracleOpsPage } from "./oracle-ops.js";
import { runtimeStatePath } from "./supervisor-runtime.js";
import { CreditSnapshotStore, listCreditAccounts, summarizeCredits, type CreditAccount } from "./credit-snapshots.js";

export function createControlPlaneAdminRouter(store: StateStore, sessions: AdminSessions, models: ModelCredentialStore, supervisorCwd: string, codex?: CodexProfiles, modelSnapshot?: () => { accounts: Array<{ accountId: string; requests: number; successes: number; failures: number; inflight: number }>; recent: Array<{ accountId: string; path: string; model?: string; durationMs: number; status: number }> }) {
  const router = express.Router();
  router.use(["/admin/models", "/admin/oracle", "/admin/credits", "/admin/codex"], async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const state = await store.load();
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    res.locals.origin = new URL(state.config.publicBaseUrl).origin;
    const token = parseCookies(req.headers.cookie).t2o_admin;
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, base + "/admin/login?next=" + encodeURIComponent(req.originalUrl));
    res.locals.base = base; res.locals.csrf = sessions.csrfToken(token); res.locals.token = token; next();
  });
  router.use("/admin/models", express.urlencoded({ extended: false, limit: "16kb" }));
  router.use("/admin/models", (req, res, next) => {
    if (req.method === "POST" && !sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    next();
  });
  const renderModels = async (res: Response, notice = "") => {
    const base = res.locals.base as string;
    const publicRoot = `${res.locals.origin as string}${base}`;
    const accounts = await models.listCredentials(), tokens = await models.listTokens();
    const metrics = modelSnapshot?.();
    const rows = accounts.map(a => `<tr><td>${esc(a.label)}<br><code>${esc(a.id)}</code></td><td>${a.enabled ? "Enabled" : "Disabled"}${a.cooldownUntil && a.cooldownUntil > Date.now() ? " · Cooling down" : ""}</td><td>${metrics?.accounts.find(x => x.accountId === a.id)?.requests ?? 0} requests since startup</td><td><form method="post" action="${esc(base)}/admin/models/toggle" class="inline"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="enabled" value="${a.enabled ? "0" : "1"}"><button class="secondary">${a.enabled ? "Disable" : "Enable"}</button></form><details><summary>Rename account</summary><form method="post" action="${esc(base)}/admin/models/rename"><input type="hidden" name="id" value="${esc(a.id)}"><label>Label<input name="label" value="${esc(a.label)}" maxlength="80" required></label><button>Save label</button></form></details><details><summary>Rotate key</summary><form method="post" action="${esc(base)}/admin/models/rotate"><input type="hidden" name="id" value="${esc(a.id)}"><label>New API key<input type="password" name="apiKey" required autocomplete="new-password"></label><button>Replace key</button></form></details><form method="post" action="${esc(base)}/admin/models/remove"><input type="hidden" name="id" value="${esc(a.id)}"><button class="secondary">Remove credential</button></form></td></tr>`).join("");
    const tokenRows = tokens.map(t => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.scopes.join(", "))}</td><td>${esc(new Date(t.expiresAt).toISOString())}</td><td><form method="post" action="${esc(base)}/admin/models/revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="secondary">Revoke</button></form></td></tr>`).join("");
    const tokenReference = `<section class="card full"><h2>Provider &amp; agent connection reference</h2><p>All URLs below use the configured public origin and base path. Send an issued token as <code>Authorization: Bearer &lt;client-token&gt;</code>. <code>model:read</code> permits model catalog reads; <code>model:invoke</code> permits inference. These model scopes do not grant MCP tools, workspace access, or admin access. MCP clients use their separate MCP OAuth flow at the canonical endpoint.</p><div class="table-scroll"><table><thead><tr><th>Provider or surface</th><th>Connection URL</th><th>State and model names</th></tr></thead><tbody>
      <tr><td>Unified OpenAI-compatible API</td><td><code>${esc(publicRoot)}/v1</code></td><td>Working when a supported provider is configured. Use <code>ollama/&lt;model&gt;</code>, <code>cloudflare/&lt;model&gt;</code>, <code>openai/&lt;model&gt;</code>, or <code>openrouter/&lt;model&gt;</code>.</td></tr>
      <tr><td>Ollama pinned API</td><td><code>${esc(publicRoot)}/providers/ollama/v1</code></td><td>Working; model names start with <code>ollama/</code>. The legacy Ollama pool API is also at <code>${esc(publicRoot)}/pool/ollama/v1</code>.</td></tr>
      <tr><td>Cloudflare, OpenAI, OpenRouter</td><td><code>${esc(publicRoot)}/providers/cloudflare/v1</code><br><code>${esc(publicRoot)}/providers/openai/v1</code><br><code>${esc(publicRoot)}/providers/openrouter/v1</code></td><td>Working with the respective provider credentials configured; model names use the matching provider prefix.</td></tr>
      <tr><td>Custom OpenAI-compatible provider</td><td><code>${esc(publicRoot)}/providers/custom-&lt;24-char-id&gt;/v1</code></td><td>Working for a configured custom provider ID; model names start with <code>custom-&lt;id&gt;/</code>.</td></tr>
      <tr><td>Claude Messages</td><td><code>${esc(publicRoot)}/providers/claude</code><br>Messages endpoint: <code>${esc(publicRoot)}/providers/claude/v1/messages</code></td><td>Conditional: requires the separately configured Bedrock Messages adapter and credentials. Send Anthropic Messages requests with <code>model:invoke</code>.</td></tr>
      <tr><td>Canonical MCP workspace</td><td><code>${esc(publicRoot)}/mcp</code></td><td>Working through MCP OAuth; client tokens issued above and the admin password do not authenticate MCP clients.</td></tr>
      <tr><td>Codex provider path</td><td><code>${esc(publicRoot)}/providers/codex</code></td><td>Pending; local Codex profiles do not provide inference dispatch on this path.</td></tr>
      <tr><td>Oracle worker inference</td><td><code>${esc(publicRoot)}/providers/oracle</code></td><td>Pending; Oracle worker pool inference is not exposed by the model API.</td></tr>
      <tr><td>LightSprint inference</td><td><code>${esc(publicRoot)}/providers/lightsprint</code></td><td>Unavailable; LightSprint is a workspace provider, not an inference adapter.</td></tr>
      <tr><td>Individual CLI or agent MCP surfaces</td><td>Per-agent configuration</td><td>Pending here; use the canonical <code>/mcp</code> endpoint and MCP OAuth. No per-agent Codex, Oracle, LightSprint, or CLI MCP URL is advertised as working.</td></tr>
      </tbody></table></div><p>Every client-token-protected inference route requires the appropriate <code>model:read</code> or <code>model:invoke</code> scope. Admin password and MCP OAuth credentials are separate.</p></section>`;
    const content = `<main class="wrap">${adminNav(base, "models")}<h1>Models &amp; APIs</h1>${notice}<p class="muted">Ollama Cloud keys rotate within this gateway. Client access uses separate scoped tokens. Account balance and provider capacity remain unknown unless reported.</p><nav aria-label="Model provider settings"><a href="${esc(base)}/admin/inference">OpenAI-compatible providers</a> · <a href="${esc(base)}/admin/cloudflare">Cloudflare Workers AI</a> · <a href="${esc(base)}/admin/bedrock">Amazon Bedrock</a></nav><div class="grid"><section class="card wide"><h2>Ollama Cloud · ${accounts.length} keys</h2><div class="table-scroll"><table><thead><tr><th>Account</th><th>State</th><th>Activity</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No keys connected.</td></tr>'}</tbody></table></div></section><section class="card"><h2>Add model account</h2><form method="post" action="${esc(base)}/admin/models/add"><label>Account label<input name="label" required maxlength="80"></label><label>Ollama API key<input type="password" name="apiKey" required autocomplete="new-password"></label><button>Connect account</button></form></section><section class="card full"><h2>Recent model requests</h2><div class="table-scroll"><table><thead><tr><th>Account</th><th>Route</th><th>Model</th><th>Result</th></tr></thead><tbody>${metrics?.recent.slice(-20).reverse().map(e => `<tr><td>${esc(accounts.find(a => a.id === e.accountId)?.label || e.accountId)}</td><td><code>${esc(e.path)}</code></td><td>${esc(e.model || "Catalog")}</td><td>${e.status} · ${e.durationMs}ms</td></tr>`).join("") || '<tr><td colspan="4">No model requests recorded since startup.</td></tr>'}</tbody></table></div><p>Payload-free, bounded to the last 100 requests in memory. This is not a durable usage or billing ledger.</p></section><section class="card full"><h2>Client tokens</h2><p>OpenAI base URL: <code>${esc(base)}/v1</code> or <code>/pool/ollama/v1</code>. Tokens are shown once and stored as hashes. Your admin password is not a bearer token.</p><table><thead><tr><th>ID</th><th>Scopes</th><th>Expires</th><th>Action</th></tr></thead><tbody>${tokenRows || '<tr><td colspan="4">No tokens issued.</td></tr>'}</tbody></table><form method="post" action="${esc(base)}/admin/models/token"><label>Permission<select name="scope"><option value="read">Read model catalog</option><option value="invoke">Read and invoke models</option></select></label><label>Lifetime<select name="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select></label><button>Issue token</button></form>${tokenReference}</section></div></main>`;
    res.type("html").send(page("Models & APIs", withCsrf(content, res.locals.csrf || "")));
  };
  router.get("/admin/models", (_req, res) => renderModels(res));
  const creditStore = async () => {
    const state = await store.load();
    const native = new URL(state.config.upstreamUrl || "http://invalid.local").hostname === "app.lightsprint.ai";
    const accounts = listCreditAccounts({ accounts: state.accounts.map(a => ({ ...a, provider: native && a.provider === "generic-bearer-mcp" ? "lightsprint" : a.provider })) });
    try {
      const file = join(store.dir, "credit-accounts.json"), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 128 * 1024) throw Error();
      const extra = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(extra) || extra.length > 200) throw Error();
      for (const a of extra) if (["exa", "lightsprint"].includes(a.provider) && typeof a.accountId === "string" && typeof a.label === "string" && a.unit === (a.provider === "exa" ? "USD" : "credits") && true) { const existing = accounts.find(x => x.provider === a.provider && x.accountId === a.accountId); if (existing) existing.label = a.label; else accounts.push(a as CreditAccount); }
    } catch (e: any) { if (e?.code !== "ENOENT") throw Error("credit_registry_unavailable"); }
    return { accounts, ledger: new CreditSnapshotStore(accounts, { directory: store.dir }) };
  };
  router.get("/admin/credits", async (_req, res) => {
    const { accounts, ledger } = await creditStore();
    const creditState = await ledger.load();
    const views = summarizeCredits(accounts, creditState);
    const groups = (["lightsprint", "exa"] as const).map(provider => {
      const rows = views.filter(v => v.account.provider === provider).map(v => {
        const amount = (n: number | null) => n === null ? "Unknown" : v.account.unit === "USD" ? "$" + n.toFixed(2) : n.toLocaleString("en-US");
        const percent = v.estimatedRemaining !== null && v.monthlyAllowance ? Math.min(100, v.estimatedRemaining / v.monthlyAllowance * 100) : undefined;
        return `<tr><td>${esc(v.account.label)}<br><small>${esc(v.account.accountId)}</small></td><td>${amount(v.balanceSnapshot?.remaining ?? null)}<br><small>${v.balanceSnapshot ? esc(new Date(v.balanceSnapshot.observedAt).toISOString()) + " · user/provider snapshot" : "No snapshot"}</small></td><td>${amount(v.estimatedRemaining)}${percent === undefined ? "" : `<progress max="100" value="${percent}"></progress><small>${percent.toFixed(1)}% of configured 10M allowance</small>`}<details><summary>Evidence</summary><p>${esc(v.estimateProvenance)}</p><p>Usage since that reading may be missing. This is not a live balance.</p></details></td><td>${amount(v.reserved + v.inflight)}<br><small>Tracked session increase: $${v.observedSessionSpendUsd.toFixed(4)} USD</small><details><summary>Model cost observations</summary>${(creditState.sessionCosts ?? []).filter(row => row.accountId === v.account.accountId).slice(-20).map(row=>`<p>${esc(row.model ?? "Model unreported")} · $${row.deltaUsd.toFixed(4)} increase · ${esc(new Date(row.observedAt).toISOString())}</p>`).join("") || "No monitored cost readings yet."}<p>First observation is a baseline; later increases are counted once. USD is not converted without a verified rate. Model is reported at observation; attribution may be provisional.</p></details></td><td>${esc(v.balanceSnapshot?.refreshDate || "Unknown")}<br><small>No automatic refill</small></td></tr>`;
      }).join("");
      return `<details class="card full"${provider === "lightsprint" ? " open" : ""}><summary>${provider === "lightsprint" ? "LightSprint" : "Exa Search"} · ${views.filter(v => v.account.provider === provider).length} accounts</summary><div class="table-scroll"><table><thead><tr><th>Account</th><th>Last reading</th><th>Snapshot estimate</th><th>Reserved / in flight</th><th>Refresh date</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }).join("");
    const content = `<main class="wrap">${adminNav(res.locals.base, "credits")}<h1>Credits &amp; quota</h1><p class="muted">Historical readings remain visible with their source and date. Provider balances, native credits, model usage and occupied slots are separate. Exa team records do not imply an API key is connected. LightSprint percentages use a 10M-credit monthly allowance. Fresh user readings replace older baselines; renewal dates alone never reset balances.</p><div class="grid">${groups}<section class="card full"><h2>Record a new reading</h2><form method="post" action="${esc(res.locals.base)}/admin/credits/snapshot"><label>Account<select name="account">${accounts.map((a, i) => `<option value="${esc(a.provider + ":" + a.accountId)}">${esc(a.label)} · ${esc(a.unit)}</option>`).join("")}</select></label><div class="row"><label>Remaining balance<input type="number" min="0" step="any" name="remaining" required></label><label>Refresh date (MM-DD, optional)<input name="refreshDate" placeholder="11-06"></label></div><button>Save user-reported reading</button></form></section></div></main>`;
    return res.type("html").send(page("Credits & quota", withCsrf(content, res.locals.csrf || "")));
  });
  router.post("/admin/credits/snapshot", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    try {
      const { accounts, ledger } = await creditStore();
      const a = accounts.find(a => a.provider + ":" + a.accountId === req.body.account); if (!a || req.body.remaining === "") throw Error();
       await ledger.recordBalanceSnapshot({ auditId: randomUUID(), provider: a.provider, accountId: a.accountId, unit: a.unit, remaining: Number(req.body.remaining), observedAt: Date.now(), source: "user-reported", ...(req.body.refreshDate ? { refreshDate: req.body.refreshDate } : {}) });
      return res.redirect(303, res.locals.base + "/admin/credits");
    } catch { return res.status(400).json({ error: "credit_reading_rejected" }); }
  });
  for (const action of ["add", "rotate", "toggle", "rename", "remove", "revoke", "token"]) router.post("/admin/models/" + action, async (req, res) => {
    try {
      if (action === "add") await models.addCredential(req.body.label, req.body.apiKey);
      if (action === "rotate") await models.rotateCredential(req.body.id, req.body.apiKey);
      if (action === "toggle") { if (!["0", "1"].includes(req.body.enabled)) throw Error(); await models.setCredentialEnabled(req.body.id, req.body.enabled === "1"); }
      if (action === "rename") await models.renameCredential(req.body.id, req.body.label);
      if (action === "remove") await models.removeCredential(req.body.id);
      if (action === "revoke") await models.revokeToken(req.body.id);
      if (action === "token") {
        if (!["read", "invoke"].includes(req.body.scope) || !["1", "7", "30"].includes(req.body.days)) throw Error();
        const scopes: ModelScope[] = req.body.scope === "invoke" ? ["model:read", "model:invoke"] : ["model:read"];
        const issued = await models.issueToken({ scopes, expiresInSeconds: Number(req.body.days) * 86400 });
        return renderModels(res, `<div class="flash"><strong>Save this client token now. It will not be shown again.</strong><pre>${esc(issued.token)}</pre></div>`);
      }
      return res.redirect(303, res.locals.base + "/admin/models");
    } catch { return res.status(400).json({ error: "model_configuration_rejected" }); }
  });
  const renderCodex = async (res: Response, notice = "") => {
    const base = res.locals.base as string;
    const profiles = codex ? await codex.listProfiles() : [];
    const snapshots = codex ? await codex.listSnapshots() : [];
    const quota = snapshots.map(s => `<section class="card"><h2>${esc(profiles.find(p => p.id === s.profileId)?.label || "Profile")} · Reported Codex quota</h2>${s.rateWindows.map(w => `<p>${w.windowDurationMins === 300 ? "Five-hour" : w.windowDurationMins === 10080 ? "Weekly" : w.windowDurationMins ? w.windowDurationMins + " minute" : "Unspecified"} window · ${esc(w.limitId)}: ${w.usedPercent === undefined ? "Unknown usage" : w.usedPercent.toFixed(1) + "% used"}${w.exhausted ? " · reported exhausted" : ""}</p>${w.usedPercent === undefined ? "" : `<progress max="100" value="${Math.min(100, w.usedPercent)}"></progress>`}`).join("") || "No quota windows reported by Codex"}<p>Last refreshed ${esc(new Date(s.capturedAt).toISOString())}. These are client-reported windows, not a live balance or billing ledger.</p></section>`).join("");
    const actions = profiles.map(p => `<fieldset><legend>${esc(p.label)} · ${esc(codex!.getDeviceLoginState(p.id))}</legend><form method="post" action="${esc(base)}/admin/codex/action"><input type="hidden" name="id" value="${esc(p.id)}"><button name="action" value="login">Start ChatGPT device-code sign-in</button> <button class="secondary" name="action" value="refresh">Refresh account, models &amp; quota</button> <button class="secondary" name="action" value="cancel">Cancel device sign-in</button></form></fieldset>`).join("");
    const capability = `<section class="card full"><h2>Worker account capabilities</h2><div class="grid"><section><h3>Local Codex</h3><p>${profiles.length ? `${profiles.length} local profile${profiles.length === 1 ? "" : "s"} registered.` : "No local Codex profiles registered."} A fresh account/model/quota snapshot can inform model-specific eligibility. This page manages sign-in and reports only; it does not start work, select an account, or promise available plan capacity.</p></section><section><h3>Claude</h3><p>No Claude account provider is implemented in this control. No Claude login or Claude quota is represented here; use a separately configured supported upstream account connection.</p></section></div></section>`;
    const localInstructions = `<section class="card full"><h2>Local Codex sign-in setup</h2><ol><li>Install the official Codex CLI on the machine running this local ROTOXY server.</li><li>Configure the server with <code>ROTOXY_CODEX_BINARY</code> set to the absolute path of that trusted executable, then restart ROTOXY.</li><li>Create a profile below, choose <strong>Start ChatGPT device-code sign-in</strong>, and complete the displayed code at <a href="https://auth.openai.com/codex/device" rel="noreferrer">OpenAI device verification</a>.</li><li>Return here and refresh the account, models, and reported quota.</li></ol><p>This is the local/open-source Codex App Server flow. It does not import or read another Codex login. For hosted or commercial apps, use OpenAI's documented <a href="https://developers.openai.com/siwc" rel="noreferrer">Sign in with ChatGPT</a> integration instead; do not extract or transfer tokens.</p><p><a href="https://learn.chatgpt.com/docs/app-server#auth-endpoints" rel="noreferrer">Codex App Server authentication documentation</a></p></section>`;
    const emptyAdapter = `<section class="card full"><h2>Local Codex adapter unavailable</h2><p>To enable this page, configure <code>ROTOXY_CODEX_BINARY</code> on the ROTOXY server with the absolute path to its installed Codex CLI, then restart the server. The executable is configured by the server operator; this page cannot discover or launch a different binary.</p>${localInstructions}</section>`;
    const content = `<main class="wrap">${adminNav(base, "codex")}<h1>ChatGPT &amp; Codex accounts</h1>${notice}<p>Manage local Codex sign-in profiles and inspect the plan, models, and quota windows reported by Codex. Unknown or missing values stay unknown. No account is automatically selected and no agent is launched from this page.</p>${codex ? `${localInstructions}${renderCodexProfilesPage(profiles, snapshots, base)}<div class="grid">${quota}</div><section class="card"><h2>Add a ChatGPT account profile</h2><p>Create a separate local profile first, then start its device-code sign-in.</p><form method="post" action="${esc(base)}/admin/codex/add"><label>Profile label<input name="label" required maxlength="80" placeholder="Personal or work"></label><button>Create profile to sign in</button></form>${actions}</section>${capability}` : `${emptyAdapter}${capability}`}</main>`;
    res.type("html").send(page("ChatGPT & Codex accounts", withCsrf(content, res.locals.csrf || "")));
  };
  router.get("/admin/codex", (_req, res) => renderCodex(res));
  for (const route of ["add", "action"]) router.post("/admin/codex/" + route, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    if (!sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    if (!codex) return res.status(503).json({ error: "codex_not_configured" });
    try {
      if (route === "add") await codex.registerProfile(req.body.label);
      else if (req.body.action === "rename") await codex.renameProfile(req.body.id, req.body.label);
      else if (req.body.action === "remove") await codex.removeProfile(req.body.id);
      else if (req.body.action === "login") {
        const prompt = await codex.startDeviceLogin(req.body.id);
        return renderCodex(res, `<div class="flash"><h2>Complete ChatGPT device-code sign-in</h2><p>Open <a href="${esc(prompt.verificationUrl)}" rel="noreferrer">${esc(prompt.verificationUrl)}</a>, enter this one-time code, and finish sign-in:</p><p><strong>${esc(prompt.userCode)}</strong></p><p>After authorization, return here and select “Refresh account, models &amp; quota.”</p></div>`);
      } else if (req.body.action === "refresh") await codex.refreshProfile(req.body.id);
      else if (req.body.action === "cancel") await codex.cancelDeviceLogin(req.body.id);
      else throw Error();
      return res.redirect(303, res.locals.base + "/admin/codex");
    } catch { return res.status(400).json({ error: "codex_profile_operation_failed" }); }
  });
  router.get("/admin/oracle", async (req, res) => {
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const afterEvent = req.query.afterEvent === undefined ? 0 : Number(req.query.afterEvent);
    try {
      const snapshot = await loadOracleOpsSnapshot({ supervisorCwd, configPath: runtimeStatePath("oracle-pool", "config.json"), dbPath: runtimeStatePath("oracle-pool", "queue.sqlite3") }, { offset, afterEvent });
      return res.type("html").send(page("Oracle workers", withCsrf(renderOracleOpsPage({ base: res.locals.base, snapshot }), res.locals.csrf || "")));
    } catch { return res.status(503).type("html").send(page("Oracle workers", `<main class="wrap">${adminNav(res.locals.base, "oracle")}<h1>Oracle workers</h1><p>Snapshot unavailable. No SSH or inference was triggered by this page.</p></main>`)); }
  });
  return router;
}
