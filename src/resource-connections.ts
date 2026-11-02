import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { AdminSessions, adminEpoch, parseCookies } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import type { StateStore } from "./store.js";
import { validateWebToolsConfig } from "./web-tools-config.js";
import type { PersistedState } from "./types.js";

const PROVIDERS = ["exa", "firecrawl", "tavily", "oracle"] as const;
const TOOLS = ["web_search", "web_extract"] as const;
const FEATURES = ["search", "extract"] as const;
type Provider = typeof PROVIDERS[number];
type Tool = typeof TOOLS[number];
type PrivateConfig = {
  providers: Partial<Record<Provider, { enabled: boolean; accountId?: string; features: Partial<Record<typeof FEATURES[number], "supported" | "unsupported" | "unknown">> }>>;
  permissions: {
    clients: Record<string, Tool[]>;
    /** Owner-selected default for every current and future authenticated OAuth client. */
    authenticatedClients?: Tool[];
  };
};
const emptyConfig = (): PrivateConfig => ({ providers: {}, permissions: { clients: {} } });
const supported: Record<Provider, readonly string[]> = {
  exa: ["search", "extract"], firecrawl: ["search", "extract"], tavily: ["search", "extract"], oracle: ["search", "extract"],
};

function configPath(store: StateStore, configuredPath?: string): string { return configuredPath ?? join(store.dir, "web-tools.json"); }
function ownerUid(): number | undefined { return process.getuid?.(); }

function validateConfig(input: unknown): PrivateConfig {
  return validateWebToolsConfig(input) as PrivateConfig;
}

async function readConfig(store: StateStore, configuredPath?: string): Promise<PrivateConfig> {
  try {
    const path = configPath(store, configuredPath);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (ownerUid() !== undefined && info.uid !== ownerUid()) || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) throw new Error("unavailable");
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyConfig();
    throw new Error("unavailable");
  }
}

async function writeConfig(store: StateStore, config: PrivateConfig, configuredPath?: string): Promise<void> {
  const path = configPath(store, configuredPath);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || (ownerUid() !== undefined && dirInfo.uid !== ownerUid()) || (dirInfo.mode & 0o077) !== 0) throw new Error("unavailable");
  try {
    const old = await lstat(path);
    if (!old.isFile() || old.isSymbolicLink() || (ownerUid() !== undefined && old.uid !== ownerUid()) || (old.mode & 0o077) !== 0 || old.size > 128 * 1024) throw new Error("unavailable");
  } catch (error: any) { if (error?.code !== "ENOENT") throw new Error("unavailable"); }
  const temp = path + ".tmp-" + randomBytes(12).toString("hex");
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  } catch { await unlink(temp).catch(() => undefined); throw new Error("unavailable"); }
}

function accountSummary(state: PersistedState, config: PrivateConfig) {
  return PROVIDERS.map((name) => {
    const binding = config.providers[name];
    const account = state.accounts.find((candidate) => candidate.id === binding?.accountId && candidate.provider === name && candidate.enabled);
    const hasEncryptedKey = Boolean(account?.secret?.v === 1 && account.secret.iv && account.secret.tag && account.secret.data);
    return {
      provider: name,
      status: name === "oracle" ? (binding?.enabled ? "configured" : "not_configured") : hasEncryptedKey ? "connected" : "not_configured",
      account: hasEncryptedKey ? { id: account!.id, label: account!.label } : undefined,
      features: Object.fromEntries(FEATURES.map((feature) => [feature, binding?.features?.[feature] === "supported" && supported[name].includes(feature)])),
    };
  });
}

function payload(state: PersistedState, config: PrivateConfig) {
  return {
    providers: accountSummary(state, config),
    clients: state.oauthClients.map((client) => ({ id: client.clientId, name: client.clientName || "Unnamed client", allowedTools: config.permissions.clients[client.clientId] || [] })),
    authenticatedClientDefaults: config.permissions.authenticatedClients || [],
    credentialStatus: "Stored encrypted credentials are not live provider-verified.",
  };
}

function renderPage(state: PersistedState, config: PrivateConfig, csrf: string): string {
  const base = state.config.publicBaseUrl.replace(/\/$/, "");
  const accounts = (provider: Provider, selected?: string) => state.accounts.filter((a) => a.provider === provider).map((a) => `<option value="${esc(a.id)}"${a.id === selected ? " selected" : ""}${a.enabled ? "" : " disabled"}>${esc(a.label)}${a.enabled ? "" : " · disabled"}</option>`).join("");
  const providerRows = PROVIDERS.map((provider) => {
    const binding = config.providers[provider];
    const current = accountSummary(state, config).find((x) => x.provider === provider)!;
    if (provider === "oracle") return `<fieldset><legend>Oracle search cluster</legend><label><input type="checkbox" name="enabled_oracle" value="1"${binding?.enabled ? " checked" : ""}> Enable private search cluster</label><p class="muted">Uses the gateway’s private token file. Configure nodes in <a href="${esc(base)}/admin/oracle/models">Oracle models</a>; no API key is entered here.</p><div class="row">${FEATURES.map((feature) => `<label><input type="checkbox" name="feature_oracle_${feature}" value="1"${binding?.features?.[feature] === "supported" ? " checked" : ""}> ${feature === "search" ? "Search" : "Extract"}</label>`).join("")}</div></fieldset>`;
    return `<fieldset><legend>${esc(provider)} · ${current.status === "connected" ? "Connected — stored key, not provider-tested" : "Not configured"}</legend><label for="account-${provider}">Encrypted account in the shared account pool</label><select id="account-${provider}" name="account_${provider}"><option value="">Not connected</option>${accounts(provider, binding?.accountId)}</select><div class="row">${FEATURES.map((feature) => `<label><input type="checkbox" name="feature_${provider}_${feature}" value="1"${binding?.features?.[feature] === "supported" ? " checked" : ""}> ${feature === "search" ? "Search" : "Extract"}</label>`).join("")}</div></fieldset>`;
  }).join("");
  const defaults = `<fieldset><legend>Default access for authenticated clients</legend><p class="muted">Applies to every current and future authenticated OAuth client. Turn this off to return to individual client checkboxes only.</p><div class="row">${TOOLS.map((tool) => `<label><input type="checkbox" name="allow_authenticated_${tool}" value="1"${config.permissions.authenticatedClients?.includes(tool) ? " checked" : ""}> ${tool === "web_search" ? "Web search" : "Web extract"}</label>`).join("")}</div></fieldset>`;
  const clients = state.oauthClients.length ? state.oauthClients.map((client) => `<fieldset><legend>${esc(client.clientName || "Unnamed client")}</legend><small>${esc(client.clientId)}</small><div class="row">${TOOLS.map((tool) => `<label><input type="checkbox" name="allow_${esc(client.clientId)}_${tool}" value="1"${config.permissions.clients[client.clientId]?.includes(tool) ? " checked" : ""}> ${tool === "web_search" ? "Web search" : "Web extract"}</label>`).join("")}</div></fieldset>`).join("") : `<p>No OAuth clients are registered yet. The authenticated-client default above will cover future registrations.</p>`;
  const body = `<main class="wrap">${adminNav(new URL(base).pathname.replace(/\/$/, ""), "resources")}<header class="hero"><div class="eyebrow">Connections</div><h1>Providers &amp; search tools</h1><p class="lead">Connect provider-owned API keys, then set one default for all authenticated clients or optional per-client exceptions.</p></header><section class="grid"><div class="card wide"><div class="eyebrow">Search &amp; scraping APIs</div><h2>Add a search account</h2><p class="muted">Keys are encrypted in the existing account pool. Credential entry does not make provider requests. Credit readings are tracked separately from API credentials.</p><form method="post" action="${esc(base)}/admin/resources/accounts"><label for="credential-provider">Provider</label><select id="credential-provider" name="provider">${PROVIDERS.filter((p) => p !== "oracle").map((p) => `<option value="${p}">${p}</option>`).join("")}</select><label for="credential-label">Account label</label><input id="credential-label" name="label" maxlength="120" required><label for="credential-secret">Provider API key</label><input id="credential-secret" name="credential" type="password" autocomplete="new-password" maxlength="4096" required><button type="submit">Encrypt and add account</button></form></div><div class="card wide"><div class="eyebrow">Models &amp; APIs</div><h2>Web search and extraction</h2><p class="muted">Choose one stored key per provider, then set the master access policy once. Individual rows are optional additions, not a required approval ritual.</p><form method="post" action="${esc(base)}/admin/resources/config">${providerRows}<h3>Master access</h3>${defaults}<h3>Individual client additions</h3>${clients}<button type="submit">Save provider and access policy</button></form></div></section><div class="footer">Private mapping: owner-private web-tools.json · keys never appear in this page after submission.</div></main>`;
  return withCsrf(page("Provider connections", body), csrf);
}

export function createResourceConnectionsRouter(store: StateStore, sessions: AdminSessions, options: { configPath?: string } = {}): Router {
  const router = express.Router();
  const safeBody = (parser: express.RequestHandler): express.RequestHandler => (req, res, next) => parser(req, res, (error?: any) => {
    if (error) return res.status(error.status === 413 ? 413 : 400).json({ error: "invalid_request_body" });
    return next();
  });
  const form = safeBody(express.urlencoded({ extended: false, limit: "16kb" }));
  const json = safeBody(express.json({ limit: "16kb" }));
  router.use("/admin", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const authenticated = async (req: Request, res: Response, next: NextFunction) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!sessions.valid(token, adminEpoch(state))) {
      if (req.method === "GET" && req.path === "/resources") return res.redirect(302, state.config.publicBaseUrl.replace(/\/$/, "") + "/admin/login");
      return res.status(401).json({ error: "admin_session_required" });
    }
    res.locals.adminToken = token;
    res.locals.state = state;
    return next();
  };
  const csrf = (req: Request, res: Response, next: NextFunction) => {
    if (!sessions.verifyCsrf(res.locals.adminToken, req.get("x-csrf-token") || req.body?._csrf)) return res.status(403).json({ error: "csrf_required" });
    return next();
  };

  router.get("/admin/resources", authenticated, async (_req, res) => {
    try {
      const config = await readConfig(store, options.configPath);
      return res.type("html").send(renderPage(res.locals.state, config, sessions.csrfToken(res.locals.adminToken) || ""));
    } catch { return res.status(503).type("html").send(withCsrf(page("Search configuration", `<main class="wrap">${adminNav(new URL(res.locals.state.config.publicBaseUrl).pathname.replace(/\/$/, ""), "resources")}<section class="card"><h1>Search configuration needs attention</h1><p>The private configuration could not be read. Check its format, ownership, and permissions with ROTOXY doctor.</p><a href="${esc(res.locals.state.config.publicBaseUrl.replace(/\/$/, ""))}/admin/diagnostics">Open diagnostics</a></section></main>`), sessions.csrfToken(res.locals.adminToken) || "")); }
  });
  router.get("/admin/api/v1/resource-connections", authenticated, async (_req, res) => {
    try { return res.json(payload(res.locals.state, await readConfig(store, options.configPath))); }
    catch { return res.status(503).json({ error: "private_config_unavailable" }); }
  });

  const addAccount = async (req: Request, res: Response) => {
    const provider = String(req.body.provider || "") as Provider;
    const credential = typeof req.body.credential === "string" ? req.body.credential.trim() : "";
    if (!(PROVIDERS as readonly string[]).includes(provider) || provider === "oracle" || !credential || credential.length > 4096) return res.status(400).json({ error: "invalid_provider_credential" });
    try {
      await store.addAccount({ provider, label: String(req.body.label || `${provider} API key`).slice(0, 120), token: credential, metadata: { resource: "web-information" } });
      return req.accepts("html") && !req.is("application/json") ? res.redirect(303, (await store.load()).config.publicBaseUrl.replace(/\/$/, "") + "/admin/resources") : res.status(201).json({ added: true, provider });
    } catch { return res.status(500).json({ error: "provider_credential_save_failed" }); }
  };
  router.post("/admin/resources/accounts", form, authenticated, csrf, addAccount);
  router.post("/admin/api/v1/resource-connections/accounts", json, authenticated, csrf, addAccount);

  const saveConfig = async (req: Request, res: Response) => {
    try {
      const state: PersistedState = res.locals.state;
      const previous = await readConfig(store, options.configPath);
      const providers: PrivateConfig["providers"] = {};
      const oracleTouched = req.body.enabled_oracle !== undefined || req.body.providers?.oracle !== undefined || !req.is("application/json");
      for (const provider of PROVIDERS) {
        if (provider === "oracle") {
          if (!oracleTouched) { if (previous.providers.oracle) providers.oracle = previous.providers.oracle; continue; }
          const enabled = req.body.enabled_oracle === "1" || req.body.providers?.oracle?.enabled === true;
          providers.oracle = { enabled, features: Object.fromEntries(FEATURES.map(feature => [feature,
            req.body[`feature_oracle_${feature}`] === "1" || req.body.providers?.oracle?.features?.[feature] === true ? "supported" : "unsupported"])) };
          continue;
        }
        const accountId = String(req.body[`account_${provider}`] ?? req.body.providers?.[provider]?.accountId ?? "");
        const account = accountId ? state.accounts.find((candidate) => candidate.id === accountId && candidate.provider === provider && candidate.enabled) : undefined;
        if (accountId && !account) return res.status(400).json({ error: "provider_account_mismatch" });
        const selectedFeatures = FEATURES.filter((feature) => req.body[`feature_${provider}_${feature}`] === "1" || req.body.providers?.[provider]?.features?.[feature] === true);
        if (selectedFeatures.some((feature) => !supported[provider].includes(feature))) return res.status(400).json({ error: "unsupported_provider_feature" });
        providers[provider] = { enabled: Boolean(account), accountId: account?.id, features: Object.fromEntries(FEATURES.map((feature) => [feature, selectedFeatures.includes(feature) ? "supported" : "unsupported"])) };
      }
      const clients: Record<string, Tool[]> = {};
      for (const client of state.oauthClients) {
        const selected = TOOLS.filter((tool) => req.body[`allow_${client.clientId}_${tool}`] === "1" || (Array.isArray(req.body.permissions?.clients?.[client.clientId]) && req.body.permissions.clients[client.clientId].includes(tool)));
        if (selected.length) clients[client.clientId] = selected;
      }
      const authenticatedClients = TOOLS.filter((tool) => req.body[`allow_authenticated_${tool}`] === "1" || (Array.isArray(req.body.permissions?.authenticatedClients) && req.body.permissions.authenticatedClients.includes(tool)));
      const config = validateConfig({ providers, permissions: { clients, ...(authenticatedClients.length ? { authenticatedClients } : {}) } });
      await writeConfig(store, config, options.configPath);
      return req.accepts("html") && !req.is("application/json") ? res.redirect(303, state.config.publicBaseUrl.replace(/\/$/, "") + "/admin/resources?saved=1") : res.json({ saved: true, ...payload(state, config) });
    } catch { return res.status(500).json({ error: "private_config_save_failed" }); }
  };
  router.post("/admin/resources/config", form, authenticated, csrf, saveConfig);
  router.post("/admin/api/v1/resource-connections", json, authenticated, csrf, saveConfig);
  return router;
}
