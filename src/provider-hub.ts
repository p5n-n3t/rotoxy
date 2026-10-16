import express, { type Router } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { InferenceProviderStore } from "./inference-providers.js";
import { ModelCredentialStore } from "./model-credentials.js";
import type { StateStore } from "./store.js";
import { page } from "./ui.js";

type AccountView = { label: string; enabled: boolean };

function accountSummary(title: string, href: string, rows: readonly AccountView[]): string {
  const enabled = rows.filter((row) => row.enabled).length;
  const labels = rows.slice(0, 3).map((row) => `<span class="ph-account">${esc(row.label)} <small>${row.enabled ? "Enabled" : "Disabled"}</small></span>`).join("");
  const remainder = rows.length > 3 ? `<span class="ph-more">+${rows.length - 3} more</span>` : "";
  return `<div class="ph-count"><strong>${rows.length}</strong><span>stored account${rows.length === 1 ? "" : "s"} · ${enabled} enabled</span></div>${rows.length ? `<div class="ph-accounts" aria-label="Stored ${esc(title)} accounts">${labels}${remainder}</div>` : `<p class="ph-empty">No account metadata stored yet.</p>`}<a class="ph-link" href="${esc(href)}">${rows.length ? "Manage accounts" : "Add an account"} <span aria-hidden="true">→</span></a>`;
}

/** Read-only authenticated directory of model APIs and agent execution setup. */
export function createProviderHubRouter(store: StateStore, sessions: AdminSessions): Router {
  const router = express.Router();
  const inference = new InferenceProviderStore(store);
  const cloudflare = new CloudflareCredentialStore(store);
  const ollama = new ModelCredentialStore(store);

  router.get("/admin/providers", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const state = await store.load();
    const token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) {
      return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

    try {
      // These stores expose credential-free view methods. The directory never
      // decrypts credentials, checks provider reachability, or calls an API.
      const [inferenceViews, cloudflareViews, ollamaViews] = await Promise.all([
        inference.listAccounts(), cloudflare.listCredentials(), ollama.listCredentials(),
      ]);
      const openAiRows = inferenceViews.map(({ label, enabled }) => ({ label, enabled }));
      const cloudflareRows = cloudflareViews.map(({ label, enabled }) => ({ label, enabled }));
      const ollamaRows = ollamaViews.map(({ label, enabled }) => ({ label, enabled }));

      const body = `<main class="wrap ph-page">${adminNav(base, "models")}<header class="ph-heading"><div><p class="eyebrow">Connections</p><h1>Provider hub</h1><p>Choose a model API, an agent client setup, or the private worker fleet. Stored credentials are not a health check.</p></div><span class="ph-readonly">Read-only directory</span></header>
      <section class="ph-family" aria-labelledby="ph-models"><div class="ph-family-head"><div><p class="eyebrow">Inference endpoints</p><h2 id="ph-models">Model APIs</h2></div><p>OpenAI-compatible APIs and hosted inference services</p></div>
        <div class="ph-grid">
          <article class="ph-card"><div class="ph-card-head"><div><h3>OpenAI-compatible providers</h3><p>Configured fixed endpoints: OpenAI and OpenRouter.</p></div><span class="ph-status">Configuration</span></div>${accountSummary("OpenAI-compatible", `${base}/admin/inference`, openAiRows)}</article>
          <article class="ph-card"><div class="ph-card-head"><div><h3>Cloudflare Workers AI</h3><p>Cloudflare-hosted inference through its configured account.</p></div><span class="ph-status">Configuration</span></div>${accountSummary("Cloudflare", `${base}/admin/cloudflare`, cloudflareRows)}</article>
          <article class="ph-card"><div class="ph-card-head"><div><h3>Ollama</h3><p>Configured Ollama accounts and model access tokens.</p></div><span class="ph-status">Configuration</span></div>${accountSummary("Ollama", `${base}/admin/models`, ollamaRows)}</article>
        </div>
      </section>
      <section class="ph-family" aria-labelledby="ph-agents"><div class="ph-family-head"><div><p class="eyebrow">Clients and workers</p><h2 id="ph-agents">Agent execution</h2></div><p>Connect a client or configure a worker using its supported setup.</p></div>
        <div class="ph-agent-list">
          <article class="ph-agent"><div><h3>LightSprint workspace</h3><p>Connect the workspace account used by task agents.</p></div><span class="ph-status">Manual setup</span><a href="${esc(`${base}/admin#accounts`)}">Workspace accounts <span aria-hidden="true">→</span></a></article>
          <article class="ph-agent"><div><h3>Claude Code</h3><p>Configure the ROTOXY remote MCP endpoint in the official client and complete its sign-in flow.</p></div><span class="ph-status">Manual setup</span><a href="https://code.claude.com/docs/en/mcp" rel="noreferrer">Official MCP setup <span aria-hidden="true">↗</span></a></article>
          <article class="ph-agent"><div><h3>OpenCode</h3><p>OpenCode is an agent client; use its documented provider/client configuration. No model import or login bridge is provided here.</p></div><span class="ph-status">Manual setup</span><a href="https://opencode.ai/docs/agents/" rel="noreferrer">Official agent docs <span aria-hidden="true">↗</span></a></article>
          <article class="ph-agent"><div><h3>Hermes</h3><p>Hermes is an agent/client setup. ROTOXY does not import Hermes models or credentials.</p></div><span class="ph-status">Manual setup</span><a href="https://hermesagent.nousresearch.com/" rel="noreferrer">Official project docs <span aria-hidden="true">↗</span></a></article>
          <article class="ph-agent"><div><h3>Codex</h3><p>Manage local Codex profiles and the account details they report. No worker is launched from this directory.</p></div><span class="ph-status">Configuration</span><a href="${esc(`${base}/admin/codex`)}">Codex profiles <span aria-hidden="true">→</span></a></article>
        </div>
      </section>
      <footer class="ph-footer"><span>Private fleet</span><a href="${esc(`${base}/admin/oracle`)}">Oracle workers and capacity <span aria-hidden="true">→</span></a><small>Counts and labels reflect locally stored metadata only. No provider was contacted.</small></footer>
      </main><style>.ph-page{max-width:1440px}.ph-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:8px 0 18px;border-bottom:1px solid var(--line)}.ph-heading h1{font-size:clamp(30px,4vw,42px);line-height:1.05;margin:5px 0}.ph-heading p:not(.eyebrow){max-width:750px;margin:5px 0;color:var(--muted)}.ph-readonly,.ph-status{display:inline-flex;align-items:center;white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:4px 9px;background:var(--surface);font-size:12px;font-weight:650;color:var(--muted)}.ph-family{padding:20px 0 18px;border-bottom:1px solid var(--line)}.ph-family-head{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:9px}.ph-family-head h2{font-size:22px;margin:3px 0}.ph-family-head>p{margin:0 0 3px;color:var(--muted);font-size:13px}.ph-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 24px}.ph-card{min-width:0;padding:14px 0 12px;border-top:1px solid var(--line)}.ph-card-head{display:flex;align-items:start;justify-content:space-between;gap:10px}.ph-card h3,.ph-agent h3{margin:0;font-size:16px}.ph-card-head p,.ph-agent p{margin:3px 0 0;color:var(--muted);font-size:13px;line-height:1.4}.ph-count{display:flex;align-items:baseline;gap:8px;margin-top:10px}.ph-count strong{font:650 23px/1 var(--mono);font-variant-numeric:tabular-nums}.ph-count span,.ph-empty{color:var(--muted);font-size:12px}.ph-empty{margin:8px 0}.ph-accounts{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.ph-account{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 7px;border-radius:4px;background:var(--sunk);font-size:12px;overflow-wrap:anywhere}.ph-account small{color:var(--muted);font-size:11px}.ph-more{align-self:center;color:var(--muted);font-size:12px}.ph-link{display:inline-flex;gap:7px;margin-top:9px;font-size:13px;font-weight:650;text-decoration:none}.ph-agent-list{border-top:1px solid var(--line)}.ph-agent{display:grid;grid-template-columns:minmax(220px,1.1fr) minmax(120px,.35fr) minmax(190px,.7fr);align-items:center;gap:16px;padding:10px 2px;border-bottom:1px solid var(--rule)}.ph-agent a,.ph-footer a{font-size:13px;font-weight:650;text-decoration:none}.ph-footer{display:grid;grid-template-columns:1fr auto;gap:5px 18px;align-items:center;padding:15px 0}.ph-footer>span{font-size:14px;font-weight:700}.ph-footer small{grid-column:1/-1;color:var(--muted);font-size:12px}@media(max-width:850px){.ph-grid{grid-template-columns:1fr}.ph-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px}.ph-card-head{grid-column:1/-1}.ph-agent{grid-template-columns:minmax(0,1fr) auto;gap:8px 12px}.ph-agent a{grid-column:1/-1}.ph-family-head{align-items:start;flex-direction:column;gap:4px}}@media(max-width:520px){.ph-heading{align-items:start;flex-direction:column;gap:8px}.ph-card{grid-template-columns:1fr}.ph-card-head{align-items:start}.ph-agent{grid-template-columns:1fr}.ph-agent a{grid-column:auto}.ph-footer{grid-template-columns:1fr}.ph-footer small{grid-column:auto}}@media(prefers-reduced-motion:reduce){.ph-page *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}</style>`;
      return res.type("html").send(page("Provider hub", withCsrf(body, sessions.csrfToken(token) ?? "")));
    } catch {
      return res.status(503).type("text").send("Provider metadata is temporarily unavailable.");
    }
  });
  return router;
}
