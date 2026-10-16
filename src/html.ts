/** Shared HTML helpers for the admin console. Every dynamic value must pass through esc(). */

export function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** ROTOXY mark: a rotor ring with one routed spoke entering a supervised hub. Authored here (MIT predecessor name, new geometry); stroke uses currentColor. */
export const ROTOXY_MARK_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M38.5 15.5A17 17 0 1 0 41 24"/><path d="M41 12.5v6h-6"/><path d="M8 24h9"/></g><circle cx="24" cy="24" r="5.2" fill="#0f7b6c"/></svg>`;

/** Favicon: rotor + hub on a solid tile for 16px legibility. */
export const ROTOXY_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#16191d"/><g fill="none" stroke="#f5f3ee" stroke-width="4" stroke-linecap="round"><path d="M37 16A15 15 0 1 0 39 24"/><path d="M39 12v6h-6"/></g><circle cx="24" cy="24" r="5.5" fill="#4fd1b8"/></svg>`;

export interface NavItem { key: string; label: string; href: string }
export interface NavGroup { label: string; items: readonly NavItem[] }

/**
 * Shared ROTOXY workspace navigation. Entries without a route are deliberately
 * rendered as unavailable text; never send an operator to a fabricated page.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Command", items: [{ key: "agents", label: "Agent workspace", href: "/admin/agents" }, { key: "pool", label: "Overview", href: "/admin" }, { key: "jobs", label: "Jobs", href: "/admin/jobs" }, { key: "supervisor", label: "Supervisor", href: "/admin/supervisor" }] },
  { label: "Resources", items: [
    { key: "accounts", label: "Agent providers", href: "/admin#accounts" },
    { key: "models", label: "Models & APIs", href: "/admin/models" },
    { key: "codex", label: "ChatGPT accounts", href: "/admin/codex" },
    { key: "oracle", label: "Private workers", href: "/admin/oracle" },
    { key: "resources", label: "Search", href: "/admin/resources" },
    { key: "credits", label: "Usage & credits", href: "/admin/credits" },
  ] },
  { label: "Settings", items: [{ key: "clients", label: "Clients", href: "/admin/models" }, { key: "tools", label: "Tools", href: "/admin/tools" }, { key: "security", label: "Auth", href: "/admin/security" }, { key: "routing", label: "Routing", href: "/admin/routing" }, { key: "diagnostics", label: "Diagnostics", href: "/admin/diagnostics" }] },
];

export function adminNav(base: string, active: string, groups: readonly NavGroup[] = NAV_GROUPS): string {
  const b = esc(base);
  const navActive = ["cloudflare", "inference"].includes(active) ? "models" : active;
  const labels: Record<string, string> = { cloudflare: "Cloudflare Workers AI", inference: "Inference accounts", codex: "ChatGPT & Codex accounts", workspace: "Resource map" };
  const current = labels[active] ?? groups.flatMap((group) => group.items).find((item) => item.key === navActive)?.label ?? active;
  const link = (item: NavItem) => item.href
    ? `<a class="nav-link" href="${b}${esc(item.href)}"${navActive === item.key ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`
    : `<span class="nav-link nav-unavailable" aria-disabled="true" title="${item.key === "jobs" ? "No standalone jobs page is mounted yet" : "Analytics is available as an authenticated JSON endpoint"}">${esc(item.label)}<small>${item.key === "jobs" ? "Unavailable" : "API only"}</small></span>`;
  const nav = groups.map((g) => {
    const items = g.items.filter(item => item.href);
    const links = items.map(link).join("");
    const selected = items.some(item => item.key === navActive);
    if (g.label === "Resources" || g.label === "Settings") return `<details class="nav-group nav-disclosure"${selected ? " open" : ""}><summary class="nav-group-toggle">${esc(g.label)}<span aria-hidden="true">⌄</span></summary><div class="nav-group-items">${links}</div></details>`;
    return `<section class="nav-group" aria-labelledby="nav-${esc(g.label.toLowerCase())}"><h2 class="nav-label" id="nav-${esc(g.label.toLowerCase())}">${esc(g.label)}</h2>${links}</section>`;
  }).join("");
  const actions = `<div class="rx-sidebar-end"><a class="btn secondary" href="${b}/">Gateway</a><form class="inline" method="post" action="${b}/admin/logout"><button class="secondary">Sign out</button></form></div>`;
  return `<a class="rx-skip-link" href="#rx-main-content">Skip to content</a><aside class="rx-sidebar" aria-label="ROTOXY workspace navigation"><a class="brand" href="${b}/admin" aria-label="ROTOXY admin home"><span class="logo">${ROTOXY_MARK_SVG}</span><span><strong>ROTOXY</strong><span class="eyebrow">AI workforce control</span></span></a><div class="rx-workspace-id"><span class="eyebrow">Workspace</span><strong>Gateway workspace</strong></div><div class="rx-desktop-nav"><nav class="rx-nav-groups" aria-label="Workspace navigation">${nav.replaceAll('id="nav-', 'id="desktop-nav-').replaceAll('aria-labelledby="nav-', 'aria-labelledby="desktop-nav-')}</nav>${actions}</div><details class="rx-nav-details"><summary class="rx-mobile-menu">Menu <span aria-hidden="true">⌄</span></summary><div class="rx-nav-content"><nav class="rx-nav-groups" aria-label="Workspace navigation">${nav}</nav>${actions}</div></details></aside><header class="rx-page-context"><div><span class="eyebrow">Current page</span><strong class="rx-current-page">${esc(current)}</strong></div></header>`;
}

/** Inject the session CSRF token into every POST form of an admin page. */
export function withCsrf(html: string, csrf: string): string {
  return html.replace(/(<form\b[^>]*\bmethod="post"[^>]*>)/gi, `$1<input type="hidden" name="_csrf" value="${esc(csrf)}">`);
}
