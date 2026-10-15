/** Shared, server-rendered ROTOXY application chrome. Existing page routes and auth remain owned by their routers. */
import { ROTOXY_MARK_SVG } from "./html.js";

export interface AppShellLink {
  key: string;
  label: string;
  href?: string;
  available: boolean;
  note?: string;
}

export interface AppShellGroup {
  label: string;
  items: readonly AppShellLink[];
}

export interface AppShellOptions {
  base?: string;
  active: string;
  pageTitle: string;
  workspaceName?: string;
  content: string;
}

const esc = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

/** Only routes backed by an existing HTML page are links. The others stay visible but inert. */
export const APP_SHELL_GROUPS: readonly AppShellGroup[] = [
  { label: "Command", items: [
    { key: "overview", label: "Overview", href: "/admin", available: true },
    { key: "jobs", label: "Jobs", available: false, note: "No standalone jobs page is mounted yet." },
    { key: "supervisor", label: "Supervisor", href: "/admin/supervisor", available: true },
  ] },
  { label: "Resources", items: [
    { key: "accounts", label: "Workspace accounts", href: "/admin#accounts", available: true },
    { key: "models", label: "Models", href: "/admin/models", available: true },
    { key: "private-workers", label: "Private workers", href: "/admin/oracle", available: true },
    { key: "search", label: "Search", href: "/admin/resources", available: true },
  ] },
  { label: "Insights", items: [
    { key: "activity", label: "Activity", href: "/admin", available: true },
    { key: "analytics", label: "Analytics", available: false, note: "Analytics is currently an authenticated JSON endpoint, not a page." },
  ] },
  { label: "Settings", items: [
    { key: "clients", label: "Clients", href: "/admin/models", available: true, note: "Client tokens are managed on Models & APIs." },
    { key: "auth", label: "Auth", href: "/admin/security", available: true },
    { key: "diagnostics", label: "Diagnostics", href: "/admin/diagnostics", available: true },
  ] },
];

export const APP_SHELL_CSS = String.raw`
:root{color-scheme:light dark;--rx-ink:#172423;--rx-muted:#64716e;--rx-paper:#f3f4ef;--rx-surface:#fffefa;--rx-rail:#173a37;--rx-rail-ink:#edf4ef;--rx-rail-muted:#b3c9c0;--rx-active:#28524c;--rx-signal:#0f7b6c;--rx-line:#d8ddd5;--rx-focus:#d4832f;--rx-rail-width:252px;font:15px/1.5 "Inter","Segoe UI",system-ui,-apple-system,sans-serif}
@media(prefers-color-scheme:dark){:root{--rx-ink:#e6ece7;--rx-muted:#a4b1ac;--rx-paper:#111817;--rx-surface:#18211f;--rx-rail:#0c211f;--rx-rail-ink:#e7f0ea;--rx-rail-muted:#a0b7ad;--rx-active:#244b44;--rx-line:#2d3a36;--rx-signal:#52c7b0;--rx-focus:#efb66b}}
*,*::before,*::after{box-sizing:border-box}
.rx-app-shell{display:grid;grid-template-columns:var(--rx-rail-width) minmax(0,1fr);min-height:100vh;background:var(--rx-paper);color:var(--rx-ink)}
.rx-app-shell a{color:inherit;text-decoration:none}
.rx-skip{position:absolute;top:8px;left:8px;z-index:100;transform:translateY(-160%);padding:8px 12px;background:var(--rx-surface);color:var(--rx-ink)!important;border:2px solid var(--rx-focus);border-radius:4px}
.rx-skip:focus{transform:translateY(0)}
.rx-nav-details{position:sticky;top:0;align-self:start;height:100vh;background:var(--rx-rail);color:var(--rx-rail-ink)}
.rx-nav-details:not([open])>.rx-sidebar{display:flex}
.rx-mobile-menu{display:none}
.rx-sidebar{height:100%;display:flex;flex-direction:column;min-width:0;padding:20px 14px 14px;overflow:auto}
.rx-brand{display:flex;align-items:center;gap:11px;padding:0 10px 18px;border-bottom:1px solid rgba(237,244,239,.15);color:var(--rx-rail-ink)!important}
.rx-brand-mark{display:grid;place-items:center;width:38px;height:38px;flex:0 0 auto;border:1px solid rgba(237,244,239,.22);border-radius:10px;color:#d7ece2}
.rx-brand-mark svg{display:block;width:28px;height:28px}
.rx-brand-name{display:block;font-size:16px;font-weight:720;letter-spacing:.02em}
.rx-workspace{display:flex;gap:10px;align-items:center;margin:14px 2px 12px;padding:11px 10px;border-radius:6px;background:rgba(237,244,239,.08);min-width:0}
.rx-workspace-mark{display:grid;place-items:center;width:28px;height:28px;flex:0 0 auto;border-radius:5px;background:#d6eee4;color:#163a35;font-size:11px;font-weight:750}
.rx-workspace-copy{min-width:0}.rx-workspace-copy small{display:block;color:var(--rx-rail-muted);font-size:10px;letter-spacing:.04em}.rx-workspace-copy strong{display:block;overflow-wrap:anywhere;font-size:12.5px;font-weight:620}
.rx-nav-groups{display:grid;align-content:start;gap:15px;padding-top:3px}
.rx-nav-group{display:grid;gap:2px;min-width:0}
.rx-nav-label{padding:3px 10px 5px;color:var(--rx-rail-muted);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.rx-nav-link,.rx-nav-unavailable{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:6px 10px;border-left:2px solid transparent;border-radius:0 4px 4px 0;font-size:13px;line-height:1.3;overflow-wrap:anywhere}
.rx-nav-link:hover{background:rgba(237,244,239,.09)}
.rx-nav-link[aria-current=page]{background:var(--rx-active);border-left-color:#71d5bd;color:#fff;font-weight:650}
.rx-nav-unavailable{color:#c0cdc6;opacity:.64;cursor:default}
.rx-nav-status{flex:0 0 auto;color:var(--rx-rail-muted);font-size:10px}
.rx-nav-footer{margin-top:auto;padding:14px 10px 0;border-top:1px solid rgba(237,244,239,.15);color:var(--rx-rail-muted);font-size:11px}
.rx-nav-details a:focus-visible,.rx-nav-details summary:focus-visible,.rx-main a:focus-visible,.rx-mobile-menu:focus-visible{outline:2px solid var(--rx-focus);outline-offset:3px}
.rx-main{min-width:0}
.rx-topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:18px;min-height:66px;padding:10px clamp(18px,3vw,42px);background:color-mix(in srgb,var(--rx-paper) 94%,transparent);border-bottom:1px solid var(--rx-line);backdrop-filter:blur(10px)}
.rx-page-identity{display:flex;align-items:center;gap:10px;min-width:0;margin-left:auto}
.rx-current-label{display:block;color:var(--rx-muted);font-size:10px;line-height:1.2;text-transform:uppercase;letter-spacing:.08em}
.rx-current-page{display:block;max-width:min(46vw,520px);overflow-wrap:anywhere;font-size:14px;font-weight:650}
.rx-content{min-width:0;padding:22px clamp(18px,3vw,42px) 48px}
.rx-mobile-menu{min-height:38px;padding:6px 12px;border:1px solid var(--rx-line);border-radius:4px;background:var(--rx-surface);color:var(--rx-ink);font:inherit;font-weight:620;cursor:pointer;list-style:none}
.rx-mobile-menu::-webkit-details-marker{display:none}
.rx-backdrop{display:none}
@media(max-width:900px){:root{--rx-rail-width:226px}.rx-nav-groups{gap:11px}.rx-topbar{min-height:60px}}
@media(max-width:720px){.rx-app-shell{display:block}.rx-nav-details{position:static;height:auto;background:transparent;color:var(--rx-ink)}.rx-mobile-menu{position:fixed;top:10px;left:10px;z-index:42;display:block}.rx-nav-details:not([open])>.rx-sidebar{display:none}.rx-nav-details[open]>.rx-sidebar{position:fixed;inset:0 auto 0 0;z-index:41;display:flex;width:min(300px,86vw);height:100dvh;box-shadow:12px 0 32px rgba(0,0,0,.25)}.rx-nav-details[open]::after{content:"";position:fixed;inset:0;z-index:40;background:rgba(8,18,16,.58)}.rx-nav-details[open]>.rx-mobile-menu{background:var(--rx-rail);border-color:rgba(255,255,255,.3);color:var(--rx-rail-ink)}.rx-topbar{padding-left:92px}.rx-page-identity{margin-left:auto}.rx-current-page{max-width:55vw}.rx-content{padding-top:17px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`;

function normalizeBase(value?: string): string {
  if (!value || value === "/") return "";
  const absolute = /^https?:\/\//i.test(value);
  if (!absolute && (!value.startsWith("/") || value.startsWith("//"))) return "";
  try {
    const parsed = new URL(value, "https://rotoxy.invalid");
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !/^https?:$/.test(parsed.protocol)) return "";
    const origin = parsed.origin === "https://rotoxy.invalid" ? "" : parsed.origin;
    if (!absolute && origin) return "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return origin + path;
  } catch { return ""; }
}

function renderNavigation(base: string, active: string, workspace: string): string {
  const groups = APP_SHELL_GROUPS.map((group) => `<section class="rx-nav-group" role="group" aria-label="${esc(group.label)}"><div class="rx-nav-label">${esc(group.label)}</div>${group.items.map((item) => item.available && item.href
    ? `<a class="rx-nav-link" href="${esc(base + item.href)}"${active === item.key ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`
    : `<span class="rx-nav-unavailable" aria-disabled="true" title="${esc(item.note || "This page is not available yet.")}">${esc(item.label)}<small class="rx-nav-status">Unavailable</small></span>`).join("")}</section>`).join("");
  return `<details class="rx-nav-details"><summary class="rx-mobile-menu" aria-label="Toggle navigation menu">Menu</summary><aside class="rx-sidebar" id="app-navigation"><a class="rx-brand" href="${esc(base)}/admin" aria-label="ROTOXY overview"><span class="rx-brand-mark">${ROTOXY_MARK_SVG}</span><span class="rx-brand-name">ROTOXY</span></a><div class="rx-workspace"><span class="rx-workspace-mark" aria-hidden="true">RO</span><span class="rx-workspace-copy"><small>WORKSPACE</small><strong>${esc(workspace)}</strong></span></div><nav class="rx-nav-groups" aria-label="Workspace navigation">${groups}</nav><div class="rx-nav-footer">Token2OAuth gateway</div></aside></details>`;
}

/** Wrap trusted server-rendered page content without changing its routes, forms, auth, or state semantics. */
export function renderAppShell(options: AppShellOptions): string {
  const base = normalizeBase(options.base);
  const workspace = options.workspaceName?.trim() || "Token2OAuth workspace";
  const nav = renderNavigation(base, options.active, workspace);
  return `<style>${APP_SHELL_CSS}</style><div class="rx-app-shell" id="rotoxy-app-shell"><a class="rx-skip" href="#app-main-content">Skip to content</a>${nav}<div class="rx-main"><header class="rx-topbar"><div class="rx-page-identity"><span><small class="rx-current-label">Current page</small><strong class="rx-current-page">${esc(options.pageTitle)}</strong></span></div></header><div class="rx-content" id="app-main-content" tabindex="-1">${options.content}</div></div></div>`;
}
