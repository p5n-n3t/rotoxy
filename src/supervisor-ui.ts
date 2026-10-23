import { redact, redactString } from "./telemetry.js";
import { renderSupervisionInboxScript } from "./admin.js";

export type SupervisorSeverity = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "unknown";
export type SupervisorHealth = { status: string; detail?: string; observedAt?: string | number };
export type SupervisorCapacity = { used?: number; limit?: number; unit?: string };
export type SupervisorUsage = { reportedSessionCostUsd?: number; reportedCostDeltaUsd?: number; promptCountDelta?: number; budgetUsed?: number; maxBudget?: number; fundingSource?: string; sandboxTier?: string; observedAt?: string | number; source?: string; provisional?: boolean; budgetUnit?: string };
export type SupervisorAccountUsage = { reportedCostDeltaUsd?: number; coveredTaskGenerations: number; totalTaskGenerations: number; observedAt?: string | number; source?: string; provisional?: boolean };
export type SupervisorQuestion = { id?: string; text: string; choices?: readonly string[]; source: "provider"; kind: "question" | "review" | "approval" | "unknown" };
export type SupervisorWorker = { id: string; label?: string; workspace?: string; status: string; dispatchStatus?: string; accountId?: string; accountLabel?: string; requestedModel?: string; actualModel?: string; taskId?: string; taskCorrelation?: string; heartbeatAt?: string | number; lastProgressAt?: string | number; monitorState?: string; nextCheckAt?: string | number; model?: string; promptCount?: number; question?: SupervisorQuestion; usage?: SupervisorUsage };
export type SupervisorWorkspace = { id: string; label?: string; workers?: readonly SupervisorWorker[] };
export type SupervisorAccount = { id: string; label: string; status: string; capacity?: SupervisorCapacity; quota?: SupervisorCapacity; usage?: SupervisorAccountUsage; workspaces?: readonly SupervisorWorkspace[] };
export type SupervisorProvider = { id: string; label: string; status: string; accounts?: readonly SupervisorAccount[]; capacity?: SupervisorCapacity; quota?: SupervisorCapacity };
export type SupervisorJob = { id: string; label?: string; status: string; provider?: string; account?: string; workspace?: string; worker?: string; taskId?: string; taskCount?: number; revision?: number; eligibleAccountIds?: readonly string[]; dependencies?: readonly string[]; updatedAt?: string | number };
export type SupervisorTask = { id: string; label?: string; status: string; workspace?: string; worker?: string; accountId?: string; generation?: number; reportedModel?: string; usage?: SupervisorUsage; updatedAt?: string | number };
export type SupervisorEvent = { id?: string; at?: string | number; severity?: SupervisorSeverity | string; source?: string; message?: string; paused?: boolean; raw?: unknown };
export type SupervisorSeries = { label: string; unit?: string; points: readonly { at?: string | number; value: number }[] };

export interface SupervisorSnapshot {
  projectControl?: { projectId: string; state: string; revision: number; maxConcurrency: number; activeTaskCount: number };
  observedAt?: string | number;
  providers?: readonly SupervisorProvider[];
  jobs?: readonly SupervisorJob[];
  tasks?: readonly SupervisorTask[];
  workers?: readonly SupervisorWorker[];
  events?: readonly SupervisorEvent[];
  inbox?: readonly SupervisorEvent[];
  supervisor?: SupervisorHealth;
  orchestrator?: SupervisorHealth;
  series?: readonly SupervisorSeries[];
  state?: "ready" | "loading" | "error";
  error?: string;
}

export interface SupervisorDashboardOptions {
  title?: string;
  search?: string;
  severity?: string;
  pause?: "all" | "paused" | "active";
  maxItems?: number;
  nonce?: string;
  csrfToken?: string;
  liveFeedUrl?: string;
}

const esc = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const css = `:root{color-scheme:light dark;--paper:#f5f3ee;--surface:#fffdf9;--sunk:#ece8df;--ink:#16191d;--muted:#5d636b;--faint:#8a8f96;--line:#dcd6ca;--rule:#e8e3d8;--signal:#0f7b6c;--signal-soft:#dff1ec;--amber:#a85d12;--amber-soft:#fbecd8;--red:#a33a2f;--red-soft:#f8e3df;--focus:#c26a12;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font:15px/1.55 ui-sans-serif,"Inter","Segoe UI",system-ui,-apple-system,sans-serif}
@media(prefers-color-scheme:dark){:root{--paper:#0d0f12;--surface:#14171b;--sunk:#0a0c0e;--ink:#e9e6df;--muted:#a3a7ad;--faint:#7b8087;--line:#2a2f36;--rule:#1f242a;--signal:#4fd1b8;--signal-soft:#123a33;--amber:#f0b25c;--amber-soft:#3a2a12;--red:#f08a7c;--red-soft:#3d1b17;--focus:#f0b25c}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--paper);color:var(--ink)}
a{color:var(--signal)}
h1,h2,h3{font-weight:640;letter-spacing:-.025em}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.rail,.main,.layout>div{min-width:0}
.rail{padding:26px 18px;background:var(--sunk);border-right:1px solid var(--line)}
.brand{display:flex;gap:11px;align-items:center;font-weight:700;font-size:17px;letter-spacing:-.02em}
.brand svg{flex:0 0 auto;width:34px;height:34px;color:var(--ink)}
.brand svg circle,.page-mark circle{fill:var(--signal)}
.brand-name{display:block}
.brand small{display:block;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase}
.title-lockup{display:flex;align-items:flex-start;gap:13px;min-width:0}.title-lockup>div{min-width:0;flex:1}.breadcrumb{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:14px}.breadcrumb a{text-decoration:none;font-weight:700}
.page-mark{width:40px;height:40px;flex:0 0 auto;color:var(--ink)}
.rail nav{display:grid;gap:2px;margin:34px 0}
.rail a{padding:8px 10px 8px 12px;border-left:2px solid transparent;text-decoration:none;color:var(--muted);font-size:14px}
.rail a:hover{color:var(--ink)}
.rail a[aria-current=page]{border-left-color:var(--signal);color:var(--ink);font-weight:620}
.rail-note{font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
.main{width:100%;max-width:1480px;min-width:0;padding:34px clamp(18px,4vw,56px) 64px;margin:auto}
.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding-bottom:18px;border-bottom:1px solid var(--line)}
.kicker{color:var(--signal);font:600 11.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}
.top h1{font-size:clamp(26px,3.6vw,40px);line-height:1.08;margin:8px 0 6px}
.muted{color:var(--muted)}
.stamp{font:12px/1.4 var(--mono);text-align:right;color:var(--muted)}
.stamp strong{color:var(--ink);font-weight:600}
.ledger{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:0 0 22px;border-bottom:1px solid var(--line)}
.ledger div{padding:16px 16px 16px 0;border-right:1px solid var(--rule);min-width:0}
.ledger div+div{padding-left:16px}
.ledger div:last-child{border-right:0}
.ledger dt{font:600 11px/1.2 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.ledger dd{margin:6px 0 0;font-size:28px;font-weight:620;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.ledger dd.unknown{font-size:15px;font-weight:500;padding-top:8px}
.ledger dd.attn{color:var(--amber)}
.ledger small{display:block;font-size:12px;font-weight:400;letter-spacing:0;color:var(--muted)}
.ledger-note{margin:-12px 0 22px;font-size:12px;color:var(--muted)}
.health{display:flex;gap:28px;flex-wrap:wrap;margin:0 0 22px}
.health article{display:flex;flex-direction:column;gap:2px;min-width:150px}
.health strong{display:block}
.pill{display:inline-block;border-radius:3px;padding:1px 7px;background:var(--signal-soft);color:var(--signal);font:600 11.5px/1.6 var(--mono)}
.pill.warn{background:var(--amber-soft);color:var(--amber)}
.pill.bad{background:var(--red-soft);color:var(--red)}
.layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:clamp(18px,3vw,40px)}
.ops-nav{display:flex;gap:6px;overflow-x:auto;margin:18px 0 12px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.ops-nav button{flex:0 0 auto;background:transparent;color:var(--muted);border:1px solid transparent;min-height:40px}
.ops-nav button[aria-selected=true]{background:var(--signal-soft);color:var(--signal);border-color:var(--line)}
.ops-panel{min-width:0;padding:8px 0 18px}
.ops-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0 8px}
.ops-kpi{background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:8px 10px;min-width:0}
.ops-kpi span{display:block;color:var(--muted);font:600 10px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.04em}
.ops-kpi strong{display:block;font-size:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.workers-table{min-width:850px}
.worker-name{font-weight:650}
.worker-meta{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.worker-status{white-space:nowrap}
.worker-notice{margin:4px 0;padding:6px 8px;border-left:2px solid var(--amber);background:var(--amber-soft);font-size:12px}
.worker-question td{padding:10px 12px;background:var(--sunk)}
.question-context{font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100ch}
.question-choices{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.question-choices button{min-height:32px;padding:4px 9px;background:var(--surface);color:var(--ink);border-color:var(--line);font-size:12px}
.guidance-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end;max-width:820px}
.guidance-form label{min-width:0;font-size:12px;color:var(--muted)}
.guidance-form textarea{display:block;width:100%;min-height:64px;max-height:160px;resize:vertical;padding:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:4px;font:inherit}
.guidance-form button{min-height:40px;white-space:normal}
.guidance-status{grid-column:1/-1;min-height:1.4em;font-size:12px;color:var(--muted)}
@media(max-width:520px){.guidance-form{grid-template-columns:minmax(0,1fr)}.guidance-form button{width:100%}}
@media(max-width:700px){.workers-table,.workers-table tbody{display:block;min-width:0;width:100%}.workers-table thead{display:none}.workers-table tr:not(.worker-question){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:12px 0;border-bottom:1px solid var(--line)}.workers-table td{display:block;min-width:0;padding:4px 0;border:0}.workers-table tr:not(.worker-question) td::before{display:block;font:600 10px var(--mono);color:var(--muted);margin-bottom:4px}.workers-table tr:not(.worker-question) td:nth-child(1)::before{content:"Worker / session"}.workers-table tr:not(.worker-question) td:nth-child(2)::before{content:"Account"}.workers-table tr:not(.worker-question) td:nth-child(3)::before{content:"State"}.workers-table tr:not(.worker-question) td:nth-child(4)::before{content:"Model"}.workers-table tr:not(.worker-question) td:nth-child(5)::before{content:"Task"}.workers-table tr:not(.worker-question) td:nth-child(6)::before{content:"Monitor"}.worker-question{display:block}.workers-table .worker-question td{padding:10px}.guidance-form{max-width:100%}}
@media(max-width:700px){.ops-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ops-nav{margin-top:10px;gap:2px}.ops-nav button{flex:1;padding:8px;font-size:13px;min-width:0}.ops-panel{padding-top:4px}}
.panel{min-width:0;padding:0 0 26px;margin-bottom:26px;border-bottom:1px solid var(--line)}
.panel h2{font-size:18px;margin:0 0 3px}
.intro{margin:0 0 14px;color:var(--muted);font-size:13px}
.distribution{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:8px 0;background:var(--surface)}
.distribution .distribution{background:transparent;border-style:dashed}
.distribution>summary,details>summary{cursor:pointer}
summary{max-width:100%;overflow-wrap:anywhere}
.distribution{min-width:0}
.provider-title{font-weight:650}
.subtree{margin:8px 0 0 9px;padding-left:12px;border-left:1px solid var(--line)}
.account,.workspace,.worker{padding:9px 0;border-bottom:1px solid var(--rule)}
.account:last-child,.workspace:last-child,.worker:last-child{border-bottom:0}
.line{display:flex;justify-content:space-between;gap:12px;align-items:baseline;min-width:0}
.line>*{min-width:0;overflow-wrap:anywhere}
.small{font-size:13px}
.capacity{margin-top:7px}
.capacity-label{display:flex;justify-content:space-between;gap:10px;font-size:12px}
.meter{height:6px;background:var(--sunk);border-radius:1px;overflow:hidden;margin-top:4px}
.meter span{display:block;height:100%;background:var(--signal)}
.metric{font-variant-numeric:tabular-nums;font-weight:620;font-family:var(--mono)}
.usage-detail{font-size:12px;line-height:1.45;margin-top:4px;min-width:0;overflow-wrap:anywhere}
.usage-detail>div{margin-top:2px}
.account-usage{margin:8px 0;padding:8px 10px;background:var(--sunk);border-left:2px solid var(--line);min-width:0;overflow-wrap:anywhere}
.account-usage p{margin:4px 0 0}
.usage-budget{max-width:100%}
.unknown{color:var(--muted);font-style:italic}
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 8px 9px 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--muted);font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase}
code,pre{font-family:var(--mono);font-size:12px}
code{overflow-wrap:anywhere;color:var(--muted)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;background:var(--sunk);padding:10px;border-radius:4px}
.events{list-style:none;margin:0;padding:0}
.event{padding:11px 0 11px 12px;border-bottom:1px solid var(--rule);border-left:2px solid var(--line)}
.event.warning,.event.notice{border-left-color:var(--amber)}
.event.error,.event.critical{border-left-color:var(--red)}
.event:last-child{border-bottom:0}
.severity{display:inline-block;font:700 10.5px/1.9 var(--mono);letter-spacing:.06em;color:var(--signal)}
.severity.warning,.severity.notice{color:var(--amber)}
.severity.error,.severity.critical{color:var(--red)}
.severity.debug,.severity.unknown{color:var(--faint)}
.event time{font-family:var(--mono)}
.supervision-event,.supervision-model{padding:12px;border:1px solid var(--line);border-radius:5px;background:var(--surface);margin:8px 0;min-width:0;overflow-wrap:anywhere}
.supervision-event h3,.supervision-model h3{font-size:14px;margin:0 0 6px}
.recovery-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px;min-width:0}
.recovery-group{min-width:0;padding:10px;border:1px solid var(--line);border-radius:5px;background:var(--surface)}
.recovery-group h4{font:600 12px/1.4 var(--mono);margin:0 0 8px;color:var(--muted)}
.recovery-group h5{font-size:13px;margin:0 0 6px;overflow-wrap:anywhere}
.recovery-cursor,.recovery-note,.advisory-label{font-size:12px;color:var(--muted)}
.recovery-note{padding:8px 10px;background:var(--signal-soft);border-left:2px solid var(--signal)}
.advisory-result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;padding:8px;background:var(--sunk);font-size:12px}
.advisory-label{font-weight:650;color:var(--signal)}
.supervision-field{font-size:12px;margin-top:3px;overflow-wrap:anywhere}
.supervision-field strong{color:var(--muted);font-weight:600}
.oracle-detail{margin-top:7px;padding:7px 9px;border-left:2px solid var(--signal);background:var(--sunk)}
.supervision-ack{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--muted);margin-top:8px;padding-top:7px;border-top:1px solid var(--rule)}
.event-message{overflow-wrap:anywhere;margin:2px 0}
.oracle{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0;font-size:12px}
.oracle span{font-family:var(--mono);padding:0 6px;border:1px solid var(--line);border-radius:3px;overflow-wrap:anywhere}
.ack{margin-top:6px}
.ack button{min-height:32px;padding:3px 10px;font-size:12.5px}
.filter{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.live-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0;font-size:12px;color:var(--muted)}
.filter label{font-size:12px;color:var(--muted);min-width:0;flex:1 1 145px}
input,select{display:block;width:100%;max-width:100%;min-width:0;min-height:38px;padding:7px 9px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:4px;font:inherit}
button{min-height:38px;max-width:100%;padding:7px 14px;border:1px solid var(--ink);border-radius:4px;background:var(--ink);color:var(--paper);font:inherit;font-weight:620;cursor:pointer}
button:hover{background:var(--signal);border-color:var(--signal)}
button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.empty{padding:16px;color:var(--muted);background:var(--sunk);border-radius:4px;font-size:13.5px}
.bar-chart{display:flex;align-items:end;gap:4px;min-height:110px;padding:14px 0 4px;border-bottom:1px solid var(--line)}
.bar-chart i{display:block;flex:1;min-width:4px;background:var(--signal);opacity:.75;border-radius:1px 1px 0 0}
.chart-note{font-size:12px;color:var(--muted)}
.errorbox{border-left:3px solid var(--red);padding:10px 12px;background:var(--red-soft)}
@media(max-width:850px){.shell{grid-template-columns:minmax(0,1fr)}
.rail{padding:14px 18px;border:0;border-bottom:1px solid var(--line)}
.rail nav{display:flex;width:100%;min-width:0;max-width:100%;overflow-x:auto;overscroll-behavior-inline:contain;margin:12px 0 0}
.rail a{flex:0 0 auto;white-space:nowrap;border-left:0;border-bottom:2px solid transparent}
.rail a[aria-current=page]{border-bottom-color:var(--signal)}
.rail-note{display:none}
.main{padding-top:22px}
.layout{grid-template-columns:1fr}
.health article{flex:1;min-width:140px}
}
@media(max-width:520px){.top{display:block}
.stamp{text-align:left;margin-top:10px}
.ledger{grid-template-columns:repeat(2,minmax(0,1fr))}
.ledger div,.ledger div+div{padding:12px 10px 12px 0;border-right:0;border-bottom:1px solid var(--rule)}
.ledger dd{font-size:23px}
.line{align-items:flex-start}
.subtree{margin-left:4px;padding-left:8px}
.filter{align-items:stretch}
.filter button{flex:1 1 100%}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}
}
`;

/** ROTOXY rotation mark with a supervised node. Stroke uses currentColor. */
export const BRAND_MARK_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M38.5 15.5A17 17 0 1 0 41 24"/><path d="M41 12.5v6h-6"/><path d="M8 24h9"/></g><circle cx="24" cy="24" r="5.2" fill="#0f7b6c"/></svg>`;
/** Favicon: the mark simplified onto a solid tile so it reads at 16px. */
export const BRAND_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#16191d"/><g fill="none" stroke="#f5f3ee" stroke-width="4" stroke-linecap="round"><path d="M37 16A15 15 0 1 0 39 24"/><path d="M39 12v6h-6"/></g><circle cx="24" cy="24" r="5.5" fill="#4fd1b8"/></svg>`;
const faviconHref = `data:image/svg+xml,${encodeURIComponent(BRAND_FAVICON_SVG)}`;

function safeJson(value: unknown): string {
  try { return JSON.stringify(redact(value, { maxDepth: 5, maxStringLength: 1200, maxKeys: 40, maxArrayItems: 30 }), null, 2) ?? "null"; }
  catch { return "[unavailable]"; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded<T>(items: readonly T[] | undefined, max: number): readonly T[] { return (items ?? []).slice(0, max); }
function statePill(status: string): string {
  const c = /error|failed|offline|stopped|blocked/i.test(status) ? "bad" : /pause|warn|degrad|unknown|idle/i.test(status) ? "warn" : "";
  return `<span class="pill ${c}">${esc(status)}</span>`;
}
function capacity(label: string, value?: SupervisorCapacity): string {
  if (!value || !Number.isFinite(value.used) || !Number.isFinite(value.limit) || (value.limit as number) <= 0) return `<div class="capacity"><div class="capacity-label"><span>${esc(label)}</span><span class="unknown">Limit not reported</span></div></div>`;
  const used = value.used as number; const limit = value.limit as number; const pct = Math.min(100, Math.max(0, used / limit * 100));
  const unit = value.unit ? ` ${esc(value.unit)}` : "";
  return `<div class="capacity"><div class="capacity-label"><span>${esc(label)}</span><span class="metric">${esc(used)} / ${esc(limit)}${unit}</span></div><div class="meter" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${esc(limit)}" aria-valuenow="${esc(used)}"><span style="width:${pct.toFixed(2)}%"></span></div></div>`;
}
function money(value: number): string { return `$${value.toFixed(4)} USD`; }
function usageTime(value?: string | number): string {
  if (typeof value === "number") return fmtTime(value * 1000);
  return fmtTime(value);
}
function taskUsage(usage?: SupervisorUsage, reportedModel?: string): string {
  if (!usage) return `${reportedModel ? `<div>Model: <strong>${esc(redactString(reportedModel, 64))}</strong></div>` : ""}<span class="unknown">Usage not reported</span>`;
  const rows: string[] = [];
  if (usage.reportedCostDeltaUsd !== undefined) rows.push(`<div><abbr title="Provider-reported USD increase during this task">Task increase</abbr>: <strong>${esc(money(usage.reportedCostDeltaUsd))}</strong>${usage.provisional ? ` <span class="pill warn">Provisional</span>` : ""}</div>`);
  if (usage.reportedSessionCostUsd !== undefined) rows.push(`<div>Reported session total: <strong>${esc(money(usage.reportedSessionCostUsd))}</strong></div>`);
  if (reportedModel) rows.push(`<div>Model: <strong>${esc(redactString(reportedModel, 64))}</strong></div>`);
  if (usage.promptCountDelta !== undefined) rows.push(`<div>Prompts during task: ${esc(usage.promptCountDelta)}</div>`);
  if (usage.budgetUsed !== undefined && usage.maxBudget !== undefined && usage.maxBudget > 0) {
    const percent = Math.min(100, Math.max(0, usage.budgetUsed / usage.maxBudget * 100));
    rows.push(`<div class="usage-budget"><span>Provider session budget (unit not reported): ${esc(usage.budgetUsed)} / ${esc(usage.maxBudget)}</span><div class="meter" role="meter" aria-label="Provider session budget, unit not reported" aria-valuemin="0" aria-valuemax="${esc(usage.maxBudget)}" aria-valuenow="${esc(usage.budgetUsed)}"><span style="width:${percent.toFixed(2)}%"></span></div></div>`);
  } else if (usage.budgetUsed !== undefined) {
    rows.push(`<div>Provider session budget: ${esc(usage.budgetUsed)} / maximum not reported (unit not reported)</div>`);
  }
  const context = [usage.fundingSource && `Funding: ${redactString(usage.fundingSource, 64)}`, usage.sandboxTier && `Sandbox: ${redactString(usage.sandboxTier, 64)}`, usage.source && `Source: ${usage.source === "lightsprint-session-status" ? "LightSprint session status" : redactString(usage.source, 64)}`, usage.observedAt !== undefined && `Observed ${usageTime(usage.observedAt)}`].filter(Boolean).join(" · ");
  if (context) rows.push(`<div class="muted small">${esc(context)}</div>`);
  return rows.length ? `<div class="usage-detail">${rows.join("")}</div>` : `<span class="unknown">Usage not reported</span>`;
}
function accountUsage(value?: SupervisorAccountUsage): string {
  if (!value || value.totalTaskGenerations === 0) return `<span class="unknown">Usage not reported</span>`;
  const amount = value.reportedCostDeltaUsd === undefined ? "No reported increase" : `Reported USD increase: ${money(value.reportedCostDeltaUsd)}${value.provisional ? " · provisional" : ""}`;
  const source = value.source === "lightsprint-session-status" ? "LightSprint session status" : value.source ? redactString(value.source, 64) : undefined;
  return `<div class="account-usage"><strong>${esc(amount)}</strong><span class="small muted">${esc(value.coveredTaskGenerations)} of ${esc(value.totalTaskGenerations)} task generations with reported cost${source ? ` · ${esc(source)}` : ""}${value.observedAt !== undefined ? ` · observed ${esc(usageTime(value.observedAt))}` : ""}</span><p class="small muted">Remaining quota is not reported; workspace billing may be shared across accounts.</p></div>`;
}
function workforce(providers: readonly SupervisorProvider[], max: number): string {
  if (!providers.length) return `<p class="empty">No provider groups are available.</p>`;
  return bounded(providers, max).map(p => `<details class="distribution"><summary><span class="provider-title">${esc(p.label)}</span> <code>${esc(p.id)}</code> ${statePill(p.status)} <span class="muted small">${(p.accounts ?? []).length} accounts</span></summary><div class="subtree">${capacity("Provider capacity", p.capacity)}${capacity("Provider quota", p.quota)}${bounded(p.accounts, max).map(a=>`<details class="distribution"><summary><span class="provider-title">${esc(a.label)}</span> <code>${esc(a.id)}</code> ${statePill(a.status)}</summary><div class="subtree">${capacity("Account capacity", a.capacity)}${capacity("Account quota", a.quota)}${accountUsage(a.usage)}${bounded(a.workspaces,max).length ? bounded(a.workspaces,max).map(w=>`<details class="distribution"><summary>Workspace ${esc(w.label || w.id)}</summary><div class="subtree">${bounded(w.workers,max).length ? bounded(w.workers,max).map(worker=>`<div class="worker line"><span>${esc(worker.label || worker.id)} <code>${esc(worker.id)}</code>${taskUsage(worker.usage,worker.model)}</span><span>${statePill(worker.status)}</span></div>`).join("") : `<p class="muted small">No workers are assigned.</p>`}</div></details>`).join("") : `<p class="muted small">No workspaces are available.</p>`}</div></details>`).join("") || `<p class="muted small">No accounts are available.</p>`}</div></details>`).join("");
}
function health(name: string, value?: SupervisorHealth): string { return `<article><span class="muted small">${esc(name)}</span><strong data-live-health="${esc(name.toLowerCase())}">${value ? statePill(value.status) : `<span class="unknown">Unknown</span>`}</strong>${value?.detail ? `<span class="small muted">${esc(value.detail)}</span>` : ""}</article>`; }
function fmtTime(value?: string | number): string { if (value === undefined) return "Time unavailable"; if (typeof value === "number") { try { return Number.isFinite(value) ? esc(new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString()) : "Time unavailable"; } catch { return "Time unavailable"; } } return esc(redactString(value, 100)); }
function eventEntries(entries: readonly SupervisorEvent[], options: SupervisorDashboardOptions, max: number): string {
  const q = (options.search || "").trim().toLowerCase(); const severity = (options.severity || "all").toLowerCase(); const pause = options.pause || "all";
  const shown = bounded(entries, max).filter(ev => (!q || `${ev.source ?? ""} ${ev.message ?? ""} ${ev.id ?? ""}`.toLowerCase().includes(q)) && (severity === "all" || (ev.severity ?? "unknown").toLowerCase() === severity) && (pause === "all" || (pause === "paused" ? ev.paused === true : ev.paused !== true)));
  if (!shown.length) return `<p class="empty">No events match these filters.</p>`;
  return `<ol class="events">${shown.map((ev,i)=>{ const level = (ev.severity || "unknown").toLowerCase(); const id = esc(redactString(ev.id || `event-${i+1}`, 160)); return `<li class="event"><div class="line"><span class="severity ${esc(level)}">${esc(level.toUpperCase())}</span><time class="muted small">${fmtTime(ev.at)}</time></div><div class="event-message">${esc(redactString(ev.message || "Event message unavailable", 1200))}</div><div class="muted small">${esc(redactString(ev.source || "Source unavailable", 160))}${ev.paused === undefined ? "" : ` · ${ev.paused ? "Paused" : "Active"}`}</div><details><summary>Show sanitized raw event</summary><pre>${esc(safeJson(ev.raw ?? ev))}</pre></details></li>`;}).join("")}</ol>`;
}

/** Normalize only recognized fields from the trusted, project-scoped backend view. Missing observations stay missing. */
export function normalizeSupervisorSnapshot(input: unknown): SupervisorSnapshot {
  const root = isRecord(input) ? input : {};
  const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord).slice(0, 200) : [];
  const text = (row: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
    return undefined;
  };
  const number = (row: Record<string, unknown>, ...keys: string[]): number | undefined => {
    for (const key of keys) if (typeof row[key] === "number" && Number.isFinite(row[key])) return row[key] as number;
    return undefined;
  };
  const timeValue = (value: unknown): string | number | undefined => typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
  const usageValue = (value: unknown): SupervisorUsage | undefined => {
    if (!isRecord(value)) return undefined;
    const nonnegative = (...keys: string[]): number | undefined => { const v = number(value, ...keys); return v !== undefined && v >= 0 ? v : undefined; };
    const usage: SupervisorUsage = {
      reportedSessionCostUsd: nonnegative("reportedSessionCostUsd"),
      reportedCostDeltaUsd: nonnegative("reportedCostDeltaUsd"),
      promptCountDelta: (() => { const v = nonnegative("promptCountDelta"); return v !== undefined && Number.isInteger(v) ? v : undefined; })(),
      budgetUsed: nonnegative("budgetUsed"),
      maxBudget: (() => { const v = number(value, "maxBudget"); return v !== undefined && v > 0 ? v : undefined; })(),
      fundingSource: typeof value.fundingSource === "string" ? redactString(value.fundingSource, 64) : undefined,
      sandboxTier: typeof value.sandboxTier === "string" ? redactString(value.sandboxTier, 64) : undefined,
      observedAt: timeValue(value.observedAt),
      source: value.source === "lightsprint-session-status" ? value.source : undefined,
      provisional: typeof value.provisional === "boolean" ? value.provisional : undefined,
      budgetUnit: value.budgetUnit === "unknown" ? "unknown" : undefined,
    };
    return Object.values(usage).some(v => v !== undefined) ? usage : undefined;
  };
  const accountUsageValue = (value: unknown): SupervisorAccountUsage | undefined => {
    if (!isRecord(value) || !Number.isInteger(value.coveredTaskGenerations) || Number(value.coveredTaskGenerations) < 0 || !Number.isInteger(value.totalTaskGenerations) || Number(value.totalTaskGenerations) < 0) return undefined;
    const cost = number(value, "reportedCostDeltaUsd");
    return { ...(cost !== undefined && cost >= 0 ? { reportedCostDeltaUsd: cost } : {}), coveredTaskGenerations: Number(value.coveredTaskGenerations), totalTaskGenerations: Number(value.totalTaskGenerations), observedAt: timeValue(value.observedAt), source: value.source === "lightsprint-session-status" ? value.source : undefined, provisional: typeof value.provisional === "boolean" ? value.provisional : undefined };
  };
  const capacityValue = (value: unknown): SupervisorCapacity | undefined => {
    if (!isRecord(value)) return undefined;
    return { used: number(value, "used", "current"), limit: number(value, "limit", "maximum", "total"), unit: text(value, "unit") };
  };
  const questionValue = (value: unknown): SupervisorQuestion | undefined => {
    if (!isRecord(value) || value.source !== "provider" || typeof value.text !== "string" || !value.text.trim()) return undefined;
    const kind = value.kind === "question" || value.kind === "review" || value.kind === "approval" ? value.kind : "unknown";
    const choices = Array.isArray(value.choices) ? value.choices.slice(0, 8).flatMap(choice => typeof choice === "string" && choice.trim() ? [redactString(choice, 240)] : []) : undefined;
    return { ...(typeof value.id === "string" && value.id ? { id: redactString(value.id, 160) } : {}), text: redactString(value.text, 1200), ...(choices?.length ? { choices } : {}), source: "provider", kind };
  };
  const workerRows = (value: unknown): SupervisorWorker[] => rows(value).map(r => ({ id: text(r, "id", "worker_id") || "unknown", label: text(r, "label", "name"), workspace: text(r, "workspace", "workspace_id"), status: text(r, "status", "state") || "unknown", dispatchStatus: text(r, "dispatchStatus"), accountId: text(r, "accountId"), accountLabel: text(r, "accountLabel"), requestedModel: text(r, "requestedModel"), actualModel: text(r, "actualModel"), taskId: text(r, "taskId", "task_id"), taskCorrelation: text(r, "taskCorrelation"), heartbeatAt: timeValue(r.heartbeatAt), lastProgressAt: timeValue(r.lastProgressAt), monitorState: text(r, "monitorState"), nextCheckAt: timeValue(r.nextCheckAt), model: text(r, "model", "modelReported", "reportedModel"), promptCount: (() => { const n = number(r, "promptCount"); return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined; })(), question: questionValue(r.question), usage: usageValue(r.usage) }));
  const providers = rows(root.providers).map((p): SupervisorProvider => ({
    id: text(p, "id", "provider_id") || "unknown", label: text(p, "label", "name", "provider") || "Provider", status: text(p, "status", "state") || "unknown",
    capacity: capacityValue(p.capacity), quota: capacityValue(p.quota),
    accounts: rows(p.accounts).map((a): SupervisorAccount => ({
      id: text(a, "id", "account_id") || "unknown", label: text(a, "label", "name") || "Account", status: text(a, "status", "state") || "unknown",
      capacity: capacityValue(a.capacity), quota: capacityValue(a.quota), usage: accountUsageValue(a.usage),
      workspaces: rows(a.workspaces).map((w): SupervisorWorkspace => ({ id: text(w, "id", "workspace_id") || "unknown", label: text(w, "label", "name"), workers: workerRows(w.workers) })),
    })),
  }));
  const jobRows = (value: unknown): SupervisorJob[] => rows(value).map(r => ({ id: text(r, "id", "job_id") || "unknown", label: text(r, "label", "name", "summary"), status: text(r, "status", "state") || "unknown", provider: text(r, "provider", "provider_id"), account: text(r, "account", "account_id"), workspace: text(r, "workspace", "workspace_id"), worker: text(r, "worker", "worker_id"), taskId: text(r, "taskId", "task_id"), dependencies: Array.isArray(r.dependencies) ? r.dependencies.filter((x): x is string => typeof x === "string").slice(0, 40) : [], updatedAt: timeValue(r.updatedAt ?? r.updated_at) }));
  const assignmentRows = (value: unknown): SupervisorJob[] => rows(value).map(r => {
    const id = text(r, "assignmentId", "id") || "unknown";
    const eligibleAccountIds = Array.isArray(r.eligibleAccountIds) ? r.eligibleAccountIds.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;
    return {
      id,
      label: text(r, "label") || `Assignment ${id}`,
      status: text(r, "state", "status") || "unknown",
      taskCount: number(r, "taskCount", "task_count"),
      revision: number(r, "revision"),
      eligibleAccountIds,
      dependencies: [],
    };
  });
  const taskRows = (value: unknown): SupervisorTask[] => rows(value).map(r => ({ id: text(r, "id", "task_id") || "unknown", label: text(r, "label", "summary", "name"), status: text(r, "status", "state") || "unknown", workspace: text(r, "workspace", "workspace_id"), worker: text(r, "worker", "worker_id"), accountId: text(r, "accountId", "selectedAccountId", "account_id"), generation: number(r, "generation"), reportedModel: text(r, "reportedModel", "modelReported", "model_reported"), usage: usageValue(r.usage), updatedAt: timeValue(r.updatedAt ?? r.updated_at) }));
  const eventRows = (value: unknown): SupervisorEvent[] => rows(value).map(r => { const detail = isRecord(r.data) ? r.data : {}; return { id: text(r, "id", "event_id"), at: timeValue(r.at ?? r.timestamp ?? r.createdAt ?? r.created_at), severity: text(r, "severity", "level") || text(detail, "severity", "level") || "unknown", source: text(r, "source", "kind", "type"), message: text(r, "message", "summary", "reason") || text(detail, "message", "summary", "reason") || "Event detail unavailable", paused: typeof r.paused === "boolean" ? r.paused : typeof detail.paused === "boolean" ? detail.paused : undefined, raw: r }; });
  const healthValue = (value: unknown): SupervisorHealth | undefined => {
    if (typeof value === "string") return { status: value };
    if (!isRecord(value)) return undefined;
    return { status: text(value, "status", "state") || "unknown", detail: text(value, "detail", "message"), observedAt: timeValue(value.observedAt ?? value.observed_at) };
  };
  const state = root.state === "ready" || root.state === "loading" || root.state === "error" ? root.state : undefined;
  const series = rows(root.series).map(r => ({ label: text(r, "label", "name") || "Measured series", unit: text(r, "unit"), points: rows(r.points).flatMap(p => { const value = number(p, "value"); return value === undefined ? [] : [{ at: timeValue(p.at), value }]; }) }));
  return {
    observedAt: timeValue(root.observedAt ?? root.observed_at),
    projectControl: isRecord(root.projectControl) && typeof root.projectControl.projectId === "string" &&
      typeof root.projectControl.state === "string" && Number.isSafeInteger(root.projectControl.revision) &&
      typeof root.projectControl.maxConcurrency === "number" && typeof root.projectControl.activeTaskCount === "number"
      ? root.projectControl as SupervisorSnapshot["projectControl"] : undefined,
    providers: Array.isArray(root.providers) ? providers : undefined,
    jobs: Array.isArray(root.jobs) ? jobRows(root.jobs) : Array.isArray(root.assignments) ? assignmentRows(root.assignments) : undefined,
    tasks: Array.isArray(root.tasks) ? taskRows(root.tasks) : undefined,
    workers: Array.isArray(root.workers) ? workerRows(root.workers) : undefined,
    events: Array.isArray(root.events) ? eventRows(root.events) : undefined,
    inbox: Array.isArray(root.inbox) ? eventRows(root.inbox) : Array.isArray(root.deliveries) ? eventRows(root.deliveries) : undefined,
    supervisor: healthValue(root.supervisor), orchestrator: healthValue(root.orchestrator),
    series: Array.isArray(root.series) ? series : undefined,
    state, error: text(root, "error"),
  };
}

export function renderSupervisorEventFeed(events: readonly SupervisorEvent[], options: SupervisorDashboardOptions = {}): string {
  const max = Math.max(1, Math.min(100, Math.floor(options.maxItems ?? 60)));
  return eventEntries(events, options, max);
}

function supervisorInboxUrl(liveFeedUrl?: string): string | undefined {
  if (!liveFeedUrl) return undefined;
  try {
    const base = "https://token2oauth.invalid";
    const parsed = new URL(liveFeedUrl, base);
    if (parsed.origin !== base || parsed.search || parsed.hash) return undefined;
    const match = parsed.pathname.match(/^(\/(?:[^/]+\/)*admin\/api\/v1\/supervisor\/[^/]+)\/live$/);
    return match ? `${match[1]}/inbox?after=0&limit=20` : undefined;
  } catch { return undefined; }
}

function supervisorProjectId(liveFeedUrl?: string): string | undefined {
  if (!liveFeedUrl) return undefined;
  try {
    const parsed = new URL(liveFeedUrl, "https://token2oauth.invalid");
    if (parsed.origin !== "https://token2oauth.invalid") return undefined;
    const match = parsed.pathname.match(/^\/(?:[^/]+\/)*admin\/api\/v1\/supervisor\/([^/]+)\/live$/);
    return match ? decodeURIComponent(match[1]).slice(0, 160) : undefined;
  } catch { return undefined; }
}

function projectWorkers(snapshot: SupervisorSnapshot): SupervisorWorker[] {
  if (snapshot.workers) return [...snapshot.workers];
  return (snapshot.providers ?? []).flatMap(provider => (provider.accounts ?? []).flatMap(account =>
    (account.workspaces ?? []).flatMap(workspace => (workspace.workers ?? []).map(worker => ({
      ...worker, accountId: worker.accountId ?? account.id, accountLabel: worker.accountLabel ?? account.label,
      workspace: worker.workspace ?? workspace.label ?? workspace.id,
    })))));
}

function supervisorGuidanceBase(liveFeedUrl?: string): string | undefined {
  if (!liveFeedUrl) return undefined;
  try {
    const parsed = new URL(liveFeedUrl, "https://token2oauth.invalid");
    if (parsed.origin !== "https://token2oauth.invalid" || parsed.search || parsed.hash) return undefined;
    const match = parsed.pathname.match(/^(\/(?:[^/]+\/)*admin\/api\/v1\/supervisor\/[^/]+)\/live$/);
    return match ? match[1] : undefined;
  } catch { return undefined; }
}

function workerQuestionRow(worker: SupervisorWorker, guidanceBase?: string, csrfToken?: string): string {
  const question = worker.question;
  if (question) {
    const choices = question.choices?.length ? `<div class="question-choices" aria-label="Reported choices">${question.choices.map(choice => `<span>${esc(choice)}</span>`).join(" · ")}</div>` : "";
    return `<tr class="worker-question"><td colspan="6"><div><span class="pill warn">Provider ${esc(question.kind)}</span> · Prompt count ${worker.promptCount === undefined ? `<span class="unknown">Unknown</span>` : `<code>${esc(worker.promptCount)}</code>`}${question.id ? ` · Question <code>${esc(redactString(question.id, 160))}</code>` : ""}</div><p class="question-context">${esc(redactString(question.text, 1200))}</p>${choices}<p class="worker-notice">${question.kind === "approval" ? "Native approval actions are not supported here; continue through the provider's supported approval flow." : "Answer this parked question in the provider. Its native answer protocol has not been verified; a chat follow-up is not an approval."}</p></td></tr>`;
  }
  if ((worker.monitorState ?? worker.status) !== "idle" || !Number.isSafeInteger(worker.promptCount) || worker.promptCount! < 0) return "";
  return `<tr class="worker-question"><td colspan="6"><details><summary>Send guidance to this idle worker</summary><form class="guidance-form" data-worker-id="${esc(worker.id)}"${guidanceBase ? ` data-guidance-base="${esc(guidanceBase)}"` : ""} data-prompt-count="${esc(worker.promptCount)}"${csrfToken ? ` data-csrf-token="${esc(csrfToken)}"` : ""}><label>Follow-up instruction<textarea name="message" maxlength="2000" required autocomplete="off" aria-label="Follow-up instruction"></textarea></label><button type="submit"${!guidanceBase || !csrfToken ? " disabled" : ""}>Send guidance</button><div class="guidance-status" role="status" aria-live="polite">This may consume provider credits and is subject to dispatch policy. Submission is explicit; polling never sends a reply.</div></form></details></td></tr>`;
}

function workersTable(workers: readonly SupervisorWorker[], max: number, guidanceBase?: string, csrfToken?: string): string {
  const rows = bounded(workers, max);
  if (!rows.length) return `<p class="empty">No registered workers are available for this project.</p>`;
  return `<div class="table-wrap"><table class="workers-table"><thead><tr><th>Worker / session</th><th>Account</th><th>State</th><th>Requested / actual model</th><th>Task correlation</th><th>Monitor</th></tr></thead><tbody>${rows.map(worker => {
    const state = worker.monitorState || worker.status || "unknown";
    const needsHuman = /needs_instructions|waiting_approval|waiting_review/i.test(state);
    const actual = worker.actualModel || worker.model;
    const monitor = worker.heartbeatAt === undefined ? `<span class="unknown">Heartbeat unknown</span>` : `Heartbeat ${fmtTime(worker.heartbeatAt)}<br><span class="worker-meta">Next check: ${worker.nextCheckAt === undefined ? "unknown; schedule not reported" : fmtTime(worker.nextCheckAt)}</span>`;
    const waiting = needsHuman && !worker.question ? `<p class="worker-notice">Waiting on a human. Question or approval context was not captured.</p>` : "";
    return `<tr><td><span class="worker-name">${esc(redactString(worker.label || worker.id, 160))}</span><br><code>${esc(redactString(worker.id, 160))}</code><span class="worker-meta">Session ${esc(redactString(worker.id, 160))} · ${esc(redactString(worker.workspace || "Workspace unknown", 160))}</span>${waiting}</td><td>${esc(redactString(worker.accountLabel || "Account unknown", 160))}<br><code>${esc(redactString(worker.accountId || "Unknown", 160))}</code></td><td class="worker-status">${statePill(state)}<span class="worker-meta">Dispatch ${esc(redactString(worker.dispatchStatus || "unknown", 80))}</span></td><td><span class="worker-meta">Requested: ${esc(redactString(worker.requestedModel || "Unknown", 120))}</span><span class="worker-meta">Actual: ${esc(redactString(actual || "Unknown", 120))}</span>${taskUsage(worker.usage)}</td><td>${worker.taskCorrelation || worker.taskId ? `<code>${esc(redactString(worker.taskCorrelation || worker.taskId || "", 180))}</code>` : `<span class="unknown">Task unknown</span>`}<span class="worker-meta">Session resumption: unknown; heartbeat does not prove wake.</span></td><td>${monitor}<span class="worker-meta">${/stalled/i.test(state) ? "Stale: monitor reports stalled" : state === "unobserved" ? "Stale: unknown (no observation)" : "Freshness: monitor cadence unavailable"}</span></td></tr>${workerQuestionRow(worker, guidanceBase, csrfToken)}`;
  }).join("")}</tbody></table></div>`;
}

export function renderSupervisorWorkerView(workers: readonly SupervisorWorker[] | undefined): { html: string; total: number; active: number | null; attention: number | null; latestHeartbeat: string } {
  const rows = workers ?? [];
  const observed = rows.some(worker => !!worker.monitorState);
  const heartbeats = rows.map(worker => worker.heartbeatAt).filter((value): value is string | number => value !== undefined);
  const millis = (value: string | number) => typeof value === "number" ? (Math.abs(value) < 100_000_000_000 ? value * 1000 : value) : Date.parse(value);
  const latest = heartbeats.sort((a,b) => millis(b) - millis(a))[0];
  return { html: workersTable(rows, 100), total: rows.length,
    active: observed ? rows.filter(worker => /running|working/i.test(worker.monitorState || "")).length : null,
    attention: observed ? rows.filter(worker => /needs_instructions|waiting_approval|waiting_review|stalled|failed/i.test(worker.monitorState || "")).length : null,
    latestHeartbeat: latest === undefined ? "Unknown" : fmtTime(latest) };
}

function supervisorTabsScript(nonce: string | undefined): string {
  if (!nonce) return "";
  return `<script nonce="${esc(nonce)}">(()=>{const nav=document.getElementById("ops-tabs"),tabs=[...document.querySelectorAll("[role=tab]")],panels=[...document.querySelectorAll("[data-ops-panel]")],events=document.getElementById("supervision-events"),handoffs=document.getElementById("supervision-handoffs");if(!nav||!tabs.length)return;let active="workers";function renderHandoffs(){if(!handoffs||!events)return;handoffs.replaceChildren();const rows=[...events.querySelectorAll(".supervision-event")].filter(node=>/needs_instructions|waiting_approval|waiting_review|idle_needs_review|stalled|failed/i.test(node.textContent||""));if(!rows.length){const empty=document.createElement("p");empty.className="empty";empty.textContent="No pending human handoffs are reported. Dormant-session resumption remains unknown.";handoffs.append(empty);return;}for(const row of rows.slice(0,20)){const item=document.createElement("article");item.className="supervision-event";item.textContent=row.textContent||"Handoff details unavailable";handoffs.append(item);}}function select(name){active=name;for(const tab of tabs){const selected=tab.dataset.tab===name;tab.setAttribute("aria-selected",String(selected));tab.tabIndex=selected?0:-1;}for(const panel of panels)panel.hidden=panel.dataset.opsPanel!==name;if(name==="handoffs")renderHandoffs();}tabs.forEach((tab,index)=>{tab.addEventListener("click",()=>select(tab.dataset.tab||"workers"));tab.addEventListener("keydown",event=>{let next=index;if(event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowLeft")next=(index+tabs.length-1)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;event.preventDefault();tabs[next].focus();tabs[next].click();});});if(events)new MutationObserver(()=>{if(active==="handoffs")renderHandoffs();}).observe(events,{childList:true,subtree:true});select("workers");})();</script>`;
}

function overviewLedger(snapshot: SupervisorSnapshot): string {
  const count = (rows: readonly unknown[] | undefined): string => rows ? String(rows.length) : "Not reported";
  const providers = snapshot.providers;
  const accounts = providers?.every((provider) => Array.isArray(provider.accounts)) ? providers.flatMap((provider) => provider.accounts ?? []) : undefined;
  const workspaces = accounts?.every((account) => Array.isArray(account.workspaces)) ? accounts.flatMap((account) => account.workspaces ?? []) : undefined;
  const nestedWorkers = workspaces?.every((workspace) => Array.isArray(workspace.workers)) ? workspaces.flatMap((workspace) => workspace.workers ?? []) : undefined;
  const workers = snapshot.workers ?? nestedWorkers;
  const values = [["Providers", count(providers)], ["Accounts", count(accounts)], ["Workers", count(workers)], ["Assignments", count(snapshot.jobs)]];
  return `<dl class="ledger" aria-label="Project snapshot ledger">${values.map(([label, value]) => `<div><dt>${esc(label)} listed</dt><dd class="${value === "Not reported" ? "unknown" : ""}">${esc(value)}</dd></div>`).join("")}</dl><p class="ledger-note">Counts are records in this project snapshot, not fleet totals, capacity, or traffic.</p>`;
}

function supervisionPanel(url: string | undefined, csrfToken: string | undefined, projectId: string | undefined, nonce: string | undefined, extra = ""): string {
  const unavailable = !url;
  const hide = nonce ? " hidden" : "";
  return `<div id="supervision-feed" data-endpoint="${esc(url || "")}" data-project-id="${esc(projectId || "")}" data-csrf-token="${esc(csrfToken || "")}"><section id="panel-inbox" class="panel ops-panel" data-ops-panel="inbox" role="tabpanel" aria-label="Inbox"${hide}><h2>Inbox</h2><p class="intro">Project-scoped observations and acknowledgments.</p>${extra}${unavailable ? `<p class="empty">The authenticated project API is not available on this page.</p>` : `<div class="live-bar"><span id="supervision-status" role="status" aria-live="polite">Connecting to the authenticated project inbox…</span><button id="supervision-refresh" type="button">Refresh recovery state</button></div><h3>Durable events</h3><div id="supervision-events" aria-live="polite"><p class="empty">Loading up to 20 events…</p></div><h3>Supervision models</h3><div id="supervision-models"><p class="empty">Loading model inventory…</p></div>`}</section><section id="panel-recovery" class="panel ops-panel" data-ops-panel="recovery" role="tabpanel" aria-label="Recovery"${hide}><h2>Recovery</h2><p class="intro">Persisted decisions, notification receipts, and completed local advice. Advice is informational only.</p><div id="supervision-recovery" class="recovery-grid" aria-live="polite"><p class="empty">${unavailable ? "Recovery API unavailable." : "Loading bounded project recovery state…"}</p></div></section><section id="panel-handoffs" class="panel ops-panel" data-ops-panel="handoffs" role="tabpanel" aria-label="Handoffs"${hide}><h2>Human handoffs</h2><p class="intro">Waiting-for-input or review signals are surfaced when the monitor reports them. Idle workers accept explicit follow-up guidance in the Workers tab; native parked questions and approvals require a provider handoff.</p><div id="supervision-handoffs"><p class="empty">${unavailable ? "Handoff API unavailable." : "Loading reported handoffs…"}</p></div></section></div>${url && nonce ? renderSupervisionInboxScript(nonce) : ""}`;
}

function liveRefreshScript(options: SupervisorDashboardOptions): string {
  if (!options.liveFeedUrl || !options.nonce) return "";
  return `<script nonce="${esc(options.nonce)}">(()=>{const root=document.getElementById("live-shell"),button=document.getElementById("live-pause"),status=document.getElementById("live-status");if(!root||!button||!status)return;let timer=0,paused=false,closed=false;const poll=async()=>{if(paused||closed||document.hidden)return;if(document.activeElement&&(document.activeElement.closest("#live-events")||document.activeElement.closest(".guidance-form")))return;try{const url=new URL(root.dataset.feedUrl,location.href);if(url.origin!==location.origin)throw new Error("origin");const form=document.getElementById("event-filter");if(form){for(const [key,value] of new FormData(form).entries())url.searchParams.set(key,String(value).slice(0,120));}const response=await fetch(url,{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"},redirect:"error"});if(!response.ok)throw new Error("response");const payload=await response.json();if(payload.ok!==true||typeof payload.eventsHtml!=="string"||payload.eventsHtml.length>90000)throw new Error("payload");const list=document.getElementById("live-events");if(list)list.innerHTML=payload.eventsHtml;if(typeof payload.workersHtml==="string"&&payload.workersHtml.length<=120000){const workers=document.getElementById("workers-live");if(workers)workers.innerHTML=payload.workersHtml;for(const [id,key] of [["active-workers","activeWorkers"],["attention-workers","attentionWorkers"],["latest-heartbeat","latestHeartbeat"]]){const node=document.getElementById(id);if(node)node.textContent=typeof payload[key]==="string"||typeof payload[key]==="number"?String(payload[key]):"Unknown";}}for(const name of ["supervisor","orchestrator"]){const node=document.querySelector('[data-live-health="'+name+'"]');if(node)node.textContent=typeof payload[name]==="string"?payload[name]:"Unknown";}status.textContent="Live data refreshed";}catch{status.textContent="Live refresh unavailable; showing the last available data";}};const start=()=>{if(timer)clearInterval(timer);paused=false;button.textContent="Pause live updates";button.setAttribute("aria-pressed","false");void poll();timer=setInterval(poll,15000);};button.addEventListener("click",()=>{if(paused){start();return;}paused=true;if(timer)clearInterval(timer);timer=0;button.textContent="Resume live updates";button.setAttribute("aria-pressed","true");status.textContent="Live updates paused";});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!paused)void poll();});window.addEventListener("pagehide",()=>{closed=true;if(timer)clearInterval(timer);timer=0;},{once:true});status.textContent="Operations data loaded; waiting for updates";start();})();</script>`;
}

function workerGuidanceScript(nonce: string | undefined): string {
  if (!nonce) return "";
  return `<script nonce="${esc(nonce)}">(()=>{const root=document.getElementById("workers-live");if(!root)return;const requestIds=new Map();const clean=v=>typeof v==="string"?v.replace(/[\\u0000-\\u001f\\u007f]/g," ").slice(0,2000):"";const newId=()=>{try{return crypto.randomUUID();}catch{return "guidance-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);}};const configure=()=>{for(const form of root.querySelectorAll("form.guidance-form")){if(!form.dataset.guidanceBase&&root.dataset.guidanceBase)form.dataset.guidanceBase=root.dataset.guidanceBase;if(!form.dataset.csrfToken&&root.dataset.csrfToken)form.dataset.csrfToken=root.dataset.csrfToken;const button=form.querySelector('button[type="submit"]');if(button)button.disabled=!form.dataset.guidanceBase||!form.dataset.csrfToken||!Number.isSafeInteger(Number(form.dataset.promptCount));}};new MutationObserver(configure).observe(root,{childList:true,subtree:true});configure();root.addEventListener("click",event=>{const button=event.target.closest("button[data-guidance-choice]");if(!button)return;const form=button.closest("tr").querySelector("form.guidance-form"),field=form&&form.elements.namedItem("message");if(field){field.value=button.dataset.guidanceChoice||"";field.focus();}});root.addEventListener("submit",async event=>{const form=event.target.closest("form.guidance-form");if(!form)return;event.preventDefault();const message=clean(form.elements.namedItem("message").value).trim(),count=Number(form.dataset.promptCount),worker=form.dataset.workerId,question=form.dataset.questionId||"";const status=form.querySelector(".guidance-status"),button=form.querySelector('button[type="submit"]');if(!message||message.length>2000||!Number.isSafeInteger(count)||count<0||!worker||!form.dataset.csrfToken||!form.dataset.guidanceBase){status.textContent="Reply unavailable: current prompt count or authorized route is missing.";return;}const key=[worker,question,String(count)].join("\\u0000");let requestId=form.dataset.requestId||requestIds.get(key);if(!requestId){requestId=newId();requestIds.set(key,requestId);}form.dataset.requestId=requestId;button.disabled=true;status.textContent="Sending one explicit reply request…";try{const url=new URL(form.dataset.guidanceBase,location.href);if(url.origin!==location.origin)throw new Error("origin");url.pathname=url.pathname.replace(/\\/$/,"")+"/workers/"+encodeURIComponent(worker)+"/guidance";url.search="";url.hash="";const response=await fetch(url,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",headers:{Accept:"application/json","Content-Type":"application/json","X-CSRF-Token":form.dataset.csrfToken},body:JSON.stringify({requestId,message,expectedPromptCount:count,...(question?{expectedQuestionId:question}:{})})});let payload={};try{const body=await response.text();if(body.length<=32768)payload=JSON.parse(body);}catch{}const outcome=payload&&["accepted","rejected","ambiguous"].includes(payload.state)?payload.state:payload&&["accepted","rejected","ambiguous"].includes(payload.outcome)?payload.outcome:payload&&["accepted","rejected","ambiguous"].includes(payload.status)?payload.status:"ambiguous";status.textContent=outcome==="accepted"?"Reply request accepted by the backend; provider completion is not implied.":outcome==="rejected"?"Reply request rejected by the backend; refresh the question before trying again.":"Reply outcome is ambiguous; check the current question before retrying. The retry will reuse this request ID.";if(outcome!=="ambiguous"){requestIds.delete(key);delete form.dataset.requestId;form.elements.namedItem("message").value="";}}catch{status.textContent="Reply outcome is ambiguous; check the current question before retrying. The retry will reuse this request ID.";}finally{button.disabled=false;}});})();</script>`;
}
function table<T extends {id:string;status:string;label?:string;updatedAt?:string|number}>(items: readonly T[] | undefined, max: number, label: string, extra: (item:T)=>string): string {
  const rows=bounded(items,max); if (!rows.length) return `<p class="empty">No ${esc(label.toLowerCase())} to show.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>${esc(label)}</th><th>Status</th><th>Routing / dependencies</th><th>Updated</th></tr></thead><tbody>${rows.map(i=>`<tr><td><strong>${esc(i.label||i.id)}</strong><br><code>${esc(i.id)}</code></td><td>${statePill(i.status)}</td><td>${extra(i)}</td><td>${fmtTime(i.updatedAt)}</td></tr>`).join("")}</tbody></table></div>`;
}
function chart(s: SupervisorSeries, max: number): string {
  const points=bounded(s.points,max).filter(p=>Number.isFinite(p.value)); if(!points.length) return `<p class="empty">No measured history is available.</p>`;
  const low=Math.min(0,...points.map(p=>p.value)); const high=Math.max(...points.map(p=>p.value)); const span=high-low || 1;
  return `<div class="bar-chart" role="img" aria-label="${esc(s.label)} measured time series"><span class="sr-only">${esc(points.map(p=>`${p.value}${s.unit||""}`).join(", "))}</span>${points.map(p=>`<i title="${esc(fmtTime(p.at))}: ${esc(p.value)}${esc(s.unit||"")}" style="height:${Math.max(4,Math.round((p.value-low)/span*92))}px"></i>`).join("")}</div><p class="chart-note">Measured values: ${esc(points.map(p=>`${p.value}${s.unit||""}`).join(" · "))}</p>`;
}

/** Render a self-contained operations dashboard from the project data available to the caller. */
function projectControls(snapshot: SupervisorSnapshot, options: SupervisorDashboardOptions): string {
  const c = snapshot.projectControl;
  if (!c || !options.csrfToken || !options.nonce) return "";
  const endpoint = new URL("./control", "http://local" + (options.liveFeedUrl || "/admin/api/v1/supervisor/project/live")).pathname;
  return `<section class="panel"><h2>Dispatch controls</h2><p>${c.projectId === "token2oauth" ? "ROTOXY Fleet" : `Task context: ${esc(c.projectId)}`} · <strong>${esc(c.state)}</strong> · ${esc(c.activeTaskCount)} active tasks. These controls affect new dispatch and do not cancel in-flight work. Limits are local policy, not verified provider capacity.</p><form id="dispatch-controls" data-project="${esc(c.projectId)}" data-revision="${esc(c.revision)}" data-csrf="${esc(options.csrfToken)}" data-endpoint="${esc(endpoint.replace(/\/[^/]+\/control$/, "/control"))}"><button name="action" value="pause_dispatch">Pause dispatch</button> <button name="action" value="resume_dispatch">Resume dispatch</button> <button name="action" value="emergency_stop">Stop new dispatch</button><label>Maximum concurrent workers <input name="value" type="number" min="1" max="32" value="${esc(c.maxConcurrency)}"></label><button name="action" value="set_concurrency">Apply limit</button><p id="dispatch-status" role="status" aria-live="polite"></p></form></section><script nonce="${esc(options.nonce)}">(()=>{const f=document.getElementById('dispatch-controls');f.addEventListener('submit',async e=>{e.preventDefault();const action=e.submitter?.value;if(!action)return;const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);const status=document.getElementById('dispatch-status');try{const body={projectId:f.dataset.project,expectedRevision:Number(f.dataset.revision),action};if(action==='set_concurrency')body.value=Number(f.elements.value.value);const r=await fetch(f.dataset.endpoint,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-csrf-token':f.dataset.csrf},body:JSON.stringify(body)});if(!r.ok)throw Error();status.textContent='Saved. Refreshing authoritative state…';location.reload();}catch{status.textContent='Control was not confirmed. Refresh before retrying.';buttons.forEach(b=>b.disabled=false);}});})();</script>`;
}

export function renderSupervisorDashboard(snapshot: SupervisorSnapshot, options: SupervisorDashboardOptions = {}): string {
  const max = Math.max(1, Math.min(200, Math.floor(options.maxItems ?? 60)));
  const title = esc(options.title || "Workforce control desk");
  const search = esc(options.search || ""); const severity = (options.severity || "all").toLowerCase(); const pause = options.pause || "all";
  const error = snapshot.state === "error" ? `<div class="panel errorbox" role="alert"><strong>Operations data unavailable</strong><p>${esc(redactString(snapshot.error || "No further details are available.", 1200))}</p></div>` : "";
  const stateNote = snapshot.state === "loading" ? `<p class="empty" role="status">Loading operations data. Values remain unknown while it loads.</p>` : "";
  const series = bounded(snapshot.series,max);
  const workers = projectWorkers(snapshot);
  const guidanceBase = supervisorGuidanceBase(options.liveFeedUrl);
  const adminHref = guidanceBase ? guidanceBase.slice(0,guidanceBase.indexOf("/admin/"))+"/admin" : "/admin";
  const attention = workers.filter(worker => /needs_instructions|waiting_approval|waiting_review|stalled|failed/i.test(worker.monitorState || worker.status)).length;
  const active = workers.filter(worker => /running|working/i.test(worker.monitorState || worker.status)).length;
  const heartbeatMillis = (value: string | number) => typeof value === "number" ? (Math.abs(value) < 100_000_000_000 ? value * 1000 : value) : Date.parse(value);
  const latestHeartbeat = workers.map(worker => worker.heartbeatAt).filter((value): value is string | number => value !== undefined).sort((a,b) => heartbeatMillis(b) - heartbeatMillis(a))[0];
  const kpis = `<div class="ops-kpis" aria-label="Project operational summary"><div class="ops-kpi"><span>Registered workers</span><strong>${esc(workers.length)}</strong></div><div class="ops-kpi"><span>Observed active</span><strong id="active-workers">${workers.some(worker=>worker.monitorState) ? esc(active) : "Unknown"}</strong></div><div class="ops-kpi"><span>Attention signals</span><strong id="attention-workers">${workers.some(worker=>worker.monitorState) ? esc(attention) : "Unknown"}</strong></div><div class="ops-kpi"><span>Latest heartbeat</span><strong id="latest-heartbeat">${latestHeartbeat === undefined ? "Unknown" : fmtTime(latestHeartbeat)}</strong></div></div>`;
  const liveControls = options.liveFeedUrl && options.nonce ? `<div class="live-bar"><span id="live-status" role="status" aria-live="polite">Operations data loaded; waiting for updates</span><button id="live-pause" type="button" aria-pressed="false">Pause live updates</button></div>` : "";
  const inboxDetails = `<details><summary>Project snapshot counts</summary>${overviewLedger(snapshot)}</details><details><summary>Account, workspace, and capacity detail</summary>${workforce(bounded(snapshot.providers,max),max)}</details><h3>Jobs and tasks</h3><div class="table-wrap"><table><thead><tr><th>Assignment</th><th>State</th><th>Routing / correlation</th></tr></thead><tbody>${bounded(snapshot.jobs,max).map(job=>`<tr><td><strong>${esc(job.label||job.id)}</strong><br><code>${esc(job.id)}</code>${job.taskCount!==undefined?`<span class="worker-meta">${esc(job.taskCount)} tasks · revision ${esc(job.revision??"not reported")}</span>`:""}</td><td>${statePill(job.status)}</td><td>${esc([job.provider,job.account,job.workspace,job.worker,job.taskId].filter(Boolean).join(" · ")||"Unknown")}${job.dependencies?.length?`<span class="worker-meta">Depends on: ${job.dependencies.map(esc).join(", ")}</span>`:""}</td></tr>`).join("")||`<tr><td colspan="3" class="unknown">No assignments reported.</td></tr>`}</tbody></table></div><h3>Tasks</h3>${table(snapshot.tasks,max,"Task",task=>esc([task.workspace,task.worker].filter(Boolean).join(" · ")||"Assignment unavailable")+((task.usage||task.reportedModel)?`<br>${taskUsage(task.usage,task.reportedModel)}`:""))}<h3>Recent project events</h3><form class="filter" id="event-filter" method="get" action="#inbox"><label>Search<input type="search" name="search" value="${search}" maxlength="120"></label><label>Severity<select name="severity"><option value="all"${severity==="all"?" selected":""}>All levels</option>${["debug","info","notice","warning","error","critical","unknown"].map(s=>`<option value="${s}"${severity===s?" selected":""}>${s}</option>`).join("")}</select></label><label>Pause state<select name="pause"><option value="all"${pause==="all"?" selected":""}>All events</option><option value="paused"${pause==="paused"?" selected":""}>Paused</option><option value="active"${pause==="active"?" selected":""}>Not paused</option></select></label><button type="submit">Filter events</button></form>${liveControls}<div id="live-shell" data-feed-url="${esc(options.liveFeedUrl || "")}"><div id="live-events">${eventEntries(snapshot.events||[],options,max)}</div></div>${series.length?series.map(item=>`<details><summary>${esc(item.label)} history</summary>${chart(item,max)}</details>`).join(""):""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" type="image/svg+xml" href="${faviconHref}"><title>${title} · ROTOXY</title><style>${css}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body><main class="main"><nav class="breadcrumb" aria-label="Location"><a class="brand-name" href="${esc(adminHref)}">ROTOXY</a><span>/</span><span>Supervision</span></nav><header class="top" id="overview"><div class="title-lockup">${BRAND_MARK_SVG.replace('<svg ', '<svg class="page-mark" ')}<div><div class="kicker">Supervised workforce</div><h1>${title}</h1><p class="muted">Account and session operations; missing observations remain unknown.</p></div></div><div class="stamp">Updated<br><strong>${fmtTime(snapshot.observedAt)}</strong></div></header>${kpis}${projectControls(snapshot,options)}${stateNote}${error}<section class="health" id="live-health" aria-label="System health">${health("Supervisor",snapshot.supervisor)}${health("Orchestrator",snapshot.orchestrator)}<article><span class="muted small">Data status</span><strong>${statePill(snapshot.state || "unknown")}</strong></article></section><nav class="ops-nav" id="ops-tabs" role="tablist" aria-label="Supervisor sections"><button type="button" role="tab" data-tab="workers" aria-controls="panel-workers" aria-selected="true">Workers</button><button type="button" role="tab" data-tab="inbox" aria-controls="panel-inbox" aria-selected="false">Inbox</button><button type="button" role="tab" data-tab="recovery" aria-controls="panel-recovery" aria-selected="false">Recovery</button><button type="button" role="tab" data-tab="handoffs" aria-controls="panel-handoffs" aria-selected="false">Handoffs</button></nav><section class="panel ops-panel" id="panel-workers" data-ops-panel="workers" role="tabpanel" aria-label="Workers"><h2>Workers</h2><p class="intro">Requested and observed models are shown separately. Monitor cadence and dormant-session resumption are not inferred.</p><div id="workers-live"${guidanceBase ? ` data-guidance-base="${esc(guidanceBase)}"` : ""}${options.csrfToken ? ` data-csrf-token="${esc(options.csrfToken)}"` : ""}>${workersTable(workers,max,guidanceBase,options.csrfToken)}</div></section>${supervisionPanel(supervisorInboxUrl(options.liveFeedUrl), options.csrfToken, supervisorProjectId(options.liveFeedUrl), options.nonce,inboxDetails)}${liveRefreshScript(options)}${workerGuidanceScript(options.nonce)}${supervisorTabsScript(options.nonce)}</main></body></html>`;
}
