import express from "express";
import type { StateStore } from "./store.js";
import { ModelCredentialStore } from "./model-credentials.js";
import { InferenceProviderStore } from "./inference-providers.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import { AdminSessions, adminEpoch, parseCookies } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { loadWebToolsConfig, validateWebToolsConfig } from "./web-tools-config.js";
import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { page } from "./ui.js";

export interface EndpointEntry {
  id: string; label: string; url: string; protocol: string; authentication: string;
  status: "configured" | "not_configured" | "unavailable";
  operations: string[]; models: string[]; note: string;
}

/** Metadata-only check: inspect owner/private file metadata without reading credential bytes. */
async function privateOracleTokenAvailable(store: StateStore): Promise<boolean> {
  const configuredPath = process.env.ROTOXY_ORACLE_API_TOKEN_FILE;
  const tokenFile = configuredPath ?? join(store.dir, "oracle-api-token");
  try {
    if (!tokenFile.startsWith("/")) return false;
    const info = await lstat(tokenFile);
    return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() &&
      (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 4096;
  } catch { return false; }
}

/** Local metadata only. A configured endpoint is never labelled execution-verified. */
export async function endpointDirectory(store: StateStore, options: { webToolsConfigPath?: string } = {}): Promise<EndpointEntry[]> {
  const state = await store.load();
  const base = state.config.publicBaseUrl.replace(/\/$/, "");
  const rows: EndpointEntry[] = [];
  const add = (id: string, label: string, path: string, protocol: string, authentication: string,
    configured: boolean, operations: string[], models: string[] = [], note = "Configuration only; authentication and execution have not been tested by this listing.") => {
    rows.push({id, label, url: base + path, protocol, authentication, status: configured ? "configured" : "not_configured", operations, models: [...new Set(models)], note});
  };
  add("workspace", "ROTOXY orchestration", "/mcp", "MCP", "OAuth", true, ["tools/list", "tools/call"], [], "Discover authorized resources through workspace_projects and rotoxy_guide. Worker execution depends on configured adapters.");
  const oracleTokenAvailable = await privateOracleTokenAvailable(store);
  let searchConfigured = false;
  try {
    const mapping = options.webToolsConfigPath ?? join(store.dir, "web-tools.json");
    const tools = await loadWebToolsConfig(mapping, store);
    const binding = validateWebToolsConfig(JSON.parse(await readFile(mapping, "utf8"))).providers.oracle;
    searchConfigured = Boolean(tools && binding?.enabled && oracleTokenAvailable);
  } catch { /* An unreadable mapping must not be advertised as configured. */ }
  add("search", "Oracle search", "/search/mcp", "MCP", "OAuth (search resource)", searchConfigured, ["search", "fetch"], [], "Requires enabled Oracle search mapping and client permission as well as the private credential file.");
  const accounts = await new InferenceProviderStore(store).listAccounts();
  const custom = await new InferenceProviderStore(store).listCustomProviders();
  const ollama = await new ModelCredentialStore(store).listCredentials();
  const cloudflare = await new CloudflareCredentialStore(store).listCredentials();
  const infer = (id: string, label: string, configured: boolean, models: string[]) => add(id,label,`/providers/${id}/v1`,"OpenAI-compatible","Scoped model Bearer token",configured,["GET /models","POST /chat/completions"],models);
  infer("ollama", "Ollama pool", ollama.some(a=>a.enabled), []);
  infer("cloudflare", "Cloudflare Workers AI", cloudflare.some(a=>a.enabled), cloudflare.filter(a=>a.enabled).flatMap(a=>a.allowedModels.map(model=>`cloudflare/${model}`)));
  for (const provider of [{id:"openai",label:"OpenAI"},{id:"openrouter",label:"OpenRouter"}, ...custom]) {
    const selected=accounts.filter(a=>a.provider===provider.id && a.enabled);
    infer(provider.id,provider.label,selected.length>0,selected.flatMap(a=>a.allowedModels.map(model=>`${provider.id}/${model}`)));
  }
  infer("oracle","Oracle compute",oracleTokenAvailable,[]);
  add("unified","Unified inference","/v1","OpenAI-compatible","Scoped model Bearer token",ollama.some(a=>a.enabled)||cloudflare.some(a=>a.enabled)||accounts.some(a=>a.enabled),["GET /models","POST /chat/completions"]);
  return rows;
}

export function createEndpointDirectoryRouter(store: StateStore, sessions: AdminSessions, options: { webToolsConfigPath?: string } = {}) {
  const router=express.Router();
  router.get(["/admin/endpoints", "/admin/api/v1/endpoints"], async(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    const state=await store.load();
    const token=parseCookies(req.headers.cookie).t2o_admin;
    if (!sessions.valid(token,adminEpoch(state))) {
      if(req.path.endsWith("/endpoints") && !req.path.includes("/api/")) return res.redirect(302,state.config.publicBaseUrl.replace(/\/$/,"")+"/admin/login");
      return res.status(401).json({error:"admin_session_required"});
    }
    try {
      const entries=await endpointDirectory(store, options);
      if(req.path.includes("/api/")) return res.json({version:1, evidence:"local_metadata", endpoints:entries});
      return res.type("html").send(withCsrf(page("Connections",`<main class="wrap">${adminNav(new URL(state.config.publicBaseUrl).pathname.replace(/\/$/,""),"endpoints")}<header><h1>Connection endpoints</h1><p>Choose a pool or connect to the orchestration workspace. Configuration does not prove successful execution.</p></header><section class="grid">${entries.map(e=>`<article class="card"><h2>${esc(e.label)}</h2><p>${esc(e.protocol)} · ${esc(e.status.replaceAll("_"," "))}</p><label>Endpoint<input readonly aria-label="${esc(e.label)} endpoint" value="${esc(e.url)}" onclick="this.select()"></label><p>${esc(e.authentication)}</p><p>${esc(e.operations.join(" · "))}</p><details><summary>Models and setup</summary><p>${esc(e.models.length ? e.models.join(", ") : "Discover eligible models using this endpoint’s catalog where supported.")}</p><p>${esc(e.note)}</p></details></article>`).join("")}</section></main>`),sessions.csrfToken(token)||""));
    } catch { return res.status(503).json({error:"endpoint_configuration_unavailable"}); }
  });
  return router;
}
