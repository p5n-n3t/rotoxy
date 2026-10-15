import { CodexProfiles, renderCodexProfilesPage } from "./codex-profiles.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import type { StateStore } from "./store.js";
import type { ModelCredentialStore, ModelScope } from "./model-credentials.js";
import { loadOracleOpsSnapshot, renderOracleOpsPage } from "./oracle-ops.js";
import { CreditSnapshotStore, listCreditAccounts, summarizeCredits, type CreditAccount } from "./credit-snapshots.js";

export function createControlPlaneAdminRouter(store: StateStore, sessions: AdminSessions, models: ModelCredentialStore, supervisorCwd: string, codex?: CodexProfiles, modelSnapshot?: () => { accounts: Array<{ accountId: string; requests: number; successes: number; failures: number; inflight: number }>; recent: Array<{ accountId: string; path: string; model?: string; durationMs: number; status: number }> }) {
  const router = express.Router();
  router.use(["/admin/models", "/admin/oracle", "/admin/credits", "/admin/codex"], async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const state = await store.load();
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
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
    const accounts = await models.listCredentials(), tokens = await models.listTokens();
    const metrics = modelSnapshot?.();
    const rows = accounts.map(a => `<tr><td>${esc(a.label)}<br><code>${esc(a.id)}</code></td><td>${a.enabled ? "Enabled" : "Disabled"}${a.cooldownUntil && a.cooldownUntil > Date.now() ? " · Cooling down" : ""}</td><td>${metrics?.accounts.find(x => x.accountId === a.id)?.requests ?? 0} requests since startup</td><td><form method="post" action="${esc(base)}/admin/models/toggle" class="inline"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="enabled" value="${a.enabled ? "0" : "1"}"><button class="secondary">${a.enabled ? "Disable" : "Enable"}</button></form><details><summary>Rotate key</summary><form method="post" action="${esc(base)}/admin/models/rotate"><input type="hidden" name="id" value="${esc(a.id)}"><label>New API key<input type="password" name="apiKey" required autocomplete="new-password"></label><button>Replace key</button></form></details><form method="post" action="${esc(base)}/admin/models/remove"><input type="hidden" name="id" value="${esc(a.id)}"><button class="secondary">Remove credential</button></form></td></tr>`).join("");
    const tokenRows = tokens.map(t => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.scopes.join(", "))}</td><td>${esc(new Date(t.expiresAt).toISOString())}</td><td><form method="post" action="${esc(base)}/admin/models/revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="secondary">Revoke</button></form></td></tr>`).join("");
    const content = `<main class="wrap">${adminNav(base, "models")}<h1>Models &amp; APIs</h1>${notice}<p class="muted">Ollama Cloud keys rotate within this gateway. Client access uses separate scoped tokens. Account balance and provider capacity remain unknown unless reported.</p><p><a href="${esc(base)}/admin/cloudflare">Manage Cloudflare AI credentials</a></p><div class="grid"><section class="card wide"><h2>Ollama Cloud · ${accounts.length} keys</h2><div class="table-scroll"><table><thead><tr><th>Account</th><th>State</th><th>Activity</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No keys connected.</td></tr>'}</tbody></table></div></section><section class="card"><h2>Add model account</h2><form method="post" action="${esc(base)}/admin/models/add"><label>Account label<input name="label" required maxlength="80"></label><label>Ollama API key<input type="password" name="apiKey" required autocomplete="new-password"></label><button>Connect account</button></form></section><section class="card full"><h2>Recent model requests</h2><div class="table-scroll"><table><thead><tr><th>Account</th><th>Route</th><th>Model</th><th>Result</th></tr></thead><tbody>${metrics?.recent.slice(-20).reverse().map(e => `<tr><td>${esc(accounts.find(a => a.id === e.accountId)?.label || e.accountId)}</td><td><code>${esc(e.path)}</code></td><td>${esc(e.model || "Catalog")}</td><td>${e.status} · ${e.durationMs}ms</td></tr>`).join("") || '<tr><td colspan="4">No model requests recorded since startup.</td></tr>'}</tbody></table></div><p>Payload-free, bounded to the last 100 requests in memory. This is not a durable usage or billing ledger.</p></section><section class="card full"><h2>Client tokens</h2><p>OpenAI base URL: <code>${esc(base)}/v1</code> or <code>/pool/ollama/v1</code>. Tokens are shown once and stored as hashes. Your admin password is not a bearer token.</p><table><thead><tr><th>ID</th><th>Scopes</th><th>Expires</th><th>Action</th></tr></thead><tbody>${tokenRows || '<tr><td colspan="4">No tokens issued.</td></tr>'}</tbody></table><form method="post" action="${esc(base)}/admin/models/token"><label>Permission<select name="scope"><option value="read">Read model catalog</option><option value="invoke">Read and invoke models</option></select></label><label>Lifetime<select name="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option></select></label><button>Issue token</button></form></section></div></main>`;
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
    const views = summarizeCredits(accounts, await ledger.load());
    const groups = (["lightsprint", "exa"] as const).map(provider => {
      const rows = views.filter(v => v.account.provider === provider).map(v => {
        const amount = (n: number | null) => n === null ? "Unknown" : v.account.unit === "USD" ? "$" + n.toFixed(2) : n.toLocaleString("en-US");
        const percent = v.estimatedRemaining !== null && v.monthlyAllowance ? Math.min(100, v.estimatedRemaining / v.monthlyAllowance * 100) : undefined;
        return `<tr><td>${esc(v.account.label)}<br><small>${esc(v.account.accountId)}</small></td><td>${amount(v.balanceSnapshot?.remaining ?? null)}<br><small>${v.balanceSnapshot ? esc(new Date(v.balanceSnapshot.observedAt).toISOString()) + " · user/provider snapshot" : "No snapshot"}</small></td><td>${amount(v.estimatedRemaining)}${percent === undefined ? "" : `<progress max="100" value="${percent}"></progress><small>${percent.toFixed(1)}% of configured 10M allowance</small>`}<details><summary>Evidence</summary><p>${esc(v.estimateProvenance)}</p><p>Usage since that reading may be missing. This is not a live balance.</p></details></td><td>${amount(v.reserved + v.inflight)}</td><td>${esc(v.balanceSnapshot?.refreshDate || "Unknown")}<br><small>No automatic refill</small></td></tr>`;
      }).join("");
      return `<details class="card full"${provider === "lightsprint" ? " open" : ""}><summary>${provider === "lightsprint" ? "LightSprint" : "Exa Search"} · ${views.filter(v => v.account.provider === provider).length} accounts</summary><div class="table-scroll"><table><thead><tr><th>Account</th><th>Last reading</th><th>Snapshot estimate</th><th>Reserved / in flight</th><th>Refresh date</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }).join("");
    const content = `<main class="wrap">${adminNav(res.locals.base, "credits")}<h1>Credits &amp; quota</h1><p class="muted">Historical readings remain visible with their source and date. Provider balances, native credits, model usage and occupied slots are separate. Exa team records do not imply an API key is connected. Itscommmena and Maryjoebake estimates use your stated 10M allowance and zero usage; those full balances are not provider-verified.</p><div class="grid">${groups}<section class="card full"><h2>Record a new reading</h2><form method="post" action="${esc(res.locals.base)}/admin/credits/snapshot"><label>Account<select name="account">${accounts.map((a, i) => `<option value="${esc(a.provider + ":" + a.accountId)}">${esc(a.label)} · ${esc(a.unit)}</option>`).join("")}</select></label><div class="row"><label>Remaining balance<input type="number" min="0" step="any" name="remaining" required></label><label>Refresh date (MM-DD, optional)<input name="refreshDate" placeholder="11-06"></label></div><button>Save user-reported reading</button></form></section></div></main>`;
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
  for (const action of ["add", "rotate", "toggle", "remove", "revoke", "token"]) router.post("/admin/models/" + action, async (req, res) => {
    try {
      if (action === "add") await models.addCredential(req.body.label, req.body.apiKey);
      if (action === "rotate") await models.rotateCredential(req.body.id, req.body.apiKey);
      if (action === "toggle") { if (!["0", "1"].includes(req.body.enabled)) throw Error(); await models.setCredentialEnabled(req.body.id, req.body.enabled === "1"); }
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
    const quota = snapshots.map(s => `<section class="card"><h2>${esc(profiles.find(p => p.id === s.profileId)?.label || "Profile")} · AI quota</h2>${s.rateWindows.map(w => `<p>${w.windowDurationMins === 300 ? "Five-hour" : w.windowDurationMins === 10080 ? "Weekly" : w.windowDurationMins ? w.windowDurationMins + " minute" : "Unspecified"} window · ${esc(w.limitId)}: ${w.usedPercent === undefined ? "Unknown usage" : w.usedPercent.toFixed(1) + "% used"}</p>${w.usedPercent === undefined ? "" : `<progress max="100" value="${Math.min(100, w.usedPercent)}"></progress>`}`).join("") || "No quota windows reported"}<p>Snapshot ${esc(new Date(s.capturedAt).toISOString())}</p></section>`).join("");
    const actions = profiles.map(p => `<fieldset><legend>${esc(p.label)} · ${esc(codex!.getDeviceLoginState(p.id))}</legend><form method="post" action="${esc(base)}/admin/codex/action"><input type="hidden" name="id" value="${esc(p.id)}"><button name="action" value="login">Sign in with ChatGPT</button> <button class="secondary" name="action" value="refresh">Refresh models &amp; quota</button> <button class="secondary" name="action" value="cancel">Cancel sign-in</button></form></fieldset>`).join("");
    const content = `<main class="wrap">${adminNav(base, "codex")}<h1>Codex subscription profiles</h1>${notice}<p>Official local Codex sign-in, isolated per profile. Entitlements and quota come from the installed client. Account rotation and automatic paid dispatch are not enabled.</p>${codex ? `${renderCodexProfilesPage(profiles, snapshots, base)}<div class="grid">${quota}</div><section class="card"><h2>Connect an account</h2><form method="post" action="${esc(base)}/admin/codex/add"><label>Profile label<input name="label" required maxlength="80"></label><button>Create isolated profile</button></form>${actions}</section>` : '<p>Local Codex adapter is not configured. Set TOKEN2OAUTH_CODEX_BINARY to the trusted absolute Codex executable path.</p>'}</main>`;
    res.type("html").send(page("Codex profiles", withCsrf(content, res.locals.csrf || "")));
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
        return renderCodex(res, `<div class="flash"><p>Complete sign-in at <a href="${esc(prompt.verificationUrl)}" rel="noreferrer">OpenAI device verification</a> using <strong>${esc(prompt.userCode)}</strong>.</p><p>This code is shown once. Return here and refresh models &amp; quota after authorization.</p></div>`);
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
      const snapshot = await loadOracleOpsSnapshot({ supervisorCwd, configPath: join(homedir(), ".local/state/token2oauth/oracle-pool/config.json"), dbPath: join(homedir(), ".local/state/token2oauth/oracle-pool/queue.sqlite3") }, { offset, afterEvent });
      return res.type("html").send(page("Oracle workers", withCsrf(renderOracleOpsPage({ base: res.locals.base, snapshot }), res.locals.csrf || "")));
    } catch { return res.status(503).type("html").send(page("Oracle workers", `<main class="wrap">${adminNav(res.locals.base, "oracle")}<h1>Oracle workers</h1><p>Snapshot unavailable. No SSH or inference was triggered by this page.</p></main>`)); }
  });
  return router;
}
