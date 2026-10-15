import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import { esc, adminNav, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { ModelCredentialStore } from "./model-credentials.js";
import { CredentialPool } from "./pool.js";
import type { SupervisorBackend } from "./supervisor-api.js";
import { normalizeSupervisorSnapshot } from "./supervisor-ui.js";
import type { StateStore } from "./store.js";
import { redact } from "./telemetry.js";
import { page } from "./ui.js";

const MAX_PROJECTS = 24;
const MAX_ACCOUNTS = 100;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type ResourceAccount = { id: string; label: string; state: string; provider: string; accountId?: string };
type WorkspaceSnapshot = {
  observedAt: number;
  counts: { gateway: number; models: number; cloudflare: number };
  accounts: { gateway: ResourceAccount[]; models: ResourceAccount[]; cloudflare: ResourceAccount[] };
  projects: { id: string; state: string; workers: number | null; jobs: number | null; activeTasks: number | null }[];
};

const safeString = (value: unknown, max = 100): string => typeof value === "string" ? String(redact(value, { maxDepth: 2, maxStringLength: max })) : "Unknown";
const safeState = (value: unknown): string => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9 _-]{0,40}$/.test(value) ? value : "unknown";

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  const nonce = randomBytes(18).toString("base64");
  res.locals.workspaceNonce = nonce;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`);
  next();
}

function workspaceGroups(): readonly NavGroup[] {
  if (NAV_GROUPS.some((group) => group.items.some((item) => item.key === "workspace"))) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => group.label === "Command"
    ? { ...group, items: [...group.items, { key: "workspace", label: "Workspace", href: "/admin/workspace" }] }
    : group);
}

function statusFor(enabled: boolean, cooldownUntil?: number): string {
  if (!enabled) return "disabled";
  if (cooldownUntil && cooldownUntil > Date.now()) return "cooldown";
  return "ready";
}

function boundedSupervisor(raw: unknown): Record<string, unknown> | undefined {
  try {
    const safe = redact(raw, { maxDepth: 8, maxStringLength: 1000, maxKeys: 80, maxArrayItems: 100 });
    const json = JSON.stringify(safe);
    return json && Buffer.byteLength(json) <= MAX_SNAPSHOT_BYTES ? safe as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function createSnapshotReader(store: StateStore, backend?: SupervisorBackend) {
  const pool = new CredentialPool(store);
  const modelStore = new ModelCredentialStore(store);
  const cloudflareStore = new CloudflareCredentialStore(store);
  return async (): Promise<WorkspaceSnapshot> => {
    const state = await store.load();
    const gateway = pool.snapshot(state).slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: safeString(row.provider, 64), state: safeState(row.state) }));
    const modelViews = await modelStore.listCredentials();
    const models = modelViews.slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: "Ollama", state: statusFor(row.enabled, row.cooldownUntil) }));
    const cloudViews = await cloudflareStore.listCredentials();
    const cloudflare = cloudViews.slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: "Cloudflare Workers AI", accountId: safeString(row.accountId, 80), state: statusFor(row.enabled, row.cooldownUntil) }));

    let projects: WorkspaceSnapshot["projects"] = [];
    let ids: string[] = [];
    try { ids = [...new Set((backend?.listProjects?.() ?? []).filter((id) => typeof id === "string" && PROJECT_ID.test(id)))].slice(0, MAX_PROJECTS); } catch { ids = []; }
    if (backend?.readAdmin) {
      for (let offset = 0; offset < ids.length; offset += 3) {
      projects.push(...await Promise.all(ids.slice(offset, offset + 3).map(async (id) => {
        try {
          const safe = boundedSupervisor(await backend.readAdmin!(id));
          if (!safe) return { id, state: "unavailable", workers: null, jobs: null, activeTasks: null };
          const snapshot = normalizeSupervisorSnapshot(safe);
          return { id, state: safeState(snapshot.projectControl?.state ?? snapshot.supervisor?.status ?? snapshot.state),
            workers: Array.isArray(snapshot.workers) ? snapshot.workers.length : null,
            jobs: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : null,
            activeTasks: Number.isSafeInteger(snapshot.projectControl?.activeTaskCount) ? snapshot.projectControl!.activeTaskCount : null };
        } catch { return { id, state: "unavailable", workers: null, jobs: null, activeTasks: null }; }
      })));
      }
    } else {
      projects = ids.map((id) => ({ id, state: "not connected", workers: null, jobs: null, activeTasks: null }));
    }
    return { observedAt: Date.now(), counts: { gateway: state.accounts.length, models: modelViews.length, cloudflare: cloudViews.length }, accounts: { gateway, models, cloudflare }, projects };
  };
}

function listMarkup(kind: keyof WorkspaceSnapshot["accounts"], rows: ResourceAccount[]): string {
  const id = `resource-${kind}`;
  const rowsHtml = rows.length ? rows.map((row) => `<li><span><strong>${esc(row.label)}</strong><small>${esc(row.provider)} · ${esc(row.accountId ?? row.id)}</small></span><b class="cw-state">${esc(row.state)}</b></li>`).join("") : `<li class="cw-empty">No configured accounts.</li>`;
  return `<ul class="cw-list" id="${id}" data-account-list="${kind}">${rowsHtml}</ul>`;
}

function projectMarkup(projects: WorkspaceSnapshot["projects"]): string {
  const rows = projects.length ? projects.map((p) => `<li><span><strong>${esc(p.id)}</strong><small>${p.workers === null ? "Workers unknown" : `${p.workers} workers`} · ${p.jobs === null ? "Jobs unknown" : `${p.jobs} jobs`}</small></span><b class="cw-state">${esc(p.state)}</b></li>`).join("") : `<li class="cw-empty">No supervised projects are configured.</li>`;
  return `<ul class="cw-list" id="supervisor-project-list">${rows}</ul>`;
}

function flowMarkup(snapshot: WorkspaceSnapshot): string {
  const counts = snapshot.counts;
  return `<div class="cw-flow" aria-label="Resource flow from gateway to configured account pools">
  <svg class="cw-flow-wide" viewBox="0 0 760 180" role="img" aria-labelledby="flow-title flow-desc"><title id="flow-title">Gateway resource flow</title><desc id="flow-desc">Gateway routes through the credential pool to the configured MCP, model, and Cloudflare account pools.</desc>
  <path class="cw-edge" d="M180 90h66m-10-8 10 8-10 8M420 90h66m-10-8 10 8-10 8"/>
  <g class="cw-node" data-node-type="gateway"><rect x="10" y="45" width="170" height="90" rx="8"/><text x="95" y="82" text-anchor="middle">ROTOXY gateway</text><text class="cw-node-sub" x="95" y="108" text-anchor="middle">authenticated entry</text></g>
  <g class="cw-node" data-node-type="pool"><rect x="250" y="45" width="170" height="90" rx="8"/><text x="335" y="82" text-anchor="middle">Credential pool</text><text class="cw-node-sub" id="flow-gateway-count" x="335" y="108" text-anchor="middle">${counts.gateway} MCP accounts</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="13" width="250" height="46" rx="7"/><text id="flow-mcp-count" x="510" y="34">MCP · ${counts.gateway} accounts</text><text class="cw-node-sub" x="510" y="51">provider credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="67" width="250" height="46" rx="7"/><text id="flow-models-count" x="510" y="88">Models · ${counts.models} accounts</text><text class="cw-node-sub" x="510" y="105">Ollama credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="121" width="250" height="46" rx="7"/><text id="flow-cloudflare-count" x="510" y="142">Cloudflare · ${counts.cloudflare} accounts</text><text class="cw-node-sub" x="510" y="159">Workers AI credentials</text></g></svg>
  <svg class="cw-flow-mobile" viewBox="0 0 360 440" role="img" aria-labelledby="flow-mobile-title flow-mobile-desc"><title id="flow-mobile-title">Gateway resource flow</title><desc id="flow-mobile-desc">Gateway routes through the credential pool to configured accounts.</desc>
  <path class="cw-edge" d="M180 88v36m-8-10 8 10 8-10M180 208v32m-8-10 8 10 8-10M180 306v25m-8-10 8 10 8-10"/>
  <g class="cw-node" data-node-type="gateway"><rect x="25" y="18" width="310" height="70" rx="8"/><text x="180" y="49" text-anchor="middle">ROTOXY gateway</text><text class="cw-node-sub" x="180" y="72" text-anchor="middle">authenticated entry</text></g>
  <g class="cw-node" data-node-type="pool"><rect x="25" y="138" width="310" height="70" rx="8"/><text x="180" y="169" text-anchor="middle">Credential pool</text><text class="cw-node-sub" id="flow-mobile-gateway-count" x="180" y="192" text-anchor="middle">${counts.gateway} MCP accounts</text></g>
  <g class="cw-node" data-node-type="account"><rect x="25" y="250" width="310" height="56" rx="8"/><text id="flow-mobile-mcp-count" x="45" y="275">MCP · ${counts.gateway} accounts</text><text class="cw-node-sub" x="45" y="296">provider credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="25" y="334" width="310" height="56" rx="8"/><text id="flow-mobile-provider-count" x="45" y="359">Models ${counts.models} · Cloudflare ${counts.cloudflare}</text><text class="cw-node-sub" x="45" y="380">configured model accounts</text></g></svg></div>`;
}

function refreshScript(nonce: string, endpoint: string): string {
  return `<script nonce="${esc(nonce)}">(()=>{const root=document.querySelector("[data-workspace-app]");if(!root)return;const endpoint=root.dataset.snapshotUrl;let busy=false;const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=String(value)};const list=(kind,rows)=>{const el=document.querySelector('[data-account-list="'+kind+'"]');if(!el)return;el.replaceChildren(...rows.map(row=>{const li=document.createElement('li'),wrap=document.createElement('span'),name=document.createElement('strong'),meta=document.createElement('small'),state=document.createElement('b');name.textContent=row.label;meta.textContent=row.provider+' · '+(row.accountId||row.id);state.className='cw-state';state.textContent=row.state;wrap.append(name,meta);li.append(wrap,state);return li}))};const tick=async()=>{if(document.hidden||busy)return;busy=true;try{const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(7000)});if(!response.ok)throw new Error('snapshot_unavailable');const data=await response.json();if(!data||!data.counts||!data.accounts)throw new Error('snapshot_invalid');for(const kind of ['gateway','models','cloudflare']){set('count-'+kind,data.counts[kind]);list(kind,data.accounts[kind]||[])}set('flow-gateway-count',data.counts.gateway+' MCP accounts');set('flow-mobile-gateway-count',data.counts.gateway+' MCP accounts');set('flow-mcp-count','MCP · '+data.counts.gateway+' accounts');set('flow-mobile-mcp-count','MCP · '+data.counts.gateway+' accounts');set('flow-models-count','Models · '+data.counts.models+' accounts');set('flow-cloudflare-count','Cloudflare · '+data.counts.cloudflare+' accounts');set('flow-mobile-provider-count','Models '+data.counts.models+' · Cloudflare '+data.counts.cloudflare);set('workspace-observed',new Date(data.observedAt).toLocaleTimeString());set('workspace-status','Current');if(Array.isArray(data.projects)){const target=document.getElementById('supervisor-project-list');if(target){const rows=data.projects.map(p=>{const li=document.createElement('li'),span=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('b');strong.textContent=p.id;small.textContent=(p.workers===null?'Workers unknown':p.workers+' workers')+' · '+(p.jobs===null?'Jobs unknown':p.jobs+' jobs');state.className='cw-state';state.textContent=p.state;span.append(strong,small);li.append(span,state);return li});target.replaceChildren(...rows)}}}catch{set('workspace-status','Refresh failed; showing last snapshot')}finally{busy=false}};const timer=setInterval(()=>void tick(),10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void tick()});window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});void tick()})()</script>`;
}

function render(snapshot: WorkspaceSnapshot, nonce: string, endpoint: string, base: string, csrf: string): string {
  const body = `<main class="wrap cw-page" data-workspace-app data-snapshot-url="${esc(endpoint)}">${adminNav(base, "workspace", workspaceGroups())}<header class="cw-heading"><div><div class="eyebrow">Command centre</div><h1>Workspace</h1><p>Live map of configured resources and supervised projects. No traffic or inference is inferred here.</p></div><div class="cw-freshness"><span id="workspace-status">Current</span><small>Updated <time id="workspace-observed">${esc(new Date(snapshot.observedAt).toLocaleTimeString())}</time></small><small>Refreshes every 10 seconds while visible</small></div></header><section class="cw-split"><article class="cw-canvas"><div class="cw-section-head"><div><div class="eyebrow">Resource map</div><h2>Connected systems</h2></div><span class="cw-live"><i></i> Snapshot</span></div>${flowMarkup(snapshot)}<details class="cw-projects" open><summary>Supervised projects <span>${snapshot.projects.length}</span></summary>${projectMarkup(snapshot.projects)}</details></article><aside class="cw-ledger" aria-label="Resource ledger"><div class="cw-section-head"><div><div class="eyebrow">Configuration</div><h2>Resource ledger</h2></div></div><p class="cw-note">Account configuration and eligibility only; usage remains unreported here.</p><details open><summary>MCP credentials <span id="count-gateway">${snapshot.counts.gateway}</span></summary>${listMarkup("gateway", snapshot.accounts.gateway)}</details><details open><summary>Model accounts <span id="count-models">${snapshot.counts.models}</span></summary>${listMarkup("models", snapshot.accounts.models)}</details><details open><summary>Cloudflare AI <span id="count-cloudflare">${snapshot.counts.cloudflare}</span></summary>${listMarkup("cloudflare", snapshot.accounts.cloudflare)}</details></aside></section></main><style nonce="${esc(nonce)}">.cw-page{max-width:1500px}.cw-heading{display:flex;justify-content:space-between;gap:18px;align-items:flex-end;padding:18px 0 17px;border-bottom:1px solid var(--line)}.cw-heading h1{margin:5px 0;font-size:clamp(28px,3.2vw,38px);line-height:1.1}.cw-heading p{margin:0;color:var(--muted);font-size:13px}.cw-freshness{display:grid;gap:3px;text-align:right;font-size:12px;color:var(--muted)}#workspace-status{font:600 11px var(--mono);color:var(--signal);text-transform:uppercase;letter-spacing:.06em}.cw-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:clamp(16px,2.5vw,30px);margin-top:18px}.cw-canvas,.cw-ledger{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:16px}.cw-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.cw-section-head h2{margin:3px 0 0;font-size:17px}.cw-live{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted)}.cw-live i{width:7px;height:7px;border-radius:50%;background:var(--signal)}.cw-flow{width:100%}.cw-flow svg{width:100%;height:auto}.cw-flow-mobile{display:none}.cw-node rect{fill:var(--sunk);stroke:var(--line);stroke-width:1.4}.cw-node[data-node-type=gateway] rect{fill:var(--signal-soft);stroke:var(--signal)}.cw-node text{fill:var(--ink);font:600 15px ui-sans-serif,system-ui,sans-serif}.cw-node .cw-node-sub{fill:var(--muted);font:12px ui-sans-serif,system-ui,sans-serif}.cw-edge{fill:none;stroke:var(--signal);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.cw-projects{border-top:1px solid var(--rule);padding-top:12px;margin-top:8px}.cw-projects>summary,.cw-ledger details>summary{display:flex;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;font-weight:630}.cw-projects>summary::-webkit-details-marker,.cw-ledger details>summary::-webkit-details-marker{display:none}.cw-projects>summary span,.cw-ledger details>summary span{font:600 11px var(--mono);color:var(--signal)}.cw-ledger details{padding:11px 0;border-top:1px solid var(--rule)}.cw-note{margin:0 0 6px;color:var(--muted);font-size:12px}.cw-list{list-style:none;padding:7px 0 0;margin:0}.cw-list li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--rule);font-size:12.5px}.cw-list li span{min-width:0;display:grid;overflow-wrap:anywhere}.cw-list li small{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.cw-state{flex:0 0 auto;font:600 11px var(--mono);color:var(--signal);text-transform:uppercase}.cw-empty{font-size:12px;color:var(--muted)}@media(max-width:760px){.cw-heading{align-items:flex-start;flex-direction:column}.cw-freshness{text-align:left}.cw-split{grid-template-columns:minmax(0,1fr)}.cw-flow-wide{display:none}.cw-flow-mobile{display:block}.cw-canvas,.cw-ledger{padding:13px}}@media(prefers-reduced-motion:reduce){.cw-page *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}@media(max-width:390px){.cw-node text{font-size:15px}.cw-page{padding-inline:12px}}</style>${refreshScript(nonce, endpoint)}`;
  return withCsrf(page("Workspace command centre", body), csrf);
}

/** Create the authenticated, read-only workspace command centre and snapshot API. */
export function createCommandWorkspaceRouter(store: StateStore, sessions: AdminSessions, supervisorBackend?: SupervisorBackend) {
  const router = express.Router();
  router.use(["/admin/workspace", "/admin/api/v1/workspace"], securityHeaders);
  const collect = createSnapshotReader(store, supervisorBackend);
  let pending: Promise<WorkspaceSnapshot> | undefined;
  let cached: WorkspaceSnapshot | undefined;
  const readSnapshot = async () => {
    if (cached && Date.now() - cached.observedAt < 5000) return cached;
    if (!pending) pending = collect().then(value => { cached = value; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await store.load();
      const token = parseCookies(req.headers.cookie)["t2o_admin"];
      if (!sessions.valid(token, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
      res.locals.workspaceToken = token;
      res.locals.workspaceCsrf = sessions.csrfToken(token) ?? "";
      res.locals.workspaceBase = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      next();
    } catch { res.status(503).json({ error: "workspace_unavailable" }); }
  };
  router.get("/admin/workspace", authenticate, async (_req, res) => {
    try {
      const snapshot = await readSnapshot();
      const endpoint = `${res.locals.workspaceBase}/admin/api/v1/workspace/snapshot`;
      res.type("html").send(render(snapshot, res.locals.workspaceNonce, endpoint, res.locals.workspaceBase, res.locals.workspaceCsrf));
    } catch { res.status(503).type("html").send("Workspace snapshot unavailable"); }
  });
  router.get("/admin/api/v1/workspace/snapshot", authenticate, async (_req, res) => {
    try {
      const snapshot = await readSnapshot();
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (bytes > MAX_SNAPSHOT_BYTES) return res.status(502).json({ error: "workspace_snapshot_too_large" });
      res.json(snapshot);
    } catch { res.status(503).json({ error: "workspace_snapshot_unavailable" }); }
  });
  return router;
}
