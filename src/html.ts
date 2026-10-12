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
 * Grouped admin navigation. Only routes that exist today are linked; root adds
 * Jobs, Oracle, Search and Clients items here when their pages are wired.
 * Every legacy URL is unchanged.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Workspace", items: [{ key: "pool", label: "Pool", href: "/admin" }] },
  { label: "Providers", items: [{ key: "accounts", label: "Accounts", href: "/admin#accounts" }, { key: "credits", label: "Credits", href: "/admin/credits" }] },
  { label: "Models & APIs", items: [{ key: "models", label: "Models", href: "/admin/models" }, { key: "resources", label: "Search", href: "/admin/resources" }, { key: "codex", label: "Codex", href: "/admin/codex" }, { key: "tools", label: "Tools", href: "/admin/tools" }] },
  { label: "Operations", items: [{ key: "supervisor", label: "Supervisor", href: "/admin/supervisor" }, { key: "oracle", label: "Oracle", href: "/admin/oracle" }] },
  { label: "Platform", items: [{ key: "security", label: "Security", href: "/admin/security" }, { key: "diagnostics", label: "Diagnostics", href: "/admin/diagnostics" }] },
];

export function adminNav(base: string, active: string, groups: readonly NavGroup[] = NAV_GROUPS): string {
  const b = esc(base);
  const link = (item: NavItem) =>
    `<a class="nav-link" href="${b}${esc(item.href)}"${active === item.key ? ' aria-current="page"' : ""}>${esc(item.label)}</a>`;
  const nav = groups.map((g) => `<div class="nav-group" role="group" aria-label="${esc(g.label)}"><span class="nav-label">${esc(g.label)}</span>${g.items.map(link).join("")}</div>`).join("");
  return `<header class="topbar"><a class="brand" href="${b}/admin" aria-label="ROTOXY admin home"><div class="logo">${ROTOXY_MARK_SVG}</div><div><strong>ROTOXY</strong><div class="eyebrow">Token2OAuth gateway</div></div></a><nav class="groups" aria-label="Admin">${nav}</nav><div class="topbar-end"><a class="btn secondary" href="${b}/">Gateway</a><form class="inline" method="post" action="${b}/admin/logout"><button class="secondary">Sign out</button></form></div></header>`;
}

/** Inject the session CSRF token into every POST form of an admin page. */
export function withCsrf(html: string, csrf: string): string {
  return html.replace(/(<form\b[^>]*\bmethod="post"[^>]*>)/gi, `$1<input type="hidden" name="_csrf" value="${esc(csrf)}">`);
}

