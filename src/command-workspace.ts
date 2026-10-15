import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { CloudflareCredentialStore } from "./cloudflare-ai.js";
import { esc, adminNav, NAV_GROUPS, withCsrf, type NavGroup } from "./html.js";
import { ModelCredentialStore } from "./model-credentials.js";
import { CredentialPool } from "./pool.js";
import type { SupervisorBackend } from "./supervisor-api.js";
import { normalizeSupervisorSnapshot } from "./supervisor-ui.js";
import { loadOracleOpsSnapshot, ORACLE_OPS_HOSTS, ORACLE_OPS_MODELS, type OracleOpsLoaderOptions, type OracleOpsSnapshot } from "./oracle-ops.js";
import { runtimeStatePath } from "./supervisor-runtime.js";
import type { StateStore } from "./store.js";
import { redact } from "./telemetry.js";
import { page } from "./ui.js";

const MAX_PROJECTS = 24;
const MAX_ACCOUNTS = 100;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type ResourceAccount = { id: string; label: string; state: string; provider: string; accountId?: string };
type OracleHostView = { host: string; models: string[]; catalogState: string; lastCatalogCheck: number | null; assignedTasks: number | null; completedTasks: number | null; runningTasks: number | null };
type CodexProfileView = { id: string; label: string; registeredAt: number; state: "unknown" };
type WorkspaceSnapshot = {
  observedAt: number;
  counts: { gateway: number; models: number; cloudflare: number; oracleHosts: number | null; codexProfiles: number | null };
  accounts: { gateway: ResourceAccount[]; models: ResourceAccount[]; cloudflare: ResourceAccount[] };
  oracle: { available: boolean; hosts: OracleHostView[] };
  codex: { state: "available" | "not_configured" | "unavailable"; profiles: CodexProfileView[] };
  projects: { id: string; state: string; workers: number | null; jobs: number | null; activeTasks: number | null }[];
};

export type CommandWorkspaceDependencies = {
  /** Test seam; production uses the validated, bounded read-only Python snapshot helper. */
  loadOracleSnapshot?: (options: OracleOpsLoaderOptions) => Promise<OracleOpsSnapshot>;
};

const safeString = (value: unknown, max = 100): string => typeof value === "string" ? String(redact(value, { maxDepth: 2, maxStringLength: max })) : "Unknown";
const safeState = (value: unknown): string => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9 _-]{0,40}$/.test(value) ? value : "unknown";
const CODEX_PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

async function readCodexRegistry(store: StateStore): Promise<WorkspaceSnapshot["codex"]> {
  try {
    const directory = await lstat(store.dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o077)) throw new Error("private_directory_invalid");
    const path = join(store.dir, "codex-profiles.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) || info.size > 128 * 1024) throw new Error("private_registry_invalid");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let contents: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || (process.getuid && opened.uid !== process.getuid()) || (opened.mode & 0o077) || opened.size > 128 * 1024 || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("private_registry_changed");
      contents = await handle.readFile("utf8");
    } finally { await handle.close(); }
    if (Buffer.byteLength(contents, "utf8") > 128 * 1024) throw new Error("private_registry_too_large");
    const raw = JSON.parse(contents);
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 16) throw new Error("registry_schema_invalid");
    const profiles: CodexProfileView[] = [];
    const ids = new Set<string>();
    for (const value of raw.profiles) {
      if (!isRecord(value) || typeof value.id !== "string" || !CODEX_PROFILE_ID.test(value.id) || ids.has(value.id) ||
          typeof value.label !== "string" || value.label.length < 1 || value.label.length > 80 ||
          !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 || (value.createdAt as number) > 8_640_000_000_000_000 ||
          !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 || (value.updatedAt as number) > 8_640_000_000_000_000) throw new Error("registry_profile_invalid");
      ids.add(value.id);
      // Registry timestamps describe metadata edits only; only createdAt is surfaced as registration time.
      profiles.push({ id: value.id, label: safeString(value.label, 80), registeredAt: value.createdAt as number, state: "unknown" });
    }
    return { state: "available", profiles };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { state: "not_configured", profiles: [] };
    return { state: "unavailable", profiles: [] };
  }
}

function safeOracleHosts(raw: unknown): { available: boolean; hosts: OracleHostView[] } {
  if (!isRecord(raw) || typeof raw.available !== "boolean" || !Array.isArray(raw.hosts)) return { available: false, hosts: [] };
  const seen = new Set<string>();
  const hosts: OracleHostView[] = [];
  for (const value of raw.hosts) {
    if (!isRecord(value) || typeof value.host !== "string" || !(ORACLE_OPS_HOSTS as readonly string[]).includes(value.host) || seen.has(value.host)) continue;
    seen.add(value.host);
    const catalogState = ["checked", "check_failed", "never_checked", "unknown"].includes(String(value.catalogCheckState)) ? String(value.catalogCheckState) : "unknown";
    const lastCatalogCheck = typeof value.lastCatalogCheck === "number" && Number.isFinite(value.lastCatalogCheck) && value.lastCatalogCheck > 0 && value.lastCatalogCheck <= 8_640_000_000_000 ? value.lastCatalogCheck : null;
    const models = Array.isArray(value.models) ? value.models.filter((model): model is string => typeof model === "string" && (ORACLE_OPS_MODELS as readonly string[]).includes(model)).slice(0, ORACLE_OPS_MODELS.length) : [];
    hosts.push({ host: value.host, models, catalogState, lastCatalogCheck,
      assignedTasks: safeCount(value.assignedTasks), completedTasks: safeCount(value.completedTasks), runningTasks: safeCount(value.runningTasks) });
  }
  return { available: raw.available, hosts };
}

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

function createSnapshotReader(store: StateStore, backend?: SupervisorBackend, dependencies: CommandWorkspaceDependencies = {}) {
  const pool = new CredentialPool(store);
  const modelStore = new ModelCredentialStore(store);
  const cloudflareStore = new CloudflareCredentialStore(store);
  const oracleLoader = dependencies.loadOracleSnapshot ?? loadOracleOpsSnapshot;
  const oraclePaths: OracleOpsLoaderOptions = {
    supervisorCwd: resolve(dirname(fileURLToPath(import.meta.url)), "../supervisor"),
    configPath: runtimeStatePath("oracle-pool", "config.json"),
    dbPath: runtimeStatePath("oracle-pool", "queue.sqlite3"),
  };
  return async (): Promise<WorkspaceSnapshot> => {
    const [state, modelViews, cloudViews, codex, oracleRaw] = await Promise.all([
      store.load(), modelStore.listCredentials(), cloudflareStore.listCredentials(), readCodexRegistry(store),
      oracleLoader(oraclePaths).catch(() => undefined),
    ]);
    const gateway = pool.snapshot(state).slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: safeString(row.provider, 64), state: safeState(row.state) }));
    const models = modelViews.slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: "Ollama", state: statusFor(row.enabled, row.cooldownUntil) }));
    const cloudflare = cloudViews.slice(0, MAX_ACCOUNTS).map((row) => ({ id: safeString(row.id, 100), label: safeString(row.label, 100), provider: "Cloudflare Workers AI", accountId: safeString(row.accountId, 80), state: statusFor(row.enabled, row.cooldownUntil) }));
    const oracle = safeOracleHosts(oracleRaw);

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
    return { observedAt: Date.now(), counts: {
      gateway: state.accounts.length, models: modelViews.length, cloudflare: cloudViews.length,
      oracleHosts: oracle.available ? oracle.hosts.length : null,
      codexProfiles: codex.state === "unavailable" ? null : codex.profiles.length,
    }, accounts: { gateway, models, cloudflare }, oracle, codex, projects };
  };
}

function listMarkup(kind: string, rows: ResourceAccount[], emptyMessage = "No configured entries."): string {
  const id = `resource-${kind}`;
  const rowsHtml = rows.length ? rows.map((row) => `<li><span><strong>${esc(row.label)}</strong><small>${esc(row.provider)} · ${esc(row.accountId ?? row.id)}</small></span><b class="cw-state">${esc(row.state)}</b></li>`).join("") : `<li class="cw-empty">${esc(emptyMessage)}</li>`;
  return `<ul class="cw-list" id="${id}" data-resource-list="${esc(kind)}">${rowsHtml}</ul>`;
}

function oracleRows(snapshot: WorkspaceSnapshot): ResourceAccount[] {
  return snapshot.oracle.hosts.map((host) => ({ id: host.host, label: host.host,
    provider: `Models ${host.models.length ? host.models.join(", ") : snapshot.oracle.available ? "none listed" : "unknown"} · Catalog ${host.catalogState}${host.lastCatalogCheck === null ? "" : ` · ${new Date(host.lastCatalogCheck * 1000).toISOString().slice(0, 10)}`}`,
    state: `Running tasks ${host.runningTasks === null ? "unknown" : host.runningTasks}`, accountId: `Assigned ${host.assignedTasks === null ? "unknown" : host.assignedTasks} · Completed ${host.completedTasks === null ? "unknown" : host.completedTasks}` }));
}

function codexRows(snapshot: WorkspaceSnapshot): ResourceAccount[] {
  return snapshot.codex.profiles.map((profile) => ({ id: profile.id, label: profile.label,
    provider: `Registered ${new Date(profile.registeredAt).toISOString().slice(0, 10)} · Models unknown · Last seen unknown`,
    state: "Worker state unknown", accountId: profile.id }));
}

function projectMarkup(projects: WorkspaceSnapshot["projects"]): string {
  const rows = projects.length ? projects.map((p) => `<li><span><strong>${esc(p.id)}</strong><small>${p.workers === null ? "Workers unknown" : `${p.workers} workers`} · ${p.jobs === null ? "Jobs unknown" : `${p.jobs} jobs`}</small></span><b class="cw-state">${esc(p.state)}</b></li>`).join("") : `<li class="cw-empty">No supervised projects are configured.</li>`;
  return `<ul class="cw-list" id="supervisor-project-list">${rows}</ul>`;
}

function flowMarkup(snapshot: WorkspaceSnapshot, base: string): string {
  const counts = snapshot.counts;
  const oracleCount = counts.oracleHosts === null ? "Unavailable" : `${counts.oracleHosts} hosts`;
  const codexCount = counts.codexProfiles === null ? "Unavailable" : snapshot.codex.state === "not_configured" ? "Not configured" : `${counts.codexProfiles} profiles`;
  const oracleDetail = snapshot.oracle.available ? `${oracleCount} · persisted pool state` : "Unavailable · worker state unknown";
  const codexDetail = snapshot.codex.state === "available" ? `${codexCount} · model and worker state unknown` : snapshot.codex.state === "not_configured" ? codexCount : "Unavailable · profile state unknown";
  return `<div class="cw-flow" aria-label="Resource flow and worker groups">
  <svg class="cw-flow-wide" viewBox="0 0 760 300" role="img" aria-labelledby="flow-title flow-desc"><title id="flow-title">Workspace resource map</title><desc id="flow-desc">Gateway and credential pool alongside the configured providers, Oracle hosts, and isolated Codex profiles. Oracle and Codex nodes link to their detail pages.</desc>
  <path class="cw-edge" d="M180 150h66m-10-8 10 8-10 8M420 150h44M464 36v228M464 36h22M464 90h22M464 144h22M464 198h22M464 252h22"/>
  <g class="cw-node" data-node-type="gateway"><rect x="10" y="105" width="170" height="90" rx="8"/><text x="95" y="142" text-anchor="middle">ROTOXY gateway</text><text class="cw-node-sub" x="95" y="168" text-anchor="middle">authenticated entry</text></g>
  <g class="cw-node" data-node-type="pool"><rect x="250" y="105" width="170" height="90" rx="8"/><text x="335" y="142" text-anchor="middle">Credential pool</text><text class="cw-node-sub" id="flow-gateway-count" x="335" y="168" text-anchor="middle">${counts.gateway} MCP accounts</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="13" width="250" height="46" rx="7"/><text id="flow-mcp-count" x="510" y="34">MCP · ${counts.gateway} accounts</text><text class="cw-node-sub" x="510" y="51">provider credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="67" width="250" height="46" rx="7"/><text id="flow-models-count" x="510" y="88">Models · ${counts.models} accounts</text><text class="cw-node-sub" x="510" y="105">Ollama credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="490" y="121" width="250" height="46" rx="7"/><text id="flow-cloudflare-count" x="510" y="142">Cloudflare · ${counts.cloudflare} accounts</text><text class="cw-node-sub" x="510" y="159">Workers AI credentials</text></g>
  <a href="${esc(base)}/admin/oracle" aria-label="Inspect Oracle operations"><g class="cw-node cw-node-link" data-node-type="oracle"><rect x="490" y="175" width="250" height="46" rx="7"/><text id="flow-oracle-count" x="510" y="196">Oracle · ${esc(oracleCount)}</text><text class="cw-node-sub" id="flow-oracle-detail" x="510" y="213">${esc(oracleDetail)}</text></g></a>
  <a href="${esc(base)}/admin/codex" aria-label="Inspect Codex profiles"><g class="cw-node cw-node-link" data-node-type="codex"><rect x="490" y="229" width="250" height="46" rx="7"/><text id="flow-codex-count" x="510" y="250">Codex · ${esc(codexCount)}</text><text class="cw-node-sub" id="flow-codex-detail" x="510" y="267">${esc(codexDetail)}</text></g></a></svg>
  <svg class="cw-flow-mobile" viewBox="0 0 360 670" role="img" aria-labelledby="flow-mobile-title flow-mobile-desc"><title id="flow-mobile-title">Workspace resource map</title><desc id="flow-mobile-desc">Gateway, credential pool, provider groups, Oracle hosts and Codex profiles. Oracle and Codex nodes link to details.</desc>
  <path class="cw-edge" d="M180 88v40m-8-10 8 10 8-10M180 208v40m-8-10 8 10 8-10M180 304v20m-8-10 8 10 8-10M180 380v20m-8-10 8 10 8-10M180 456v20m-8-10 8 10 8-10M180 532v20m-8-10 8 10 8-10"/>
  <g class="cw-node" data-node-type="gateway"><rect x="25" y="18" width="310" height="70" rx="8"/><text x="180" y="49" text-anchor="middle">ROTOXY gateway</text><text class="cw-node-sub" x="180" y="72" text-anchor="middle">authenticated entry</text></g>
  <g class="cw-node" data-node-type="pool"><rect x="25" y="138" width="310" height="70" rx="8"/><text x="180" y="169" text-anchor="middle">Credential pool</text><text class="cw-node-sub" id="flow-mobile-gateway-count" x="180" y="192" text-anchor="middle">${counts.gateway} MCP accounts</text></g>
  <g class="cw-node" data-node-type="account"><rect x="25" y="250" width="310" height="54" rx="8"/><text id="flow-mobile-mcp-count" x="45" y="274">MCP · ${counts.gateway} accounts</text><text class="cw-node-sub" x="45" y="295">provider credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="25" y="326" width="310" height="54" rx="8"/><text id="flow-mobile-models-count" x="45" y="350">Models · ${counts.models} accounts</text><text class="cw-node-sub" x="45" y="371">Ollama credentials</text></g>
  <g class="cw-node" data-node-type="account"><rect x="25" y="402" width="310" height="54" rx="8"/><text id="flow-mobile-cloudflare-count" x="45" y="426">Cloudflare · ${counts.cloudflare} accounts</text><text class="cw-node-sub" x="45" y="447">Workers AI credentials</text></g>
  <a href="${esc(base)}/admin/oracle" aria-label="Inspect Oracle operations"><g class="cw-node cw-node-link" data-node-type="oracle"><rect x="25" y="478" width="310" height="54" rx="8"/><text id="flow-mobile-oracle-count" x="45" y="502">Oracle · ${esc(oracleCount)}</text><text class="cw-node-sub" id="flow-mobile-oracle-detail" x="45" y="523">${esc(oracleDetail)}</text></g></a>
  <a href="${esc(base)}/admin/codex" aria-label="Inspect Codex profiles"><g class="cw-node cw-node-link" data-node-type="codex"><rect x="25" y="554" width="310" height="54" rx="8"/><text id="flow-mobile-codex-count" x="45" y="578">Codex · ${esc(codexCount)}</text><text class="cw-node-sub" id="flow-mobile-codex-detail" x="45" y="599">${esc(codexDetail)}</text></g></a></svg></div>`;
}

function refreshScript(nonce: string, endpoint: string): string {
  return `<script nonce="${esc(nonce)}">(()=>{const root=document.querySelector("[data-workspace-app]");if(!root)return;const endpoint=root.dataset.snapshotUrl;let busy=false;const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=String(value)};const list=(kind,rows)=>{const el=document.querySelector('[data-resource-list="'+kind+'"]');if(!el)return;el.replaceChildren(...rows.map(row=>{const li=document.createElement('li'),wrap=document.createElement('span'),name=document.createElement('strong'),meta=document.createElement('small'),state=document.createElement('b');name.textContent=row.label;meta.textContent=row.provider+' · '+(row.accountId||row.id);state.className='cw-state';state.textContent=row.state;wrap.append(name,meta);li.append(wrap,state);return li}))};const tick=async()=>{if(document.hidden||busy)return;busy=true;try{const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(7000)});if(!response.ok)throw new Error('snapshot_unavailable');const data=await response.json();if(!data||!data.counts||!data.accounts||!data.oracle||!data.codex)throw new Error('snapshot_invalid');for(const kind of ['gateway','models','cloudflare']){set('count-'+kind,data.counts[kind]);list(kind,data.accounts[kind]||[])}const oracleRows=(data.oracle.hosts||[]).map(h=>({id:h.host,label:h.host,provider:'Models '+(h.models.length?h.models.join(', '):data.oracle.available?'none listed':'unknown')+' · Catalog '+h.catalogState+(h.lastCatalogCheck===null?'':' · '+new Date(h.lastCatalogCheck*1000).toISOString().slice(0,10)),state:'Running tasks '+(h.runningTasks===null?'unknown':h.runningTasks),accountId:'Assigned '+(h.assignedTasks===null?'unknown':h.assignedTasks)+' · Completed '+(h.completedTasks===null?'unknown':h.completedTasks)}));const codexRows=(data.codex.profiles||[]).map(p=>({id:p.id,label:p.label,provider:'Registered '+new Date(p.registeredAt).toISOString().slice(0,10)+' · Models unknown · Last seen unknown',state:'Worker state unknown',accountId:p.id}));list('oracle',oracleRows);list('codex',codexRows);const oracleCount=data.counts.oracleHosts===null?'Unavailable':data.counts.oracleHosts+' hosts';const codexCount=data.counts.codexProfiles===null?'Unavailable':data.codex.state==='not_configured'?'Not configured':data.counts.codexProfiles+' profiles';const oracleDetail=data.oracle.available?'Persisted pool state':'Worker state unknown';set('count-oracle',data.counts.oracleHosts===null?'Unknown':data.counts.oracleHosts);set('count-codex',data.counts.codexProfiles===null?'Unknown':data.counts.codexProfiles);const codexDetail=data.codex.state==='available'?'Model and worker state unknown':data.codex.state==='not_configured'?'No profile registry':'Profile state unknown';for(const id of ['flow-oracle-count','flow-mobile-oracle-count'])set(id,'Oracle · '+oracleCount);for(const id of ['flow-codex-count','flow-mobile-codex-count'])set(id,'Codex · '+codexCount);for(const id of ['flow-oracle-detail','flow-mobile-oracle-detail'])set(id,oracleDetail);for(const id of ['flow-codex-detail','flow-mobile-codex-detail'])set(id,codexDetail);set('flow-gateway-count',data.counts.gateway+' MCP accounts');set('flow-mobile-gateway-count',data.counts.gateway+' MCP accounts');set('flow-mcp-count','MCP · '+data.counts.gateway+' accounts');set('flow-mobile-mcp-count','MCP · '+data.counts.gateway+' accounts');set('flow-models-count','Models · '+data.counts.models+' accounts');set('flow-mobile-models-count','Models · '+data.counts.models+' accounts');set('flow-cloudflare-count','Cloudflare · '+data.counts.cloudflare+' accounts');set('flow-mobile-cloudflare-count','Cloudflare · '+data.counts.cloudflare+' accounts');set('workspace-observed',new Date(data.observedAt).toLocaleTimeString());set('workspace-status','Current');if(Array.isArray(data.projects)){const target=document.getElementById('supervisor-project-list');if(target){const rows=data.projects.map(p=>{const li=document.createElement('li'),span=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),state=document.createElement('b');strong.textContent=p.id;small.textContent=(p.workers===null?'Workers unknown':p.workers+' workers')+' · '+(p.jobs===null?'Jobs unknown':p.jobs+' jobs');state.className='cw-state';state.textContent=p.state;span.append(strong,small);li.append(span,state);return li});target.replaceChildren(...rows)}}}catch{set('workspace-status','Refresh failed; showing last snapshot')}finally{busy=false}};const timer=setInterval(()=>void tick(),10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void tick()});window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});void tick()})()</script>`;
}

function render(snapshot: WorkspaceSnapshot, nonce: string, endpoint: string, base: string, csrf: string): string {
  const oracleCount = snapshot.counts.oracleHosts === null ? "Unknown" : snapshot.counts.oracleHosts;
  const codexCount = snapshot.counts.codexProfiles === null ? "Unknown" : snapshot.counts.codexProfiles;
  const oracleEmpty = snapshot.oracle.available ? "No Oracle host rows in the persisted snapshot." : "Oracle snapshot unavailable; host state is unknown.";
  const codexEmpty = snapshot.codex.state === "not_configured" ? "No isolated Codex profile registry is configured." : snapshot.codex.state === "unavailable" ? "Codex profile registry unavailable." : "No isolated profiles registered.";
  const body = `<main class="wrap cw-page" data-workspace-app data-snapshot-url="${esc(endpoint)}">${adminNav(base, "workspace", workspaceGroups())}<header class="cw-heading"><div><div class="eyebrow">Command centre</div><h1>Workspace</h1><p>Live map of configured resources and supervised projects. No traffic or inference is inferred here.</p></div><div class="cw-freshness"><span id="workspace-status">Current</span><small>Updated <time id="workspace-observed">${esc(new Date(snapshot.observedAt).toLocaleTimeString())}</time></small><small>Refreshes every 10 seconds while visible</small></div></header><section class="cw-split"><article class="cw-canvas"><div class="cw-section-head"><div><div class="eyebrow">Resource map</div><h2>Connected systems</h2></div><span class="cw-live"><i></i> Snapshot</span></div>${flowMarkup(snapshot, base)}<details class="cw-projects" open><summary>Supervised projects <span>${snapshot.projects.length}</span></summary>${projectMarkup(snapshot.projects)}</details></article><aside class="cw-ledger" aria-label="Resource ledger"><div class="cw-section-head"><div><div class="eyebrow">Configuration</div><h2>Resource ledger</h2></div></div><p class="cw-note">Account configuration and eligibility only; usage remains unreported here.</p><details><summary>MCP credentials <span id="count-gateway">${snapshot.counts.gateway}</span></summary>${listMarkup("gateway", snapshot.accounts.gateway)}</details><details><summary>Model accounts <span id="count-models">${snapshot.counts.models}</span></summary>${listMarkup("models", snapshot.accounts.models)}</details><details><summary>Cloudflare AI <span id="count-cloudflare">${snapshot.counts.cloudflare}</span></summary>${listMarkup("cloudflare", snapshot.accounts.cloudflare)}</details><details><summary>Oracle hosts <span id="count-oracle">${oracleCount}</span></summary><p class="cw-note">Persisted task/catalog snapshot only; no SSH checks or model calls.</p>${listMarkup("oracle", oracleRows(snapshot), oracleEmpty)}<a class="cw-inspect" href="${esc(base)}/admin/oracle">Inspect Oracle operations →</a></details><details><summary>Codex profiles <span id="count-codex">${codexCount}</span></summary><p class="cw-note">Private registry metadata only. Models, sign-in, worker state and last seen are unknown.</p>${listMarkup("codex", codexRows(snapshot), codexEmpty)}<a class="cw-inspect" href="${esc(base)}/admin/codex">Inspect Codex profiles →</a></details></aside></section></main><style nonce="${esc(nonce)}">.cw-page{max-width:1500px}.cw-heading{display:flex;justify-content:space-between;gap:18px;align-items:flex-end;padding:18px 0 17px;border-bottom:1px solid var(--line)}.cw-heading h1{margin:5px 0;font-size:clamp(28px,3.2vw,38px);line-height:1.1}.cw-heading p{margin:0;color:var(--muted);font-size:13px}.cw-freshness{display:grid;gap:3px;text-align:right;font-size:12px;color:var(--muted)}#workspace-status{font:600 11px var(--mono);color:var(--signal);text-transform:uppercase;letter-spacing:.06em}.cw-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);align-items:start;gap:clamp(16px,2.5vw,30px);margin-top:18px}.cw-canvas,.cw-ledger{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:16px}.cw-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.cw-section-head h2{margin:3px 0 0;font-size:17px}.cw-live{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted)}.cw-live i{width:7px;height:7px;border-radius:50%;background:var(--signal)}.cw-flow{width:100%}.cw-flow svg{width:100%;height:auto}.cw-flow-mobile{display:none}.cw-node rect{fill:var(--sunk);stroke:var(--line);stroke-width:1.4}.cw-node[data-node-type=gateway] rect{fill:var(--signal-soft);stroke:var(--signal)}.cw-node text{fill:var(--ink);font:600 15px ui-sans-serif,system-ui,sans-serif}.cw-node .cw-node-sub{fill:var(--muted);font:12px ui-sans-serif,system-ui,sans-serif}.cw-node-link{cursor:pointer}.cw-node-link rect{stroke:var(--signal);stroke-dasharray:3 2}.cw-flow a:focus .cw-node rect{stroke-width:3}.cw-edge{fill:none;stroke:var(--signal);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.cw-projects{border-top:1px solid var(--rule);padding-top:12px;margin-top:8px}.cw-projects>summary,.cw-ledger details>summary{display:flex;justify-content:space-between;gap:10px;cursor:pointer;list-style:none;font-weight:630}.cw-projects>summary::-webkit-details-marker,.cw-ledger details>summary::-webkit-details-marker{display:none}.cw-projects>summary span,.cw-ledger details>summary span{font:600 11px var(--mono);color:var(--signal)}.cw-ledger details{padding:11px 0;border-top:1px solid var(--rule)}.cw-note{margin:0 0 6px;color:var(--muted);font-size:12px}.cw-inspect{display:inline-block;margin-top:7px;color:var(--signal);font-size:12px;font-weight:650}.cw-list{list-style:none;padding:7px 0 0;margin:0}.cw-list li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--rule);font-size:12.5px}.cw-list li span{min-width:0;display:grid;overflow-wrap:anywhere}.cw-list li small{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.cw-state{flex:0 0 auto;font:600 11px var(--mono);color:var(--signal);text-transform:uppercase}.cw-empty{font-size:12px;color:var(--muted)}@media(max-width:760px){.cw-heading{align-items:flex-start;flex-direction:column}.cw-freshness{text-align:left}.cw-split{grid-template-columns:minmax(0,1fr)}.cw-flow-wide{display:none}.cw-flow-mobile{display:block}.cw-canvas,.cw-ledger{padding:13px}}@media(prefers-reduced-motion:reduce){.cw-page *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}@media(max-width:390px){.cw-node text{font-size:15px}.cw-page{padding-inline:12px}}</style>${refreshScript(nonce, endpoint)}`;
  return withCsrf(page("Workspace command centre", body), csrf);
}

/** Create the authenticated, read-only workspace command centre and snapshot API. */
export function createCommandWorkspaceRouter(store: StateStore, sessions: AdminSessions, supervisorBackend?: SupervisorBackend, dependencies: CommandWorkspaceDependencies = {}) {
  const router = express.Router();
  router.use(["/admin/workspace", "/admin/api/v1/workspace"], securityHeaders);
  const collect = createSnapshotReader(store, supervisorBackend, dependencies);
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
