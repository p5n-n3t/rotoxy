import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { verifyPassword } from "./crypto.js";
import { AdminSessions, adminEpoch, parseCookies } from "./admin-session.js";
import { generateAdminPassword, validateAdminRedirect } from "./admin-security.js";
import { CredentialPool } from "./pool.js";
import { StateStore } from "./store.js";
import type { PoolStrategy } from "./types.js";
import { strategyHelp, parameterHelp } from "./dashboard-help.js";
import type { OAuthService } from "./oauth.js";
import { TelemetryRecorder, type GatewayEvent, type GatewaySummary } from "./telemetry.js";
import { renderDiagnosticsPage, renderSecurityPage, renderToolsPage, renderRotatedPage } from "./ui-pages.js";
import { refreshAccountCapabilities, toolCatalog } from "./capabilities.js";
import { collectDoctorSnapshot } from "./doctor-runtime.js";
import { diagnoseDoctorSnapshot } from "./doctor.js";
import { LifecycleController, effectiveServeConfig, createExecFileRunner, planUp, renderCommand } from "./lifecycle.js";
import { compileToolPolicy, type ToolPolicy } from "./tool-policy.js";
import { adminNav, withCsrf, ROTOXY_FAVICON_SVG } from "./html.js";
import { BRAND_MARK_SVG } from "./supervisor-ui.js";

export interface AdminUiDeps {
  oauth?: OAuthService;
  telemetry?: TelemetryRecorder;
}


const strategies: PoolStrategy[] = [
  "adaptive-sticky",
  "round-robin",
  "least-used",
  "weighted-random",
  "random",
  "priority",
];

function e(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const css = String.raw`
:root{color-scheme:light dark;--paper:#f5f3ee;--surface:#fffdf9;--sunk:#ece8df;--ink:#16191d;--muted:#565c64;--line:#d6d0c4;--rule:#e6e1d6;--signal:#0f7b6c;--signal-soft:#dff1ec;--amber:#9a540f;--amber-soft:#fbecd8;--red:#a33a2f;--red-soft:#f8e3df;--focus:#c26a12;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font:15px/1.55 ui-sans-serif,"Segoe UI",system-ui,-apple-system,sans-serif}
@media(prefers-color-scheme:dark){:root{--paper:#0d0f12;--surface:#14171b;--sunk:#0a0c0e;--ink:#e9e6df;--muted:#a3a7ad;--line:#2c3138;--rule:#1f242a;--signal:#4fd1b8;--signal-soft:#123a33;--amber:#f0b25c;--amber-soft:#3a2a12;--red:#f08a7c;--red-soft:#3d1b17;--focus:#f0b25c}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);min-height:100vh}
a{color:var(--signal);text-underline-offset:3px}
.wrap{width:min(1240px,100%);margin:0 auto;padding:0 clamp(16px,4vw,48px) 72px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:18px 0;margin-bottom:28px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;min-width:0}.brand strong{font-size:16px;letter-spacing:-.02em}
.logo{width:34px;height:34px;flex:0 0 auto;color:var(--ink);display:grid;place-items:center}.logo svg{width:34px;height:34px;display:block}
.muted{color:var(--muted)}.tiny{font-size:12.5px;line-height:1.45}
.eyebrow{font:600 11px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
h1,h2,h3{letter-spacing:-.02em;font-weight:640}
.hero{padding:20px 0 26px;border-bottom:1px solid var(--line)}
.hero h1{font-size:clamp(30px,5vw,54px);letter-spacing:-.04em;line-height:1.04;margin:10px 0 16px;max-width:820px}
.gradient{color:var(--signal)}
.lead{font-size:17px;line-height:1.65;color:var(--muted);max-width:720px;margin:0}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:0 clamp(20px,3vw,40px);margin-top:8px}
.card{grid-column:span 4;min-width:0;padding:22px 0 26px;border-bottom:1px solid var(--line)}
.card.wide{grid-column:span 8}.card.full{grid-column:1/-1}
.card h2{font-size:19px;margin:6px 0 12px}.card h3{font-size:15px;margin:16px 0 8px}
.metric{font:620 30px/1.1 var(--mono);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.pill{display:inline-flex;gap:6px;align-items:center;padding:1px 8px;border:1px solid var(--line);border-radius:3px;font:600 12px/1.7 var(--mono);background:var(--surface);color:var(--ink)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--signal)}.dot.warn{background:var(--amber)}.dot.bad{background:var(--red)}
code,.mono{font-family:var(--mono);font-size:.92em}
.copy{padding:11px 12px;border:1px solid var(--line);border-left:3px solid var(--signal);background:var(--surface);border-radius:4px;overflow-wrap:anywhere;font-size:13px;color:var(--ink)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:10px 10px 10px 0;border-bottom:1px solid var(--rule);font-size:13.5px;vertical-align:top}
th{color:var(--muted);font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.07em}tr:last-child td{border:0}
.card:has(table){overflow-x:auto}
form.inline{display:inline}
label{display:block;color:var(--muted);font-size:13px;font-weight:550;margin:12px 0 6px}
input,select,textarea{width:100%;max-width:100%;min-width:0;min-height:40px;padding:8px 11px;border-radius:4px;background:var(--surface);border:1px solid var(--line);color:var(--ink);font:inherit}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
input[aria-invalid=true]{border-color:var(--red)}
.row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid var(--ink);border-radius:4px;padding:7px 14px;font:inherit;font-weight:620;font-size:14px;color:var(--paper);background:var(--ink);cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--signal);border-color:var(--signal)}
.btn.secondary,button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.secondary:hover,button.secondary:hover{border-color:var(--ink);background:var(--surface)}
.btn[aria-current=page]{background:var(--ink);color:var(--paper)}
button:disabled{opacity:.5;cursor:not-allowed}
.danger{background:var(--red-soft)!important;border-color:var(--red)!important;color:var(--red)!important}
.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.flash{padding:11px 14px;border-left:3px solid var(--signal);background:var(--signal-soft);color:var(--ink);margin:0 0 18px}
label.toggle{display:inline-flex;gap:8px;align-items:center;margin:4px 12px 4px 0;color:var(--ink)}label.toggle input{width:auto;min-height:0}
.findings,.events{list-style:none;padding:0;margin:0}.findings li,.events li{padding:10px 0 10px 12px;border-bottom:1px solid var(--rule);border-left:2px solid var(--line)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sunk);border-radius:4px;padding:10px;max-height:320px;overflow:auto;font:12.5px/1.5 var(--mono)}
.footer{margin-top:34px;color:var(--muted);font-size:12.5px;text-align:center}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}
.login .card{width:min(420px,100%);grid-column:auto;padding:28px;border:1px solid var(--line);background:var(--surface);border-radius:6px}
@media(max-width:850px){.card,.card.wide{grid-column:1/-1}.row{grid-template-columns:1fr}.hide-sm{display:none}nav.actions{width:100%;overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px}nav.actions>*{flex:0 0 auto}}
@media(max-width:520px){.metric{font-size:25px}.hero h1{font-size:30px}th,td{font-size:13px}}
.ops-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line)}
.ops-head h1{font-size:clamp(26px,4vw,40px);line-height:1.08;letter-spacing:-.035em;margin:6px 0 4px}
.ops-head .verdict{display:flex;gap:8px;align-items:center;font-weight:600}
.ledger{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border-bottom:1px solid var(--line);margin:0}
.ledger div{padding:16px 16px 16px 0;min-width:0}.ledger div+div{padding-left:16px;border-left:1px solid var(--rule)}
.ledger dt{font:600 11px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.ledger dd{margin:6px 0 0;font:620 28px/1.1 var(--mono);font-variant-numeric:tabular-nums}
.ledger dd.unknown{font:italic 500 15px/1.4 inherit;color:var(--muted);padding-top:8px}
.ledger dd.attn{color:var(--amber)}.ledger dd.bad{color:var(--red)}
.ledger small{display:block;margin-top:3px;font:400 12.5px/1.35 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.bar{display:flex;height:8px;margin-top:10px;background:var(--sunk);border-radius:1px;overflow:hidden}.bar i{display:block;height:100%}
.bar .ok{background:var(--signal)}.bar .warn{background:var(--amber)}.bar .bad{background:var(--red)}.bar .off{background:var(--muted);opacity:.45}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12.5px;color:var(--muted)}.legend span{display:inline-flex;gap:6px;align-items:center}
.narrative{font-size:15px;line-height:1.7;max-width:62ch;margin:6px 0 0}
.narrative strong{font-weight:620}
.reqs{list-style:none;margin:0;padding:0}.reqs li{display:grid;grid-template-columns:78px minmax(0,1fr) auto;gap:4px 12px;padding:8px 0;border-bottom:1px solid var(--rule);font-size:13.5px;align-items:baseline}
.reqs time,.reqs .lat{font-family:var(--mono);font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.reqs .what{min-width:0;overflow-wrap:anywhere}.reqs .err{color:var(--red)}
details.settings{border-top:1px solid var(--line);padding:4px 0}details.settings>summary{padding:16px 0;font-weight:620;font-size:17px;list-style-position:outside}
details.settings>summary .tiny{font-weight:400;margin-left:8px}
.empty{padding:14px 16px;background:var(--sunk);color:var(--muted);border-radius:4px;font-size:14px}
@media(max-width:520px){.ledger{grid-template-columns:repeat(2,minmax(0,1fr))}.ledger div,.ledger div+div{padding:12px 10px 12px 0;border-left:0;border-bottom:1px solid var(--rule)}.ledger dd{font-size:23px}.reqs li{grid-template-columns:64px minmax(0,1fr)}.reqs .lat{grid-column:2}}
.wrap:has(>.rx-sidebar){width:auto;max-width:none;margin:0 0 0 252px;padding:0 clamp(22px,3vw,44px) 72px}
.rx-sidebar{position:fixed;inset:0 auto 0 0;z-index:20;width:252px;display:flex;flex-direction:column;gap:18px;padding:20px 14px 14px;background:#173a37;color:#edf4ef;overflow-y:auto}
.rx-sidebar .brand{color:#edf4ef;text-decoration:none;gap:10px;padding:0 8px}.rx-sidebar .brand strong{display:block;font:700 15px/1.2 var(--mono);letter-spacing:.12em}.rx-sidebar .brand .eyebrow{display:block;margin-top:3px;color:#bfcec8;font-size:10px}.rx-sidebar .logo{color:#edf4ef;width:32px;height:32px}.rx-sidebar .logo svg{width:32px;height:32px}
.rx-workspace-id{display:grid;gap:4px;margin:0 8px;padding:12px 10px;border-top:1px solid #ffffff2b;border-bottom:1px solid #ffffff2b}.rx-workspace-id .eyebrow{color:#bfcec8}.rx-workspace-id strong{font-size:13px;overflow-wrap:anywhere}
.rx-nav-details{display:flex;flex:1;flex-direction:column;min-height:0}.rx-nav-details>summary{display:none}.rx-nav-content{display:flex;flex:1;flex-direction:column;min-height:0}.rx-nav-groups{display:grid;align-content:start;gap:15px;overflow-y:auto;padding:0 3px}
.nav-group{display:grid;gap:2px;min-width:0}.nav-label{margin:0 8px 3px;font:600 10px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:#bfcec8}.nav-link{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:34px;padding:6px 9px;border-radius:4px;color:#edf4ef;text-decoration:none;font-size:13px;font-weight:540;line-height:1.3;overflow-wrap:anywhere}.nav-link:hover{background:#ffffff16}.nav-link[aria-current=page]{background:#28524c;color:#fff;box-shadow:inset 2px 0 #4fd1b8}.nav-unavailable{color:#bfcec8;cursor:default}.nav-unavailable small{font-size:10px;font-weight:500;color:#bfcec8}
.rx-sidebar-end{display:grid;gap:7px;margin-top:auto;padding:12px 3px 0;border-top:1px solid #ffffff2b}.rx-sidebar-end .btn,.rx-sidebar-end button{width:100%;min-height:34px;padding:5px 9px;font-size:12.5px;white-space:normal;color:#edf4ef;border-color:#ffffff52}.rx-sidebar-end .btn:hover,.rx-sidebar-end button:hover{background:#28524c;border-color:#4fd1b8}
.rx-page-context{position:sticky;top:0;z-index:10;display:flex;align-items:center;min-height:76px;margin-bottom:20px;border-bottom:1px solid var(--line);background:var(--paper)}.rx-page-context>div{display:grid;gap:2px}.rx-page-context .eyebrow{font-size:10px}.rx-current-page{font-size:17px;font-weight:650;letter-spacing:-.02em}
.rx-skip-link{position:fixed;left:12px;top:12px;z-index:50;transform:translateY(-160%);padding:9px 12px;background:var(--surface);border:2px solid var(--focus);border-radius:4px;color:var(--ink);font-weight:650}.rx-skip-link:focus{transform:translateY(0)}#rx-main-content:focus{outline:none}
.rx-mobile-menu{cursor:pointer;list-style:none}.rx-mobile-menu::-webkit-details-marker{display:none}
button,.btn{white-space:nowrap}
@media(max-width:720px){.wrap:has(>.rx-sidebar){margin:0;padding:0 16px 48px}.rx-sidebar{position:sticky;inset:auto;top:0;width:auto;margin:0 -16px;padding:9px 16px;min-height:62px;display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:12px;overflow:visible}.rx-sidebar .brand{padding:0;flex:1;min-width:0}.rx-sidebar .brand>span:last-child{min-width:0}.rx-workspace-id{display:none}.rx-nav-details{position:static;display:block;flex:0 0 auto}.rx-nav-details>summary{display:flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:7px 12px;border:1px solid #ffffff62;border-radius:4px;color:#edf4ef;font-weight:620}.rx-nav-content{display:none;position:absolute;top:100%;left:0;right:0;max-height:calc(100dvh - 62px);overflow:auto;padding:14px 16px 16px;background:#173a37;box-shadow:0 12px 22px #101b1980}.rx-nav-details[open]>.rx-nav-content{display:flex}.rx-nav-groups{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 12px;overflow:visible}.rx-page-context{position:static;min-height:58px;margin-bottom:12px}.rx-current-page{font-size:15px}.rx-sidebar-end{grid-template-columns:1fr 1fr;margin-top:16px;padding-top:10px}.rx-sidebar-end .btn,.rx-sidebar-end button{min-height:40px}}
@media(max-width:390px){.rx-nav-groups{grid-template-columns:1fr}.rx-nav-content{max-height:calc(100dvh - 62px)}.rx-sidebar .brand .eyebrow{font-size:9px}.rx-sidebar-end{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`;


const faviconHref = `data:image/svg+xml,${encodeURIComponent(ROTOXY_FAVICON_SVG)}`;

/** Swap the legacy text badge (also emitted by shared nav helpers) for the relay-gate mark. */
export function brandMarkup(body: string): string {
  return body.replaceAll('<div class="logo">T2</div>', `<div class="logo">${BRAND_MARK_SVG}</div>`);
}

export function page(title: string, body: string): string {
  const shellBody = body.includes("rx-skip-link") ? body.replace(/<main\b/, '<main id="rx-main-content" tabindex="-1"') : body;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f3ee"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d0f12"><link rel="icon" type="image/svg+xml" href="${faviconHref}"><title>${e(title)} · ROTOXY</title><style>${css}</style></head><body>${brandMarkup(shellBody)}</body></html>`;
}

export class AdminUi {
  readonly router: Router = express.Router();

  constructor(
    private readonly store: StateStore,
    private readonly pool: CredentialPool,
    private readonly sessions: AdminSessions,
    private readonly deps: AdminUiDeps = {},
  ) {
    const form = express.urlencoded({ extended: false, limit: "64kb" });
    this.router.use("/admin", this.securityHeaders);
    this.router.get("/", this.home);
    this.router.get("/healthz", this.health);
    this.router.get("/admin/login", this.loginGet);
    this.router.post("/admin/login", form, this.loginPost);
    this.router.post("/admin/logout", form, this.requireAdmin, this.requireCsrf, this.logout);
    this.router.get("/admin", this.requireAdmin, this.admin);
    this.router.post("/admin/accounts", form, this.requireAdmin, this.requireCsrf, this.addAccount);
    this.router.post("/admin/accounts/probe-all", form, this.requireAdmin, this.requireCsrf, this.probeAll);
    this.router.post("/admin/accounts/:id/toggle", form, this.requireAdmin, this.requireCsrf, this.toggleAccount);
    this.router.post("/admin/accounts/:id/reset", form, this.requireAdmin, this.requireCsrf, this.resetAccount);
    this.router.post("/admin/accounts/:id/probe", form, this.requireAdmin, this.requireCsrf, this.probeAccount);
    this.router.post("/admin/accounts/:id/remove", form, this.requireAdmin, this.requireCsrf, this.removeAccount);
    this.router.post("/admin/config", form, this.requireAdmin, this.requireCsrf, this.saveConfig);
    this.router.get("/admin/tools", this.requireAdmin, this.tools);
    this.router.post("/admin/tools/policy", form, this.requireAdmin, this.requireCsrf, this.saveToolPolicy);
    this.router.post("/admin/tools/refresh", form, this.requireAdmin, this.requireCsrf, this.refreshTools);
    this.router.get("/admin/diagnostics", this.requireAdmin, this.diagnostics);
    this.router.post("/admin/diagnostics", form, this.requireAdmin, this.requireCsrf, this.diagnostics);
    this.router.get("/admin/diagnostics.json", this.requireAdmin, this.diagnosticsJson);
    this.router.get("/admin/security", this.requireAdmin, this.security);
    this.router.post("/admin/security/rotate", form, this.requireAdmin, this.requireCsrf, this.rotatePassword);
  }

  private base = async () => (await this.store.load()).config.publicBaseUrl.replace(/\/$/, "");

  private securityHeaders = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };

  private requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie)["t2o_admin"];
    const state = await this.store.load();
    if (!this.sessions.valid(token, adminEpoch(state))) {
      const base = state.config.publicBaseUrl.replace(/\/$/, "");
      if (req.method !== "GET") return res.status(401).type("text").send("Admin session expired. Sign in again.");
      return res.redirect(302, base + "/admin/login?next=" + encodeURIComponent(base + "/admin"));
    }
    res.locals.adminToken = token;
    res.locals.csrf = this.sessions.csrfToken(token);
    next();
  };

  private requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    if (!this.sessions.verifyCsrf(res.locals.adminToken, req.body?._csrf)) {
      return res.status(403).type("text").send("Invalid or missing CSRF token. Reload the admin page and try again.");
    }
    next();
  };

  private sendAdmin(res: Response, title: string, body: string): void {
    res.type("html").send(withCsrf(page(title, body), String(res.locals.csrf || "")));
  }

  private home = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const snapshot = this.pool.snapshot(state);
    const ready = snapshot.filter((a) => ["healthy", "ready", "unknown"].includes(String(a.state)) && a.enabled).length;
    res.type("html").send(page("Gateway", `<main class="wrap">
<div class="nav"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Bearer → OAuth 2.1</div></div></div><a class="btn secondary" href="${e(base)}/admin">Admin console</a></div>
<section class="hero"><div class="eyebrow">MCP credential gateway</div><h1>One OAuth connection.<br><span class="gradient">Many upstream tokens.</span></h1><p class="lead">A self-hosted OAuth facade for bearer-token MCP servers, with encrypted credentials, sticky sessions, adaptive pooling, quota-aware cooldowns and optional Tailscale Funnel exposure.</p></section>
<section class="grid">
<div class="card"><div class="eyebrow">Gateway</div><div class="metric"><span class="dot"></span> Online</div><p class="muted tiny">OAuth metadata and MCP proxy are available.</p></div>
<div class="card"><div class="eyebrow">Credential pool</div><div class="metric">${ready}<span class="muted"> / ${snapshot.length}</span></div><p class="muted tiny">currently selectable accounts</p></div>
<div class="card"><div class="eyebrow">Strategy</div><div class="metric" style="font-size:21px">${e(state.config.strategy)}</div><p class="muted tiny">session-aware selection policy</p></div>
<div class="card wide"><div class="eyebrow">ChatGPT / MCP URL</div><h3>Protected MCP endpoint</h3><div class="copy">${e(base)}/mcp</div></div>
<div class="card"><div class="eyebrow">Discovery</div><h3>OAuth 2.1</h3><p class="muted tiny">Authorization code + PKCE S256, DCR, refresh rotation, resource-bound access tokens.</p></div>
</section><div class="footer">Token2OAuth · secrets stay encrypted on this host</div></main>`));
  };

  private health = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const snapshot = this.pool.snapshot(state);
    res.json({
      ok: true,
      version: 1,
      upstreamConfigured: Boolean(state.config.upstreamUrl),
      strategy: state.config.strategy,
      accounts: snapshot.length,
      selectable: snapshot.filter((a) => a.enabled && !["cooldown", "exhausted", "auth-failed", "disabled"].includes(String(a.state))).length,
    });
  };

  private loginGet = async (req: Request, res: Response) => {
    const base = await this.base();
    res.type("html").send(page("Admin login", `<main class="login"><section class="card"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Admin console</div></div></div>
<h2>Unlock your gateway</h2><p class="muted">Manage upstream MCP endpoints, encrypted bearer credentials, routing and pool health.</p>
<form method="post" action="${e(base)}/admin/login"><input type="hidden" name="next" value="${e(String(req.query.next || base + "/admin"))}"><label>Admin password</label><input type="password" name="password" required autofocus autocomplete="current-password"><button type="submit">Sign in →</button></form></section></main>`));
  };

  private loginPost = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const client = req.ip || "unknown";
    const wait = this.sessions.passwordBlocked(client);
    if (wait) {
      res.setHeader("Retry-After", String(wait));
      return res.status(429).type("html").send(page("Too many attempts", '<main class="login"><section class="card"><h2>Too many attempts</h2><p class="muted">Sign-in is paused for this address. Try again later.</p></section></main>'));
    }
    if (!verifyPassword(String(req.body.password || ""), state.admin)) {
      this.sessions.passwordFailed(client);
      return res.status(401).type("html").send(page("Login failed", '<main class="login"><section class="card"><h2>Incorrect password</h2><p class="muted">The gateway admin password did not match.</p><a class="btn" href="./login">Try again</a></section></main>'));
    }
    this.sessions.passwordSucceeded(client);
    const token = this.sessions.create(undefined, adminEpoch(state));
    res.setHeader("Set-Cookie", this.sessionCookie(state.config.publicBaseUrl, encodeURIComponent(token), 43200));
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const next = validateAdminRedirect(String(req.body.next || ""), base) || base + "/admin";
    res.redirect(302, next);
  };

  /** Admin cookie scoped to this gateway's own path, never the shared host root. */
  private sessionCookie(publicBaseUrl: string, value: string, maxAge: number): string {
    let path = "/";
    try {
      path = new URL(publicBaseUrl).pathname.replace(/\/$/, "") || "/";
    } catch {
      // keep "/"
    }
    const secure = publicBaseUrl.startsWith("https://") ? "; Secure" : "";
    return "t2o_admin=" + value + "; Path=" + path + "; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secure;
  };

  private logout = async (req: Request, res: Response) => {
    const state = await this.store.load();
    this.sessions.revoke(parseCookies(req.headers.cookie)["t2o_admin"]);
    res.setHeader("Set-Cookie", this.sessionCookie(state.config.publicBaseUrl, "", 0));
    res.redirect(302, state.config.publicBaseUrl + "/");
  };

  private admin = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const accounts = this.pool.snapshot(state);
    const notice = typeof req.query.notice === "string" ? req.query.notice : req.query.ok ? "Saved successfully." : "";
    const message = notice ? '<div class="flash">' + e(notice) + "</div>" : "";
    const rows = accounts.map((a) => {
      const dot = ["healthy", "ready", "unknown"].includes(String(a.state)) ? "" : a.state === "cooldown" ? "warn" : "bad";
      const probe = a.lastProbeAt
        ? (a.lastProbeOk ? "OK " + e(a.lastProbeStatus || "") : "Failed " + e(a.lastProbeStatus || a.lastProbeError || ""))
        : "Not tested";
      return `<tr><td><strong>${e(a.label)}</strong><div class="tiny muted mono">${e(a.id)}</div></td><td><span class="pill"><span class="dot ${dot}"></span>${e(a.state)}</span></td><td>${a.successes}/${a.requests}</td><td>${e(a.lastStatus || "—")}</td><td>${probe}</td><td><div class="actions"><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/probe"><button class="secondary" type="submit">Test credential</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/toggle"><input type="hidden" name="enabled" value="${a.enabled ? "0" : "1"}"><button class="secondary" type="submit">${a.enabled ? "Disable" : "Enable"}</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/reset"><button class="secondary" type="submit">Reset health</button></form><form class="inline" method="post" action="${e(base)}/admin/accounts/${e(a.id)}/remove" onsubmit="return confirm('Remove this credential?')"><button class="danger" type="submit">Remove</button></form></div></td></tr>`;
    }).join("");

    const strategyOptions = strategies.map((s) => '<option value="' + e(s) + '"' + (state.config.strategy === s ? " selected" : "") + ">" + e(s) + "</option>").join("");

    this.sendAdmin(res, "Admin", `<main class="wrap">${adminNav(base, "pool")}
${message}${renderOverview({ base, strategy: state.config.strategy, upstreamUrl: state.config.upstreamUrl, maxFailoverAttempts: state.config.maxFailoverAttempts, accounts, summary: this.deps.telemetry?.summary(), recent: this.deps.telemetry?.recent({ limit: 40 }) })}<section class="grid">
<div class="card full"><div class="eyebrow">Connection</div><h2>One MCP endpoint for every compatible client</h2><div class="copy">${e(base)}/mcp</div><p class="muted tiny">Add this single URL to ChatGPT, Claude, Codex or any MCP client that supports OAuth. Token2OAuth handles sign-in and pooling; you do not create one connection per upstream account.</p></div>
<div class="card full" id="accounts"><div class="eyebrow">Credential pool</div><h2>Upstream accounts</h2><p class="muted tiny">New tokens are <code>unknown</code> until used. Test credentials sends one authenticated MCP <code>initialize</code> request to each selected account; it does not create a ChatGPT OAuth connection or reveal a token.</p>${rows ? `<div class="actions" style="margin:12px 0"><form class="inline" method="post" action="${e(base)}/admin/accounts/probe-all"><button type="submit">Test all enabled credentials</button></form></div><div style="overflow:auto"><table><thead><tr><th>Account</th><th>State</th><th>Success</th><th>Last HTTP</th><th>Probe</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No bearer credentials have been added yet.</p>'}</div>
</section>
<details class="settings" id="settings"><summary>Routing &amp; upstream settings <span class="tiny muted">${e(state.config.strategy)} · ${e(state.config.upstreamUrl || "no upstream set")}</span></summary><section class="grid">
<div class="card wide"><div class="eyebrow">Upstream</div><h2>MCP target & routing</h2><form method="post" action="${e(base)}/admin/config"><label>Upstream MCP URL</label><input name="upstreamUrl" value="${e(state.config.upstreamUrl)}" placeholder="https://provider.example.com/mcp" required><div class="row"><div><label>Pool strategy</label><select id="pool-strategy" name="strategy" aria-describedby="strategy-definition strategy-example">${strategyOptions}</select></div><div><label for="maxFailoverAttempts">Max failover attempts <span title="${e(parameterHelp.maxFailoverAttempts)}" tabindex="0" aria-label="Help for Max failover attempts">ⓘ</span></label><input type="number" min="1" max="20" id="maxFailoverAttempts" title="${e(parameterHelp.maxFailoverAttempts)}" aria-describedby="maxFailoverAttempts-help" name="maxFailoverAttempts" value="${e(state.config.maxFailoverAttempts)}"><details class="tiny muted"><summary>What does this control?</summary><p id="maxFailoverAttempts-help">${e(parameterHelp.maxFailoverAttempts)}</p></details></div></div><div class="row"><div><label for="quotaCooldownSeconds">Quota cooldown (seconds) <span title="${e(parameterHelp.quotaCooldownSeconds)}" tabindex="0" aria-label="Help for Quota cooldown (seconds)">ⓘ</span></label><input type="number" min="1" id="quotaCooldownSeconds" title="${e(parameterHelp.quotaCooldownSeconds)}" aria-describedby="quotaCooldownSeconds-help" name="quotaCooldownSeconds" value="${e(state.config.quotaCooldownSeconds)}"><details class="tiny muted"><summary>What does this control?</summary><p id="quotaCooldownSeconds-help">${e(parameterHelp.quotaCooldownSeconds)}</p></details></div><div><label for="requestTimeoutMs">Request timeout (ms) <span title="${e(parameterHelp.requestTimeoutMs)}" tabindex="0" aria-label="Help for Request timeout (ms)">ⓘ</span></label><input type="number" min="1000" id="requestTimeoutMs" title="${e(parameterHelp.requestTimeoutMs)}" aria-describedby="requestTimeoutMs-help" name="requestTimeoutMs" value="${e(state.config.requestTimeoutMs)}"><details class="tiny muted"><summary>What does this control?</summary><p id="requestTimeoutMs-help">${e(parameterHelp.requestTimeoutMs)}</p></details></div></div><button type="submit">Save gateway settings</button></form></div>
<div class="card" aria-live="polite"><div class="eyebrow">Selected strategy</div><h3 id="strategy-title">${e(strategyHelp[state.config.strategy].title)}</h3><p class="muted tiny" id="strategy-definition">${e(strategyHelp[state.config.strategy].definition)}</p><strong class="tiny">Example use case</strong><p class="muted tiny" id="strategy-example">${e(strategyHelp[state.config.strategy].example)}</p><p class="muted tiny">Every strategy keeps an established MCP session, and tasks it started, on the credential that created them.</p></div>
</section></details>
<details class="settings" id="add-credential"${accounts.length ? "" : " open"}><summary>Add an upstream credential <span class="tiny muted">encrypted at rest</span></summary><section class="grid">
<div class="card full"><div class="eyebrow">Add credential</div><h2>Add an upstream bearer token</h2><p class="muted tiny">The token is AES-256-GCM encrypted before it is written to disk. It is never rendered back into this page.</p><form method="post" action="${e(base)}/admin/accounts"><div class="row"><div><label>Label</label><input name="label" placeholder="LightSprint Pro #1" required></div><div><label>Provider / preset</label><input name="provider" value="generic-bearer-mcp"></div></div><label>Bearer token</label><input type="password" name="token" autocomplete="off" required><div class="row"><div><label>Weight</label><input type="number" step="0.1" min="0.1" name="weight" value="1"></div><div><label>Priority (lower first)</label><input type="number" name="priority" value="100"></div></div><button type="submit">Encrypt & add credential</button></form></div>
</section></details><script>
const help = ${JSON.stringify(strategyHelp).replaceAll("<", "\\u003c")};
const strategySelect = document.getElementById("pool-strategy");
strategySelect.addEventListener("change", () => {
  const selected = help[strategySelect.value];
  if (!selected) return;
  document.getElementById("strategy-title").textContent = selected.title;
  document.getElementById("strategy-definition").textContent = selected.definition;
  document.getElementById("strategy-example").textContent = selected.example;
});
</script><div class="footer">Secrets: ${e(this.store.dir)} · Public base: ${e(base)}</div></main>`);
  };

  private addAccount = async (req: Request, res: Response) => {
    const token = String(req.body.token || "").trim();
    if (!token) return res.status(400).send("token required");
    const base = await this.base();
    await this.store.addAccount({
      label: String(req.body.label || "Account").slice(0, 120),
      token,
      provider: String(req.body.provider || "generic-bearer-mcp").slice(0, 80),
      weight: Number(req.body.weight || 1),
      priority: Number(req.body.priority || 100),
    });
    res.redirect(303, base + "/admin?ok=1");
  };

  private toggleAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.setAccountEnabled(String(req.params.id), String(req.body.enabled) === "1");
    res.redirect(303, base + "/admin?ok=1");
  };

  private resetAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.resetAccountHealth(String(req.params.id));
    res.redirect(303, base + "/admin?ok=1");
  };

  private probeAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    const result = await this.pool.probeAccount(String(req.params.id));
    const notice = result.ok
      ? result.label + " passed authenticated MCP probe (HTTP " + result.status + ")."
      : result.label + " probe failed: " + (result.error || "unknown error") + ".";
    res.redirect(303, base + "/admin?notice=" + encodeURIComponent(notice));
  };

  private probeAll = async (_req: Request, res: Response) => {
    const base = await this.base();
    const results = await this.pool.probeAll();
    const passed = results.filter((result) => result.ok).length;
    res.redirect(303, base + "/admin?notice=" + encodeURIComponent("Tested " + results.length + " enabled credentials: " + passed + " passed, " + (results.length - passed) + " failed."));
  };

  private removeAccount = async (req: Request, res: Response) => {
    const base = await this.base();
    await this.store.removeAccount(String(req.params.id));
    res.redirect(303, base + "/admin?ok=1");
  };

  private saveConfig = async (req: Request, res: Response) => {
    const base = await this.base();
    const strategy = strategies.includes(req.body.strategy as PoolStrategy)
      ? (req.body.strategy as PoolStrategy)
      : "adaptive-sticky";
    await this.store.update((state) => {
      state.config.upstreamUrl = String(req.body.upstreamUrl || "").trim();
      state.config.strategy = strategy;
      state.config.maxFailoverAttempts = Math.max(1, Math.min(20, Number(req.body.maxFailoverAttempts || 3)));
      state.config.quotaCooldownSeconds = Math.max(1, Number(req.body.quotaCooldownSeconds || 900));
      state.config.requestTimeoutMs = Math.max(1000, Number(req.body.requestTimeoutMs || 120000));
    });
    res.redirect(303, base + "/admin?ok=1");
  };
  private tools = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const notice = typeof req.query.notice === "string" ? req.query.notice : undefined;
    this.sendAdmin(res, "Tools", renderToolsPage({ base, state, catalog: toolCatalog(state), notice }));
  };

  /**
   * Persist the enabled-tool selection as denyTools. Allowlists and endpoint
   * rules managed from the CLI are preserved untouched. Denials of tools not
   * in the current inventory are kept, so a tool that temporarily disappears
   * upstream is not silently re-enabled when it returns.
   */
  private saveToolPolicy = async (req: Request, res: Response) => {
    const base = await this.base();
    const list = (value: unknown): string[] =>
      (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String).filter((v) => v.length > 0 && v.length <= 128);
    const enabled = new Set(list(req.body.enabled));
    const readOnly = list(req.body.readOnly);
    let message = "Tool policy saved.";
    await this.store.update((state) => {
      const catalogNames = toolCatalog(state).map((t) => t.name);
      const previous = state.config.toolPolicy;
      const keptDenied = (previous?.denyTools || []).filter((name) => !catalogNames.includes(name));
      const denyTools = [...new Set([...keptDenied, ...catalogNames.filter((name) => !enabled.has(name))])].sort();
      const next: ToolPolicy = { ...(previous || {}), denyTools };
      if (!denyTools.length) delete next.denyTools;
      const empty = !next.denyTools && !next.allowTools && !next.endpoints?.length;
      // Never persist a policy the proxy would refuse to compile (that would
      // fail every MCP request closed); throwing aborts the update.
      if (!empty) compileToolPolicy(next);
      state.config.toolPolicy = empty ? undefined : next;
      const readOnlySet = [...new Set(readOnly.filter((name) => catalogNames.includes(name)))].sort();
      state.config.readOnlyTools = readOnlySet.length ? readOnlySet : undefined;
      message = `Tool policy saved: ${denyTools.length} tool${denyTools.length === 1 ? "" : "s"} blocked, ${readOnlySet.length} marked replay-safe.`;
    });
    res.redirect(303, base + "/admin/tools?notice=" + encodeURIComponent(message));
  };

  private refreshTools = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const requested = typeof req.body.accountId === "string" ? req.body.accountId : undefined;
    const targets = state.accounts.filter((a) => a.enabled && (!requested || a.id === requested));
    let ok = 0;
    // Sequential on purpose: avoid a burst of upstream sessions.
    for (const account of targets) {
      const result = await refreshAccountCapabilities(this.store, account.id, this.deps.telemetry);
      if (result.ok) ok += 1;
    }
    const notice = targets.length
      ? `Refreshed ${targets.length} account inventor${targets.length === 1 ? "y" : "ies"}: ${ok} succeeded, ${targets.length - ok} failed.`
      : "No enabled account matched.";
    res.redirect(303, base + "/admin/tools?notice=" + encodeURIComponent(notice));
  };

  private diagnostics = async (req: Request, res: Response) => {
    const posted = req.method === "POST";
    const checks = {
      live: posted && req.body.live === "1",
      funnel: posted && req.body.funnel === "1",
      publicMetadata: posted && req.body.publicMetadata === "1",
    };
    const telemetry = this.deps.telemetry;
    const snapshot = await collectDoctorSnapshot(this.store, this.pool, {
      inProcess: true,
      live: checks.live,
      publicMetadata: checks.publicMetadata,
      telemetry,
    });
    let lifecycle: Parameters<typeof renderDiagnosticsPage>[0]["lifecycle"];
    if (checks.funnel) {
      try {
        const controller = new LifecycleController(createExecFileRunner(15_000));
        const observed = await controller.observe();
        const up = planUp(observed);
        lifecycle = { status: await controller.status(), upCommands: up.steps.map(renderCommand), upBlockers: up.blockers };
        const routes = observed.routes;
        snapshot.funnel = {
          checked: true,
          enabled: routes.funnel,
          expectedPath: routes.root.target === "http://127.0.0.1:2030" ? "/" : controller.routes.ownedPath,
          reportedCollision: routes.owned.state === "collision",
          mounts: Object.entries((routes.hostPort && effectiveServeConfig(observed.serveConfig).Web?.[routes.hostPort]?.Handlers) || {}).map(([path, handler]) => {
            try {
              const target = new URL(String(handler.Proxy));
              return { path, targetHost: target.hostname, targetPort: Number(target.port) || undefined };
            } catch {
              return { path };
            }
          }),
        };
      } catch (error: any) {
        lifecycle = { error: "Could not read the service or Tailscale status: " + String(error?.message || error).slice(0, 200) };
      }
    }
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const empty = { recorded: 0, retained: 0, dropped: 0, providerRetained: 0 };
    this.sendAdmin(res, "Diagnostics", renderDiagnosticsPage({
      base,
      state,
      summary: telemetry ? telemetry.summary() : emptySummary(),
      recent: telemetry ? telemetry.recent({ limit: 60 }) : [],
      stats: telemetry ? telemetry.stats() : empty,
      report: diagnoseDoctorSnapshot(snapshot),
      checks,
      providerUsage: telemetry ? telemetry.latestProviderUsage() : [],
      lifecycle,
      ownership: this.pool.ownership.size(),
    }));
  };

  private diagnosticsJson = async (_req: Request, res: Response) => {
    const telemetry = this.deps.telemetry;
    const snapshot = await collectDoctorSnapshot(this.store, this.pool, { inProcess: true });
    res.json({
      doctor: diagnoseDoctorSnapshot(snapshot),
      telemetry: telemetry
        ? { stats: telemetry.stats(), summary: telemetry.summary(), recent: telemetry.recent({ limit: 100 }), providerUsage: telemetry.latestProviderUsage() }
        : null,
      ownership: this.pool.ownership.size(),
    });
  };

  private security = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    const notice = typeof req.query.notice === "string" ? req.query.notice : undefined;
    this.sendAdmin(res, "Security", renderSecurityPage(base, state, notice));
  };

  /**
   * Regenerate the admin password. The new value exists only in this response
   * body (marked no-store) and in the hash written to state; it is never put
   * in a URL, a log line or a redirect.
   */
  private rotatePassword = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const base = state.config.publicBaseUrl.replace(/\/$/, "");
    if (!verifyPassword(String(req.body.currentPassword || ""), state.admin)) {
      return res.redirect(303, base + "/admin/security?notice=" + encodeURIComponent("Current password did not match. Nothing was changed."));
    }
    const revokeConnections = req.body.revokeConnections === "1";
    const password = generateAdminPassword();
    await this.store.rotateAdminPassword(password, { revokeConnections });
    this.sessions.revokeAll();
    this.deps.oauth?.revokeAuthorizationCodes();
    res.setHeader("Set-Cookie", this.sessionCookie(state.config.publicBaseUrl, "", 0));
    res.type("html").send(page("New admin password", renderRotatedPage(base, password, revokeConnections)));
  };
}

export interface OverviewAccount { id: string; label: string; provider?: string; enabled: boolean; state: string; requests: number; successes: number; failures: number; active?: number; cooldownUntil?: number }

export interface OverviewInput {
  base: string;
  strategy: string;
  upstreamUrl: string;
  maxFailoverAttempts: number;
  accounts: readonly OverviewAccount[];
  summary?: GatewaySummary;
  recent?: readonly GatewayEvent[];
  now?: number;
}

/** Bucket pool snapshot rows into operator-facing states. Disabled wins over health. */
export function accountBuckets(accounts: readonly OverviewAccount[]) {
  const b = { healthy: 0, depleted: 0, failing: 0, disabled: 0, unknown: 0 };
  for (const a of accounts) {
    if (!a.enabled || a.state === "disabled") b.disabled += 1;
    else if (a.state === "healthy" || a.state === "ready") b.healthy += 1;
    else if (a.state === "exhausted" || a.state === "cooldown") b.depleted += 1;
    else if (a.state === "auth-failed") b.failing += 1;
    else b.unknown += 1;
  }
  return b;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toISOString().slice(0, 10);
}

const strategyPhrase: Record<string, string> = {
  "adaptive-sticky": "scores eligible credentials by load and recent failures, then keeps each MCP session on the credential that started it",
  "round-robin": "rotates new sessions through eligible credentials in order",
  "least-used": "sends new sessions to the credential with the fewest weighted requests",
  "weighted-random": "picks eligible credentials at random in proportion to their weight",
  random: "picks any eligible credential uniformly",
  priority: "uses the lowest-priority-number eligible credential first",
};

/** Operational overview for the primary admin page. Every figure comes from the pool snapshot or gateway telemetry; absent data is labelled, never zero-filled. */
export function renderOverview(input: OverviewInput): string {
  const now = input.now ?? Date.now();
  const accounts = input.accounts;
  const b = accountBuckets(accounts);
  const total = accounts.length;
  const usable = b.healthy + b.unknown;
  const verdict = total === 0 ? ["warn", "No credentials in the pool"]
    : usable === 0 ? ["bad", "No credential can take new sessions"]
    : b.depleted + b.failing > 0 ? ["warn", `${usable} of ${total} credentials can route; ${b.depleted + b.failing} need attention`]
    : ["", `${usable} of ${total} credentials can route`];
  const tel = input.summary?.total;
  const observed = tel && tel.count > 0 ? tel : undefined;
  const reqs = input.summary?.by?.kind?.request;
  const pct = (n: number) => `${(n / total * 100).toFixed(2)}%`;
  const bar = total ? `<div class="bar" role="img" aria-label="${b.healthy} healthy, ${b.unknown} untested, ${b.depleted} depleted or cooling down, ${b.failing} auth failed, ${b.disabled} disabled of ${total}">${[["ok", b.healthy], ["off", b.unknown], ["warn", b.depleted], ["bad", b.failing], ["off", b.disabled]].filter(([, n]) => n).map(([c, n]) => `<i class="${c}" style="width:${pct(n as number)}"></i>`).join("")}</div><div class="legend"><span><span class="dot"></span>${b.healthy} healthy</span><span>${b.unknown} untested</span><span><span class="dot warn"></span>${b.depleted} depleted / cooldown</span><span><span class="dot bad"></span>${b.failing} auth failed</span><span>${b.disabled} disabled</span></div>` : "";
  const cell = (label: string, value: string, note: string, cls = "") => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd><small>${note}</small></div>`;
  const ledger = `<dl class="ledger" aria-label="Gateway status">${
    cell("Routable", total ? `${usable}<span class="muted" style="font-size:.55em"> / ${total}</span>` : "None", "healthy or untested, enabled", usable === 0 ? "bad" : "")}${
    cell("Needs attention", String(b.depleted + b.failing), "depleted, cooling down or auth failed", b.depleted + b.failing ? "attn" : "")}${
    cell("Requests seen", observed ? String(reqs?.count ?? observed.count) : "Not observed yet", observed ? `in this process, since ${input.summary?.window.from ? ago(input.summary.window.from, now) : "start"}` : "telemetry starts at process start")}${
    observed ? cell("Success", `${((1 - observed.errorRate) * 100).toFixed(1)}%`, `${observed.success} ok · ${observed.error} errors · ${observed.retries} retries`, observed.errorRate > .1 ? "attn" : "") : cell("Success", "Not observed", "no completed requests", "unknown")}${
    observed && observed.latency.p50 !== null ? cell("Latency p50 / p95", `${Math.round(observed.latency.p50)}<span class="muted" style="font-size:.55em"> / ${Math.round(observed.latency.p95 ?? observed.latency.p50)} ms</span>`, `${observed.latency.count} timed requests`) : cell("Latency", "Not observed", "no timed requests yet", "unknown")}${
    cell("Quota / capacity", "Unknown", "providers report no remaining quota; only 402/429 signals", "unknown")}</dl>`;
  const host = (() => { try { return new URL(input.upstreamUrl).host; } catch { return input.upstreamUrl || "an unconfigured upstream"; } })();
  const narrative = `<p class="narrative">A client opens <strong>one MCP connection</strong> at <code>${e(input.base)}/mcp</code> and signs in with OAuth. The gateway forwards to <strong>${e(host)}</strong> and ${e(strategyPhrase[input.strategy] ?? `uses the ${input.strategy} strategy`)}. ${total ? `It can choose among <strong>${usable}</strong> routable credential${usable === 1 ? "" : "s"}` : "It has no credentials to choose from yet"}${b.depleted ? `; <strong>${b.depleted}</strong> ${b.depleted === 1 ? "is" : "are"} waiting out a quota cooldown` : ""}. A failed request may retry on another credential up to <strong>${e(input.maxFailoverAttempts)}</strong> time${input.maxFailoverAttempts === 1 ? "" : "s"}; established sessions do not move.</p>`;
  const label = new Map(accounts.map((a) => [a.id, a.label]));
  const recent = (input.recent ?? []).filter((ev) => ev.kind === "request" || ev.kind === "attempt").slice(0, 8);
  const list = recent.length ? `<ol class="reqs">${recent.map((ev) => `<li><time datetime="${new Date(ev.at).toISOString()}">${ago(ev.at, now)}</time><span class="what"><strong>${e(ev.tool || ev.method || ev.kind)}</strong>${ev.accountId ? ` <span class="muted">via ${e(label.get(ev.accountId) ?? ev.accountId)}</span>` : ""}${ev.outcome === "error" ? ` <span class="err">${e(ev.status ?? ev.errorClass ?? "error")}</span>` : ev.status ? ` <span class="muted">${e(ev.status)}</span>` : ""}${ev.retries ? ` <span class="muted">· ${ev.retries} retr${ev.retries === 1 ? "y" : "ies"}</span>` : ""}</span><span class="lat">${ev.latencyMs !== undefined ? `${Math.round(ev.latencyMs)} ms` : ""}</span></li>`).join("")}</ol>` : `<p class="empty">No requests observed since this gateway process started.</p>`;
  return `<header class="ops-head"><div><div class="eyebrow">Gateway overview</div><h1>Credential gateway</h1><div class="verdict"><span class="dot ${verdict[0]}"></span>${e(verdict[1])}</div></div><div class="actions"><a class="btn" href="${e(input.base)}/admin/supervisor">Open supervisor</a><a class="btn secondary" href="#accounts">Accounts</a><a class="btn secondary" href="#settings">Routing settings</a></div></header>${ledger}<section class="grid"><div class="card wide"><div class="eyebrow">Routing, as configured now</div>${narrative}${bar}</div><div class="card"><div class="eyebrow">Recent requests</div>${list}</div></section>`;
}

function emptySummary(): GatewaySummary {
  return new TelemetryRecorder({ capacity: 1 }).summary();
}
